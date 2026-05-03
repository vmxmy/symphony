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
const { startGenericTicketWorkflowForTicket } = await import("../src/workflows/generic_ticket.js");
const worker = workerModule.default;

const TOKEN = "test-bearer-token";
const TENANT = "tenant_1";

type SqliteDb = ReturnType<typeof createMigratedDatabase>;

function makeEnv(db: SqliteDb) {
  return {
    DB: asD1(db),
    OPERATOR_TOKEN: TOKEN,
    ARTIFACTS: {
      async put() {
        throw new Error("G5 generic workflow must not write R2 artifacts");
      },
    } as unknown as R2Bucket,
    EXECUTION_WORKFLOW: {
      async create() {
        throw new Error("G5 generic workflow must not launch coding ExecutionWorkflow");
      },
      async get() {
        throw new Error("G5 generic workflow must not inspect coding ExecutionWorkflow");
      },
    },
    TENANT_AGENT: throwingNamespace("TENANT_AGENT"),
    PROJECT_AGENT: throwingNamespace("PROJECT_AGENT"),
    ISSUE_AGENT: throwingNamespace("ISSUE_AGENT"),
    TRACKER_EVENTS: throwingQueue("TRACKER_EVENTS"),
    DISPATCH: throwingQueue("DISPATCH"),
  };
}

function throwingNamespace(name: string): DurableObjectNamespace {
  return {
    idFromName() {
      throw new Error(`G5 generic workflow must not touch ${name}`);
    },
    get() {
      throw new Error(`G5 generic workflow must not touch ${name}`);
    },
  } as unknown as DurableObjectNamespace;
}

function throwingQueue(name: string): Queue {
  return {
    async send() {
      throw new Error(`G5 generic workflow must not enqueue ${name}`);
    },
    async sendBatch() {
      throw new Error(`G5 generic workflow must not enqueue ${name}`);
    },
  } as unknown as Queue;
}

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://test.example.com" + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "X-Symphony-Tenant": TENANT,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createVendorTicket(env: ReturnType<typeof makeEnv>) {
  return worker.fetch(
    request("POST", "/api/v2/tickets", {
      tenantId: TENANT,
      type: "vendor_review",
      title: "Review ACME Data Ltd",
      description: "Need vendor due diligence before signature.",
      priority: "high",
      workflowKey: "vendor-due-diligence",
      input: { vendor_name: "ACME Data Ltd", country: "UK" },
    }),
    env,
    {},
  );
}

function seedWorkflowDefinition(db: SqliteDb) {
  db.query(
    `INSERT INTO workflow_definitions (
       id, tenant_id, key, version, name, status, definition_json, source_ref, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
  ).run(
    "wfd_vendor_v1",
    TENANT,
    "vendor-due-diligence",
    1,
    "Vendor Due Diligence",
    JSON.stringify({
      key: "vendor-due-diligence",
      name: "Vendor Due Diligence",
      version: 1,
      steps: [
        { id: "intake", type: "agent", role: "intake", goal: "Validate vendor request completeness." },
        { id: "research", type: "agent", role: "researcher", goal: "Collect vendor risk evidence." },
        { id: "deliver", type: "action", goal: "Deliver the mock due diligence summary." },
      ],
    }),
    "test://workflow-definitions/vendor-due-diligence/v1",
    "2026-05-03T00:00:00.000Z",
    "2026-05-03T00:00:00.000Z",
  );
}

function tableCount(db: SqliteDb, table: string, where = "1 = 1"): number {
  return (db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get() as { count: number }).count;
}

function auditActions(db: SqliteDb): string[] {
  return db
    .query(`SELECT action FROM audit_events ORDER BY created_at, id`)
    .all()
    .map((row) => String((row as { action: string }).action));
}

describe("G5 GenericTicketWorkflow MVP", () => {
  test("POST /api/v2/tickets starts and completes a non-coding workflow when an active definition exists", async () => {
    const db = createMigratedDatabase();
    seedWorkflowDefinition(db);
    const env = makeEnv(db);
    expect("LINEAR_API_KEY" in env).toBe(false);

    const res = await createVendorTicket(env);

    expect(res.status).toBe(201);
    const body = (await res.json()) as { ticketId: string; workflowInstanceId: string; status: string };
    expect(body.workflowInstanceId).toStartWith(`wfi:${body.ticketId}:vendor-due-diligence:v1`);
    expect(body.status).toBe("COMPLETED");

    expect(tableCount(db, "workflow_instances")).toBe(1);
    expect(tableCount(db, "workflow_steps")).toBe(3);
    expect(tableCount(db, "agent_sessions")).toBe(2);
    expect(tableCount(db, "runs")).toBe(0);
    expect(tableCount(db, "run_steps")).toBe(0);
    expect(tableCount(db, "tool_calls")).toBe(0);
    expect(tableCount(db, "artifacts")).toBe(0);

    const ticket = db.query(`SELECT status, workflow_version FROM tickets WHERE id = ?`).get(body.ticketId) as { status: string; workflow_version: number };
    expect(ticket).toEqual({ status: "COMPLETED", workflow_version: 1 });
    expect(auditActions(db)).toEqual(
      expect.arrayContaining([
        "ticket.created",
        "workflow.started",
        "workflow.step.started",
        "workflow.step.completed",
        "workflow.completed",
      ]),
    );
  });

  test("workflow instance and steps APIs expose the persisted timeline", async () => {
    const db = createMigratedDatabase();
    seedWorkflowDefinition(db);
    const env = makeEnv(db);
    const created = await createVendorTicket(env);
    const { workflowInstanceId } = (await created.json()) as { workflowInstanceId: string };

    const instanceRes = await worker.fetch(request("GET", `/api/v2/workflow-instances/${workflowInstanceId}`), env, {});
    expect(instanceRes.status).toBe(200);
    const instanceBody = (await instanceRes.json()) as {
      workflowInstance: { id: string; status: string; workflowKey: string; runtime: { kind: string } };
    };
    expect(instanceBody.workflowInstance).toMatchObject({
      id: workflowInstanceId,
      status: "completed",
      workflowKey: "vendor-due-diligence",
      runtime: { kind: "mock_generic_ticket_workflow" },
    });

    const stepsRes = await worker.fetch(request("GET", `/api/v2/workflow-instances/${workflowInstanceId}/steps`), env, {});
    expect(stepsRes.status).toBe(200);
    const stepsBody = (await stepsRes.json()) as { steps: Array<{ stepKey: string; status: string; inputRef: string; outputRef: string }> };
    expect(stepsBody.steps.map((step) => step.stepKey)).toEqual(["intake", "research", "deliver"]);
    expect(stepsBody.steps.every((step) => step.status === "completed")).toBe(true);
    expect(stepsBody.steps.every((step) => step.inputRef.startsWith("mock://workflow/"))).toBe(true);
    expect(stepsBody.steps.every((step) => step.outputRef.startsWith("mock://workflow/"))).toBe(true);
  });

  test("replay reuses workflow rows and does not duplicate mock side effects", async () => {
    const db = createMigratedDatabase();
    seedWorkflowDefinition(db);
    const env = makeEnv(db);
    const created = await createVendorTicket(env);
    const { ticketId, workflowInstanceId } = (await created.json()) as { ticketId: string; workflowInstanceId: string };
    const before = {
      workflowInstances: tableCount(db, "workflow_instances"),
      workflowSteps: tableCount(db, "workflow_steps"),
      agentSessions: tableCount(db, "agent_sessions"),
      auditEvents: tableCount(db, "audit_events"),
    };

    const replay = await startGenericTicketWorkflowForTicket(asD1(db), ticketId, { now: "2026-05-03T00:01:00.000Z" });

    expect(replay?.instance.id).toBe(workflowInstanceId);
    expect(replay?.steps).toHaveLength(3);
    expect({
      workflowInstances: tableCount(db, "workflow_instances"),
      workflowSteps: tableCount(db, "workflow_steps"),
      agentSessions: tableCount(db, "agent_sessions"),
      auditEvents: tableCount(db, "audit_events"),
    }).toEqual(before);
  });

  test("workflow reads enforce tenant scope", async () => {
    const db = createMigratedDatabase();
    seedWorkflowDefinition(db);
    const env = makeEnv(db);
    const created = await createVendorTicket(env);
    const { workflowInstanceId } = (await created.json()) as { workflowInstanceId: string };

    const missingScope = await worker.fetch(
      new Request(`https://test.example.com/api/v2/workflow-instances/${workflowInstanceId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      env,
      {},
    );
    expect(missingScope.status).toBe(400);
    expect((await missingScope.json()) as { error: string }).toMatchObject({ error: "missing_tenant_scope" });

    const forbidden = await worker.fetch(
      request("GET", `/api/v2/workflow-instances/${workflowInstanceId}`, undefined, { "X-Symphony-Tenant": "tenant_2" }),
      env,
      {},
    );

    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()) as { error: string }).toMatchObject({ error: "tenant_forbidden" });
  });
});
