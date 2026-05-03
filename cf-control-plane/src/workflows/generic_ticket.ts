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
  role: string | null;
  goal: string | null;
  summary: string | null;
};

type NormalizedWorkflowDefinition = {
  id: string;
  tenantId: string;
  key: string;
  version: number;
  name: string;
  steps: WorkflowStepDefinition[];
};

type AuditEventInput = {
  id: string;
  tenantId: string;
  ticketId: string;
  workflowInstanceId: string;
  workflowStepId?: string | null;
  actorType: "system" | "agent";
  actorId?: string | null;
  action: string;
  summary: string;
  createdAt: string;
  payloadRef?: string | null;
};

const GENERIC_RUNTIME_KIND = "mock_generic_ticket_workflow";

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
  if (instance.status === "completed") {
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
    await runGenericWorkflowStep(db, ticket, instanceId, stepDefinition, index + 1, now);
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

async function runGenericWorkflowStep(
  db: D1Database,
  ticket: Ticket,
  workflowInstanceId: string,
  stepDefinition: WorkflowStepDefinition,
  sequence: number,
  now: string,
): Promise<void> {
  const stepId = workflowStepId(workflowInstanceId, sequence);
  const existing = await db.prepare(`SELECT * FROM workflow_steps WHERE id = ?`).bind(stepId).first<WorkflowStepRow>();
  if (existing?.status === "completed") return;

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
    role: stringProperty(rawStep, "role"),
    goal: stringProperty(rawStep, "goal"),
    summary: stringProperty(rawStep, "summary"),
  };
}

function defaultStep(): WorkflowStepDefinition {
  return {
    id: "mock_agent",
    type: "agent",
    role: "executor",
    goal: "Complete the mock generic workflow step.",
    summary: null,
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

function auditId(workflowInstanceId: string, name: string): string {
  return `${workflowInstanceId}:audit:${name}`;
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

function numberProperty(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}
