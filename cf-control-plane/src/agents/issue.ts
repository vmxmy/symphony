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
// Phase 4 next sub-cut will add: dispatch queue consumer that calls
// dispatch() on cron-decisioned candidates, retry_wait + failed states,
// and the run lease (workflow_instance_id) once ExecutionWorkflow lands.

import { DurableObject } from "cloudflare:workers";
import { assertControlPlaneId } from "../identity.js";

export type IssueAgentStatus =
  | "discovered"
  | "queued"
  | "paused"
  | "cancelled";

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
};

type Env = {
  ISSUE_AGENT: DurableObjectNamespace;
};

const ALLOWED_TRANSITIONS: Record<IssueAgentStatus, IssueAgentStatus[]> = {
  discovered: ["queued", "cancelled"],
  queued: ["paused", "cancelled"],
  paused: ["queued", "cancelled"],
  cancelled: [], // terminal
};

export class IssueAgent extends DurableObject<Env> {
  private async loadOrInit(
    tenantId: string,
    slug: string,
    externalId: string,
  ): Promise<IssueAgentState> {
    const cached = await this.ctx.storage.get<IssueAgentState>("state");
    if (cached) return cached;
    const state: IssueAgentState = {
      issueKey: `${tenantId}:${slug}:${externalId}`,
      tenantId,
      slug,
      externalId,
      status: "discovered",
      updatedAt: new Date().toISOString(),
      dispatchCount: 0,
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
    return this.transition(tenantId, slug, externalId, "queued", decidedBy, reason);
  }

  async pause(
    tenantId: string,
    slug: string,
    externalId: string,
    decidedBy?: string,
    reason?: string,
  ): Promise<IssueAgentState> {
    return this.transition(tenantId, slug, externalId, "paused", decidedBy, reason);
  }

  async resume(
    tenantId: string,
    slug: string,
    externalId: string,
    decidedBy?: string,
    reason?: string,
  ): Promise<IssueAgentState> {
    return this.transition(tenantId, slug, externalId, "queued", decidedBy, reason);
  }

  async cancel(
    tenantId: string,
    slug: string,
    externalId: string,
    decidedBy?: string,
    reason?: string,
  ): Promise<IssueAgentState> {
    return this.transition(tenantId, slug, externalId, "cancelled", decidedBy, reason);
  }
}
