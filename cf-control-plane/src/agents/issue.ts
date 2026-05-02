// IssueAgent — durable per-issue owner.
//
// Phase 4 sub-cut 1: state machine + lease identity. No run lifecycle yet
// (Phase 5 ExecutionWorkflow drives that). The `discovered → queued ⇄
// paused → cancelled` arc is the minimal subset of target.md §8.3 that
// lets ProjectAgent dispatch decisions land somewhere durable and lets
// operators cancel/pause individual issues, without violating the Phase
// 3 "no execution starts" invariant.
//
// Identity: `issue:{tenant_id}:{profile_slug}:{external_id}`. The
// external_id is the tracker-side stable id (Linear UUID for linear,
// native id for cloudflare tracker). DO names get URL-encoded via
// durableObjectName so hyphens / underscores in UUIDs are safe.
//
// Persistence: DO storage owns the agent state. We deliberately do NOT
// add an `agent_state` column to D1.issues yet — that schema bump can
// wait until Phase 5 when we have run lifecycle to mirror. Dashboard
// reads agent state per-issue via a Worker route that calls getStatus.
//
// Phase 4 sub-cut 3 PR-C adds markFailed + retryNow + alarm-driven
// re-dispatch + D1 issue_retries mirror writes. The run lease
// (workflow_instance_id) remains out of scope until Phase 5.

import { DurableObject } from "cloudflare:workers";
import { nextBackoffMs } from "./backoff.js";
import { assertControlPlaneId } from "../identity.js";
import type { IssueDispatchMessage } from "../queues/types.js";

export type IssueAgentStatus =
  | "discovered"
  | "queued"
  | "paused"
  | "cancelled"
  | "retry_wait"
  | "failed";

export type IssueAgentState = {
  issueKey: string; // `${tenantId}:${slug}:${externalId}`
  tenantId: string;
  slug: string;
  externalId: string;
  status: IssueAgentStatus;
  updatedAt: string;
  reason?: string;
  decidedBy?: string;
  /** Number of times this issue has been dispatched (incremented on each transition into `queued`). */
  dispatchCount: number;
  /** Business-layer retry attempt. PR-A preserves it; PR-C markFailed will increment it. */
  attempt: number;
  lastError?: string;
  /** ISO timestamp when the next business-layer retry becomes due. */
  nextRetryAt?: string;
};

type Env = {
  DB: D1Database;
  ISSUE_AGENT: DurableObjectNamespace;
  DISPATCH: Queue<IssueDispatchMessage>;
};

const ALLOWED_TRANSITIONS: Record<IssueAgentStatus, IssueAgentStatus[]> = {
  discovered: ["queued", "cancelled"],
  queued: ["paused", "cancelled", "retry_wait", "failed"],
  paused: ["queued", "cancelled"],
  cancelled: [], // terminal
  retry_wait: ["queued", "paused", "cancelled"],
  failed: ["queued", "cancelled"],
};

export class IssueAgent extends DurableObject<Env> {
  private profileId(tenantId: string, slug: string): string {
    return `${tenantId}/${slug}`;
  }

  private issueId(tenantId: string, slug: string, externalId: string): string {
    return `${this.profileId(tenantId, slug)}:${externalId}`;
  }

  // PR-D keeps failed issues visible in the retry mirror with due_at="".
  // The upsert updates an existing retry row in place when one is present.
  private async putRetryMirror(state: IssueAgentState): Promise<void> {
    try {
      await this.env.DB.prepare(
        `INSERT INTO issue_retries (
           issue_id, tenant_id, profile_id, external_id, attempt, due_at, last_error, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(issue_id) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           profile_id = excluded.profile_id,
           external_id = excluded.external_id,
           attempt = excluded.attempt,
           due_at = excluded.due_at,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`,
      )
        .bind(
          this.issueId(state.tenantId, state.slug, state.externalId),
          state.tenantId,
          this.profileId(state.tenantId, state.slug),
          state.externalId,
          state.attempt,
          state.nextRetryAt ?? "",
          state.lastError ?? null,
          state.updatedAt,
        )
        .run();
    } catch (e) {
      console.warn(
        `[IssueAgent] issue_retries write failed for ${state.issueKey}: ${String((e as Error)?.message ?? e)}`,
      );
    }
  }

  private async deleteRetryMirror(tenantId: string, slug: string, externalId: string): Promise<void> {
    try {
      await this.env.DB.prepare("DELETE FROM issue_retries WHERE issue_id = ?")
        .bind(this.issueId(tenantId, slug, externalId))
        .run();
    } catch (e) {
      console.warn(
        `[IssueAgent] issue_retries delete failed for ${tenantId}:${slug}:${externalId}: ${String((e as Error)?.message ?? e)}`,
      );
    }
  }

  private async loadOrInit(
    tenantId: string,
    slug: string,
    externalId: string,
  ): Promise<IssueAgentState> {
    const cached = await this.ctx.storage.get<IssueAgentState>("state");
    if (cached) return { ...cached, attempt: cached.attempt ?? 0 };
    const state: IssueAgentState = {
      issueKey: `${tenantId}:${slug}:${externalId}`,
      tenantId,
      slug,
      externalId,
      status: "discovered",
      updatedAt: new Date().toISOString(),
      dispatchCount: 0,
      attempt: 0,
    };
    await this.ctx.storage.put("state", state);
    return state;
  }

  async getStatus(
    tenantId: string,
    slug: string,
    externalId: string,
  ): Promise<IssueAgentState> {
    assertControlPlaneId("tenant", tenantId);
    assertControlPlaneId("profile", slug);
    assertControlPlaneId("issue", externalId);
    return this.loadOrInit(tenantId, slug, externalId);
  }

  async transition(
    tenantId: string,
    slug: string,
    externalId: string,
    next: IssueAgentStatus,
    decidedBy?: string,
    reason?: string,
  ): Promise<IssueAgentState> {
    assertControlPlaneId("tenant", tenantId);
    assertControlPlaneId("profile", slug);
    assertControlPlaneId("issue", externalId);

    const current = await this.loadOrInit(tenantId, slug, externalId);
    if (current.status === next) return current; // idempotent

    const allowed = ALLOWED_TRANSITIONS[current.status];
    if (!allowed.includes(next)) {
      throw new Error(
        `issue_invalid_transition: ${current.status} -> ${next} (allowed: ${allowed.join(", ") || "(none — terminal)"})`,
      );
    }

    const updated: IssueAgentState = {
      ...current,
      status: next,
      updatedAt: new Date().toISOString(),
      decidedBy,
      reason,
      dispatchCount:
        next === "queued" ? current.dispatchCount + 1 : current.dispatchCount,
      nextRetryAt: next === "retry_wait" ? current.nextRetryAt : undefined,
    };
    await this.ctx.storage.put("state", updated);
    return updated;
  }

  async dispatch(
    tenantId: string,
    slug: string,
    externalId: string,
    decidedBy?: string,
    reason?: string,
  ): Promise<IssueAgentState> {
    const state = await this.transition(tenantId, slug, externalId, "queued", decidedBy, reason);
    await this.deleteRetryMirror(tenantId, slug, externalId);
    return state;
  }

  async markFailed(
    tenantId: string,
    slug: string,
    externalId: string,
    error: string,
    opts: { maxAttempts?: number; baseMs?: number; maxBackoffMs?: number } = {},
  ): Promise<IssueAgentState> {
    assertControlPlaneId("tenant", tenantId);
    assertControlPlaneId("profile", slug);
    assertControlPlaneId("issue", externalId);

    const current = await this.loadOrInit(tenantId, slug, externalId);
    if (current.status !== "queued") {
      throw new Error(`issue_markfailed_invalid_state: ${current.status}`);
    }

    const nextAttempt = current.attempt + 1;
    const maxAttempts = opts.maxAttempts ?? 5;
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const target: IssueAgentStatus = nextAttempt < maxAttempts ? "retry_wait" : "failed";
    const nextRetryMs =
      target === "retry_wait" ?
        nextBackoffMs(nextAttempt, opts.maxBackoffMs ?? 300_000, opts.baseMs ?? 1000)
      : undefined;
    const nextRetryAt =
      nextRetryMs !== undefined ? new Date(nowMs + nextRetryMs).toISOString() : undefined;

    const updated: IssueAgentState = {
      ...current,
      status: target,
      attempt: nextAttempt,
      lastError: error,
      nextRetryAt,
      updatedAt: now,
      decidedBy: "issue-agent",
      reason: target === "retry_wait" ? "retry-scheduled" : "max-attempts-exhausted",
    };

    await this.ctx.storage.put("state", updated);
    if (nextRetryMs !== undefined) await this.ctx.storage.setAlarm(nowMs + nextRetryMs);

    await this.putRetryMirror(updated);

    return updated;
  }

  /**
   * Force a retrying issue back to queued immediately.
   *
   * This method intentionally does NOT enqueue an IssueDispatchMessage. The
   * caller owns dispatching the next attempt (the operator route sends one);
   * the Durable Object alarm path enqueues directly inside alarm().
   */
  async retryNow(
    tenantId: string,
    slug: string,
    externalId: string,
    decidedBy?: string,
    reason?: string,
  ): Promise<IssueAgentState> {
    assertControlPlaneId("tenant", tenantId);
    assertControlPlaneId("profile", slug);
    assertControlPlaneId("issue", externalId);

    const current = await this.loadOrInit(tenantId, slug, externalId);
    if (current.status !== "retry_wait") {
      throw new Error(`issue_retrynow_invalid_state: ${current.status}`);
    }

    await this.ctx.storage.deleteAlarm();
    await this.deleteRetryMirror(tenantId, slug, externalId);
    return this.transition(tenantId, slug, externalId, "queued", decidedBy, reason);
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<IssueAgentState>("state");
    if (!state || state.status !== "retry_wait") return;

    assertControlPlaneId("tenant", state.tenantId);
    assertControlPlaneId("profile", state.slug);
    assertControlPlaneId("issue", state.externalId);

    const message: IssueDispatchMessage = {
      kind: "issue.dispatch",
      version: 1,
      tenant_id: state.tenantId,
      slug: state.slug,
      external_id: state.externalId,
      identifier: state.externalId,
      attempt: state.attempt,
      scheduled_at: new Date().toISOString(),
    };
    await this.env.DISPATCH.send(message);
    await this.deleteRetryMirror(state.tenantId, state.slug, state.externalId);
    await this.transition(
      state.tenantId,
      state.slug,
      state.externalId,
      "queued",
      "issue-agent-alarm",
      `attempt=${state.attempt}`,
    );
  }

  async pause(
    tenantId: string,
    slug: string,
    externalId: string,
    decidedBy?: string,
    reason?: string,
  ): Promise<IssueAgentState> {
    const state = await this.transition(tenantId, slug, externalId, "paused", decidedBy, reason);
    await this.deleteRetryMirror(tenantId, slug, externalId);
    return state;
  }

  async resume(
    tenantId: string,
    slug: string,
    externalId: string,
    decidedBy?: string,
    reason?: string,
  ): Promise<IssueAgentState> {
    const state = await this.transition(tenantId, slug, externalId, "queued", decidedBy, reason);
    await this.deleteRetryMirror(tenantId, slug, externalId);
    return state;
  }

  async cancel(
    tenantId: string,
    slug: string,
    externalId: string,
    decidedBy?: string,
    reason?: string,
  ): Promise<IssueAgentState> {
    const state = await this.transition(tenantId, slug, externalId, "cancelled", decidedBy, reason);
    await this.deleteRetryMirror(tenantId, slug, externalId);
    return state;
  }
}
