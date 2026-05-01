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

interface Env {
  DB: D1Database;
  // Bearer token for the placeholder auth gate. If unset, the Worker fails
  // closed: every authenticated route returns 503.
  OPERATOR_TOKEN?: string;
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

    // ---- gated routes ----
    if (url.pathname.startsWith("/api/v1/")) {
      const denial = checkAuth(req, env);
      if (denial) return denial;

      if (url.pathname === "/api/v1/state") {
        if (req.method !== "GET") return methodNotAllowed(["GET"]);
        const [tenants, profiles] = await Promise.all([listTenants(env), listProfiles(env)]);
        return jsonResponse({
          generated_at: new Date().toISOString(),
          tenants,
          profiles,
        });
      }

      if (url.pathname === "/api/v1/tenants") {
        if (req.method !== "GET") return methodNotAllowed(["GET"]);
        return jsonResponse({ tenants: await listTenants(env) });
      }

      if (url.pathname === "/api/v1/profiles") {
        if (req.method !== "GET") return methodNotAllowed(["GET"]);
        return jsonResponse({ profiles: await listProfiles(env) });
      }
    }

    return notFound();
  },
};
