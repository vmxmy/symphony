// TenantAgent — durable per-tenant state and policy gate.
//
// Phase 2 minimal state machine:
//
//   active <-> paused
//   active -> suspended (terminal until operator restores)
//
// Identity: `tenant:{tenant_id}` (resolved via env.TENANT_AGENT.idFromName).
//
// Persistence:
//   - hot state lives in DO storage (this.ctx.storage)
//   - every transition mirrors to D1 `tenants.status` so dashboard
//     reads stay consistent and so CLI ops can see status without
//     hitting the agent
//   - DO is the source of truth for transition correctness; D1 is
//     the queryable index. If they diverge, DO wins.
//
// Operator-facing methods are auto-RPC: any async method on the class
// is callable as `env.TENANT_AGENT.get(id).<method>(args)`.

import { DurableObject } from "cloudflare:workers";

type TenantStatus = "active" | "paused" | "suspended";

type TenantState = {
  tenantId: string;
  status: TenantStatus;
  updatedAt: string;
  reason?: string;
  decidedBy?: string;
};

type Env = {
  DB: D1Database;
  TENANT_AGENT: DurableObjectNamespace;
};

const ALLOWED_TRANSITIONS: Record<TenantStatus, TenantStatus[]> = {
  active: ["paused", "suspended"],
  paused: ["active", "suspended"],
  suspended: ["active"],
};

export class TenantAgent extends DurableObject<Env> {
  private async loadOrInit(tenantId: string): Promise<TenantState> {
    const cached = await this.ctx.storage.get<TenantState>("state");
    if (cached) return cached;

    // First touch: hydrate from D1 if a row exists, else assume active.
    const row = await this.env.DB.prepare(
      `SELECT status, updated_at FROM tenants WHERE id = ?`,
    )
      .bind(tenantId)
      .first<{ status: string; updated_at: string }>();

    const status: TenantStatus =
      (row?.status as TenantStatus | undefined) ?? "active";
    const state: TenantState = {
      tenantId,
      status,
      updatedAt: row?.updated_at ?? new Date().toISOString(),
    };
    await this.ctx.storage.put("state", state);
    return state;
  }

  private async persistAndMirror(state: TenantState): Promise<void> {
    await this.ctx.storage.put("state", state);
    await this.env.DB.prepare(
      `UPDATE tenants SET status = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(state.status, state.updatedAt, state.tenantId)
      .run();
  }

  async getStatus(tenantId: string): Promise<TenantState> {
    return this.loadOrInit(tenantId);
  }

  async transition(
    tenantId: string,
    next: TenantStatus,
    decidedBy?: string,
    reason?: string,
  ): Promise<TenantState> {
    const current = await this.loadOrInit(tenantId);
    if (current.status === next) return current; // no-op idempotent

    const allowed = ALLOWED_TRANSITIONS[current.status];
    if (!allowed.includes(next)) {
      throw new Error(
        `tenant_invalid_transition: ${current.status} -> ${next} (allowed: ${allowed.join(", ")})`,
      );
    }

    const updated: TenantState = {
      ...current,
      status: next,
      updatedAt: new Date().toISOString(),
      decidedBy,
      reason,
    };
    await this.persistAndMirror(updated);
    return updated;
  }

  async pause(tenantId: string, decidedBy?: string, reason?: string) {
    return this.transition(tenantId, "paused", decidedBy, reason);
  }

  async resume(tenantId: string, decidedBy?: string, reason?: string) {
    return this.transition(tenantId, "active", decidedBy, reason);
  }

  async suspend(tenantId: string, decidedBy?: string, reason?: string) {
    return this.transition(tenantId, "suspended", decidedBy, reason);
  }
}
