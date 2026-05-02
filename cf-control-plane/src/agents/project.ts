// ProjectAgent — durable per-profile (project) state and dispatch gate.
//
// Phase 2 minimal state machine:
//
//   active <-> paused
//   active -> draining (no new dispatch; existing IssueAgents finish)
//   draining -> paused | active
//
// Identity: `project:{tenant_id}:{profile_slug}`.
//
// Persistence:
//   - hot state lives in DO storage
//   - every transition mirrors to D1 `profiles.status`
//   - D1 is the identity registry; missing/archived rows are rejected before
//     DO state is initialized.
//
// Phase 2 first cut does NOT yet implement:
//   - polling schedule (Phase 3)
//   - dispatch queue producer (Phase 4)
//   - drain completion tracking (waits on IssueAgent)

import { DurableObject } from "cloudflare:workers";
import { LinearGraphqlClient } from "../tracker/linear.js";
import { extractLinearTrackerConfig } from "../tracker/config.js";
import { mirrorIssues } from "../tracker/mirror.js";
import { reconcileTick } from "../reconcile/tick.js";
import type { ReconcileInput, Decision } from "../reconcile/types.js";
import { assertControlPlaneId } from "../identity.js";

type ProjectStatus = "active" | "paused" | "draining" | "archived";

type ProjectState = {
  projectId: string; // `${tenantId}/${slug}`
  tenantId: string;
  slug: string;
  status: ProjectStatus;
  updatedAt: string;
  drainStartedAt?: string;
  reason?: string;
  decidedBy?: string;
};

type Env = {
  DB: D1Database;
  PROJECT_AGENT: DurableObjectNamespace;
  // Linear API key shared at Worker scope; per-tenant secrets land
  // when ToolGatewayAgent ships in Phase 8.
  LINEAR_API_KEY?: string;
};

export type PollResult = {
  generated_at: string;
  profile: { id: string; tenant_id: string; slug: string };
  decisions: Decision[];
  mirrored: { inserted: number; updated: number; unchanged: number };
  cleaned_up: number;
};

const ALLOWED_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  active: ["paused", "draining"],
  paused: ["active"],
  draining: ["paused", "active"],
  archived: [],
};

export class ProjectAgent extends DurableObject<Env> {
  private parseStatus(status: string): ProjectStatus {
    if (status === "active" || status === "paused" || status === "draining" || status === "archived") return status;
    throw new Error(`project_status_invalid: ${status}`);
  }

  private async loadTenantStatus(tenantId: string): Promise<string> {
    assertControlPlaneId("tenant", tenantId);
    const row = await this.env.DB.prepare(
      `SELECT status FROM tenants WHERE id = ? AND archived_at IS NULL`,
    )
      .bind(tenantId)
      .first<{ status: string }>();
    if (!row) throw new Error("tenant_not_found");
    return row.status;
  }

  private async ensureTenantActive(tenantId: string): Promise<void> {
    const status = await this.loadTenantStatus(tenantId);
    if (status !== "active") throw new Error(`tenant_not_active: ${status}`);
  }

  private async loadD1State(tenantId: string, slug: string): Promise<ProjectState> {
    assertControlPlaneId("tenant", tenantId);
    assertControlPlaneId("profile", slug);
    const row = await this.env.DB.prepare(
      `SELECT status, updated_at FROM profiles
        WHERE tenant_id = ? AND slug = ? AND archived_at IS NULL`,
    )
      .bind(tenantId, slug)
      .first<{ status: string; updated_at: string }>();
    if (!row) throw new Error("project_not_found");
    const status = this.parseStatus(row.status);
    if (status === "archived") throw new Error("project_archived");
    return {
      projectId: `${tenantId}/${slug}`,
      tenantId,
      slug,
      status,
      updatedAt: row.updated_at,
    };
  }

  private async loadOrInit(
    tenantId: string,
    slug: string,
  ): Promise<ProjectState> {
    assertControlPlaneId("tenant", tenantId);
    assertControlPlaneId("profile", slug);
    const d1State = await this.loadD1State(tenantId, slug);
    const cached = await this.ctx.storage.get<ProjectState>("state");
    if (!cached) {
      await this.ctx.storage.put("state", d1State);
      return d1State;
    }
    const state = { ...cached, status: d1State.status, updatedAt: d1State.updatedAt };
    if (cached.status !== state.status || cached.updatedAt !== state.updatedAt) {
      await this.ctx.storage.put("state", state);
    }
    return state;
  }

  private async persistAndMirror(state: ProjectState): Promise<void> {
    const result = await this.env.DB.prepare(
      `UPDATE profiles
          SET status = ?, updated_at = ?
        WHERE tenant_id = ? AND slug = ? AND archived_at IS NULL`,
    )
      .bind(state.status, state.updatedAt, state.tenantId, state.slug)
      .run();
    if (result.meta.changes !== 1) throw new Error("project_d1_mirror_drift");
    await this.ctx.storage.put("state", state);
  }

  async getStatus(tenantId: string, slug: string): Promise<ProjectState> {
    return this.loadOrInit(tenantId, slug);
  }

  async peekStatus(tenantId: string, slug: string): Promise<ProjectState> {
    return this.loadD1State(tenantId, slug);
  }

  async transition(
    tenantId: string,
    slug: string,
    next: ProjectStatus,
    decidedBy?: string,
    reason?: string,
  ): Promise<ProjectState> {
    assertControlPlaneId("tenant", tenantId);
    assertControlPlaneId("profile", slug);
    if (next === "active" || next === "draining") await this.ensureTenantActive(tenantId);
    const current = await this.loadOrInit(tenantId, slug);
    if (current.status === next) return current; // idempotent

    const allowed = ALLOWED_TRANSITIONS[current.status];
    if (!allowed.includes(next)) {
      throw new Error(
        `project_invalid_transition: ${current.status} -> ${next} (allowed: ${allowed.join(", ")})`,
      );
    }

    const updated: ProjectState = {
      ...current,
      status: next,
      updatedAt: new Date().toISOString(),
      drainStartedAt:
        next === "draining" ? new Date().toISOString() : current.drainStartedAt,
      decidedBy,
      reason,
    };
    await this.persistAndMirror(updated);
    return updated;
  }

  async pause(tenantId: string, slug: string, decidedBy?: string, reason?: string) {
    return this.transition(tenantId, slug, "paused", decidedBy, reason);
  }

  async resume(tenantId: string, slug: string, decidedBy?: string, reason?: string) {
    return this.transition(tenantId, slug, "active", decidedBy, reason);
  }

  async drain(tenantId: string, slug: string, decidedBy?: string, reason?: string) {
    return this.transition(tenantId, slug, "draining", decidedBy, reason);
  }

  /**
   * Phase 3 poll: fetch tracker state, run the reconcile harness, mirror
   * issues into D1, and apply cleanup decisions (archive). Other decisions
   * (`dispatch`, `reconcile_*`) are surfaced for the operator but not
   * actioned — Phase 3 explicitly does not start runs.
   */
  async poll(tenantId: string, slug: string): Promise<PollResult> {
    assertControlPlaneId("tenant", tenantId);
    assertControlPlaneId("profile", slug);
    await this.ensureTenantActive(tenantId);
    const profileRow = await this.env.DB.prepare(
      `SELECT id, tenant_id, slug, status, tracker_kind, config_json
         FROM profiles
        WHERE tenant_id = ? AND slug = ? AND archived_at IS NULL`,
    )
      .bind(tenantId, slug)
      .first<{
        id: string;
        tenant_id: string;
        slug: string;
        status: string;
        tracker_kind: string;
        config_json: string;
      }>();
    if (!profileRow) throw new Error("profile_not_found");
    if (profileRow.status !== "active") throw new Error(`project_not_active: ${profileRow.status}`);
    if (profileRow.tracker_kind !== "linear") {
      throw new Error(
        `tracker_kind_unsupported: expected 'linear', got '${profileRow.tracker_kind}'`,
      );
    }
    if (!this.env.LINEAR_API_KEY) {
      throw new Error("linear_api_key_unset");
    }

    let parsedConfig: unknown;
    try {
      parsedConfig = JSON.parse(profileRow.config_json);
    } catch (e) {
      throw new Error(`config_json_parse_failed: ${(e as Error).message}`);
    }
    const extracted = extractLinearTrackerConfig(parsedConfig, this.env.LINEAR_API_KEY);
    if (!extracted.ok) {
      throw new Error(`${extracted.code}${extracted.detail ? ": " + extracted.detail : ""}`);
    }
    const trackerCfg = extracted.config;
    const config = parsedConfig as Record<string, unknown>;

    const client = new LinearGraphqlClient(trackerCfg);
    const [active, terminal] = await Promise.all([
      client.fetchActiveIssues(),
      client.fetchTerminalIssues(),
    ]);

    const now = new Date().toISOString();

    // Determine which terminal issues currently look "alive" in D1
    // (archived_at IS NULL); used as the workspaceExists oracle so the
    // reconcile harness only emits a cleanup decision once per terminal
    // transition, not on every poll.
    const aliveRows = await this.env.DB.prepare(
      `SELECT identifier FROM issues
        WHERE profile_id = ? AND archived_at IS NULL`,
    )
      .bind(profileRow.id)
      .all<{ identifier: string }>();
    const aliveIdentifiers = new Set((aliveRows.results ?? []).map((r) => r.identifier));

    // Phase 4 sub-cut 3 PR-B (docs/cloudflare-agent-native-phase4-plan.md §4 Step 5):
    // feed reconcileTick from the D1 retry mirror. IssueAgent DO storage stays
    // the source of truth; an empty mirror preserves the previous no-retry path.
    const retryRows = await this.env.DB.prepare(
      `SELECT issue_id, attempt, due_at FROM issue_retries WHERE profile_id = ?`,
    )
      .bind(profileRow.id)
      .all<{ issue_id: string; attempt: number; due_at: string }>();
    const retries = (retryRows.results ?? []).map((row) => ({
      issueId: row.issue_id,
      attempt: row.attempt,
      dueAt: row.due_at,
    }));

    const agentCfg = (config.agent as Record<string, unknown> | undefined) ?? {};
    const input: ReconcileInput = {
      cfg: {
        tracker: {
          activeStates: trackerCfg.activeStates,
          terminalStates: trackerCfg.terminalStates,
        },
        agent: {
          maxConcurrentAgents:
            (agentCfg.max_concurrent_agents as number | undefined) ??
            (agentCfg.maxConcurrentAgents as number | undefined) ??
            1,
          maxConcurrentAgentsByState:
            (agentCfg.max_concurrent_agents_by_state as
              | Record<string, number>
              | undefined) ??
            (agentCfg.maxConcurrentAgentsByState as
              | Record<string, number>
              | undefined) ??
            {},
        },
      },
      active,
      terminal,
      byIdLookup: {},
      running: [],
      retries,
      workspaceExists: (issue) => aliveIdentifiers.has(issue.identifier),
      now,
    };

    const decisions = reconcileTick(input);

    // Mirror both active and terminal issues; UPSERT clears archived_at if
    // the issue reappears in either set.
    const mirrored = await mirrorIssues(
      this.env.DB,
      profileRow.id,
      profileRow.tenant_id,
      [...active, ...terminal],
      now,
    );

    // Apply cleanup decisions: archive the row in D1.
    let cleaned_up = 0;
    for (const d of decisions) {
      if (d.kind !== "cleanup") continue;
      await this.env.DB.prepare(
        `UPDATE issues SET archived_at = ?, updated_at = ?
          WHERE profile_id = ? AND identifier = ?`,
      )
        .bind(now, now, profileRow.id, d.issueIdentifier)
        .run();
      cleaned_up++;
    }

    return {
      generated_at: now,
      profile: {
        id: profileRow.id,
        tenant_id: profileRow.tenant_id,
        slug: profileRow.slug,
      },
      decisions,
      mirrored,
      cleaned_up,
    };
  }
}
