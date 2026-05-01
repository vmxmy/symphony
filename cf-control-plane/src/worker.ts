// Symphony control-plane Worker entrypoint.
//
// Phase 2 first HTTP surface. Read-only routes that aggregate state from D1
// for the dashboard and operator API.
//
// Auth model in this commit: a single shared bearer token kept in the Worker
// secret OPERATOR_TOKEN. This is a placeholder for the proper Cloudflare
// Access JWT validation that comes with the Phase 8 OperatorAgent /
// dashboard work; the token stub keeps the surface gated while the Access
// application is configured. Public routes (`/` banner, `/api/v1/healthz`)
// are deliberately unauthenticated.
//
// All non-trivial routes touch D1 only — no Agents, no Workflows, no Queues
// in this commit. TenantAgent / ProjectAgent skeletons land in the next
// commit.

import { TenantAgent } from "./agents/tenant.js";
import { ProjectAgent } from "./agents/project.js";
import { executeMockRun } from "./orchestration/mock_run.js";
import { renderDashboard } from "./dashboard/render.js";
import {
  getSession,
  sessionCookieHeader,
  sessionClearCookieHeader,
} from "./dashboard/auth.js";

export { TenantAgent, ProjectAgent };

interface Env {
  DB: D1Database;
  TENANT_AGENT: DurableObjectNamespace<TenantAgent>;
  PROJECT_AGENT: DurableObjectNamespace<ProjectAgent>;
  // Bearer token for the placeholder auth gate. If unset, the Worker fails
  // closed: every authenticated route returns 503.
  OPERATOR_TOKEN?: string;
}

function tenantAgentFor(env: Env, tenantId: string) {
  const id = env.TENANT_AGENT.idFromName(`tenant:${tenantId}`);
  return env.TENANT_AGENT.get(id);
}

function projectAgentFor(env: Env, tenantId: string, slug: string) {
  const id = env.PROJECT_AGENT.idFromName(`project:${tenantId}:${slug}`);
  return env.PROJECT_AGENT.get(id);
}

type TenantRow = {
  id: string;
  name: string;
  status: string;
  policy_json: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type ProfileRow = {
  id: string;
  tenant_id: string;
  slug: string;
  active_version: string;
  tracker_kind: string;
  runtime_kind: string;
  status: string;
  source_schema_version: number;
  imported_schema_version: number;
  defaults_applied: string;
  warnings: string | null;
  imported_at: string | null;
  created_at: string;
  updated_at: string;
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

function unauthorized(reason: string): Response {
  return jsonResponse({ error: "unauthorized", reason }, { status: 401 });
}

function forbidden(reason: string): Response {
  return jsonResponse({ error: "forbidden", reason }, { status: 403 });
}

function notFound(): Response {
  return jsonResponse({ error: "not_found" }, { status: 404 });
}

function methodNotAllowed(allowed: string[]): Response {
  return jsonResponse(
    { error: "method_not_allowed", allowed },
    { status: 405, headers: { allow: allowed.join(", ") } },
  );
}

/**
 * Bearer-token gate. Fails closed if OPERATOR_TOKEN is missing.
 * Constant-time comparison via crypto.subtle.timingSafeEqual is overkill
 * for a placeholder; simple equality is fine here and the doc note
 * explains the eventual Access swap.
 */
function checkAuth(req: Request, env: Env): Response | null {
  if (!env.OPERATOR_TOKEN) {
    return forbidden("OPERATOR_TOKEN is not configured on this Worker");
  }
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return unauthorized("missing or malformed Authorization: Bearer <token>");
  const presented = m[1] ?? "";
  if (presented !== env.OPERATOR_TOKEN) return unauthorized("token does not match");
  return null;
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function listTenants(env: Env): Promise<unknown[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, status, policy_json, created_at, updated_at, archived_at
       FROM tenants
      WHERE archived_at IS NULL
      ORDER BY id`,
  ).all<TenantRow>();
  return (results ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    policy: safeJsonParse<unknown>(row.policy_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

async function listProfiles(env: Env): Promise<unknown[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, tenant_id, slug, active_version, tracker_kind, runtime_kind,
            status, source_schema_version, imported_schema_version,
            defaults_applied, warnings, imported_at, created_at, updated_at
       FROM profiles
      WHERE archived_at IS NULL
      ORDER BY tenant_id, slug`,
  ).all<ProfileRow>();
  return (results ?? []).map((row) => ({
    id: row.id,
    tenant_id: row.tenant_id,
    slug: row.slug,
    active_version: row.active_version,
    tracker_kind: row.tracker_kind,
    runtime_kind: row.runtime_kind,
    status: row.status,
    source_schema_version: row.source_schema_version,
    imported_schema_version: row.imported_schema_version,
    defaults_applied: safeJsonParse<string[]>(row.defaults_applied, []),
    warnings: safeJsonParse<string[]>(row.warnings, []),
    imported_at: row.imported_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

async function probeDbReady(env: Env): Promise<{ ok: boolean; message?: string }> {
  try {
    const row = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    if (!row || row.ok !== 1) return { ok: false, message: "unexpected probe row" };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String((e as Error).message ?? e) };
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // ---- public routes (no auth) ----
    if (req.method === "GET" && url.pathname === "/") {
      return new Response(
        "symphony-control-plane: GET /api/v1/healthz | /api/v1/state | " +
          "/api/v1/tenants | /api/v1/profiles\n",
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    if (url.pathname === "/api/v1/healthz") {
      if (req.method !== "GET") return methodNotAllowed(["GET"]);
      const db = await probeDbReady(env);
      const status = db.ok ? 200 : 503;
      return jsonResponse(
        { status: db.ok ? "ok" : "degraded", db: db.ok ? "ok" : "down", message: db.message ?? null },
        { status },
      );
    }

    if (url.pathname === "/dashboard") {
      if (req.method !== "GET") return methodNotAllowed(["GET"]);
      if (!env.OPERATOR_TOKEN) return forbidden("OPERATOR_TOKEN is not configured on this Worker");
      const session = getSession(req, env.OPERATOR_TOKEN);
      if (!session) {
        return new Response(
          "401 unauthorized — supply Authorization: Bearer <token> or visit /dashboard?token=<token> once.",
          { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } },
        );
      }
      // First-touch query path: upgrade to cookie + clean URL.
      if (session.source === "query") {
        return new Response(null, {
          status: 302,
          headers: {
            location: "/dashboard",
            "set-cookie": sessionCookieHeader(session.token),
          },
        });
      }
      const [tenants, profiles, runsRes] = await Promise.all([
        listTenantsWithAgentState(env),
        listProfilesWithAgentState(env),
        env.DB.prepare(
          `SELECT r.id, r.issue_id, r.attempt, r.status, r.adapter_kind,
                  r.started_at, r.finished_at, r.error, r.token_usage_json,
                  i.identifier AS issue_identifier
             FROM runs r
             LEFT JOIN issues i ON i.id = r.issue_id
            WHERE r.archived_at IS NULL
            ORDER BY r.started_at DESC
            LIMIT 20`,
        ).all<Record<string, unknown>>(),
      ]);
      const html = renderDashboard({
        generated_at: new Date().toISOString(),
        tenants: tenants as Parameters<typeof renderDashboard>[0]["tenants"],
        profiles: profiles as Parameters<typeof renderDashboard>[0]["profiles"],
        runs: (runsRes.results ?? []) as Parameters<typeof renderDashboard>[0]["runs"],
      });
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/logout") {
      return new Response(null, {
        status: 302,
        headers: {
          location: "/",
          "set-cookie": sessionClearCookieHeader(),
        },
      });
    }

    // ---- gated routes ----
    if (url.pathname.startsWith("/api/v1/")) {
      const denial = checkAuth(req, env);
      if (denial) return denial;

      if (url.pathname === "/api/v1/state") {
        if (req.method !== "GET") return methodNotAllowed(["GET"]);
        const [tenants, profiles] = await Promise.all([
          listTenantsWithAgentState(env),
          listProfilesWithAgentState(env),
        ]);
        return jsonResponse({
          generated_at: new Date().toISOString(),
          tenants,
          profiles,
        });
      }

      if (url.pathname === "/api/v1/tenants") {
        if (req.method !== "GET") return methodNotAllowed(["GET"]);
        return jsonResponse({ tenants: await listTenantsWithAgentState(env) });
      }

      if (url.pathname === "/api/v1/profiles") {
        if (req.method !== "GET") return methodNotAllowed(["GET"]);
        return jsonResponse({ profiles: await listProfilesWithAgentState(env) });
      }

      // ---- operator transition routes -------------------------------
      const tenantAction = url.pathname.match(
        /^\/api\/v1\/tenants\/([^/]+)\/actions\/(pause|resume|suspend)$/,
      );
      if (tenantAction) {
        if (req.method !== "POST") return methodNotAllowed(["POST"]);
        const [, tenantId, action] = tenantAction;
        const decidedBy = req.headers.get("x-symphony-operator") ?? null;
        const reason = req.headers.get("x-symphony-reason") ?? undefined;
        try {
          const stub = tenantAgentFor(env, tenantId!);
          let result;
          if (action === "pause") result = await stub.pause(tenantId!, decidedBy ?? undefined, reason);
          else if (action === "resume") result = await stub.resume(tenantId!, decidedBy ?? undefined, reason);
          else result = await stub.suspend(tenantId!, decidedBy ?? undefined, reason);
          return jsonResponse({ tenant: result });
        } catch (e) {
          return jsonResponse({ error: "transition_rejected", message: String((e as Error).message) }, { status: 409 });
        }
      }

      // ---- mock orchestration (Phase 2 last cut; Phase 3 replaces) ----
      const mockRun = url.pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/([^/]+)\/issues\/([^/]+)\/actions\/mock-run$/,
      );
      if (mockRun) {
        if (req.method !== "POST") return methodNotAllowed(["POST"]);
        const [, tenantId, slug, identifier] = mockRun;
        const profileRow = await env.DB.prepare(
          `SELECT id, tenant_id, slug FROM profiles WHERE tenant_id = ? AND slug = ?`,
        )
          .bind(tenantId!, slug!)
          .first<{ id: string; tenant_id: string; slug: string }>();
        if (!profileRow) {
          return jsonResponse({ error: "profile_not_found", tenant: tenantId, slug }, { status: 404 });
        }
        const result = await executeMockRun(env, {
          profile: profileRow,
          issueIdentifier: identifier!,
        });
        return jsonResponse({ run: result });
      }

      // ---- run inspection -----------------------------------------------
      const runDetail = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)$/);
      if (runDetail) {
        if (req.method !== "GET") return methodNotAllowed(["GET"]);
        const runId = runDetail[1]!;
        const [run, events, toolCalls] = await Promise.all([
          env.DB.prepare(
            `SELECT id, issue_id, attempt, status, adapter_kind,
                    started_at, finished_at, error, token_usage_json
               FROM runs WHERE id = ?`,
          )
            .bind(runId)
            .first<Record<string, unknown>>(),
          env.DB.prepare(
            `SELECT id, event_type, severity, message, created_at
               FROM run_events WHERE run_id = ? ORDER BY created_at`,
          )
            .bind(runId)
            .all(),
          env.DB.prepare(
            `SELECT id, turn_number, tool_name, status, started_at, finished_at
               FROM tool_calls WHERE run_id = ? ORDER BY started_at`,
          )
            .bind(runId)
            .all(),
        ]);
        if (!run) return jsonResponse({ error: "run_not_found", run_id: runId }, { status: 404 });
        return jsonResponse({
          run: {
            ...run,
            token_usage: safeJsonParse<unknown>(run.token_usage_json as string | null, null),
          },
          events: events.results ?? [],
          tool_calls: toolCalls.results ?? [],
        });
      }

      if (url.pathname === "/api/v1/runs") {
        if (req.method !== "GET") return methodNotAllowed(["GET"]);
        const { results } = await env.DB.prepare(
          `SELECT r.id AS id, r.issue_id, r.attempt, r.status, r.adapter_kind,
                  r.started_at, r.finished_at, r.error, r.token_usage_json,
                  i.identifier AS issue_identifier
             FROM runs r
             LEFT JOIN issues i ON i.id = r.issue_id
            WHERE r.archived_at IS NULL
            ORDER BY r.started_at DESC
            LIMIT 50`,
        ).all<Record<string, unknown>>();
        return jsonResponse({ runs: results ?? [] });
      }

      const projectAction = url.pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/([^/]+)\/actions\/(pause|resume|drain)$/,
      );
      if (projectAction) {
        if (req.method !== "POST") return methodNotAllowed(["POST"]);
        const [, tenantId, slug, action] = projectAction;
        const decidedBy = req.headers.get("x-symphony-operator") ?? null;
        const reason = req.headers.get("x-symphony-reason") ?? undefined;
        try {
          const stub = projectAgentFor(env, tenantId!, slug!);
          let result;
          if (action === "pause") result = await stub.pause(tenantId!, slug!, decidedBy ?? undefined, reason);
          else if (action === "resume") result = await stub.resume(tenantId!, slug!, decidedBy ?? undefined, reason);
          else result = await stub.drain(tenantId!, slug!, decidedBy ?? undefined, reason);
          return jsonResponse({ project: result });
        } catch (e) {
          return jsonResponse({ error: "transition_rejected", message: String((e as Error).message) }, { status: 409 });
        }
      }
    }

    return notFound();
  },
};

async function listTenantsWithAgentState(env: Env) {
  const base = (await listTenants(env)) as Array<{ id: string; [k: string]: unknown }>;
  return Promise.all(
    base.map(async (t) => {
      try {
        const hot = await tenantAgentFor(env, t.id).getStatus(t.id);
        return { ...t, agent: hot };
      } catch (e) {
        return { ...t, agent_error: String((e as Error).message) };
      }
    }),
  );
}

async function listProfilesWithAgentState(env: Env) {
  const base = (await listProfiles(env)) as Array<{ tenant_id: string; slug: string; [k: string]: unknown }>;
  return Promise.all(
    base.map(async (p) => {
      try {
        const hot = await projectAgentFor(env, p.tenant_id, p.slug).getStatus(p.tenant_id, p.slug);
        return { ...p, agent: hot };
      } catch (e) {
        return { ...p, agent_error: String((e as Error).message) };
      }
    }),
  );
}
