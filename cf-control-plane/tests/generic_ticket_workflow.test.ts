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
        throw new Error("generic ticket workflow must not write R2 artifacts");
      },
    } as unknown as R2Bucket,
    EXECUTION_WORKFLOW: {
      async create() {
        throw new Error("generic ticket workflow must not launch coding ExecutionWorkflow");
      },
      async get() {
        throw new Error("generic ticket workflow must not inspect coding ExecutionWorkflow");
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
      throw new Error(`generic ticket workflow must not touch ${name}`);
    },
    get() {
      throw new Error(`generic ticket workflow must not touch ${name}`);
    },
  } as unknown as DurableObjectNamespace;
}

function throwingQueue(name: string): Queue {
  return {
    async send() {
      throw new Error(`generic ticket workflow must not enqueue ${name}`);
    },
    async sendBatch() {
      throw new Error(`generic ticket workflow must not enqueue ${name}`);
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

type WorkflowStepSeed = {
  id: string;
  type: string;
  tool?: string;
  input?: Record<string, unknown>;
  role?: string;
  goal?: string;
  approver_group?: string;
  action?: string;
  risk_level?: string;
  expires_in?: string;
};

function seedWorkflowDefinition(db: SqliteDb, steps: WorkflowStepSeed[] = defaultWorkflowSteps(), tools: string[] = []) {
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
      tools,
      steps,
    }),
    "test://workflow-definitions/vendor-due-diligence/v1",
    "2026-05-03T00:00:00.000Z",
    "2026-05-03T00:00:00.000Z",
  );
}

function seedToolDefinition(
  db: SqliteDb,
  input: {
    name: string;
    riskLevel: "L0" | "L1" | "L2" | "L3" | "L4";
    requiresApproval?: boolean;
    idempotencyRequired?: boolean;
    handler?: string;
    inputSchema?: Record<string, unknown>;
  },
) {
  db.query(
    `INSERT INTO tool_definitions (
       id, tenant_id, name, description, input_schema_json, output_schema_json,
       risk_level, requires_approval, idempotency_required, handler, status,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(
    `tool_${input.name.replace(/[^A-Za-z0-9]/g, "_")}`,
    TENANT,
    input.name,
    `Test definition for ${input.name}`,
    JSON.stringify(input.inputSchema ?? { type: "object" }),
    input.riskLevel,
    input.requiresApproval ? 1 : 0,
    input.idempotencyRequired ? 1 : 0,
    input.handler ?? input.name,
    "2026-05-03T00:00:00.000Z",
    "2026-05-03T00:00:00.000Z",
  );
}

function defaultWorkflowSteps(): WorkflowStepSeed[] {
  return [
    { id: "intake", type: "agent", role: "intake", goal: "Validate vendor request completeness." },
    { id: "research", type: "agent", role: "researcher", goal: "Collect vendor risk evidence." },
    { id: "deliver", type: "action", goal: "Deliver the mock due diligence summary." },
  ];
}

function approvalWorkflowSteps(): WorkflowStepSeed[] {
  return [
    { id: "intake", type: "agent", role: "intake", goal: "Validate vendor request completeness." },
    {
      id: "plan_approval",
      type: "approval",
      goal: "Approve the due diligence plan before execution.",
      approver_group: "procurement",
      action: "vendor_due_diligence.plan_approval",
      risk_level: "medium",
      expires_in: "2 days",
    },
    { id: "deliver", type: "action", goal: "Deliver the mock due diligence summary." },
  ];
}

function artifactWorkflowSteps(input: Record<string, unknown> = { kind: "report", mimeType: "application/json", metadata: { source: "test" } }): WorkflowStepSeed[] {
  return [
    { id: "intake", type: "agent", role: "intake", goal: "Validate vendor request completeness." },
    { id: "create_artifact", type: "tool", tool: "artifact.create", input },
    { id: "deliver", type: "action", goal: "Deliver the mock due diligence summary." },
  ];
}

function webhookWorkflowSteps(toolStepOverrides: Partial<WorkflowStepSeed> = {}): WorkflowStepSeed[] {
  return [
    { id: "intake", type: "agent", role: "intake", goal: "Validate vendor request completeness." },
    {
      id: "call_webhook",
      type: "tool",
      tool: "webhook.call",
      input: { url: "https://example.invalid/webhook", payload: { vendor: "ACME" } },
      approver_group: "security",
      expires_in: "1 day",
      ...toolStepOverrides,
    },
    { id: "deliver", type: "action", goal: "Deliver the mock due diligence summary." },
  ];
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

function approvalRow(db: SqliteDb) {
  return db.query(`SELECT * FROM approvals ORDER BY created_at ASC LIMIT 1`).get() as
    | {
        id: string;
        status: string;
        ticket_id: string;
        workflow_instance_id: string;
        workflow_step_id: string;
        approver_group: string;
        requested_by: string;
        decided_by: string | null;
        request_ref: string;
        decision_ref: string | null;
        decided_at: string | null;
      }
    | null;
}

function toolInvocationRows(db: SqliteDb) {
  return db.query(`SELECT * FROM tool_invocations ORDER BY started_at, id`).all() as Array<{
    id: string;
    tool_name: string;
    status: string;
    risk_level: string;
    output_ref: string | null;
    approval_id: string | null;
    idempotency_key: string | null;
  }>;
}

function firstArtifact(db: SqliteDb) {
  return db.query(`SELECT * FROM artifacts ORDER BY created_at, id LIMIT 1`).get() as
    | { id: string; kind: string; r2_key: string; mime_type: string; metadata_json: string; created_by: string }
    | null;
}

function firstIdempotencyRecord(db: SqliteDb) {
  return db.query(`SELECT * FROM idempotency_records ORDER BY created_at, idem_key LIMIT 1`).get() as
    | { idem_key: string; status: string; run_id: string; tool_call_id: string; operation_type: string; result_ref: string | null }
    | null;
}

describe("GenericTicketWorkflow generic ticket runtime", () => {
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

  test("approval steps create a pending approval row and pause before later steps", async () => {
    const db = createMigratedDatabase();
    seedWorkflowDefinition(db, approvalWorkflowSteps());
    const env = makeEnv(db);

    const res = await createVendorTicket(env);

    expect(res.status).toBe(201);
    const body = (await res.json()) as { ticketId: string; workflowInstanceId: string; status: string };
    expect(body.status).toBe("WAITING_HUMAN");

    const instance = db.query(`SELECT status, current_step_key, completed_at FROM workflow_instances WHERE id = ?`).get(body.workflowInstanceId) as {
      status: string;
      current_step_key: string;
      completed_at: string | null;
    };
    expect(instance).toEqual({ status: "waiting_human", current_step_key: "plan_approval", completed_at: null });

    const steps = db.query(`SELECT step_key, step_type, status FROM workflow_steps ORDER BY sequence`).all() as Array<{ step_key: string; step_type: string; status: string }>;
    expect(steps).toEqual([
      { step_key: "intake", step_type: "agent", status: "completed" },
      { step_key: "plan_approval", step_type: "approval", status: "waiting_human" },
    ]);

    const approval = approvalRow(db);
    expect(approval).toMatchObject({
      status: "pending",
      ticket_id: body.ticketId,
      workflow_instance_id: body.workflowInstanceId,
      approver_group: "procurement",
      requested_by: "workflow-runtime",
      decided_by: null,
    });
    expect(JSON.parse(approval?.request_ref ?? "{}")).toMatchObject({
      actionSummary: "Approve the due diligence plan before execution.",
      riskLevel: "medium",
      effect: expect.stringContaining("approved resumes"),
    });
    expect(tableCount(db, "workflow_steps", "step_key = 'deliver'")).toBe(0);
    expect(auditActions(db)).toEqual(expect.arrayContaining(["approval.requested"]));
    expect(auditActions(db)).not.toContain("workflow.completed");
  });

  test("approved decisions are immutable and resume the workflow to completion", async () => {
    const db = createMigratedDatabase();
    seedWorkflowDefinition(db, approvalWorkflowSteps());
    const env = makeEnv(db);
    const created = await createVendorTicket(env);
    const { workflowInstanceId } = (await created.json()) as { workflowInstanceId: string };
    const approval = approvalRow(db);
    expect(approval?.status).toBe("pending");

    const decided = await worker.fetch(
      request("POST", `/api/v2/approvals/${approval?.id}/decision`, {
        tenantId: TENANT,
        decision: "approved",
        comment: "Plan is acceptable.",
      }),
      env,
      {},
    );

    expect(decided.status).toBe(200);
    const decidedBody = (await decided.json()) as {
      approval: { status: string; decidedBy: string; decisionRef: string };
      ticket: { status: string };
      workflowInstance: { status: string; id: string };
      steps: Array<{ stepKey: string; status: string }>;
    };
    expect(decidedBody.approval.status).toBe("approved");
    expect(decidedBody.approval.decidedBy).toBe("operator-token");
    expect(JSON.parse(decidedBody.approval.decisionRef)).toMatchObject({ decision: "approved", comment: "Plan is acceptable." });
    expect(decidedBody.ticket.status).toBe("COMPLETED");
    expect(decidedBody.workflowInstance).toMatchObject({ id: workflowInstanceId, status: "completed" });
    expect(decidedBody.steps.map((step) => [step.stepKey, step.status])).toEqual([
      ["intake", "completed"],
      ["plan_approval", "completed"],
      ["deliver", "completed"],
    ]);

    const secondDecision = await worker.fetch(
      request("POST", `/api/v2/approvals/${approval?.id}/decision`, {
        tenantId: TENANT,
        decision: "rejected",
        comment: "Too late to change.",
      }),
      env,
      {},
    );
    expect(secondDecision.status).toBe(409);
    expect((await secondDecision.json()) as { error: string; status: string }).toMatchObject({ error: "approval_already_decided", status: "approved" });
    expect((approvalRow(db) as { status: string }).status).toBe("approved");
    expect(auditActions(db)).toEqual(expect.arrayContaining(["approval.decided", "workflow.completed"]));
  });

  test("rejected decisions stop the workflow and do not execute later steps", async () => {
    const db = createMigratedDatabase();
    seedWorkflowDefinition(db, approvalWorkflowSteps());
    const env = makeEnv(db);
    await createVendorTicket(env);
    const approval = approvalRow(db);

    const rejected = await worker.fetch(
      request("POST", `/api/v2/approvals/${approval?.id}/decision`, {
        tenantId: TENANT,
        decision: "rejected",
        comment: "Insufficient evidence.",
      }),
      env,
      {},
    );

    expect(rejected.status).toBe(200);
    const body = (await rejected.json()) as {
      approval: { status: string };
      ticket: { status: string };
      workflowInstance: { status: string; completedAt: string | null };
      steps: Array<{ stepKey: string; status: string }>;
    };
    expect(body.approval.status).toBe("rejected");
    expect(body.ticket.status).toBe("CANCELLED");
    expect(body.workflowInstance.status).toBe("cancelled");
    expect(body.workflowInstance.completedAt).toBeString();
    expect(body.steps.map((step) => [step.stepKey, step.status])).toEqual([
      ["intake", "completed"],
      ["plan_approval", "cancelled"],
    ]);
    expect(tableCount(db, "workflow_steps", "step_key = 'deliver'")).toBe(0);
    expect(auditActions(db)).toEqual(expect.arrayContaining(["approval.decided", "workflow.cancelled"]));
    expect(auditActions(db)).not.toContain("workflow.completed");
  });

  test("changes_requested decisions move the ticket to rework without running later steps", async () => {
    const db = createMigratedDatabase();
    seedWorkflowDefinition(db, approvalWorkflowSteps());
    const env = makeEnv(db);
    await createVendorTicket(env);
    const approval = approvalRow(db);

    const changes = await worker.fetch(
      request("POST", `/api/v2/approvals/${approval?.id}/decision`, {
        tenantId: TENANT,
        decision: "changes_requested",
        comment: "Add sanctions screening evidence.",
      }),
      env,
      {},
    );

    expect(changes.status).toBe(200);
    const body = (await changes.json()) as {
      approval: { status: string };
      ticket: { status: string };
      workflowInstance: { status: string };
      steps: Array<{ stepKey: string; status: string }>;
    };
    expect(body.approval.status).toBe("changes_requested");
    expect(body.ticket.status).toBe("REWORK");
    expect(body.workflowInstance.status).toBe("cancelled");
    expect(body.steps.map((step) => [step.stepKey, step.status])).toEqual([
      ["intake", "completed"],
      ["plan_approval", "cancelled"],
    ]);
    expect(tableCount(db, "workflow_steps", "step_key = 'deliver'")).toBe(0);
    expect(auditActions(db)).toEqual(expect.arrayContaining(["approval.decided", "workflow.rework_requested"]));
  });

  test("approval decisions enforce tenant scope before mutating approval state", async () => {
    const db = createMigratedDatabase();
    seedWorkflowDefinition(db, approvalWorkflowSteps());
    const env = makeEnv(db);
    await createVendorTicket(env);
    const approval = approvalRow(db);

    const forbidden = await worker.fetch(
      request(
        "POST",
        `/api/v2/approvals/${approval?.id}/decision`,
        { tenantId: "tenant_2", decision: "approved" },
        { "X-Symphony-Tenant": "tenant_2" },
      ),
      env,
      {},
    );

    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()) as { error: string }).toMatchObject({ error: "tenant_forbidden" });
    expect((approvalRow(db) as { status: string }).status).toBe("pending");
    expect(auditActions(db)).not.toContain("approval.decided");
  });

  test("ToolGateway executes allowed artifact.create with schema, idempotency, metadata, and audit evidence", async () => {
    const db = createMigratedDatabase();
    seedToolDefinition(db, {
      name: "artifact.create",
      riskLevel: "L2",
      idempotencyRequired: true,
      inputSchema: {
        type: "object",
        required: ["kind", "mimeType"],
        properties: {
          kind: { type: "string" },
          mimeType: { type: "string" },
          metadata: { type: "object" },
        },
      },
    });
    seedWorkflowDefinition(db, artifactWorkflowSteps(), ["artifact.create"]);
    const env = makeEnv(db);

    const res = await createVendorTicket(env);

    expect(res.status).toBe(201);
    const body = (await res.json()) as { ticketId: string; workflowInstanceId: string; status: string };
    expect(body.status).toBe("COMPLETED");
    expect(tableCount(db, "tool_invocations")).toBe(1);
    expect(tableCount(db, "idempotency_records")).toBe(1);
    expect(tableCount(db, "artifacts")).toBe(1);
    expect(tableCount(db, "tool_calls")).toBe(0);

    const [invocation] = toolInvocationRows(db);
    expect(invocation).toMatchObject({
      tool_name: "artifact.create",
      status: "completed",
      risk_level: "L2",
    });
    expect(invocation?.output_ref).toStartWith("mock-r2://artifacts/");
    expect(invocation?.idempotency_key).toStartWith(`idem:g7:${TENANT}:${body.ticketId}:`);
    const outputRef = invocation?.output_ref ?? "";

    const artifact = firstArtifact(db);
    expect(artifact).toMatchObject({
      kind: "report",
      mime_type: "application/json",
      created_by: "toolgateway",
    });
    expect(artifact?.r2_key).toBe(outputRef);
    expect(JSON.parse(artifact?.metadata_json ?? "{}")).toEqual({ source: "test" });

    const idem = firstIdempotencyRecord(db);
    expect(idem).toMatchObject({
      status: "completed",
      run_id: body.workflowInstanceId,
      tool_call_id: invocation?.id,
      operation_type: "artifact.create",
      result_ref: artifact?.r2_key,
    });
    expect(auditActions(db)).toEqual(expect.arrayContaining(["tool.invocation.started", "tool.invocation.completed", "artifact.created"]));

    const replay = await startGenericTicketWorkflowForTicket(asD1(db), body.ticketId, { now: "2026-05-03T00:02:00.000Z" });
    expect(replay?.instance.id).toBe(body.workflowInstanceId);
    expect(tableCount(db, "tool_invocations")).toBe(1);
    expect(tableCount(db, "idempotency_records")).toBe(1);
    expect(tableCount(db, "artifacts")).toBe(1);
  });

  test("ToolGateway rejects tools outside the workflow allowlist", async () => {
    const db = createMigratedDatabase();
    seedToolDefinition(db, { name: "artifact.create", riskLevel: "L2", idempotencyRequired: true });
    seedWorkflowDefinition(db, artifactWorkflowSteps(), []);
    const env = makeEnv(db);

    const res = await createVendorTicket(env);

    expect(res.status).toBe(201);
    const body = (await res.json()) as { status: string; workflowInstanceId: string };
    expect(body.status).toBe("FAILED");
    const instance = db.query(`SELECT status, error_message FROM workflow_instances WHERE id = ?`).get(body.workflowInstanceId) as { status: string; error_message: string };
    expect(instance.status).toBe("failed");
    expect(instance.error_message).toContain("not allowed");
    expect(tableCount(db, "tool_invocations")).toBe(0);
    expect(tableCount(db, "artifacts")).toBe(0);
    expect(auditActions(db)).toContain("workflow.step.failed");
  });

  test("ToolGateway schema validation fails before artifact metadata is written", async () => {
    const db = createMigratedDatabase();
    seedToolDefinition(db, {
      name: "artifact.create",
      riskLevel: "L2",
      idempotencyRequired: true,
      inputSchema: { type: "object", required: ["kind", "mimeType"] },
    });
    seedWorkflowDefinition(db, artifactWorkflowSteps({ kind: "report" }), ["artifact.create"]);
    const env = makeEnv(db);

    const res = await createVendorTicket(env);

    expect(res.status).toBe(201);
    const body = (await res.json()) as { status: string; workflowInstanceId: string };
    expect(body.status).toBe("FAILED");
    const step = db.query(`SELECT status, error_message FROM workflow_steps WHERE step_key = 'create_artifact'`).get() as { status: string; error_message: string };
    expect(step.status).toBe("failed");
    expect(step.error_message).toContain("missing required field: mimeType");
    expect(toolInvocationRows(db)[0]).toMatchObject({ tool_name: "artifact.create", status: "failed" });
    expect(tableCount(db, "artifacts")).toBe(0);
  });

  test("ToolGateway fails closed when the registered input schema is malformed", async () => {
    const db = createMigratedDatabase();
    seedToolDefinition(db, { name: "artifact.create", riskLevel: "L2", idempotencyRequired: true });
    db.query(`UPDATE tool_definitions SET input_schema_json = ? WHERE tenant_id = ? AND name = ?`).run("{not-json", TENANT, "artifact.create");
    seedWorkflowDefinition(db, artifactWorkflowSteps(), ["artifact.create"]);
    const env = makeEnv(db);

    const res = await createVendorTicket(env);

    expect(res.status).toBe(201);
    expect(((await res.json()) as { status: string }).status).toBe("FAILED");
    const step = db.query(`SELECT status, error_message FROM workflow_steps WHERE step_key = 'create_artifact'`).get() as { status: string; error_message: string };
    expect(step).toMatchObject({
      status: "failed",
      error_message: expect.stringContaining("schema must be valid JSON"),
    });
    expect(toolInvocationRows(db)[0]).toMatchObject({ tool_name: "artifact.create", status: "failed" });
    expect(tableCount(db, "artifacts")).toBe(0);
  });

  test("ToolGateway ignores workflow supplied artifact r2Key overrides", async () => {
    const db = createMigratedDatabase();
    seedToolDefinition(db, { name: "artifact.create", riskLevel: "L2", idempotencyRequired: true });
    seedWorkflowDefinition(
      db,
      artifactWorkflowSteps({ kind: "report", mimeType: "application/json", r2Key: "mock-r2://attacker-controlled/path.json" }),
      ["artifact.create"],
    );
    const env = makeEnv(db);

    const res = await createVendorTicket(env);

    expect(res.status).toBe(201);
    const body = (await res.json()) as { ticketId: string; status: string };
    expect(body.status).toBe("COMPLETED");
    const artifact = firstArtifact(db);
    const invocation = toolInvocationRows(db)[0];
    expect(artifact?.r2_key).toStartWith(`mock-r2://artifacts/${body.ticketId}/`);
    expect(artifact?.r2_key).not.toBe("mock-r2://attacker-controlled/path.json");
    expect(invocation?.output_ref).toBe(artifact?.r2_key);
  });

  test("ToolGateway blocks replay while a mutating idempotency record is in progress", async () => {
    const db = createMigratedDatabase();
    seedToolDefinition(db, { name: "artifact.create", riskLevel: "L2", idempotencyRequired: true });
    seedWorkflowDefinition(db, artifactWorkflowSteps(), ["artifact.create"]);
    const env = makeEnv(db);
    const created = await createVendorTicket(env);
    const body = (await created.json()) as { ticketId: string; workflowInstanceId: string };
    const invocation = toolInvocationRows(db)[0];
    expect(invocation?.idempotency_key).toBeString();

    db.query(`DELETE FROM artifacts`).run();
    db.query(`UPDATE idempotency_records SET status = 'in_progress', result_ref = NULL, finalized_at = NULL WHERE idem_key = ?`).run(invocation?.idempotency_key ?? "");
    db.query(`UPDATE tool_invocations SET status = 'running', output_ref = NULL, completed_at = NULL WHERE id = ?`).run(invocation?.id ?? "");
    db.query(`UPDATE workflow_steps SET status = 'running', output_ref = NULL, completed_at = NULL WHERE step_key = 'create_artifact'`).run();
    db.query(`UPDATE workflow_instances SET status = 'running', completed_at = NULL, error_message = NULL WHERE id = ?`).run(body.workflowInstanceId);
    db.query(`UPDATE tickets SET status = 'RUNNING' WHERE id = ?`).run(body.ticketId);

    const replay = await startGenericTicketWorkflowForTicket(asD1(db), body.ticketId, { now: "2026-05-03T00:03:00.000Z" });

    expect(replay?.ticket.status).toBe("FAILED");
    expect(toolInvocationRows(db)[0]).toMatchObject({ tool_name: "artifact.create", status: "failed" });
    expect(firstIdempotencyRecord(db)).toMatchObject({ status: "in_progress", result_ref: null });
    expect(tableCount(db, "artifacts")).toBe(0);
    const step = db.query(`SELECT status, error_message FROM workflow_steps WHERE step_key = 'create_artifact'`).get() as { status: string; error_message: string };
    expect(step).toMatchObject({
      status: "failed",
      error_message: expect.stringContaining("idempotency key is already in progress"),
    });
  });

  test("L3 ToolGateway path creates approval wait and approved decisions execute through idempotency", async () => {
    const db = createMigratedDatabase();
    seedToolDefinition(db, {
      name: "webhook.call",
      riskLevel: "L3",
      requiresApproval: true,
      idempotencyRequired: true,
      inputSchema: { type: "object", required: ["url", "payload"], properties: { url: { type: "string" }, payload: { type: "object" } } },
    });
    seedWorkflowDefinition(db, webhookWorkflowSteps(), ["webhook.call"]);
    const env = makeEnv(db);

    const created = await createVendorTicket(env);

    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { ticketId: string; workflowInstanceId: string; status: string };
    expect(createdBody.status).toBe("WAITING_HUMAN");
    expect(tableCount(db, "tool_invocations")).toBe(1);
    expect(tableCount(db, "idempotency_records")).toBe(0);
    expect(tableCount(db, "workflow_steps", "step_key = 'deliver'")).toBe(0);
    expect(toolInvocationRows(db)[0]).toMatchObject({
      tool_name: "webhook.call",
      status: "approval_wait",
      risk_level: "L3",
    });
    const approval = approvalRow(db);
    expect(approval).toMatchObject({
      status: "pending",
      approver_group: "security",
      requested_by: "toolgateway",
    });
    expect(JSON.parse(approval?.request_ref ?? "{}")).toMatchObject({
      riskLevel: "L3",
      toolName: "webhook.call",
      effect: expect.stringContaining("ToolGateway"),
    });

    const approved = await worker.fetch(
      request("POST", `/api/v2/approvals/${approval?.id}/decision`, {
        tenantId: TENANT,
        decision: "approved",
        comment: "Allowed for test endpoint.",
      }),
      env,
      {},
    );

    expect(approved.status).toBe(200);
    const approvedBody = (await approved.json()) as {
      ticket: { status: string };
      workflowInstance: { status: string };
      steps: Array<{ stepKey: string; status: string }>;
    };
    expect(approvedBody.ticket.status).toBe("COMPLETED");
    expect(approvedBody.workflowInstance.status).toBe("completed");
    expect(approvedBody.steps.map((step) => [step.stepKey, step.status])).toEqual([
      ["intake", "completed"],
      ["call_webhook", "completed"],
      ["deliver", "completed"],
    ]);
    expect(toolInvocationRows(db)[0]).toMatchObject({ tool_name: "webhook.call", status: "completed" });
    expect(firstIdempotencyRecord(db)).toMatchObject({
      status: "completed",
      run_id: createdBody.workflowInstanceId,
      operation_type: "webhook.call",
    });
    expect(auditActions(db)).toEqual(expect.arrayContaining(["approval.requested", "approval.decided", "tool.invocation.completed"]));
  });

  test("L4 ToolGateway risk requires approval even without an explicit requiresApproval flag", async () => {
    const db = createMigratedDatabase();
    seedToolDefinition(db, {
      name: "webhook.call",
      riskLevel: "L4",
      requiresApproval: false,
      idempotencyRequired: true,
      inputSchema: { type: "object", required: ["url", "payload"] },
    });
    seedWorkflowDefinition(db, webhookWorkflowSteps(), ["webhook.call"]);
    const env = makeEnv(db);

    const created = await createVendorTicket(env);

    expect(created.status).toBe(201);
    expect(((await created.json()) as { status: string }).status).toBe("WAITING_HUMAN");
    expect(toolInvocationRows(db)[0]).toMatchObject({
      tool_name: "webhook.call",
      status: "approval_wait",
      risk_level: "L4",
    });
    expect(approvalRow(db)).toMatchObject({
      status: "pending",
      requested_by: "toolgateway",
      approver_group: "security",
    });
    expect(tableCount(db, "idempotency_records")).toBe(0);
    expect(tableCount(db, "workflow_steps", "step_key = 'deliver'")).toBe(0);
  });

  test("ToolGateway keeps registered L4 risk when workflow metadata attempts to downgrade it", async () => {
    const db = createMigratedDatabase();
    seedToolDefinition(db, {
      name: "webhook.call",
      riskLevel: "L4",
      requiresApproval: false,
      idempotencyRequired: true,
      inputSchema: { type: "object", required: ["url", "payload"] },
    });
    seedWorkflowDefinition(db, webhookWorkflowSteps({ risk_level: "L0" }), ["webhook.call"]);
    const env = makeEnv(db);

    const created = await createVendorTicket(env);

    expect(created.status).toBe(201);
    expect(((await created.json()) as { status: string }).status).toBe("WAITING_HUMAN");
    expect(toolInvocationRows(db)[0]).toMatchObject({
      tool_name: "webhook.call",
      status: "approval_wait",
      risk_level: "L4",
    });
    expect(approvalRow(db)).toMatchObject({
      status: "pending",
      requested_by: "toolgateway",
    });
    expect(tableCount(db, "idempotency_records")).toBe(0);
    expect(tableCount(db, "workflow_steps", "step_key = 'deliver'")).toBe(0);
  });
});
