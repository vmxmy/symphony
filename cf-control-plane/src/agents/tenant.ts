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
//   - D1 is the identity registry; missing/archived rows are rejected before
//     DO state is initialized.
//
// Operator-facing methods are auto-RPC: any async method on the class
// is callable as `env.TENANT_AGENT.get(id).<method>(args)`.

import { DurableObject } from "cloudflare:workers";
import { assertControlPlaneId } from "../identity.js";

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
  private parseStatus(status: string): TenantStatus {
    if (status === "active" || status === "paused" || status === "suspended") return status;
    throw new Error(`tenant_status_invalid: ${status}`);
  }

  private async loadD1State(tenantId: string): Promise<TenantState> {
    assertControlPlaneId("tenant", tenantId);
    const row = await this.env.DB.prepare(
      `SELECT status, updated_at FROM tenants WHERE id = ? AND archived_at IS NULL`,
    )
      .bind(tenantId)
      .first<{ status: string; updated_at: string }>();
    if (!row) throw new Error("tenant_not_found");
    return {
      tenantId,
      status: this.parseStatus(row.status),
      updatedAt: row.updated_at,
    };
  }

  private async loadOrInit(tenantId: string): Promise<TenantState> {
    assertControlPlaneId("tenant", tenantId);
    const d1State = await this.loadD1State(tenantId);
    const cached = await this.ctx.storage.get<TenantState>("state");
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

  private async persistAndMirror(state: TenantState): Promise<void> {
    const result = await this.env.DB.prepare(
      `UPDATE tenants
          SET status = ?, updated_at = ?
        WHERE id = ? AND archived_at IS NULL`,
    )
      .bind(state.status, state.updatedAt, state.tenantId)
      .run();
    if (result.meta.changes !== 1) throw new Error("tenant_d1_mirror_drift");
    await this.ctx.storage.put("state", state);
  }

  async getStatus(tenantId: string): Promise<TenantState> {
    return this.loadOrInit(tenantId);
  }

  async peekStatus(tenantId: string): Promise<TenantState> {
    return this.loadD1State(tenantId);
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
