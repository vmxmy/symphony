// Symphony control-plane Worker entrypoint.
//
// HTTP surface for the Cloudflare-native control plane. Dashboard/read APIs
// aggregate D1 read models; mutating routes call Durable Object agents.
//
// Auth model in this commit: a single shared bearer token kept in the Worker
// secret OPERATOR_TOKEN. This is a placeholder for the proper Cloudflare
// Access JWT validation that comes with the Phase 8 OperatorAgent /
// dashboard work; the token stub keeps the surface gated while the Access
// application is configured. Public routes (`/` banner, `/api/v1/healthz`)
// are deliberately unauthenticated.
//
// Real Cloudflare Access JWT validation lands later; route handlers already
// authorize against an operator-principal shim so the auth provider can swap
// without changing each route.

import { TenantAgent } from "./agents/tenant.js";
import { ProjectAgent } from "./agents/project.js";
import { IssueAgent } from "./agents/issue.js";
import { ExecutionWorkflow } from "./workflows/execution.js";
import type { ExecutionWorkflowParams } from "./workflows/execution.js";
import { GenericTicketWorkflow } from "./workflows/generic_ticket.js";
import type { GenericTicketWorkflowParams } from "./workflows/generic_ticket.js";
import { executeMockRun } from "./orchestration/mock_run.js";
import { renderDashboard, renderRunDetail } from "./dashboard/render.js";
import type { DashboardState, ProfileView, RetryView, TenantView } from "./dashboard/render.js";
import { renderApprovalCenter, renderTicketDetail, renderTicketInbox } from "./dashboard/control_center.js";
import { loadApprovalCenter, loadTicketDetail, loadTicketInbox } from "./dashboard/control_center_data.js";
import {
  authenticateOperator,
  requireCapability,
  sessionCookieHeader,
  sessionClearCookieHeader,
} from "./auth/operator.js";
import { LinearGraphqlClient } from "./tracker/linear.js";
import type { LinearTrackerConfig } from "./tracker/types.js";
import { extractLinearTrackerConfig } from "./tracker/config.js";
import { assertControlPlaneId, durableObjectName } from "./identity.js";
import { runScheduledPoll, enqueueScheduledPolls } from "./orchestration/scheduled_poll.js";
import { handleTicketApiV2 } from "./tickets/api.js";
import { handleTrackerRefresh, handleIssueDispatch } from "./queues/handlers.js";
import { parseRuntimeConfig } from "./runtime/factory.js";
import type {
  TrackerRefreshMessage,
  IssueDispatchMessage,
  SymphonyQueueMessage,
} from "./queues/types.js";

export { TenantAgent, ProjectAgent, IssueAgent, ExecutionWorkflow, GenericTicketWorkflow };

interface Env {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  TENANT_AGENT: DurableObjectNamespace<TenantAgent>;
  PROJECT_AGENT: DurableObjectNamespace<ProjectAgent>;
  ISSUE_AGENT: DurableObjectNamespace<IssueAgent>;
  EXECUTION_WORKFLOW: Workflow<ExecutionWorkflowParams>;
  GENERIC_TICKET_WORKFLOW: Workflow<GenericTicketWorkflowParams>;
  // Bearer token for the placeholder auth gate. If unset, the Worker fails
  // closed: every authenticated route returns 503.
  OPERATOR_TOKEN?: string;
  // Linear API key (single-tenant for Phase 3 first cut; per-tenant
  // secrets land with Phase 8 ToolGatewayAgent).
  LINEAR_API_KEY?: string;
  // Cloudflare Queue producer binding for tracker.refresh fan-out
  // (cron path). Sync /refresh routes bypass the queue.
  TRACKER_EVENTS: Queue<TrackerRefreshMessage>;
  // Phase 4 sub-cut 2: dispatch queue. Tracker-events consumer enqueues
  // one issue.dispatch per dispatch decision; consumer transitions
  // IssueAgent into `queued`.
  DISPATCH: Queue<IssueDispatchMessage>;
}

function tenantAgentFor(env: Env, tenantId: string) {
  const id = env.TENANT_AGENT.idFromName(durableObjectName("tenant", tenantId));
  return env.TENANT_AGENT.get(id);
}

function projectAgentFor(env: Env, tenantId: string, slug: string) {
  const id = env.PROJECT_AGENT.idFromName(durableObjectName("project", tenantId, slug));
  return env.PROJECT_AGENT.get(id);
}

function issueAgentFor(env: Env, tenantId: string, slug: string, externalId: string) {
  const id = env.ISSUE_AGENT.idFromName(
    durableObjectName("issue", tenantId, slug, externalId),
  );
  return env.ISSUE_AGENT.get(id);
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

type TenantPolicy = { maxProjects?: number; maxRunningIssues?: number };

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

function notFound(): Response {
  return jsonResponse({ error: "not_found" }, { status: 404 });
}

function methodNotAllowed(allowed: string[]): Response {
  return jsonResponse(
    { error: "method_not_allowed", allowed },
    { status: 405, headers: { allow: allowed.join(", ") } },
  );
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function listTenants(env: Env): Promise<TenantView[]> {
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
    policy: safeJsonParse<TenantPolicy>(row.policy_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

async function listProfiles(env: Env): Promise<ProfileView[]> {
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

async function readiness(env: Env): Promise<{ ready: boolean; db: { ok: boolean; message?: string }; operatorToken: boolean }> {
  const db = await probeDbReady(env);
  const operatorToken = Boolean(env.OPERATOR_TOKEN);
  return { ready: db.ok && operatorToken, db, operatorToken };
}

function tenantScopeFromRequest(
  url: URL,
  principal: { tenantId: string | null },
): { ok: true; tenantId: string } | { ok: false; response: Response } {
  const queryTenantId = url.searchParams.get("tenantId")?.trim() ?? null;
  if (principal.tenantId && queryTenantId && principal.tenantId !== queryTenantId) {
    return { ok: false, response: new Response("tenant forbidden", { status: 403 }) };
  }
  const tenantId = principal.tenantId ?? queryTenantId;
  if (!tenantId) return { ok: false, response: new Response("missing tenantId", { status: 400 }) };
  return { ok: true, tenantId };
}

async function loadDashboardState(env: Env): Promise<DashboardState> {
  const [tenants, profiles, runsRes, issuesRes, retriesRes] = await Promise.all([
    listTenants(env),
    listProfiles(env),
    env.DB.prepare(
      `SELECT r.id, r.issue_id, r.attempt, r.status, r.adapter_kind,
              r.started_at, r.finished_at, r.error, r.token_usage_json,
              i.identifier AS issue_identifier
         FROM runs r
         LEFT JOIN issues i ON i.id = r.issue_id
        WHERE r.archived_at IS NULL
        ORDER BY r.started_at DESC
        LIMIT 20`,
    ).all<NonNullable<DashboardState["runs"]>[number]>(),
    env.DB.prepare(
      `SELECT i.id, i.identifier, i.title, i.state, i.url,
              i.last_seen_at, p.slug AS profile_slug
         FROM issues i
         LEFT JOIN profiles p ON p.id = i.profile_id
        WHERE i.archived_at IS NULL
        ORDER BY i.last_seen_at DESC
        LIMIT 50`,
    ).all<NonNullable<DashboardState["issues"]>[number]>(),
    env.DB.prepare(
      `SELECT COALESCE(i.identifier, r.external_id) AS identifier,
              CASE WHEN r.due_at IS NULL OR r.due_at = '' THEN 'failed' ELSE 'retry_wait' END AS status,
              r.attempt, r.due_at, r.last_error
         FROM issue_retries r
         LEFT JOIN issues i ON i.id = r.issue_id
        ORDER BY
              CASE WHEN r.due_at IS NULL OR r.due_at = '' THEN 1 ELSE 0 END,
              r.due_at ASC,
              r.updated_at DESC
        LIMIT 50`,
    ).all<RetryView>(),
  ]);

  return {
    generated_at: new Date().toISOString(),
    tenants,
    profiles,
    runs: runsRes.results ?? [],
    issues: issuesRes.results ?? [],
    retries: retriesRes.results ?? [],
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // ---- public routes (no auth) ----
    if (req.method === "GET" && url.pathname === "/") {
      return new Response(
        "symphony-control-plane: GET /api/v1/healthz | /api/v1/readyz | " +
          "/api/v1/state | /api/v1/tenants | /api/v1/profiles | /dashboard\n",
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    if (url.pathname === "/api/v1/healthz") {
      if (req.method !== "GET") return methodNotAllowed(["GET"]);
      const { ready, db, operatorToken } = await readiness(env);
      if (!db.ok) console.error(`[healthz] db probe failed: ${db.message ?? "unknown"}`);
      return jsonResponse(
        {
          status: ready ? "ok" : "degraded",
          checks: {
            db: db.ok ? "ok" : "down",
            operator_token: operatorToken ? "configured" : "missing",
          },
        },
        { status: ready ? 200 : 503 },
      );
    }

    if (url.pathname === "/api/v1/readyz") {
      if (req.method !== "GET") return methodNotAllowed(["GET"]);
      const { ready, db, operatorToken } = await readiness(env);
      if (!db.ok) console.error(`[readyz] db probe failed: ${db.message ?? "unknown"}`);
      return jsonResponse(
        {
          status: ready ? "ok" : "degraded",
          checks: {
            db: db.ok ? "ok" : "down",
            operator_token: operatorToken ? "configured" : "missing",
          },
        },
        { status: ready ? 200 : 503 },
      );
    }

    if (url.pathname === "/dashboard") {
      if (req.method !== "GET") return methodNotAllowed(["GET"]);
      const session = await authenticateOperator(req, env.OPERATOR_TOKEN, {
        allowCookie: true,
        allowQuery: true,
        jsonErrors: false,
      });
      if (!session.ok) return session.response;
      const denied = requireCapability(session.principal, "read:dashboard");
      if (denied) return denied;
      // First-touch query path: upgrade to cookie + clean URL.
      if (session.principal.sessionSource === "query") {
        return new Response(null, {
          status: 302,
          headers: {
            location: "/dashboard",
            "set-cookie": await sessionCookieHeader(env.OPERATOR_TOKEN!),
          },
        });
      }
      const html = renderDashboard(await loadDashboardState(env));
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    const ticketDetailPage = url.pathname.match(/^\/tickets\/([^/]+)$/);
    if (url.pathname === "/tickets" || url.pathname === "/approvals" || ticketDetailPage) {
      if (req.method !== "GET") return methodNotAllowed(["GET"]);
      const session = await authenticateOperator(req, env.OPERATOR_TOKEN, {
        allowCookie: true,
        allowQuery: true,
        jsonErrors: false,
      });
      if (!session.ok) return session.response;
      const denied = requireCapability(session.principal, "ticket.read");
      if (denied) return denied;
      if (session.principal.sessionSource === "query") {
        const redirectUrl = new URL(req.url);
        redirectUrl.searchParams.delete("token");
        return new Response(null, {
          status: 302,
          headers: {
            location: redirectUrl.pathname + redirectUrl.search,
            "set-cookie": await sessionCookieHeader(env.OPERATOR_TOKEN!),
          },
        });
      }

      const tenantScope = tenantScopeFromRequest(url, session.principal);
      if (!tenantScope.ok) return tenantScope.response;
      const { tenantId } = tenantScope;

      const generatedAt = new Date().toISOString();
      if (url.pathname === "/tickets") {
        const html = renderTicketInbox(await loadTicketInbox(env.DB, tenantId, generatedAt));
        return new Response(html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/approvals") {
        const html = renderApprovalCenter(await loadApprovalCenter(env.DB, tenantId, generatedAt));
        return new Response(html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      const detail = await loadTicketDetail(env.DB, tenantId, decodeURIComponent(ticketDetailPage![1]!), generatedAt);
      if (!detail) return notFound();
      return new Response(renderTicketDetail(detail), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // Per-run dashboard view (Phase 5 PR-D). Read-only — operator actions
    // stay on the Bearer-protected /api/v1/runs/.../actions/cancel route.
    const dashboardRun = url.pathname.match(
      /^\/dashboard\/runs\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/,
    );
    if (dashboardRun) {
      if (req.method !== "GET") return methodNotAllowed(["GET"]);
      const session = await authenticateOperator(req, env.OPERATOR_TOKEN, {
        allowCookie: true,
        allowQuery: true,
        jsonErrors: false,
      });
      if (!session.ok) return session.response;
      const denied = requireCapability(session.principal, "read:dashboard");
      if (denied) return denied;
      if (session.principal.sessionSource === "query") {
        return new Response(null, {
          status: 302,
          headers: {
            location: url.pathname,
            "set-cookie": await sessionCookieHeader(env.OPERATOR_TOKEN!),
          },
        });
      }
      const [, tenantId, slug, externalId, attemptStr] = dashboardRun;
      const attempt = Number(attemptStr);
      if (!Number.isFinite(attempt)) {
        return new Response("invalid attempt", { status: 400 });
      }
      const runId = `run:${tenantId}:${slug}:${externalId}:${attempt}`;
      const [run, steps, events, profileRow] = await Promise.all([
        env.DB.prepare(
          `SELECT r.id, r.issue_id, r.attempt, r.status, r.workflow_id, r.adapter_kind,
                  r.started_at, r.finished_at, r.error, r.token_usage_json,
                  r.artifact_manifest_ref,
                  i.identifier AS issue_identifier
             FROM runs r
             LEFT JOIN issues i ON i.id = r.issue_id
            WHERE r.id = ?`,
        )
          .bind(runId)
          .first<Record<string, unknown>>(),
        env.DB.prepare(
          `SELECT step_sequence, step_name, status, started_at, finished_at, error
             FROM run_steps WHERE run_id = ? ORDER BY step_sequence`,
        )
          .bind(runId)
          .all<{
            step_sequence: number;
            step_name: string;
            status: string;
            started_at: string;
            finished_at: string | null;
            error: string | null;
          }>(),
        env.DB.prepare(
          `SELECT id, event_type, severity, message, created_at
             FROM run_events WHERE run_id = ? ORDER BY id ASC LIMIT 200`,
        )
          .bind(runId)
          .all<{
            id: string;
            event_type: string;
            severity: string;
            message: string | null;
            created_at: string;
          }>(),
        env.DB.prepare(
          `SELECT config_json FROM profiles WHERE id = ?`,
        ).bind(`${tenantId}/${slug}`).first<{ config_json: string | null }>(),
      ]);
      if (!run) {
        return new Response(`run not found: ${runId}`, { status: 404 });
      }
      const runtime = parseRuntimeConfig(profileRow?.config_json ?? null);
      const html = renderRunDetail({
        generated_at: new Date().toISOString(),
        run: {
          id: run.id as string,
          issue_id: run.issue_id as string,
          issue_identifier: (run.issue_identifier as string | null) ?? null,
          attempt: run.attempt as number,
          status: run.status as string,
          workflow_id: (run.workflow_id as string | null) ?? null,
          adapter_kind: run.adapter_kind as string,
          started_at: run.started_at as string,
          finished_at: (run.finished_at as string | null) ?? null,
          error: (run.error as string | null) ?? null,
          token_usage_json: (run.token_usage_json as string | null) ?? null,
          artifact_manifest_ref: (run.artifact_manifest_ref as string | null) ?? null,
          tenant_id: tenantId!,
          slug: slug!,
          external_id: externalId!,
        },
        steps: steps.results ?? [],
        events: events.results ?? [],
        runtime,
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
    if (url.pathname.startsWith("/api/v2/")) {
      const auth = await authenticateOperator(req, env.OPERATOR_TOKEN);
      if (!auth.ok) return auth.response;
      return await handleTicketApiV2(req, env.DB, auth.principal);
    }

    if (url.pathname.startsWith("/api/v1/")) {
      const auth = await authenticateOperator(req, env.OPERATOR_TOKEN);
      if (!auth.ok) return auth.response;
      const { principal } = auth;

      if (url.pathname === "/api/v1/state") {
        if (req.method !== "GET") return methodNotAllowed(["GET"]);
        const denied = requireCapability(principal, "read:state");
        if (denied) return denied;
        const [tenants, profiles] = await Promise.all([listTenants(env), listProfiles(env)]);
        return jsonResponse({
          generated_at: new Date().toISOString(),
          tenants,
          profiles,
        });
      }

      if (url.pathname === "/api/v1/tenants") {
        if (req.method !== "GET") return methodNotAllowed(["GET"]);
        const denied = requireCapability(principal, "read:state");
        if (denied) return denied;
        return jsonResponse({ tenants: await listTenants(env) });
      }

      if (url.pathname === "/api/v1/profiles") {
        if (req.method !== "GET") return methodNotAllowed(["GET"]);
        const denied = requireCapability(principal, "read:state");
        if (denied) return denied;
        return jsonResponse({ profiles: await listProfiles(env) });
      }

      // ---- operator transition routes -------------------------------
      const tenantAction = url.pathname.match(
        /^\/api\/v1\/tenants\/([^/]+)\/actions\/(pause|resume|suspend)$/,
      );
      if (tenantAction) {
        if (req.method !== "POST") return methodNotAllowed(["POST"]);
        const [, tenantId, action] = tenantAction;
        const denied = requireCapability(principal, "write:tenant.transition");
        if (denied) return denied;
        try {
          assertControlPlaneId("tenant", tenantId!);
        } catch (e) {
          return jsonResponse({ error: "invalid_tenant_id", message: String((e as Error).message) }, { status: 400 });
        }
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

      // ---- tracker debug routes (Phase 3 US-002) ------------------------
      const trackerProbe = url.pathname.match(
        /^\/api\/v1\/profiles\/([^/]+)\/([^/]+)\/tracker\/(active|terminal)$/,
      );
      if (trackerProbe) {
        if (req.method !== "GET") return methodNotAllowed(["GET"]);
        const [, tenantId, slug, kind] = trackerProbe;
        const denied = requireCapability(principal, "read:state");
        if (denied) return denied;
        try {
          assertControlPlaneId("tenant", tenantId!);
          assertControlPlaneId("profile", slug!);
        } catch (e) {
          return jsonResponse({ error: "invalid_profile_id", message: String((e as Error).message) }, { status: 400 });
        }
        const cfg = await loadLinearTrackerConfig(env, tenantId!, slug!);
        if (!cfg.ok) {
          return jsonResponse(
            { error: cfg.error, detail: cfg.detail ?? null },
            { status: cfg.status },
          );
        }
        try {
          const client = new LinearGraphqlClient(cfg.config);
          const issues =
            kind === "active"
              ? await client.fetchActiveIssues()
              : await client.fetchTerminalIssues();
          return jsonResponse({
            count: issues.length,
            kind,
            tenant: tenantId,
            slug,
            issues: issues.map(shapeIssueForDebug),
          });
        } catch (e) {
          return jsonResponse(
            { error: "linear_fetch_failed", detail: String((e as Error).message) },
            { status: 502 },
          );
        }
      }

      // ---- runtime config route (Phase 6 PR-E-1) -----------------------
      const profileRuntime = url.pathname.match(
        /^\/api\/v1\/profiles\/([^/]+)\/([^/]+)\/runtime$/,
      );
      if (profileRuntime) {
        if (req.method !== "GET") return methodNotAllowed(["GET"]);
        const [, tenantId, slug] = profileRuntime;
        const denied = requireCapability(principal, "read:state");
        if (denied) return denied;
        try {
          assertControlPlaneId("tenant", tenantId!);
          assertControlPlaneId("profile", slug!);
        } catch (e) {
          return jsonResponse(
            { error: "invalid_profile_id", message: String((e as Error).message) },
            { status: 400 },
          );
        }
        const profileId = `${tenantId}/${slug}`;
        const row = await env.DB.prepare(
          `SELECT config_json FROM profiles WHERE id = ?`,
        )
          .bind(profileId)
          .first<{ config_json: string | null }>();
        if (!row) {
          return jsonResponse({ error: "profile_not_found" }, { status: 404 });
        }
        const runtime = parseRuntimeConfig(row.config_json);
        return jsonResponse({ runtime });
      }

      // ---- mock orchestration (Phase 2 last cut; Phase 3 replaces) ----
      const mockRun = url.pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/([^/]+)\/issues\/([^/]+)\/actions\/mock-run$/,
      );
      if (mockRun) {
        if (req.method !== "POST") return methodNotAllowed(["POST"]);
        const [, tenantId, slug, identifier] = mockRun;
        const denied = requireCapability(principal, "write:run.mock");
        if (denied) return denied;
        try {
          assertControlPlaneId("tenant", tenantId!);
          assertControlPlaneId("profile", slug!);
          assertControlPlaneId("issue", identifier!);
        } catch (e) {
          return jsonResponse({ error: "invalid_mock_run_id", message: String((e as Error).message) }, { status: 400 });
        }
        const profileRow = await env.DB.prepare(
          `SELECT p.id, p.tenant_id, p.slug, p.status, t.status AS tenant_status
             FROM profiles p
             JOIN tenants t ON t.id = p.tenant_id AND t.archived_at IS NULL
            WHERE p.tenant_id = ? AND p.slug = ? AND p.archived_at IS NULL`,
        )
          .bind(tenantId!, slug!)
          .first<{ id: string; tenant_id: string; slug: string; status: string; tenant_status: string }>();
        if (!profileRow) {
          return jsonResponse({ error: "profile_not_found", tenant: tenantId, slug }, { status: 404 });
        }
        if (profileRow.tenant_status !== "active") {
          return jsonResponse({ error: "tenant_not_active", status: profileRow.tenant_status }, { status: 409 });
        }
        if (profileRow.status !== "active") {
          return jsonResponse({ error: "project_not_active", status: profileRow.status }, { status: 409 });
        }
        const result = await executeMockRun(env, {
          profile: profileRow,
          issueIdentifier: identifier!,
        });
        return jsonResponse({ run: result });
      }

      // ---- per-run operator surface (Phase 5 PR-D) ---------------------
      // Run IDs are constructed by ExecutionWorkflow as
      // `run:{tenant}:{slug}:{external_id}:{attempt}`; the per-run routes
      // accept the four positional parts so operators do not have to URL-
      // encode the colon-delimited id.
      const runState = url.pathname.match(
        /^\/api\/v1\/runs\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/state$/,
      );
      if (runState) {
        if (req.method !== "GET") return methodNotAllowed(["GET"]);
        const denied = requireCapability(principal, "read:state");
        if (denied) return denied;
        const [, tenantId, slug, externalId, attemptStr] = runState;
        const attempt = Number(attemptStr);
        if (!Number.isFinite(attempt)) {
          return jsonResponse({ error: "invalid_attempt" }, { status: 400 });
        }
        const runId = `run:${tenantId}:${slug}:${externalId}:${attempt}`;
        const profileId = `${tenantId}/${slug}`;
        const [run, steps, profileRow] = await Promise.all([
          env.DB.prepare(
            `SELECT id, issue_id, attempt, status, workflow_id, adapter_kind,
                    started_at, finished_at, error, token_usage_json,
                    artifact_manifest_ref
               FROM runs WHERE id = ?`,
          )
            .bind(runId)
            .first<Record<string, unknown>>(),
          env.DB.prepare(
            `SELECT step_sequence, step_name, status, started_at, finished_at, error
               FROM run_steps WHERE run_id = ? ORDER BY step_sequence`,
          )
            .bind(runId)
            .all<{
              step_sequence: number;
              step_name: string;
              status: string;
              started_at: string;
              finished_at: string | null;
              error: string | null;
            }>(),
          env.DB.prepare(
            `SELECT config_json FROM profiles WHERE id = ?`,
          )
            .bind(profileId)
            .first<{ config_json: string | null }>(),
        ]);
        if (!run) {
          return jsonResponse({ error: "run_not_found", run_id: runId }, { status: 404 });
        }
        const runtime = parseRuntimeConfig(profileRow?.config_json ?? null);
        return jsonResponse({
          run: {
            ...run,
            token_usage: safeJsonParse<unknown>(run.token_usage_json as string | null, null),
          },
          steps: steps.results ?? [],
          runtime,
        });
      }

      const runCancel = url.pathname.match(
        /^\/api\/v1\/runs\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/actions\/cancel$/,
      );
      if (runCancel) {
        if (req.method !== "POST") return methodNotAllowed(["POST"]);
        const denied = requireCapability(principal, "write:run.cancel");
        if (denied) return denied;
        const [, tenantId, slug, externalId, attemptStr] = runCancel;
        const attempt = Number(attemptStr);
        if (!Number.isFinite(attempt)) {
          return jsonResponse({ error: "invalid_attempt" }, { status: 400 });
        }
        try {
          assertControlPlaneId("tenant", tenantId!);
          assertControlPlaneId("profile", slug!);
          assertControlPlaneId("issue", externalId!);
        } catch (e) {
          return jsonResponse(
            { error: "invalid_id", message: String((e as Error).message) },
            { status: 400 },
          );
        }
        const runId = `run:${tenantId}:${slug}:${externalId}:${attempt}`;
        const run = await env.DB.prepare(
          `SELECT status, workflow_id FROM runs WHERE id = ?`,
        )
          .bind(runId)
          .first<{ status: string; workflow_id: string | null }>();
        if (!run) {
          return jsonResponse({ error: "run_not_found", run_id: runId }, { status: 404 });
        }
        if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
          return jsonResponse(
            { error: "run_already_terminal", status: run.status },
            { status: 409 },
          );
        }
        // Best-effort terminate the workflow instance, then notify the
        // IssueAgent. Phase 5 mock — terminate may be a no-op locally; the
        // run row + IssueAgent state are the durable side of the cancel.
        if (run.workflow_id) {
          try {
            const instance = await env.EXECUTION_WORKFLOW.get(run.workflow_id);
            await instance.terminate();
          } catch {
            /* best-effort; D1 + DO writes below are durable */
          }
        }
        const issueId = env.ISSUE_AGENT.idFromName(
          durableObjectName("issue", tenantId!, slug!, externalId!),
        );
        const stub = env.ISSUE_AGENT.get(issueId) as unknown as {
          onRunFinished: (
            t: string,
            s: string,
            e: string,
            outcome: "completed" | "failed" | "cancelled" | "retry",
          ) => Promise<unknown>;
        };
        try {
          await stub.onRunFinished(tenantId!, slug!, externalId!, "cancelled");
        } catch {
          /* swallow; the runs row update below is the source of truth */
        }
        const now = new Date().toISOString();
        await env.DB.prepare(
          `UPDATE runs SET status = 'cancelled', finished_at = ? WHERE id = ?`,
        )
          .bind(now, runId)
          .run();
        return jsonResponse({ run_id: runId, status: "cancelled" });
      }

      const runEvents = url.pathname.match(
        /^\/api\/v1\/runs\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/events$/,
      );
      if (runEvents) {
        if (req.method !== "GET") return methodNotAllowed(["GET"]);
        const denied = requireCapability(principal, "read:state");
        if (denied) return denied;
        const [, tenantId, slug, externalId, attemptStr] = runEvents;
        const attempt = Number(attemptStr);
        if (!Number.isFinite(attempt)) {
          return jsonResponse({ error: "invalid_attempt" }, { status: 400 });
        }
        const runId = `run:${tenantId}:${slug}:${externalId}:${attempt}`;
        const after = url.searchParams.get("after");
        const limitParam = Number(url.searchParams.get("limit") ?? "100");
        const limit = Number.isFinite(limitParam) ? Math.min(Math.max(1, limitParam), 500) : 100;
        const params: unknown[] = [runId];
        let where = `WHERE run_id = ?`;
        if (after) {
          where += ` AND id > ?`;
          params.push(after);
        }
        const { results } = await env.DB.prepare(
          `SELECT id, event_type, severity, message, payload_ref, created_at
             FROM run_events ${where}
             ORDER BY id ASC LIMIT ?`,
        )
          .bind(...params, limit)
          .all<Record<string, unknown>>();
        const rows = results ?? [];
        const nextCursor = rows.length === limit ? (rows[rows.length - 1]?.id ?? null) : null;
        return jsonResponse({ data: rows, next_cursor: nextCursor });
      }

      // ---- run inspection (legacy single-id form) -----------------------
      const runDetail = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)$/);
      if (runDetail) {
        if (req.method !== "GET") return methodNotAllowed(["GET"]);
        const denied = requireCapability(principal, "read:state");
        if (denied) return denied;
        const runId = runDetail[1]!;
        const [run, steps, events, toolCalls] = await Promise.all([
          env.DB.prepare(
            `SELECT id, issue_id, attempt, status, adapter_kind,
                    started_at, finished_at, error, token_usage_json
               FROM runs WHERE id = ?`,
          )
            .bind(runId)
            .first<Record<string, unknown>>(),
          env.DB.prepare(
            `SELECT id, step_name, step_sequence, status, started_at, finished_at, input_ref, output_ref, error
               FROM run_steps WHERE run_id = ? AND archived_at IS NULL ORDER BY step_sequence`,
          )
            .bind(runId)
            .all(),
          env.DB.prepare(
            `SELECT id, event_type, severity, message, payload_ref, created_at
               FROM run_events WHERE run_id = ? AND archived_at IS NULL ORDER BY created_at`,
          )
            .bind(runId)
            .all(),
          env.DB.prepare(
            `SELECT id, turn_number, tool_name, status, input_ref, output_ref, started_at, finished_at
               FROM tool_calls WHERE run_id = ? AND archived_at IS NULL ORDER BY started_at`,
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
          steps: steps.results ?? [],
          events: events.results ?? [],
          tool_calls: toolCalls.results ?? [],
        });
      }

      if (url.pathname === "/api/v1/runs") {
        if (req.method !== "GET") return methodNotAllowed(["GET"]);
        const denied = requireCapability(principal, "read:state");
        if (denied) return denied;
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

      // ---- refresh: tracker poll + reconcile + D1 mirror (Phase 3 US-004) ----
      const refresh = url.pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/([^/]+)\/actions\/refresh$/,
      );
      if (refresh) {
        if (req.method !== "POST") return methodNotAllowed(["POST"]);
        const [, tenantId, slug] = refresh;
        const denied = requireCapability(principal, "write:project.refresh");
        if (denied) return denied;
        try {
          assertControlPlaneId("tenant", tenantId!);
          assertControlPlaneId("profile", slug!);
        } catch (e) {
          return jsonResponse({ error: "invalid_profile_id", message: String((e as Error).message) }, { status: 400 });
        }
        try {
          const stub = projectAgentFor(env, tenantId!, slug!);
          const result = await stub.poll(tenantId!, slug!);
          return jsonResponse(result);
        } catch (e) {
          const msg = String((e as Error).message);
          const status =
            msg.startsWith("profile_not_found") ? 404
            : msg.startsWith("tenant_not_found") ? 404
            : msg.startsWith("project_not_found") ? 404
            : msg.startsWith("tenant_not_active") ? 409
            : msg.startsWith("project_not_active") ? 409
            : msg.startsWith("linear_api_key_unset") ? 500
            : msg.startsWith("tracker_kind_unsupported") ? 400
            : msg.startsWith("tracker_config_incomplete") ? 500
            : 502;
          return jsonResponse({ error: "refresh_failed", message: msg }, { status });
        }
      }

      const projectAction = url.pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/([^/]+)\/actions\/(pause|resume|drain)$/,
      );
      if (projectAction) {
        if (req.method !== "POST") return methodNotAllowed(["POST"]);
        const [, tenantId, slug, action] = projectAction;
        const denied = requireCapability(principal, "write:project.transition");
        if (denied) return denied;
        try {
          assertControlPlaneId("tenant", tenantId!);
          assertControlPlaneId("profile", slug!);
        } catch (e) {
          return jsonResponse({ error: "invalid_profile_id", message: String((e as Error).message) }, { status: 400 });
        }
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

      // ---- IssueAgent state + transitions (Phase 4 sub-cut 1) ----
      // GET  /api/v1/issues/:tenant/:slug/:external_id/state
      // POST /api/v1/issues/:tenant/:slug/:external_id/actions/{dispatch,pause,resume,cancel}
      const issueState = url.pathname.match(
        /^\/api\/v1\/issues\/([^/]+)\/([^/]+)\/([^/]+)\/state$/,
      );
      if (issueState) {
        if (req.method !== "GET") return methodNotAllowed(["GET"]);
        const denied = requireCapability(principal, "read:state");
        if (denied) return denied;
        const [, tenantId, slug, externalId] = issueState;
        try {
          const stub = issueAgentFor(env, tenantId!, slug!, externalId!);
          const state = await stub.getStatus(tenantId!, slug!, externalId!);
          return jsonResponse({ issue: state });
        } catch (e) {
          return jsonResponse(
            { error: "issue_state_failed", message: String((e as Error).message) },
            { status: 500 },
          );
        }
      }

      const issueRetryNow = url.pathname.match(
        /^\/api\/v1\/issues\/([^/]+)\/([^/]+)\/([^/]+)\/actions\/retry-now$/,
      );
      if (issueRetryNow) {
        if (req.method !== "POST") return methodNotAllowed(["POST"]);
        const denied = requireCapability(principal, "write:issue.transition");
        if (denied) return denied;
        const [, tenantId, slug, externalId] = issueRetryNow;
        try {
          const stub = issueAgentFor(env, tenantId!, slug!, externalId!);
          const state = await stub.retryNow(
            tenantId!,
            slug!,
            externalId!,
            principal.subject,
            "operator-retry-now",
          );
          const message: IssueDispatchMessage = {
            kind: "issue.dispatch",
            version: 1,
            tenant_id: tenantId!,
            slug: slug!,
            external_id: externalId!,
            identifier: externalId!,
            attempt: state.attempt,
            scheduled_at: new Date().toISOString(),
          };
          await env.DISPATCH.send(message);
          return jsonResponse({ state });
        } catch (e) {
          const msg = String((e as Error).message);
          return jsonResponse(
            { error: "issue_retry_now_rejected", message: msg },
            { status: msg.startsWith("issue_retrynow_invalid_state") ? 400 : 409 },
          );
        }
      }

      const issueAction = url.pathname.match(
        /^\/api\/v1\/issues\/([^/]+)\/([^/]+)\/([^/]+)\/actions\/(dispatch|pause|resume|cancel)$/,
      );
      if (issueAction) {
        if (req.method !== "POST") return methodNotAllowed(["POST"]);
        const denied = requireCapability(principal, "write:issue.transition");
        if (denied) return denied;
        const [, tenantId, slug, externalId, action] = issueAction;
        const decidedBy = req.headers.get("x-symphony-operator") ?? undefined;
        const reason = req.headers.get("x-symphony-reason") ?? undefined;
        try {
          const stub = issueAgentFor(env, tenantId!, slug!, externalId!);
          let result;
          if (action === "dispatch") result = await stub.dispatch(tenantId!, slug!, externalId!, decidedBy, reason);
          else if (action === "pause") result = await stub.pause(tenantId!, slug!, externalId!, decidedBy, reason);
          else if (action === "resume") result = await stub.resume(tenantId!, slug!, externalId!, decidedBy, reason);
          else result = await stub.cancel(tenantId!, slug!, externalId!, decidedBy, reason);
          return jsonResponse({ issue: result });
        } catch (e) {
          return jsonResponse(
            { error: "issue_transition_rejected", message: String((e as Error).message) },
            { status: 409 },
          );
        }
      }

      // ---- admin: synchronous fan-out poll (bypasses queue) ----
      // Same poll path the cron trigger used to use directly. After Phase 3
      // queue migration the cron path enqueues; this route stays sync so
      // operators get immediate feedback. Reuses write:project.refresh.
      if (url.pathname === "/api/v1/admin/run-scheduled") {
        if (req.method !== "POST") return methodNotAllowed(["POST"]);
        const denied = requireCapability(principal, "write:project.refresh");
        if (denied) return denied;
        const summary = await runScheduledPoll(env);
        return jsonResponse(summary);
      }

      // ---- admin: enqueue scheduled polls via the queue (test the
      // cron-equivalent path on demand) ----
      if (url.pathname === "/api/v1/admin/enqueue-scheduled") {
        if (req.method !== "POST") return methodNotAllowed(["POST"]);
        const denied = requireCapability(principal, "write:project.refresh");
        if (denied) return denied;
        const summary = await enqueueScheduledPolls(env);
        return jsonResponse(summary);
      }

      // ---- admin: enqueue a single issue.dispatch message (test the
      // dispatch queue path without needing a real active tracker issue) ----
      // Body: { tenant_id, slug, external_id, identifier?, attempt? }
      if (url.pathname === "/api/v1/admin/enqueue-dispatch") {
        if (req.method !== "POST") return methodNotAllowed(["POST"]);
        const denied = requireCapability(principal, "write:issue.transition");
        if (denied) return denied;
        let body: Partial<IssueDispatchMessage> = {};
        try {
          body = (await req.json()) as Partial<IssueDispatchMessage>;
        } catch {
          return jsonResponse({ error: "bad_json" }, { status: 400 });
        }
        if (!body.tenant_id || !body.slug || !body.external_id) {
          return jsonResponse(
            { error: "missing_fields", required: ["tenant_id", "slug", "external_id"] },
            { status: 400 },
          );
        }
        const message: IssueDispatchMessage = {
          kind: "issue.dispatch",
          version: 1,
          tenant_id: body.tenant_id,
          slug: body.slug,
          external_id: body.external_id,
          identifier: body.identifier ?? body.external_id,
          attempt: body.attempt ?? 1,
          scheduled_at: new Date().toISOString(),
        };
        await env.DISPATCH.send(message);
        return jsonResponse({ enqueued: true, message });
      }

      // ---- admin: enqueue a synthetic issue failure (Phase 4 PR-C test seam) ----
      // Body: { tenant_id, slug, external_id, error?, attempt? }
      if (url.pathname === "/api/v1/admin/inject-failure") {
        if (req.method !== "POST") return methodNotAllowed(["POST"]);
        const denied = requireCapability(principal, "write:issue.transition");
        if (denied) return denied;
        let body: {
          tenant_id?: unknown;
          slug?: unknown;
          external_id?: unknown;
          error?: unknown;
          attempt?: unknown;
        } = {};
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ error: "bad_json" }, { status: 400 });
        }
        if (
          typeof body.tenant_id !== "string" ||
          typeof body.slug !== "string" ||
          typeof body.external_id !== "string"
        ) {
          return jsonResponse(
            { error: "missing_fields", required: ["tenant_id", "slug", "external_id"] },
            { status: 400 },
          );
        }
        try {
          assertControlPlaneId("tenant", body.tenant_id);
          assertControlPlaneId("profile", body.slug);
          assertControlPlaneId("issue", body.external_id);
        } catch (e) {
          return jsonResponse({ error: "invalid_issue_id", message: String((e as Error).message) }, { status: 400 });
        }
        const attempt =
          typeof body.attempt === "number" && Number.isFinite(body.attempt) ?
            body.attempt
          : 1;
        const message: IssueDispatchMessage = {
          kind: "issue.dispatch",
          version: 2,
          tenant_id: body.tenant_id,
          slug: body.slug,
          external_id: body.external_id,
          identifier: body.external_id,
          attempt,
          scheduled_at: new Date().toISOString(),
          inject_failure: true,
          error: typeof body.error === "string" ? body.error : undefined,
        };
        await env.DISPATCH.send(message);
        return jsonResponse(
          {
            enqueued: true,
            message: {
              kind: message.kind,
              version: message.version,
              tenant_id: message.tenant_id,
              slug: message.slug,
              external_id: message.external_id,
              attempt: message.attempt,
            },
          },
          { status: 202 },
        );
      }
    }

    return notFound();
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Cron trigger fires every 5 minutes (see wrangler.toml [triggers]).
    // Enqueue one TrackerRefreshMessage per active profile so failure
    // isolation, retry, and dead-letter handling are owned by the queue.
    // The queue() handler picks up messages and calls ProjectAgent.poll.
    ctx.waitUntil(
      enqueueScheduledPolls(env).then(
        (summary) => {
          console.log(
            JSON.stringify({
              kind: "scheduled_enqueue",
              ...summary,
            }),
          );
        },
        (err) => {
          console.error(
            JSON.stringify({
              kind: "scheduled_enqueue_error",
              error: String((err as Error)?.message ?? err),
            }),
          );
        },
      ),
    );
  },

  async queue(
    batch: MessageBatch<SymphonyQueueMessage>,
    env: Env,
  ): Promise<void> {
    // Multi-queue consumer. Cloudflare delivers each batch from a single
    // queue (visible on batch.queue); we discriminate by queue name and
    // message body kind. Errors throw → Cloudflare Queues retries up to
    // max_retries then routes to the DLQ.
    for (const message of batch.messages) {
      try {
        if (batch.queue === "symphony-tracker-events" && message.body.kind === "tracker.refresh") {
          const outcome = await handleTrackerRefresh(env, message.body);
          console.log(
            JSON.stringify({
              kind: "tracker_refresh_consumed",
              message_id: message.id,
              attempts: message.attempts,
              ...outcome,
            }),
          );
          message.ack();
          continue;
        }
        if (batch.queue === "symphony-dispatch" && message.body.kind === "issue.dispatch") {
          const outcome = await handleIssueDispatch(env, message.body);
          console.log(
            JSON.stringify({
              kind: "issue_dispatch_consumed",
              message_id: message.id,
              attempts: message.attempts,
              ...outcome,
            }),
          );
          message.ack();
          continue;
        }
        // Unknown queue / kind combination — log and ack to avoid DLQ
        // storms during a rolling deploy with stale messages.
        console.error(
          JSON.stringify({
            kind: "queue_unknown_message",
            queue: batch.queue,
            message_id: message.id,
            body_kind: (message.body as { kind: string }).kind,
          }),
        );
        message.ack();
      } catch (e) {
        console.error(
          JSON.stringify({
            kind: "queue_handler_failed",
            queue: batch.queue,
            message_id: message.id,
            attempts: message.attempts,
            error: String((e as Error)?.message ?? e),
          }),
        );
        message.retry();
      }
    }
  },
};

/**
 * Load a profile from D1 and produce a LinearTrackerConfig for the Worker
 * debug routes. Returns a discriminated union the caller maps to HTTP
 * status; field-level parsing lives in tracker/config.ts so ProjectAgent
 * can share the same canonicalization.
 */
async function loadLinearTrackerConfig(
  env: Env,
  tenantId: string,
  slug: string,
): Promise<
  | { ok: true; config: LinearTrackerConfig }
  | { ok: false; status: number; error: string; detail?: string }
> {
  const row = await env.DB.prepare(
    `SELECT tracker_kind, config_json FROM profiles
     WHERE tenant_id = ? AND slug = ? AND archived_at IS NULL`,
  )
    .bind(tenantId, slug)
    .first<{ tracker_kind: string; config_json: string }>();
  if (!row) return { ok: false, status: 404, error: "profile_not_found" };
  if (row.tracker_kind !== "linear") {
    return {
      ok: false,
      status: 400,
      error: "tracker_kind_unsupported",
      detail: `expected 'linear', got '${row.tracker_kind}'`,
    };
  }
  if (!env.LINEAR_API_KEY) {
    return {
      ok: false,
      status: 500,
      error: "linear_api_key_unset",
      detail: "LINEAR_API_KEY Worker secret is not configured",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.config_json);
  } catch (e) {
    return {
      ok: false,
      status: 500,
      error: "config_json_parse_failed",
      detail: String((e as Error).message),
    };
  }
  const extracted = extractLinearTrackerConfig(parsed, env.LINEAR_API_KEY);
  if (!extracted.ok) {
    return { ok: false, status: 500, error: extracted.code, detail: extracted.detail };
  }
  return { ok: true, config: extracted.config };
}

function shapeIssueForDebug(issue: {
  id: string;
  identifier: string;
  state: string;
  title: string | null;
  url: string | null;
}) {
  return {
    id: issue.id,
    identifier: issue.identifier,
    state: issue.state,
    title: issue.title,
    url: issue.url,
  };
}
