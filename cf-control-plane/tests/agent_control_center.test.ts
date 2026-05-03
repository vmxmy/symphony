import { describe, expect, mock, test } from "bun:test";
import { asD1, createMigratedDatabase } from "./support/sqlite_d1.js";

class MockDurableObject {
  protected ctx: DurableObjectState;
  protected env: unknown;
  constructor(ctx: DurableObjectState, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}
class MockWorkflowEntrypoint {
  protected env: unknown;
  constructor(_ctx: unknown, env: unknown) {
    this.env = env;
  }
}

mock.module("cloudflare:workers", () => ({
  DurableObject: MockDurableObject,
  WorkflowEntrypoint: MockWorkflowEntrypoint,
}));

const workerModule = (await import("../src/worker.js")) as {
  default: { fetch: (req: Request, env: unknown, ctx: unknown) => Promise<Response> };
};
const worker = workerModule.default;

const TOKEN = "test-bearer-token";
const TENANT = "tenant_1";
const TICKET_ID = "ticket_agent_control";
const WORKFLOW_ID = "workflow_agent_control";

type SqliteDb = ReturnType<typeof createMigratedDatabase>;

function makeEnv(db: SqliteDb) {
  const forbidden = () => {
    throw new Error("Agent Control Center must be D1 read-only in G4");
  };
  return {
    DB: asD1(db),
    OPERATOR_TOKEN: TOKEN,
    ARTIFACTS: { async get() { forbidden(); }, async put() { forbidden(); } } as unknown as R2Bucket,
    EXECUTION_WORKFLOW: { async get(_id: string) { forbidden(); } },
    TENANT_AGENT: { idFromName: forbidden, get: forbidden } as unknown as DurableObjectNamespace,
    PROJECT_AGENT: { idFromName: forbidden, get: forbidden } as unknown as DurableObjectNamespace,
    ISSUE_AGENT: { idFromName: forbidden, get: forbidden } as unknown as DurableObjectNamespace,
    TRACKER_EVENTS: { async send() { forbidden(); }, async sendBatch() { forbidden(); } },
    DISPATCH: { async send() { forbidden(); }, async sendBatch() { forbidden(); } },
  };
}

function request(path: string, headers: Record<string, string> = {}): Request {
  return new Request("https://test.example.com" + path, {
    method: "GET",
    headers: { Authorization: `Bearer ${TOKEN}`, "X-Symphony-Tenant": TENANT, ...headers },
  });
}

function seedControlCenterData(db: SqliteDb) {
  const now = "2026-05-03T03:30:00Z";
  db.query(`
    INSERT INTO tickets (
      id, tenant_id, key, type, title, description, requester, owner,
      priority, status, workflow_key, workflow_version, input_json,
      tags_json, created_at, updated_at
    ) VALUES (?, ?, 'TKT-ACC', 'vendor_review', ?, ?, 'ops@example.com', 'procurement',
      'high', 'WAITING_HUMAN', 'vendor-due-diligence', 1, ?, ?, ?, ?)
  `).run(
    TICKET_ID,
    TENANT,
    "Review <ACME> Supplier",
    "Need review before signature & onboarding.",
    JSON.stringify({ vendor_name: "ACME", contract_value: 120000 }),
    JSON.stringify(["procurement", "risk"]),
    now,
    now,
  );
  db.query(`
    INSERT INTO ticket_sources (
      id, tenant_id, ticket_id, source_kind, external_id, external_key,
      external_url, sync_status, last_synced_at, created_at, updated_at
    ) VALUES ('source_acc', ?, ?, 'api', NULL, 'manual-request', NULL, 'active', ?, ?, ?)
  `).run(TENANT, TICKET_ID, now, now, now);
  db.query(`
    INSERT INTO ticket_sources (
      id, tenant_id, ticket_id, source_kind, external_id, external_key,
      external_url, sync_status, last_synced_at, created_at, updated_at
    ) VALUES ('source_bad_url', ?, ?, 'manual', NULL, 'unsafe-source', ?, 'active', ?, ?, ?)
  `).run(TENANT, TICKET_ID, "javascript:alert(1)", now, now, now);
  db.query(`
    INSERT INTO workflow_instances (
      id, tenant_id, ticket_id, workflow_key, workflow_version, status,
      current_step_key, started_at, runtime_json
    ) VALUES (?, ?, ?, 'vendor-due-diligence', 1, 'WAITING_HUMAN', 'risk_approval', ?, '{}')
  `).run(WORKFLOW_ID, TENANT, TICKET_ID, now);
  db.query(`
    INSERT INTO workflow_steps (
      id, tenant_id, ticket_id, workflow_instance_id, step_key, step_type,
      status, sequence, input_ref, output_ref, summary, retry_count, started_at
    ) VALUES (?, ?, ?, ?, 'risk_approval', 'approval', 'waiting', 1,
      'r2://private-chain-of-thought-secret', 'r2://private-output-secret',
      'Safe summary: waiting for procurement approval', 0, ?)
  `).run("step_acc", TENANT, TICKET_ID, WORKFLOW_ID, now);
  db.query(`
    INSERT INTO approvals (
      id, tenant_id, profile_id, ticket_id, workflow_instance_id,
      action, status, requested_by, request_ref, approver_group,
      created_at, expires_at
    ) VALUES ('approval_acc', ?, 'tenant_1/profile', ?, ?, 'vendor.approve_onboarding',
      'pending', 'agent-reviewer', 'r2://approval-pack-risk-evidence', 'procurement', ?, ?)
  `).run(TENANT, TICKET_ID, WORKFLOW_ID, now, "2026-05-05T03:30:00Z");
  db.query(`
    INSERT INTO ticket_comments (
      id, tenant_id, ticket_id, author_type, author_id, body, visibility, created_at
    ) VALUES ('comment_acc', ?, ?, 'human', 'manager@example.com', ?, 'internal', ?)
  `).run(TENANT, TICKET_ID, "Looks safe <but verify insurance>.", now);
  db.query(`
    INSERT INTO artifacts (
      id, tenant_id, ticket_id, workflow_instance_id, kind, r2_key,
      mime_type, metadata_json, created_by, created_at
    ) VALUES ('artifact_acc', ?, ?, ?, 'report', 'r2://reports/vendor-risk.json',
      'application/json', '{}', 'agent', ?)
  `).run(TENANT, TICKET_ID, WORKFLOW_ID, now);
  db.query(`
    INSERT INTO audit_events (
      id, tenant_id, ticket_id, workflow_instance_id, actor_type, actor_id,
      action, severity, summary, payload_ref, created_at
    ) VALUES ('audit_acc', ?, ?, ?, 'agent', 'review_agent', 'ticket.review.summarized',
      'info', 'Safe audit summary for approval packet', 'r2://audit/payload', ?)
  `).run(TENANT, TICKET_ID, WORKFLOW_ID, now);
}

describe("G4 Agent Control Center routes", () => {
  test("GET /tickets renders canonical ticket inbox without touching runtime bindings", async () => {
    const db = createMigratedDatabase();
    seedControlCenterData(db);
    const env = makeEnv(db);

    const res = await worker.fetch(request("/tickets?tenantId=tenant_1"), env, {});

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Agent Control Center · Ticket Inbox");
    expect(html).toContain("TKT-ACC");
    expect(html).toContain("WAITING_HUMAN");
    expect(html).toContain("vendor-due-diligence");
    expect(html).toContain("risk_approval");
    expect(html).toContain("1 pending");
    expect(html).toContain(`/tickets/${TICKET_ID}?tenantId=tenant_1`);
  });

  test("GET /tickets/:ticketId renders detail, timeline, artifacts, approvals, audit, and escapes content", async () => {
    const db = createMigratedDatabase();
    seedControlCenterData(db);
    const env = makeEnv(db);

    const res = await worker.fetch(request(`/tickets/${TICKET_ID}?tenantId=tenant_1`), env, {});

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Agent Control Center · TKT-ACC");
    expect(html).toContain("Review &lt;ACME&gt; Supplier");
    expect(html).toContain("Need review before signature &amp; onboarding.");
    expect(html).toContain("Safe summary: waiting for procurement approval");
    expect(html).toContain("r2://approval-pack-risk-evidence");
    expect(html).toContain("r2://reports/vendor-risk.json");
    expect(html).toContain("Safe audit summary for approval packet");
    expect(html).toContain("Looks safe &lt;but verify insurance&gt;.");
    expect(html).not.toContain("private-chain-of-thought-secret");
    expect(html).not.toContain("private-output-secret");
    expect(html).not.toContain("javascript:alert");
  });

  test("GET /approvals renders read-only approval center cards as table rows", async () => {
    const db = createMigratedDatabase();
    seedControlCenterData(db);
    const env = makeEnv(db);

    const res = await worker.fetch(request("/approvals?tenantId=tenant_1"), env, {});

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Agent Control Center · Approval Center");
    expect(html).toContain("vendor.approve_onboarding");
    expect(html).toContain("procurement");
    expect(html).toContain("r2://approval-pack-risk-evidence");
    expect(html).toContain(`/tickets/${TICKET_ID}?tenantId=tenant_1`);
    expect(html).toContain("API actions drive resume/stop behavior");
    expect(html).not.toContain("<button");
  });

  test("Agent Control Center routes require auth and tenant scope", async () => {
    const db = createMigratedDatabase();
    const env = makeEnv(db);

    const unauthorized = await worker.fetch(new Request("https://test.example.com/tickets?tenantId=tenant_1"), env, {});
    expect(unauthorized.status).toBe(401);

    const missingTenant = await worker.fetch(
      new Request("https://test.example.com/tickets", { headers: { Authorization: `Bearer ${TOKEN}` } }),
      env,
      {},
    );
    expect(missingTenant.status).toBe(400);

    const wrongTenant = await worker.fetch(
      request("/tickets?tenantId=tenant_2"),
      env,
      {},
    );
    expect(wrongTenant.status).toBe(403);
  });

  test("Agent Control Center renders empty states for new tenants", async () => {
    const db = createMigratedDatabase();
    const env = makeEnv(db);

    const tickets = await worker.fetch(request("/tickets?tenantId=tenant_1"), env, {});
    const approvals = await worker.fetch(request("/approvals?tenantId=tenant_1"), env, {});

    expect(await tickets.text()).toContain("No canonical tickets for this tenant yet.");
    expect(await approvals.text()).toContain("No ticket approvals yet.");
  });
});
