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
//   - draining timestamp is tracked in DO state but not yet mirrored;
//     dashboard reads it through the agent until the schema gains a
//     dedicated column
//
// Phase 2 first cut does NOT yet implement:
//   - polling schedule (Phase 3)
//   - dispatch queue producer (Phase 4)
//   - reconciliation (Phase 3)
//   - drain completion tracking (waits on IssueAgent)

import { DurableObject } from "cloudflare:workers";

type ProjectStatus = "active" | "paused" | "draining";

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
};

const ALLOWED_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  active: ["paused", "draining"],
  paused: ["active"],
  draining: ["paused", "active"],
};

export class ProjectAgent extends DurableObject<Env> {
  private async loadOrInit(
    tenantId: string,
    slug: string,
  ): Promise<ProjectState> {
    const cached = await this.ctx.storage.get<ProjectState>("state");
    if (cached) return cached;

    // Hydrate from D1; the profile row carries an authoritative status.
    const row = await this.env.DB.prepare(
      `SELECT status, updated_at FROM profiles WHERE tenant_id = ? AND slug = ?`,
    )
      .bind(tenantId, slug)
      .first<{ status: string; updated_at: string }>();

    const status: ProjectStatus =
      (row?.status as ProjectStatus | undefined) ?? "active";
    const state: ProjectState = {
      projectId: `${tenantId}/${slug}`,
      tenantId,
      slug,
      status,
      updatedAt: row?.updated_at ?? new Date().toISOString(),
    };
    await this.ctx.storage.put("state", state);
    return state;
  }

  private async persistAndMirror(state: ProjectState): Promise<void> {
    await this.ctx.storage.put("state", state);
    await this.env.DB.prepare(
      `UPDATE profiles
          SET status = ?, updated_at = ?
        WHERE tenant_id = ? AND slug = ?`,
    )
      .bind(state.status, state.updatedAt, state.tenantId, state.slug)
      .run();
  }

  async getStatus(tenantId: string, slug: string): Promise<ProjectState> {
    return this.loadOrInit(tenantId, slug);
  }

  async transition(
    tenantId: string,
    slug: string,
    next: ProjectStatus,
    decidedBy?: string,
    reason?: string,
  ): Promise<ProjectState> {
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
}
