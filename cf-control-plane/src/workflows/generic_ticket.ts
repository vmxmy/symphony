import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import { getTicketById } from "../tickets/store.js";
import type { Ticket, TicketStatus } from "../tickets/types.js";

export type WorkflowInstanceStatus =
  | "created"
  | "running"
  | "waiting_human"
  | "waiting_external"
  | "retry_wait"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export type WorkflowStepStatus =
  | "pending"
  | "running"
  | "waiting_human"
  | "waiting_external"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled"
  | "retry_wait";

export type GenericWorkflowInstance = {
  id: string;
  tenantId: string;
  ticketId: string;
  workflowKey: string;
  workflowVersion: number;
  status: WorkflowInstanceStatus;
  currentStepKey: string | null;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  runtime: unknown;
};

export type GenericWorkflowStep = {
  id: string;
  tenantId: string;
  ticketId: string;
  workflowInstanceId: string;
  stepKey: string;
  stepType: string;
  status: WorkflowStepStatus;
  sequence: number;
  inputRef: string | null;
  outputRef: string | null;
  summary: string | null;
  retryCount: number;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
};

export type GenericWorkflowRunResult = {
  ticket: Ticket;
  instance: GenericWorkflowInstance;
  steps: GenericWorkflowStep[];
};

export type GenericApprovalDecision = "approved" | "rejected" | "changes_requested";
type ToolRiskLevel = "L0" | "L1" | "L2" | "L3" | "L4";

export type GenericApproval = {
  id: string;
  tenantId: string;
  ticketId: string | null;
  workflowInstanceId: string | null;
  workflowStepId: string | null;
  action: string;
  status: string;
  requestedBy: string | null;
  decidedBy: string | null;
  requestRef: string;
  decisionRef: string | null;
  approverGroup: string | null;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string | null;
};

export type GenericApprovalDecisionResult =
  | {
      ok: true;
      approval: GenericApproval;
      ticket: Ticket;
      instance: GenericWorkflowInstance;
      steps: GenericWorkflowStep[];
    }
  | {
      ok: false;
      error: "approval_not_found" | "approval_not_pending" | "approval_not_generic" | "workflow_not_found" | "ticket_not_found" | "workflow_definition_not_found";
      approval?: GenericApproval;
    };

export type GenericTicketWorkflowParams = {
  ticketId: string;
};

type GenericWorkflowEnv = {
  DB: D1Database;
};

export class GenericTicketWorkflow extends WorkflowEntrypoint<GenericWorkflowEnv, GenericTicketWorkflowParams> {
  async run(event: WorkflowEvent<GenericTicketWorkflowParams>, step: WorkflowStep): Promise<{ workflowInstanceId: string | null; status: string }> {
    const runBody = async () => {
      const result = await startGenericTicketWorkflowForTicket(this.env.DB, event.payload.ticketId);
      return {
        workflowInstanceId: result?.instance.id ?? null,
        status: result?.instance.status ?? "no_definition",
      };
    };
    const promise = step.do(
      "run generic ticket workflow",
      { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } } as Parameters<typeof step.do>[1],
      runBody as Parameters<typeof step.do>[2],
    );
    return promise as unknown as Promise<{ workflowInstanceId: string | null; status: string }>;
  }
}

type WorkflowDefinitionRow = {
  id: string;
  tenant_id: string;
  key: string;
  version: number;
  name: string;
  status: string;
  definition_json: string;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
};

type WorkflowInstanceRow = {
  id: string;
  tenant_id: string;
  ticket_id: string;
  workflow_key: string;
  workflow_version: number;
  status: WorkflowInstanceStatus;
  current_step_key: string | null;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
  runtime_json: string | null;
};

type WorkflowStepRow = {
  id: string;
  tenant_id: string;
  ticket_id: string;
  workflow_instance_id: string;
  step_key: string;
  step_type: string;
  status: WorkflowStepStatus;
  sequence: number;
  input_ref: string | null;
  output_ref: string | null;
  summary: string | null;
  retry_count: number;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
};

type WorkflowStepDefinition = {
  id: string;
  type: string;
  toolName: string | null;
  input: Record<string, unknown>;
  role: string | null;
  goal: string | null;
  summary: string | null;
  approverGroup: string | null;
  action: string | null;
  riskLevel: string | null;
  expiresIn: string | null;
};

type NormalizedWorkflowDefinition = {
  id: string;
  tenantId: string;
  key: string;
  version: number;
  name: string;
  allowedTools: string[];
  steps: WorkflowStepDefinition[];
};

type AuditEventInput = {
  id: string;
  tenantId: string;
  ticketId: string;
  workflowInstanceId: string;
  workflowStepId?: string | null;
  actorType: "system" | "agent" | "human";
  actorId?: string | null;
  action: string;
  summary: string;
  createdAt: string;
  payloadRef?: string | null;
};

const GENERIC_RUNTIME_KIND = "mock_generic_ticket_workflow";
const GENERIC_APPROVAL_PROFILE_ID = "generic-ticket-workflow";

type ApprovalRow = {
  id: string;
  tenant_id: string;
  profile_id: string;
  issue_id: string | null;
  run_id: string | null;
  action: string;
  status: string;
  requested_by: string | null;
  decided_by: string | null;
  request_ref: string;
  decision_ref: string | null;
  created_at: string;
  decided_at: string | null;
  ticket_id: string | null;
  workflow_instance_id: string | null;
  workflow_step_id: string | null;
  approver_group: string | null;
  expires_at: string | null;
};

type ToolDefinitionRow = {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  input_schema_json: string;
  output_schema_json: string;
  risk_level: ToolRiskLevel;
  requires_approval: number;
  idempotency_required: number;
  handler: string;
  status: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type ToolInvocationRow = {
  id: string;
  tenant_id: string;
  ticket_id: string;
  workflow_instance_id: string | null;
  workflow_step_id: string | null;
  agent_session_id: string | null;
  tool_name: string;
  status: "pending" | "running" | "approval_wait" | "completed" | "failed" | "rejected";
  risk_level: ToolRiskLevel;
  input_ref: string;
  output_ref: string | null;
  approval_id: string | null;
  idempotency_key: string | null;
  started_at: string;
  completed_at: string | null;
};

type IdempotencyRecordRow = {
  idem_key: string;
  tenant_id: string;
  profile_id: string;
  issue_id: string | null;
  run_id: string | null;
  tool_call_id: string | null;
  operation_type: string;
  status: "in_progress" | "completed" | "failed" | "expired";
  result_ref: string | null;
};

export async function startGenericTicketWorkflowForTicket(
  db: D1Database,
  ticketId: string,
  options: { now?: string } = {},
): Promise<GenericWorkflowRunResult | null> {
  const ticket = await getTicketById(db, ticketId);
  if (!ticket || ticket.archivedAt) return null;

  const definition = await loadActiveWorkflowDefinition(db, ticket.tenantId, ticket.workflowKey);
  if (!definition) return null;

  return runGenericTicketWorkflow(db, ticket, definition, options.now ?? new Date().toISOString());
}

export async function getGenericWorkflowInstanceById(
  db: D1Database,
  workflowInstanceId: string,
): Promise<GenericWorkflowInstance | null> {
  const row = await db
    .prepare(`SELECT * FROM workflow_instances WHERE id = ?`)
    .bind(workflowInstanceId)
    .first<WorkflowInstanceRow>();
  return row ? shapeWorkflowInstance(row) : null;
}

export async function listGenericWorkflowSteps(
  db: D1Database,
  workflowInstanceId: string,
): Promise<GenericWorkflowStep[]> {
  const { results } = await db
    .prepare(
      `SELECT *
         FROM workflow_steps
        WHERE workflow_instance_id = ?
        ORDER BY sequence ASC`,
    )
    .bind(workflowInstanceId)
    .all<WorkflowStepRow>();
  return (results ?? []).map(shapeWorkflowStep);
}

export async function getGenericApprovalById(db: D1Database, approvalId: string): Promise<GenericApproval | null> {
  const row = await db.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(approvalId).first<ApprovalRow>();
  return row ? shapeApproval(row) : null;
}

export async function decideGenericWorkflowApproval(
  db: D1Database,
  approvalId: string,
  input: {
    decision: GenericApprovalDecision;
    decidedBy: string;
    decisionRef: string;
    now?: string;
  },
): Promise<GenericApprovalDecisionResult> {
  const now = input.now ?? new Date().toISOString();
  const approval = await getGenericApprovalById(db, approvalId);
  if (!approval) return { ok: false, error: "approval_not_found" };
  if (!approval.ticketId || !approval.workflowInstanceId || !approval.workflowStepId) {
    return { ok: false, error: "approval_not_generic", approval };
  }
  if (approval.status !== "pending") {
    return { ok: false, error: "approval_not_pending", approval };
  }

  const instance = await getGenericWorkflowInstanceById(db, approval.workflowInstanceId);
  if (!instance) return { ok: false, error: "workflow_not_found", approval };

  const ticket = await getTicketById(db, approval.ticketId);
  if (!ticket || ticket.archivedAt) return { ok: false, error: "ticket_not_found", approval };

  const definition = await loadWorkflowDefinitionVersion(db, ticket.tenantId, instance.workflowKey, instance.workflowVersion);
  if (!definition) return { ok: false, error: "workflow_definition_not_found", approval };

  const workflowStep = await db.prepare(`SELECT * FROM workflow_steps WHERE id = ?`).bind(approval.workflowStepId).first<WorkflowStepRow>();
  if (!workflowStep) return { ok: false, error: "workflow_not_found", approval };

  const decided = await db
    .prepare(
      `UPDATE approvals
          SET status = ?, decided_by = ?, decision_ref = ?, decided_at = ?
        WHERE id = ? AND status = 'pending'`,
    )
    .bind(input.decision, input.decidedBy, input.decisionRef, now, approvalId)
    .run();

  if ((decided.meta.changes ?? 0) === 0) {
    const current = await getGenericApprovalById(db, approvalId);
    return { ok: false, error: "approval_not_pending", approval: current ?? approval };
  }

  await insertAuditEventOnce(db, {
    id: auditId(instance.id, `step.${workflowStep.sequence}.approval.decided`),
    tenantId: ticket.tenantId,
    ticketId: ticket.id,
    workflowInstanceId: instance.id,
    workflowStepId: approval.workflowStepId,
    actorType: "human",
    actorId: input.decidedBy,
    action: "approval.decided",
    summary: `Approval ${approval.action} ${input.decision}`,
    payloadRef: input.decisionRef,
    createdAt: now,
  });

  if (input.decision === "approved" && workflowStep.step_type === "approval") {
    await completeApprovalStep(db, ticket, instance, workflowStep, input.decidedBy, now);
    const resumed = await runGenericTicketWorkflow(db, ticket, definition, now);
    return { ok: true, approval: (await getGenericApprovalById(db, approvalId)) ?? approval, ...resumed };
  }

  if (input.decision === "approved") {
    await db
      .prepare(`UPDATE tool_invocations SET status = 'running' WHERE approval_id = ? AND status = 'approval_wait'`)
      .bind(approvalId)
      .run();
    const resumed = await runGenericTicketWorkflow(db, ticket, definition, now);
    return { ok: true, approval: (await getGenericApprovalById(db, approvalId)) ?? approval, ...resumed };
  }

  const ticketStatus: TicketStatus = input.decision === "changes_requested" ? "REWORK" : "CANCELLED";
  const instanceStatus: WorkflowInstanceStatus = "cancelled";
  await stopWorkflowForApprovalDecision(db, ticket, instance, workflowStep, input.decision, ticketStatus, instanceStatus, input.decidedBy, now);

  return {
    ok: true,
    approval: (await getGenericApprovalById(db, approvalId)) ?? approval,
    ticket: (await getTicketById(db, ticket.id)) ?? ticket,
    instance: await requireWorkflowInstance(db, instance.id),
    steps: await listGenericWorkflowSteps(db, instance.id),
  };
}

async function loadActiveWorkflowDefinition(
  db: D1Database,
  tenantId: string,
  workflowKey: string,
): Promise<NormalizedWorkflowDefinition | null> {
  const row = await db
    .prepare(
      `SELECT *
         FROM workflow_definitions
        WHERE tenant_id = ? AND key = ? AND status = 'active'
        ORDER BY version DESC
        LIMIT 1`,
    )
    .bind(tenantId, workflowKey)
    .first<WorkflowDefinitionRow>();
  return row ? normalizeWorkflowDefinition(row) : null;
}

async function loadWorkflowDefinitionVersion(
  db: D1Database,
  tenantId: string,
  workflowKey: string,
  version: number,
): Promise<NormalizedWorkflowDefinition | null> {
  const row = await db
    .prepare(
      `SELECT *
         FROM workflow_definitions
        WHERE tenant_id = ? AND key = ? AND version = ?
        LIMIT 1`,
    )
    .bind(tenantId, workflowKey, version)
    .first<WorkflowDefinitionRow>();
  return row ? normalizeWorkflowDefinition(row) : null;
}

async function runGenericTicketWorkflow(
  db: D1Database,
  ticket: Ticket,
  definition: NormalizedWorkflowDefinition,
  now: string,
): Promise<GenericWorkflowRunResult> {
  const instanceId = workflowInstanceId(ticket.id, definition.key, definition.version);
  const runtimeJson = JSON.stringify({ kind: GENERIC_RUNTIME_KIND, definitionId: definition.id });
  const firstStep = definition.steps[0] ?? null;

  await db
    .prepare(
      `INSERT OR IGNORE INTO workflow_instances (
         id, tenant_id, ticket_id, workflow_key, workflow_version, status,
         current_step_key, started_at, runtime_json
       ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
    )
    .bind(
      instanceId,
      ticket.tenantId,
      ticket.id,
      definition.key,
      definition.version,
      firstStep?.id ?? null,
      now,
      runtimeJson,
    )
    .run();

  let instance = await requireWorkflowInstance(db, instanceId);
  if (isTerminalWorkflowStatus(instance.status)) {
    return { ticket: (await getTicketById(db, ticket.id)) ?? ticket, instance, steps: await listGenericWorkflowSteps(db, instanceId) };
  }

  await updateTicketState(db, ticket.id, "RUNNING", definition.version, now);
  await insertAuditEventOnce(db, {
    id: auditId(instanceId, "workflow.started"),
    tenantId: ticket.tenantId,
    ticketId: ticket.id,
    workflowInstanceId: instanceId,
    actorType: "system",
    action: "workflow.started",
    summary: `Workflow ${definition.key} v${definition.version} started`,
    createdAt: now,
  });

  for (const [index, stepDefinition] of definition.steps.entries()) {
    const stepResult = await runGenericWorkflowStep(db, ticket, instanceId, definition, stepDefinition, index + 1, now);
    if (stepResult.status !== "completed") {
      instance = await requireWorkflowInstance(db, instanceId);
      return {
        ticket: (await getTicketById(db, ticket.id)) ?? ticket,
        instance,
        steps: await listGenericWorkflowSteps(db, instanceId),
      };
    }
  }

  const completedAt = new Date().toISOString();
  await db
    .prepare(
      `UPDATE workflow_instances
          SET status = 'completed', current_step_key = NULL, completed_at = ?, error_message = NULL
        WHERE id = ?`,
    )
    .bind(completedAt, instanceId)
    .run();
  await updateTicketState(db, ticket.id, "COMPLETED", definition.version, completedAt);
  await insertAuditEventOnce(db, {
    id: auditId(instanceId, "workflow.completed"),
    tenantId: ticket.tenantId,
    ticketId: ticket.id,
    workflowInstanceId: instanceId,
    actorType: "system",
    action: "workflow.completed",
    summary: `Workflow ${definition.key} v${definition.version} completed`,
    createdAt: completedAt,
  });

  instance = await requireWorkflowInstance(db, instanceId);
  return {
    ticket: (await getTicketById(db, ticket.id)) ?? ticket,
    instance,
    steps: await listGenericWorkflowSteps(db, instanceId),
  };
}

type StepRunResult = { status: "completed" } | { status: "paused" } | { status: "stopped" };

async function runGenericWorkflowStep(
  db: D1Database,
  ticket: Ticket,
  workflowInstanceId: string,
  definition: NormalizedWorkflowDefinition,
  stepDefinition: WorkflowStepDefinition,
  sequence: number,
  now: string,
): Promise<StepRunResult> {
  const stepId = workflowStepId(workflowInstanceId, sequence);
  const existing = await db.prepare(`SELECT * FROM workflow_steps WHERE id = ?`).bind(stepId).first<WorkflowStepRow>();
  if (existing?.status === "completed") return { status: "completed" };
  if (existing?.status === "waiting_human" && stepDefinition.type === "approval") {
    await pauseForApprovalStep(db, ticket, workflowInstanceId, definition.version, stepId, stepDefinition, sequence, now);
    return { status: "paused" };
  }
  if (existing?.status === "waiting_human" && stepDefinition.type === "tool") {
    return runToolGatewayStep(db, ticket, workflowInstanceId, definition, stepId, stepDefinition, sequence, now);
  }

  await db
    .prepare(
      `UPDATE workflow_instances
          SET status = 'running', current_step_key = ?
        WHERE id = ?`,
    )
    .bind(stepDefinition.id, workflowInstanceId)
    .run();

  await db
    .prepare(
      `INSERT OR IGNORE INTO workflow_steps (
         id, tenant_id, ticket_id, workflow_instance_id, step_key, step_type,
         status, sequence, input_ref, summary, started_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
    )
    .bind(
      stepId,
      ticket.tenantId,
      ticket.id,
      workflowInstanceId,
      stepDefinition.id,
      stepDefinition.type,
      sequence,
      `mock://workflow/${workflowInstanceId}/steps/${sequence}/input`,
      runningSummary(stepDefinition),
      now,
    )
    .run();

  await insertAuditEventOnce(db, {
    id: auditId(workflowInstanceId, `step.${sequence}.started`),
    tenantId: ticket.tenantId,
    ticketId: ticket.id,
    workflowInstanceId,
    workflowStepId: stepId,
    actorType: "system",
    action: "workflow.step.started",
    summary: `Step ${stepDefinition.id} started`,
    createdAt: now,
  });

  if (stepDefinition.type === "approval") {
    await pauseForApprovalStep(db, ticket, workflowInstanceId, definition.version, stepId, stepDefinition, sequence, now);
    return { status: "paused" };
  }

  if (stepDefinition.type === "tool") {
    return runToolGatewayStep(db, ticket, workflowInstanceId, definition, stepId, stepDefinition, sequence, now);
  }

  if (stepDefinition.type === "agent") {
    await recordMockAgentSession(db, ticket, workflowInstanceId, stepDefinition, sequence, now);
  }

  const completedAt = new Date().toISOString();
  await db
    .prepare(
      `UPDATE workflow_steps
          SET status = 'completed', output_ref = ?, summary = ?, completed_at = ?, error_message = NULL
        WHERE id = ?`,
    )
    .bind(
      `mock://workflow/${workflowInstanceId}/steps/${sequence}/output`,
      completedSummary(stepDefinition),
      completedAt,
      stepId,
    )
    .run();

  await insertAuditEventOnce(db, {
    id: auditId(workflowInstanceId, `step.${sequence}.completed`),
    tenantId: ticket.tenantId,
    ticketId: ticket.id,
    workflowInstanceId,
    workflowStepId: stepId,
    actorType: stepDefinition.type === "agent" ? "agent" : "system",
    actorId: stepDefinition.role,
    action: "workflow.step.completed",
    summary: `Step ${stepDefinition.id} completed`,
    createdAt: completedAt,
  });

  return { status: "completed" };
}

async function runToolGatewayStep(
  db: D1Database,
  ticket: Ticket,
  workflowInstanceId: string,
  definition: NormalizedWorkflowDefinition,
  stepId: string,
  stepDefinition: WorkflowStepDefinition,
  sequence: number,
  now: string,
): Promise<StepRunResult> {
  const toolName = stepDefinition.toolName;
  if (!toolName) {
    await failWorkflowStep(db, ticket, workflowInstanceId, definition.version, stepId, stepDefinition, sequence, "Tool step is missing tool name", now);
    return { status: "stopped" };
  }
  if (!definition.allowedTools.includes(toolName)) {
    await failWorkflowStep(db, ticket, workflowInstanceId, definition.version, stepId, stepDefinition, sequence, `Tool ${toolName} is not allowed by workflow`, now);
    return { status: "stopped" };
  }

  const toolDefinition = await loadActiveToolDefinition(db, ticket.tenantId, toolName);
  if (!toolDefinition) {
    await failWorkflowStep(db, ticket, workflowInstanceId, definition.version, stepId, stepDefinition, sequence, `Tool ${toolName} is not active for tenant`, now);
    return { status: "stopped" };
  }

  const schemaError = validateToolInput(toolDefinition.input_schema_json, stepDefinition.input);
  const invocationId = toolInvocationId(stepId, toolName);
  const riskLevel = maxRiskLevel(toolDefinition.risk_level, normalizeRiskLevel(stepDefinition.riskLevel));
  const inputRef = JSON.stringify({ toolName, input: stepDefinition.input, workflowInstanceId, workflowStepId: stepId });
  const idempotencyRequired = Boolean(toolDefinition.idempotency_required);
  const idempotencyKey = idempotencyRequired ? await buildIdempotencyKey(ticket, workflowInstanceId, stepId, toolName, stepDefinition.input) : null;

  await db
    .prepare(
      `INSERT OR IGNORE INTO tool_invocations (
         id, tenant_id, ticket_id, workflow_instance_id, workflow_step_id,
         tool_name, status, risk_level, input_ref, idempotency_key, started_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
    )
    .bind(invocationId, ticket.tenantId, ticket.id, workflowInstanceId, stepId, toolName, riskLevel, inputRef, idempotencyKey, now)
    .run();

  await insertAuditEventOnce(db, {
    id: auditId(workflowInstanceId, `step.${sequence}.tool.invocation.started`),
    tenantId: ticket.tenantId,
    ticketId: ticket.id,
    workflowInstanceId,
    workflowStepId: stepId,
    actorType: "system",
    actorId: "toolgateway",
    action: "tool.invocation.started",
    summary: `Tool ${toolName} invocation started`,
    payloadRef: inputRef,
    createdAt: now,
  });

  if (schemaError) {
    await db.prepare(`UPDATE tool_invocations SET status = 'failed', completed_at = ? WHERE id = ?`).bind(now, invocationId).run();
    await failWorkflowStep(db, ticket, workflowInstanceId, definition.version, stepId, stepDefinition, sequence, schemaError, now);
    return { status: "stopped" };
  }

  const existingInvocation = await getToolInvocation(db, invocationId);
  if (existingInvocation?.status === "completed") {
    await completeWorkflowStepFromTool(db, ticket, workflowInstanceId, stepId, stepDefinition, sequence, existingInvocation.output_ref ?? toolOutputRef(workflowInstanceId, sequence, toolName), now);
    return { status: "completed" };
  }

  const requiresApproval = Boolean(toolDefinition.requires_approval) || riskLevel === "L3" || riskLevel === "L4";
  if (requiresApproval) {
    const approvalId = toolApprovalId(invocationId);
    const approval = await getGenericApprovalById(db, approvalId);
    if (approval?.status !== "approved") {
      await pauseForToolApproval(db, ticket, workflowInstanceId, definition.version, stepId, stepDefinition, sequence, toolName, riskLevel, invocationId, approvalId, inputRef, now);
      return { status: "paused" };
    }
  }

  const replay = idempotencyKey ? await getIdempotencyRecord(db, idempotencyKey) : null;
  if (replay?.status === "completed" && replay.result_ref) {
    await db
      .prepare(`UPDATE tool_invocations SET status = 'completed', output_ref = ?, completed_at = ? WHERE id = ?`)
      .bind(replay.result_ref, now, invocationId)
      .run();
    await completeWorkflowStepFromTool(db, ticket, workflowInstanceId, stepId, stepDefinition, sequence, replay.result_ref, now);
    return { status: "completed" };
  }
  if (replay) {
    const message = `Tool ${toolName} idempotency key is already ${replay.status.replace("_", " ")}`;
    await db.prepare(`UPDATE tool_invocations SET status = 'failed', completed_at = ? WHERE id = ?`).bind(now, invocationId).run();
    await failWorkflowStep(db, ticket, workflowInstanceId, definition.version, stepId, stepDefinition, sequence, message, now);
    return { status: "stopped" };
  }

  if (idempotencyKey) {
    await createIdempotencyRecord(db, ticket, workflowInstanceId, invocationId, idempotencyKey, toolName, now);
  }

  const outputRef = await executeMockToolHandler(db, ticket, workflowInstanceId, stepId, stepDefinition, sequence, toolDefinition, now);
  await db
    .prepare(`UPDATE tool_invocations SET status = 'completed', output_ref = ?, completed_at = ? WHERE id = ?`)
    .bind(outputRef, now, invocationId)
    .run();
  if (idempotencyKey) {
    await completeIdempotencyRecord(db, idempotencyKey, toolName, outputRef, now);
  }

  await insertAuditEventOnce(db, {
    id: auditId(workflowInstanceId, `step.${sequence}.tool.invocation.completed`),
    tenantId: ticket.tenantId,
    ticketId: ticket.id,
    workflowInstanceId,
    workflowStepId: stepId,
    actorType: "system",
    actorId: "toolgateway",
    action: "tool.invocation.completed",
    summary: `Tool ${toolName} invocation completed`,
    payloadRef: outputRef,
    createdAt: now,
  });
  await completeWorkflowStepFromTool(db, ticket, workflowInstanceId, stepId, stepDefinition, sequence, outputRef, now);
  return { status: "completed" };
}

async function pauseForApprovalStep(
  db: D1Database,
  ticket: Ticket,
  workflowInstanceId: string,
  workflowVersion: number,
  stepId: string,
  stepDefinition: WorkflowStepDefinition,
  sequence: number,
  now: string,
): Promise<void> {
  const approvalId = workflowApprovalId(stepId);
  const requestRef = JSON.stringify({
    actionSummary: approvalActionSummary(stepDefinition),
    riskLevel: stepDefinition.riskLevel ?? "medium",
    evidence: [],
    effect: "approved resumes the workflow at the next step; rejected cancels it; changes_requested moves the ticket to REWORK",
    workflowInstanceId,
    workflowStepId: stepId,
    stepKey: stepDefinition.id,
  });

  await db
    .prepare(
      `INSERT OR IGNORE INTO approvals (
         id, tenant_id, profile_id, issue_id, run_id, action, status,
         requested_by, request_ref, created_at, ticket_id, workflow_instance_id,
         workflow_step_id, approver_group, expires_at
       ) VALUES (?, ?, ?, NULL, NULL, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      approvalId,
      ticket.tenantId,
      GENERIC_APPROVAL_PROFILE_ID,
      stepDefinition.action ?? `approval.${stepDefinition.id}`,
      "workflow-runtime",
      requestRef,
      now,
      ticket.id,
      workflowInstanceId,
      stepId,
      stepDefinition.approverGroup,
      approvalExpiresAt(now, stepDefinition.expiresIn),
    )
    .run();

  await db
    .prepare(
      `UPDATE workflow_steps
          SET status = 'waiting_human', summary = ?, error_message = NULL
        WHERE id = ?`,
    )
    .bind(`Waiting for ${stepDefinition.approverGroup ?? "human"} approval: ${approvalActionSummary(stepDefinition)}`, stepId)
    .run();

  await db
    .prepare(
      `UPDATE workflow_instances
          SET status = 'waiting_human', current_step_key = ?, error_message = NULL
        WHERE id = ?`,
    )
    .bind(stepDefinition.id, workflowInstanceId)
    .run();
  await updateTicketState(db, ticket.id, "WAITING_HUMAN", workflowVersion, now);

  await insertAuditEventOnce(db, {
    id: auditId(workflowInstanceId, `step.${sequence}.approval.requested`),
    tenantId: ticket.tenantId,
    ticketId: ticket.id,
    workflowInstanceId,
    workflowStepId: stepId,
    actorType: "system",
    action: "approval.requested",
    summary: `Approval requested for ${stepDefinition.id}`,
    payloadRef: requestRef,
    createdAt: now,
  });
}

async function pauseForToolApproval(
  db: D1Database,
  ticket: Ticket,
  workflowInstanceId: string,
  workflowVersion: number,
  stepId: string,
  stepDefinition: WorkflowStepDefinition,
  sequence: number,
  toolName: string,
  riskLevel: ToolRiskLevel,
  invocationId: string,
  approvalId: string,
  inputRef: string,
  now: string,
): Promise<void> {
  const requestRef = JSON.stringify({
    actionSummary: `Approve governed tool ${toolName}`,
    riskLevel,
    evidence: [inputRef],
    effect: "approved executes the governed tool via ToolGateway; rejected cancels it; changes_requested moves the ticket to REWORK",
    workflowInstanceId,
    workflowStepId: stepId,
    toolInvocationId: invocationId,
    toolName,
  });

  await db
    .prepare(
      `INSERT OR IGNORE INTO approvals (
         id, tenant_id, profile_id, issue_id, run_id, action, status,
         requested_by, request_ref, created_at, ticket_id, workflow_instance_id,
         workflow_step_id, approver_group, expires_at
       ) VALUES (?, ?, ?, NULL, NULL, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      approvalId,
      ticket.tenantId,
      GENERIC_APPROVAL_PROFILE_ID,
      `tool.${toolName}`,
      "toolgateway",
      requestRef,
      now,
      ticket.id,
      workflowInstanceId,
      stepId,
      stepDefinition.approverGroup ?? "tool_approvers",
      approvalExpiresAt(now, stepDefinition.expiresIn),
    )
    .run();

  await db
    .prepare(`UPDATE tool_invocations SET status = 'approval_wait', approval_id = ?, risk_level = ?, input_ref = ? WHERE id = ?`)
    .bind(approvalId, riskLevel, inputRef, invocationId)
    .run();

  await db
    .prepare(`UPDATE workflow_steps SET status = 'waiting_human', summary = ?, error_message = NULL WHERE id = ?`)
    .bind(`Waiting for ${riskLevel} ToolGateway approval: ${toolName}`, stepId)
    .run();
  await db
    .prepare(`UPDATE workflow_instances SET status = 'waiting_human', current_step_key = ?, error_message = NULL WHERE id = ?`)
    .bind(stepDefinition.id, workflowInstanceId)
    .run();
  await updateTicketState(db, ticket.id, "WAITING_HUMAN", workflowVersion, now);

  await insertAuditEventOnce(db, {
    id: auditId(workflowInstanceId, `step.${sequence}.tool.approval.requested`),
    tenantId: ticket.tenantId,
    ticketId: ticket.id,
    workflowInstanceId,
    workflowStepId: stepId,
    actorType: "system",
    actorId: "toolgateway",
    action: "approval.requested",
    summary: `Approval requested for tool ${toolName}`,
    payloadRef: requestRef,
    createdAt: now,
  });
}

async function completeApprovalStep(
  db: D1Database,
  ticket: Ticket,
  instance: GenericWorkflowInstance,
  workflowStep: WorkflowStepRow,
  decidedBy: string,
  now: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE workflow_steps
          SET status = 'completed', output_ref = ?, summary = ?, completed_at = ?, error_message = NULL
        WHERE id = ?`,
    )
    .bind(
      `mock://workflow/${instance.id}/steps/${workflowStep.sequence}/approval-decision`,
      `Approval ${workflowStep.step_key} approved by ${decidedBy}`,
      now,
      workflowStep.id,
    )
    .run();

  await insertAuditEventOnce(db, {
    id: auditId(instance.id, `step.${workflowStep.sequence}.completed`),
    tenantId: ticket.tenantId,
    ticketId: ticket.id,
    workflowInstanceId: instance.id,
    workflowStepId: workflowStep.id,
    actorType: "system",
    action: "workflow.step.completed",
    summary: `Step ${workflowStep.step_key} completed after approval`,
    createdAt: now,
  });
}

async function completeWorkflowStepFromTool(
  db: D1Database,
  ticket: Ticket,
  workflowInstanceId: string,
  stepId: string,
  stepDefinition: WorkflowStepDefinition,
  sequence: number,
  outputRef: string,
  now: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE workflow_steps
          SET status = 'completed', output_ref = ?, summary = ?, completed_at = ?, error_message = NULL
        WHERE id = ?`,
    )
    .bind(outputRef, `ToolGateway completed ${stepDefinition.toolName ?? stepDefinition.id}`, now, stepId)
    .run();

  await insertAuditEventOnce(db, {
    id: auditId(workflowInstanceId, `step.${sequence}.completed`),
    tenantId: ticket.tenantId,
    ticketId: ticket.id,
    workflowInstanceId,
    workflowStepId: stepId,
    actorType: "system",
    actorId: "toolgateway",
    action: "workflow.step.completed",
    summary: `Step ${stepDefinition.id} completed`,
    payloadRef: outputRef,
    createdAt: now,
  });
}

async function failWorkflowStep(
  db: D1Database,
  ticket: Ticket,
  workflowInstanceId: string,
  workflowVersion: number,
  stepId: string,
  stepDefinition: WorkflowStepDefinition,
  sequence: number,
  message: string,
  now: string,
): Promise<void> {
  await db
    .prepare(`UPDATE workflow_steps SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?`)
    .bind(message, now, stepId)
    .run();
  await db
    .prepare(`UPDATE workflow_instances SET status = 'failed', current_step_key = NULL, completed_at = ?, error_message = ? WHERE id = ?`)
    .bind(now, message, workflowInstanceId)
    .run();
  await updateTicketState(db, ticket.id, "FAILED", workflowVersion, now);
  await insertAuditEventOnce(db, {
    id: auditId(workflowInstanceId, `step.${sequence}.failed`),
    tenantId: ticket.tenantId,
    ticketId: ticket.id,
    workflowInstanceId,
    workflowStepId: stepId,
    actorType: "system",
    actorId: "toolgateway",
    action: "workflow.step.failed",
    summary: `Step ${stepDefinition.id} failed: ${message}`,
    createdAt: now,
  });
}

async function stopWorkflowForApprovalDecision(
  db: D1Database,
  ticket: Ticket,
  instance: GenericWorkflowInstance,
  workflowStep: WorkflowStepRow,
  decision: Exclude<GenericApprovalDecision, "approved">,
  ticketStatus: TicketStatus,
  instanceStatus: WorkflowInstanceStatus,
  decidedBy: string,
  now: string,
): Promise<void> {
  const summary = decision === "changes_requested" ? `Approval requested changes by ${decidedBy}` : `Approval rejected by ${decidedBy}`;
  await db
    .prepare(
      `UPDATE workflow_steps
          SET status = 'cancelled', output_ref = ?, summary = ?, completed_at = ?, error_message = ?
        WHERE id = ?`,
    )
    .bind(
      `mock://workflow/${instance.id}/steps/${workflowStep.sequence}/approval-decision`,
      summary,
      now,
      summary,
      workflowStep.id,
    )
    .run();

  await db
    .prepare(
      `UPDATE workflow_instances
          SET status = ?, current_step_key = NULL, completed_at = ?, error_message = ?
        WHERE id = ?`,
    )
    .bind(instanceStatus, now, summary, instance.id)
    .run();
  await db
    .prepare(`UPDATE tool_invocations SET status = 'rejected', completed_at = ? WHERE workflow_step_id = ? AND status = 'approval_wait'`)
    .bind(now, workflowStep.id)
    .run();
  await updateTicketState(db, ticket.id, ticketStatus, instance.workflowVersion, now);

  await insertAuditEventOnce(db, {
    id: auditId(instance.id, `step.${workflowStep.sequence}.${decision}`),
    tenantId: ticket.tenantId,
    ticketId: ticket.id,
    workflowInstanceId: instance.id,
    workflowStepId: workflowStep.id,
    actorType: "system",
    action: decision === "changes_requested" ? "workflow.rework_requested" : "workflow.cancelled",
    summary,
    createdAt: now,
  });
}

async function recordMockAgentSession(
  db: D1Database,
  ticket: Ticket,
  workflowInstanceId: string,
  stepDefinition: WorkflowStepDefinition,
  sequence: number,
  now: string,
): Promise<void> {
  const role = stepDefinition.role ?? "executor";
  const agentSessionId = `${workflowInstanceId}:agent:${sequence}`;
  await db
    .prepare(
      `INSERT OR IGNORE INTO agent_sessions (
         id, tenant_id, ticket_id, workflow_instance_id, role, adapter_kind,
         status, memory_scope, memory_ref, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'mock', 'thinking', 'ticket', ?, ?, ?)`,
    )
    .bind(
      agentSessionId,
      ticket.tenantId,
      ticket.id,
      workflowInstanceId,
      role,
      `mock://workflow/${workflowInstanceId}/agent/${sequence}/memory`,
      now,
      now,
    )
    .run();
  await db
    .prepare(`UPDATE agent_sessions SET status = 'done', updated_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), agentSessionId)
    .run();
}

async function loadActiveToolDefinition(db: D1Database, tenantId: string, toolName: string): Promise<ToolDefinitionRow | null> {
  return db
    .prepare(
      `SELECT *
         FROM tool_definitions
        WHERE tenant_id = ? AND name = ? AND status = 'active' AND archived_at IS NULL
        LIMIT 1`,
    )
    .bind(tenantId, toolName)
    .first<ToolDefinitionRow>();
}

async function getToolInvocation(db: D1Database, invocationId: string): Promise<ToolInvocationRow | null> {
  return db.prepare(`SELECT * FROM tool_invocations WHERE id = ?`).bind(invocationId).first<ToolInvocationRow>();
}

async function getIdempotencyRecord(db: D1Database, idempotencyKey: string): Promise<IdempotencyRecordRow | null> {
  return db.prepare(`SELECT * FROM idempotency_records WHERE idem_key = ?`).bind(idempotencyKey).first<IdempotencyRecordRow>();
}

async function createIdempotencyRecord(
  db: D1Database,
  ticket: Ticket,
  workflowInstanceId: string,
  invocationId: string,
  idempotencyKey: string,
  toolName: string,
  now: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO idempotency_records (
         idem_key, tenant_id, profile_id, issue_id, run_id, tool_call_id,
         operation_type, status, lease_owner, attempt_count, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'in_progress', 'toolgateway', 1, ?)`,
    )
    .bind(idempotencyKey, ticket.tenantId, GENERIC_APPROVAL_PROFILE_ID, ticket.id, workflowInstanceId, invocationId, toolName, now)
    .run();
}

async function completeIdempotencyRecord(db: D1Database, idempotencyKey: string, toolName: string, outputRef: string, now: string): Promise<void> {
  await db
    .prepare(
      `UPDATE idempotency_records
          SET status = 'completed', external_ref = ?, result_ref = ?, finalized_at = ?
        WHERE idem_key = ?`,
    )
    .bind(`mock://${toolName}`, outputRef, now, idempotencyKey)
    .run();
}

async function executeMockToolHandler(
  db: D1Database,
  ticket: Ticket,
  workflowInstanceId: string,
  stepId: string,
  stepDefinition: WorkflowStepDefinition,
  sequence: number,
  toolDefinition: ToolDefinitionRow,
  now: string,
): Promise<string> {
  if (toolDefinition.handler === "artifact.create" || toolDefinition.name === "artifact.create") {
    const artifactId = `${stepId}:artifact`;
    const kind = stringInput(stepDefinition.input, "kind") ?? "json";
    const mimeType = stringInput(stepDefinition.input, "mimeType") ?? "application/json";
    const r2Key = `mock-r2://artifacts/${ticket.id}/${encodeURIComponent(stepId)}.json`;
    const metadata = isRecord(stepDefinition.input.metadata) ? stepDefinition.input.metadata : {};
    await db
      .prepare(
        `INSERT OR IGNORE INTO artifacts (
           id, tenant_id, ticket_id, workflow_instance_id, workflow_step_id,
           kind, r2_key, mime_type, metadata_json, created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'toolgateway', ?)`,
      )
      .bind(artifactId, ticket.tenantId, ticket.id, workflowInstanceId, stepId, kind, r2Key, mimeType, JSON.stringify(metadata), now)
      .run();
    await insertAuditEventOnce(db, {
      id: auditId(workflowInstanceId, `step.${sequence}.artifact.created`),
      tenantId: ticket.tenantId,
      ticketId: ticket.id,
      workflowInstanceId,
      workflowStepId: stepId,
      actorType: "system",
      actorId: "toolgateway",
      action: "artifact.created",
      summary: `Artifact ${kind} created by ToolGateway`,
      payloadRef: r2Key,
      createdAt: now,
    });
    return r2Key;
  }

  return toolOutputRef(workflowInstanceId, sequence, toolDefinition.name);
}

async function updateTicketState(
  db: D1Database,
  ticketId: string,
  status: TicketStatus,
  workflowVersion: number,
  updatedAt: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE tickets
          SET status = ?, workflow_version = ?, updated_at = ?
        WHERE id = ?`,
    )
    .bind(status, workflowVersion, updatedAt, ticketId)
    .run();
}

async function insertAuditEventOnce(db: D1Database, input: AuditEventInput): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO audit_events (
         id, tenant_id, ticket_id, workflow_instance_id, workflow_step_id,
         actor_type, actor_id, action, severity, summary, payload_ref, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'info', ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.tenantId,
      input.ticketId,
      input.workflowInstanceId,
      input.workflowStepId ?? null,
      input.actorType,
      input.actorId ?? null,
      input.action,
      input.summary,
      input.payloadRef ?? null,
      input.createdAt,
    )
    .run();
}

async function requireWorkflowInstance(db: D1Database, workflowInstanceId: string): Promise<GenericWorkflowInstance> {
  const instance = await getGenericWorkflowInstanceById(db, workflowInstanceId);
  if (!instance) throw new Error(`workflow_instance_not_found_after_insert:${workflowInstanceId}`);
  return instance;
}

function normalizeWorkflowDefinition(row: WorkflowDefinitionRow): NormalizedWorkflowDefinition {
  const body = parseJsonObject(row.definition_json);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    key: stringProperty(body, "key") ?? row.key,
    version: numberProperty(body, "version") ?? row.version,
    name: stringProperty(body, "name") ?? row.name,
    allowedTools: normalizeAllowedTools(body.tools),
    steps: normalizeSteps(body.steps),
  };
}

function normalizeSteps(rawSteps: unknown): WorkflowStepDefinition[] {
  if (!Array.isArray(rawSteps)) return [defaultStep()];
  const steps = rawSteps.map(normalizeStep).filter((step): step is WorkflowStepDefinition => step !== null);
  return steps.length > 0 ? steps : [defaultStep()];
}

function normalizeStep(rawStep: unknown, index: number): WorkflowStepDefinition | null {
  if (!isRecord(rawStep)) return null;
  const id = stringProperty(rawStep, "id") ?? `step_${index + 1}`;
  const type = stringProperty(rawStep, "type") ?? "agent";
  return {
    id,
    type,
    toolName: stringProperty(rawStep, "tool") ?? stringProperty(rawStep, "toolName"),
    input: recordProperty(rawStep, "input") ?? {},
    role: stringProperty(rawStep, "role"),
    goal: stringProperty(rawStep, "goal"),
    summary: stringProperty(rawStep, "summary"),
    approverGroup: stringProperty(rawStep, "approver_group") ?? stringProperty(rawStep, "approverGroup"),
    action: stringProperty(rawStep, "action"),
    riskLevel: stringProperty(rawStep, "risk_level") ?? stringProperty(rawStep, "riskLevel"),
    expiresIn: stringProperty(rawStep, "expires_in") ?? stringProperty(rawStep, "expiresIn"),
  };
}

function defaultStep(): WorkflowStepDefinition {
  return {
    id: "mock_agent",
    type: "agent",
    toolName: null,
    input: {},
    role: "executor",
    goal: "Complete the mock generic workflow step.",
    summary: null,
    approverGroup: null,
    action: null,
    riskLevel: null,
    expiresIn: null,
  };
}

function runningSummary(stepDefinition: WorkflowStepDefinition): string {
  if (stepDefinition.summary) return stepDefinition.summary;
  if (stepDefinition.goal) return stepDefinition.goal;
  return `Running ${stepDefinition.type} step ${stepDefinition.id}`;
}

function completedSummary(stepDefinition: WorkflowStepDefinition): string {
  if (stepDefinition.goal) return `Mock ${stepDefinition.type} step completed: ${stepDefinition.goal}`;
  return `Mock ${stepDefinition.type} step ${stepDefinition.id} completed`;
}

function workflowInstanceId(ticketId: string, workflowKey: string, version: number): string {
  return `wfi:${ticketId}:${workflowKey}:v${version}`;
}

function workflowStepId(workflowInstanceId: string, sequence: number): string {
  return `${workflowInstanceId}:step:${sequence}`;
}

function toolInvocationId(workflowStepId: string, toolName: string): string {
  return `${workflowStepId}:tool:${toolName}`;
}

function workflowApprovalId(workflowStepId: string): string {
  return `${workflowStepId}:approval`;
}

function toolApprovalId(toolInvocationId: string): string {
  return `${toolInvocationId}:approval`;
}

function auditId(workflowInstanceId: string, name: string): string {
  return `${workflowInstanceId}:audit:${name}`;
}

function toolOutputRef(workflowInstanceId: string, sequence: number, toolName: string): string {
  return `mock://workflow/${workflowInstanceId}/steps/${sequence}/tools/${toolName}/output`;
}

function isTerminalWorkflowStatus(status: WorkflowInstanceStatus): boolean {
  return ["completed", "failed", "cancelled", "expired"].includes(status);
}

function approvalActionSummary(stepDefinition: WorkflowStepDefinition): string {
  if (stepDefinition.goal) return stepDefinition.goal;
  if (stepDefinition.summary) return stepDefinition.summary;
  return `Approve workflow step ${stepDefinition.id}`;
}

function approvalExpiresAt(now: string, expiresIn: string | null): string | null {
  if (!expiresIn) return null;
  const match = /^(\d+)\s*(minute|minutes|hour|hours|day|days)$/i.exec(expiresIn.trim());
  if (!match?.[1] || !match[2]) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2].toLowerCase();
  const multiplier = unit.startsWith("minute") ? 60_000 : unit.startsWith("hour") ? 3_600_000 : 86_400_000;
  const base = Date.parse(now);
  if (!Number.isFinite(base)) return null;
  return new Date(base + value * multiplier).toISOString();
}

function normalizeAllowedTools(rawTools: unknown): string[] {
  if (!Array.isArray(rawTools)) return [];
  return rawTools.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0).map((tool) => tool.trim());
}

function normalizeRiskLevel(value: string | null): ToolRiskLevel | null {
  if (!value) return null;
  return ["L0", "L1", "L2", "L3", "L4"].includes(value) ? (value as ToolRiskLevel) : null;
}

function maxRiskLevel(base: ToolRiskLevel, override: ToolRiskLevel | null): ToolRiskLevel {
  if (!override) return base;
  return riskRank(override) > riskRank(base) ? override : base;
}

function riskRank(riskLevel: ToolRiskLevel): number {
  return Number(riskLevel.slice(1));
}

function validateToolInput(schemaJson: string, input: Record<string, unknown>): string | null {
  const schema = parseToolInputSchema(schemaJson);
  if (schema === null) return "Tool input schema must be valid JSON";
  if (!isRecord(schema)) return "Tool input schema must be a JSON object";
  const required = Array.isArray(schema.required) ? schema.required.filter((field): field is string => typeof field === "string") : [];
  for (const field of required) {
    const value = input[field];
    if (value === undefined || value === null || value === "") return `Tool input missing required field: ${field}`;
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [field, rawRule] of Object.entries(properties)) {
    const value = input[field];
    if (value === undefined || value === null || !isRecord(rawRule)) continue;
    const type = stringProperty(rawRule, "type");
    if (type && !matchesJsonType(value, type)) return `Tool input field ${field} must be ${type}`;
  }
  return null;
}

function parseToolInputSchema(schemaJson: string): unknown | null {
  try {
    return JSON.parse(schemaJson) as unknown;
  } catch {
    return null;
  }
}

function matchesJsonType(value: unknown, type: string): boolean {
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function shapeWorkflowInstance(row: WorkflowInstanceRow): GenericWorkflowInstance {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ticketId: row.ticket_id,
    workflowKey: row.workflow_key,
    workflowVersion: row.workflow_version,
    status: row.status,
    currentStepKey: row.current_step_key,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorMessage: row.error_message,
    runtime: parseJson(row.runtime_json, null),
  };
}

function shapeWorkflowStep(row: WorkflowStepRow): GenericWorkflowStep {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ticketId: row.ticket_id,
    workflowInstanceId: row.workflow_instance_id,
    stepKey: row.step_key,
    stepType: row.step_type,
    status: row.status,
    sequence: row.sequence,
    inputRef: row.input_ref,
    outputRef: row.output_ref,
    summary: row.summary,
    retryCount: row.retry_count,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorMessage: row.error_message,
  };
}

function shapeApproval(row: ApprovalRow): GenericApproval {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ticketId: row.ticket_id,
    workflowInstanceId: row.workflow_instance_id,
    workflowStepId: row.workflow_step_id,
    action: row.action,
    status: row.status,
    requestedBy: row.requested_by,
    decidedBy: row.decided_by,
    requestRef: row.request_ref,
    decisionRef: row.decision_ref,
    approverGroup: row.approver_group,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    expiresAt: row.expires_at,
  };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  return parseJson(raw, {});
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringProperty(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function stringInput(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordProperty(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function numberProperty(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

async function buildIdempotencyKey(
  ticket: Ticket,
  workflowInstanceId: string,
  workflowStepId: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<string> {
  const digest = await sha256Hex(stableJson(input));
  return `idem:g7:${ticket.tenantId}:${ticket.id}:${workflowInstanceId}:${workflowStepId}:${toolName}:${digest}`;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
