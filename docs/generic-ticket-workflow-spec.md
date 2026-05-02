# Generic Ticket Workflow Specification

Status: Draft v2 target specification
Date: 2026-05-03
Baseline: `vmxmy/symphony` main after `78a3bfb`; `cf-control-plane` has a
known green baseline of 150 tests and `tsc --noEmit` clean.
Scope: Define Symphony vNext as a generic agent ticket workflow platform.

This document is the product/runtime specification for the next architecture
target. It does not delete the original coding-agent contract in `SPEC.md`.
Instead, it reclassifies the existing Linear/Codex issue runner as one
compatibility workflow inside a broader ticket-native platform.

## Normative Language

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`,
`RECOMMENDED`, `MAY`, and `OPTIONAL` are interpreted as described in RFC 2119.

`Implementation-defined` means implementations may choose a concrete mechanism,
but MUST document the choice and preserve the externally visible contract.

## 1. Product Thesis

Symphony vNext is a generic agent ticket workflow platform:

```text
Ticket
  -> WorkflowInstance
  -> WorkflowStep
  -> AgentRole / ToolInvocation / Approval / Artifact / AuditEvent
```

The platform turns a natural-language or structured ticket into a traceable,
auditable, resumable workflow that can use agents, tools, human approvals,
external waits, artifacts, retries, SLA policies, and connector sync.

The core product is not a coding-agent scaffold. Coding work remains supported,
but as a `coding_agent_run` workflow step implemented by a compatibility adapter.

## 2. Product Positioning

### 2.1 Primary Product

```text
Universal Agent Ticket Workflow Platform
```

Chinese product framing:

```text
泛化 Agent 工单工作流平台
```

The product's core value is:

```text
Make long-running agent work ticket-native, workflow-first, human-governed,
artifact-backed, and audit-safe.
```

### 2.2 Target Workflows

The platform MUST support non-coding workflows such as:

- customer complaint handling
- vendor due diligence
- contract review
- procurement approval
- recruiting workflows
- content review
- market research
- sales lead follow-up
- compliance checks
- report generation
- data cleanup tasks
- cross-functional project coordination

Coding workflows remain supported as one workflow family, not the product core.

## 3. Goals and Non-Goals

### 3.1 Goals

- Provide a first-class internal `Ticket` model independent of Linear, Jira,
  Slack, email, or any other external source.
- Support external systems as connectors: source, notification channel, and
  optional sync target.
- Execute long-running, retryable, resumable `WorkflowInstance`s with durable
  step state.
- Model agent work through role-scoped `AgentSession`s.
- Route tool calls through a policy-checked `ToolGateway`.
- Gate risky actions through first-class human approvals.
- Store artifacts in R2 with D1 metadata and audit pointers.
- Persist all meaningful workflow decisions, state changes, tool calls, approval
  decisions, and artifact references as audit events.
- Expose an Agent Control Center dashboard that replaces Linear as the primary
  workflow-bearing UI.
- Preserve existing Cloudflare control-plane work and current coding-agent
  compatibility paths during the migration.

### 3.2 Non-Goals

- Rebuilding every Linear product feature before the generic workflow core is
  usable.
- Migrating the Linear SaaS UI. Linear UI is not a portable module.
- Making Linear, Codex, or local workspaces mandatory in the final architecture.
- Exposing model chain-of-thought. Operator UI MUST show action summaries,
  decisions, evidence, tool calls, and outputs, not private reasoning traces.
- Running arbitrary shell commands inside the control-plane Worker.
- Building a complex visual workflow editor in the MVP.

## 4. Architecture Overview

### 4.1 Target Component Map

```text
External sources
API / Linear / Jira / Slack / Email / Notion / Web Form / Webhook
        |
        v
Cloudflare Worker API Gateway
  - auth / tenant / RBAC
  - ticket intake
  - connector normalization
  - workflow launch
  - approval decisions
        |
        v
Cloudflare Workflows
  - durable workflow instances
  - retryable step boundaries
  - waiting / approval / external event gates
  - SLA timeout and escalation hooks
        |
        +--> Durable Objects / Agents
        |     - TenantAgent
        |     - WorkflowAgent or TicketAgent
        |     - AgentSession owners
        |
        +--> D1
        |     - tickets, workflow records, approvals, audit indexes
        |
        +--> R2
        |     - artifacts, logs, payload envelopes, large outputs
        |
        +--> Queues
        |     - connector events, async dispatch, retries, notifications
        |
        +--> ToolGateway
        |     - policy, idempotency, approval, execution, audit
        |
        +--> Agent Control Center
              - tickets, timeline, approvals, artifacts, audit, admin
```

### 4.2 Cloudflare Responsibility Split

| Cloudflare primitive | Responsibility |
|---|---|
| Workers | API gateway, connector webhooks, dashboard API, auth checks |
| Workflows | durable workflow orchestration and step replay boundaries |
| Durable Objects / Agents | hot entity state, per-ticket coordination, agent sessions |
| D1 | queryable relational index and durable metadata |
| R2 | large immutable artifacts, payload envelopes, logs, manifests |
| Queues | async fan-out, connector events, notification delivery, retry transport |
| Access / Zero Trust | operator and dashboard protection |
| AI Gateway | model routing, rate limits, cost/usage observability, fallback policy |
| Analytics Engine | high-cardinality metrics and operational analysis |

### 4.3 Compatibility Paths

The current coding system is preserved through compatibility adapters:

```text
Linear issue        -> TicketSource(kind=linear)
IssueAgent          -> compatibility owner for coding issue execution
ExecutionWorkflow   -> coding_agent_run workflow implementation detail
WorkerHost          -> workspace-backed execution substrate
CodexAdapter        -> CodingAgentAdapter(kind=codex_compat)
run_events          -> technical event stream, mirrored/summarized into audit
```

New product code MUST avoid adding new mandatory dependencies on Linear or Codex.

## 5. Core Domain Model

### 5.1 Tenant

A tenant is the top-level security and policy boundary.

Required fields:

```ts
type Tenant = {
  id: string;
  name: string;
  status: "active" | "paused" | "suspended";
  policyJson: unknown;
  createdAt: string;
  updatedAt: string;
};
```

### 5.2 Ticket

A ticket is the canonical internal unit of work.

```ts
type Ticket = {
  id: string;
  tenantId: string;
  key: string;
  type: string;
  title: string;
  description: string;
  requester?: string;
  owner?: string;
  priority: "low" | "normal" | "high" | "urgent";
  status: TicketStatus;
  workflowKey: string;
  workflowVersion?: number;
  inputJson: unknown;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};
```

The platform MUST treat `Ticket.id` as canonical. External ids from Linear,
Jira, Slack, email, or APIs MUST NOT be used as primary ticket ids.

### 5.3 TicketSource

`TicketSource` maps an external object to a canonical internal ticket.

```ts
type TicketSource = {
  id: string;
  tenantId: string;
  ticketId: string;
  sourceKind: "api" | "manual" | "linear" | "jira" | "slack" | "email" | "notion" | "webhook";
  externalId?: string;
  externalKey?: string;
  externalUrl?: string;
  syncStatus: "active" | "paused" | "error" | "disabled";
  lastSyncedAt?: string;
  createdAt: string;
  updatedAt: string;
};
```

Connector implementations MUST be idempotent on `(tenantId, sourceKind,
externalId)` when `externalId` is available.

### 5.4 WorkflowDefinition

A workflow definition declares how a ticket type is processed.

```ts
type WorkflowDefinition = {
  id: string;
  tenantId: string;
  key: string;
  version: number;
  name: string;
  status: "draft" | "active" | "paused" | "archived";
  definitionJson: WorkflowDefinitionBody;
  sourceRef?: string;
  createdAt: string;
  updatedAt: string;
};
```

Workflow definitions MAY be stored as file bundles, R2 objects, or D1 records.
The active version MUST be immutable for already-started workflow instances.

### 5.5 WorkflowInstance

A workflow instance is one durable execution of a workflow definition for a ticket.

```ts
type WorkflowInstance = {
  id: string;
  tenantId: string;
  ticketId: string;
  workflowKey: string;
  workflowVersion: number;
  status: WorkflowInstanceStatus;
  currentStepKey?: string;
  startedAt: string;
  completedAt?: string;
  errorMessage?: string;
  runtimeJson?: unknown;
};
```

### 5.6 WorkflowStep

A workflow step is one durable unit inside a workflow instance.

```ts
type WorkflowStep = {
  id: string;
  tenantId: string;
  ticketId: string;
  workflowInstanceId: string;
  stepKey: string;
  stepType: StepType;
  status: StepStatus;
  sequence: number;
  inputRef?: string;
  outputRef?: string;
  summary?: string;
  retryCount: number;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
};
```

Large step inputs and outputs SHOULD live in R2. D1 SHOULD store pointers and
short summaries.

### 5.7 AgentRole and AgentSession

Agent roles are workflow-scoped responsibilities.

Built-in role ids:

```text
intake
planner
executor
researcher
reviewer
communicator
coding_executor
```

```ts
type AgentSession = {
  id: string;
  tenantId: string;
  ticketId: string;
  workflowInstanceId: string;
  role: string;
  adapterKind: "mock" | "codex_compat" | "cloudflare_native" | "external";
  status: "idle" | "thinking" | "waiting_tool" | "waiting_human" | "done" | "failed";
  memoryScope: "ticket" | "source" | "tenant" | "global";
  memoryRef?: string;
  createdAt: string;
  updatedAt: string;
};
```

An agent session MUST be role-scoped. A workflow MUST NOT rely on one
unbounded omnipotent agent for all stages.

### 5.8 ToolDefinition and ToolInvocation

Tool definitions describe callable capabilities.

```ts
type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  riskLevel: "L0" | "L1" | "L2" | "L3" | "L4";
  requiresApproval: boolean;
  idempotencyRequired: boolean;
  handler: string;
};
```

Tool invocation records audit every tool call.

```ts
type ToolInvocation = {
  id: string;
  tenantId: string;
  ticketId: string;
  workflowInstanceId?: string;
  workflowStepId?: string;
  agentSessionId?: string;
  toolName: string;
  status: "pending" | "running" | "approval_wait" | "completed" | "failed" | "rejected";
  riskLevel: ToolDefinition["riskLevel"];
  inputRef: string;
  outputRef?: string;
  approvalId?: string;
  idempotencyKey?: string;
  startedAt: string;
  completedAt?: string;
};
```

### 5.9 Approval

Approvals are first-class workflow gates.

```ts
type Approval = {
  id: string;
  tenantId: string;
  ticketId: string;
  workflowInstanceId?: string;
  workflowStepId?: string;
  action: string;
  status: "pending" | "approved" | "rejected" | "changes_requested" | "expired";
  approverGroup?: string;
  requestedBy?: string;
  decidedBy?: string;
  requestRef: string;
  decisionRef?: string;
  requestedAt: string;
  decidedAt?: string;
  expiresAt?: string;
};
```

Approval payloads MUST include a short action summary, risk level, supporting
evidence, and the exact effect of approval.

### 5.10 Artifact

Artifacts are workflow outputs or evidence objects.

```ts
type Artifact = {
  id: string;
  tenantId: string;
  ticketId: string;
  workflowInstanceId?: string;
  workflowStepId?: string;
  kind:
    | "report"
    | "summary"
    | "decision"
    | "email_draft"
    | "contract_review"
    | "spreadsheet"
    | "json"
    | "attachment"
    | "snapshot"
    | "log"
    | "approval_pack";
  r2Key: string;
  mimeType: string;
  metadataJson?: unknown;
  createdBy: "agent" | "human" | "tool" | "system";
  createdAt: string;
};
```

### 5.11 Comment

Comments are collaboration messages, not audit records.

```ts
type TicketComment = {
  id: string;
  tenantId: string;
  ticketId: string;
  authorType: "human" | "agent" | "system";
  authorId?: string;
  body: string;
  visibility: "internal" | "external_sync";
  sourceId?: string;
  createdAt: string;
};
```

### 5.12 AuditEvent

Audit events are immutable records of meaningful system actions.

```ts
type AuditEvent = {
  id: string;
  tenantId: string;
  ticketId?: string;
  workflowInstanceId?: string;
  workflowStepId?: string;
  actorType: "system" | "human" | "agent" | "tool" | "connector";
  actorId?: string;
  action: string;
  severity: "debug" | "info" | "warning" | "error";
  summary: string;
  payloadRef?: string;
  createdAt: string;
};
```

Audit events MUST be append-only except for retention/archival metadata.

### 5.13 Notification

Notifications are delivery tasks for humans or external channels.

```ts
type Notification = {
  id: string;
  tenantId: string;
  ticketId?: string;
  channel: "dashboard" | "email" | "slack" | "linear" | "jira" | "webhook";
  recipient: string;
  status: "pending" | "sent" | "failed" | "cancelled";
  payloadRef: string;
  createdAt: string;
  sentAt?: string;
};
```

Notifications SHOULD be queued. A failed notification MUST NOT corrupt the
canonical ticket or workflow state.

## 6. State Machines

### 6.1 Ticket Status

Required ticket statuses:

```text
CREATED
TRIAGING
NEEDS_INFO
PLANNING
PLAN_REVIEW
RUNNING
WAITING_HUMAN
WAITING_EXTERNAL
VALIDATING
REWORK
FINAL_REVIEW
COMPLETED
FAILED
CANCELLED
EXPIRED
ARCHIVED
```

Allowed high-level flow:

```text
CREATED
  -> TRIAGING
  -> NEEDS_INFO
  -> PLANNING
  -> PLAN_REVIEW
  -> RUNNING
  -> WAITING_HUMAN
  -> WAITING_EXTERNAL
  -> VALIDATING
  -> REWORK
  -> FINAL_REVIEW
  -> COMPLETED

Any non-terminal state -> FAILED | CANCELLED | EXPIRED
COMPLETED | FAILED | CANCELLED | EXPIRED -> ARCHIVED
```

The implementation MAY skip states that are not used by a workflow definition,
but it MUST NOT invent arbitrary workflow-specific ticket statuses.

### 6.2 WorkflowInstance Status

Required workflow instance statuses:

```text
created
running
waiting_human
waiting_external
retry_wait
completed
failed
cancelled
expired
```

Only the workflow runtime may move a workflow instance between execution states.
Human actions SHOULD be recorded as approvals/events that the workflow consumes.

### 6.3 WorkflowStep Status

Required step statuses:

```text
pending
running
waiting_human
waiting_external
completed
failed
skipped
cancelled
retry_wait
```

### 6.4 Approval Status

Required approval statuses:

```text
pending
approved
rejected
changes_requested
expired
```

An approval decision MUST be immutable after it leaves `pending`. Any correction
MUST create a new approval or follow-up audit event.

## 7. Workflow Definition Format

Workflow definitions SHOULD be authorable as YAML and storable as JSON.

Example:

```yaml
key: vendor-due-diligence
name: Vendor Due Diligence
version: 1

trigger:
  ticket_types:
    - vendor_review

input_schema:
  required:
    - vendor_name
    - business_purpose
    - requester
  optional:
    - vendor_website
    - contract_value
    - country
    - documents

policy:
  require_plan_approval: true
  require_final_approval: true
  max_runtime_days: 10
  max_agent_iterations: 8
  risk_threshold_for_escalation: medium

roles:
  - id: intake
    description: Verify request completeness and ask for missing information.
  - id: researcher
    description: Gather evidence and summarize risks.
  - id: reviewer
    description: Validate quality, risk, and policy compliance.
  - id: communicator
    description: Produce final human-facing deliverables.

tools:
  allowed:
    - knowledge.search
    - web.search
    - artifact.create
    - approval.request
    - email.draft
  require_human_for:
    - external_notification
    - production_publish

steps:
  - id: intake
    type: agent
    role: intake
    goal: Validate vendor information and ask for missing fields.

  - id: plan_approval
    type: approval
    when: "{{ policy.require_plan_approval }}"
    approver_group: procurement

  - id: research
    type: agent
    role: researcher
    goal: Collect background information and risk evidence.

  - id: risk_review
    type: agent
    role: reviewer
    goal: Produce risk rating, evidence table, and decision recommendation.

  - id: final_approval
    type: approval
    when: "{{ policy.require_final_approval }}"
    approver_group: procurement_manager

  - id: final_report
    type: agent
    role: communicator
    goal: Generate the final report and email draft.

  - id: deliver
    type: tool
    tool: artifact.create
```

### 7.1 Required Step Types

The runtime MUST support these step types:

| Step type | Purpose |
|---|---|
| `agent` | Run one role-scoped agent session |
| `tool` | Invoke a ToolGateway tool |
| `approval` | Create and wait for a human approval |
| `wait` | Wait for time or external event |
| `action` | Built-in workflow action such as status transition or delivery |
| `coding_agent_run` | Compatibility step for existing coding execution |

### 7.2 Prompt Fragments

Prompt fragments MAY be part of workflow bundles, but prompts are not the
workflow definition itself. Implementations SHOULD keep operational policy and
step structure machine-readable.

## 8. Workflow Runtime Semantics

### 8.1 Generic Runtime Loop

The generic workflow runtime MUST:

1. Load the ticket by `ticketId`.
2. Load the immutable workflow definition version selected for the instance.
3. Create a `workflow_instances` row if one does not exist.
4. Execute steps in deterministic sequence unless the definition declares a
   conditional branch.
5. Record every step boundary in `workflow_steps`.
6. Store large input/output payloads in R2 and D1 pointers.
7. Route agent tool calls through ToolGateway.
8. Pause cleanly for approval or external wait.
9. Resume idempotently after decision/event arrival.
10. Mark the workflow terminal only after final audit and artifact persistence.

### 8.2 Replay and Idempotency

Workflow steps may replay. Therefore:

- Mutating side effects MUST go through ToolGateway idempotency records.
- Approval creation MUST be idempotent for a given workflow step.
- Artifact keys SHOULD be deterministic or explicitly versioned.
- External notifications MUST be idempotent.
- Retry is not replay. Retry MAY reattempt only when policy marks the previous
  failure as safe to retry and no completed idempotency record exists.

### 8.3 Human Approval Wait

Approval steps MUST:

1. Write an `approvals` row with status `pending`.
2. Write an audit event.
3. Set the workflow instance and ticket to a waiting state.
4. Notify the approver group.
5. Stop executing subsequent steps until a decision is recorded.

On decision:

```text
approved          -> workflow resumes
rejected          -> workflow cancels or follows a configured rejection branch
changes_requested -> workflow enters REWORK or configured branch
expired           -> workflow escalates or expires by policy
```

### 8.4 External Wait

External waits MUST be represented as workflow state, not hidden in comments.
External callbacks SHOULD enter through Worker API, be normalized into ticket
events, and resume the workflow via deterministic correlation keys.

### 8.5 SLA and Escalation

The MVP MAY implement SLA policy as static timestamps on tickets and approvals.
The target runtime SHOULD support:

- `response_due_at`
- `completion_due_at`
- per-step timeout policy
- approval expiration policy
- escalation notification targets
- terminal `EXPIRED` state

SLA escalation MUST write audit events and notifications.

## 9. ToolGateway and Policy Model

### 9.1 Risk Levels

| Level | Description | Default policy |
|---|---|---|
| L0 | Read-only | Allowed if tool is on allowlist |
| L1 | Draft-only | Allowed with audit |
| L2 | Internal write | Requires workflow policy allow |
| L3 | External action | Requires human approval by default |
| L4 | Financial/legal/irreversible | Requires human approval and second confirmation |

### 9.2 Required Tool Policy Checks

ToolGateway MUST:

1. Reject tools not in the workflow or tenant allowlist.
2. Validate input schema before execution.
3. Compute risk level and approval requirement.
4. Create a tool invocation audit record before execution.
5. Create or check an idempotency record for mutating actions.
6. Pause for approval when required.
7. Store large request/response payloads in R2.
8. Redact secrets before writing logs or artifacts.

### 9.3 MVP Tool Set

The first generic workflow MVP SHOULD implement:

```text
knowledge.search
artifact.create
approval.request
email.draft
webhook.call
```

These MAY be mock or stub implementations if they preserve policy, audit, and
artifact semantics.

## 10. Connector Model

### 10.1 Connector Roles

External systems can play one or more roles:

```text
source        - creates or updates tickets
notification  - receives status/comment notifications
sync_target   - receives selected state/comment/artifact updates
tool_provider - exposes callable business tools
```

Linear, Jira, Slack, email, Notion, Zendesk, and webhooks MUST be modeled as
connectors, not as core product primitives.

### 10.2 Linear Compatibility Mode

Linear compatibility mode MUST follow these rules:

- Linear issue is a `TicketSource`, not the canonical ticket.
- Internal `Ticket` and `WorkflowInstance` records are canonical for workflow
  state.
- Linear MAY receive comments/status updates containing summaries and dashboard
  links.
- Linear comments MUST NOT be the only place approvals, artifacts, or audit
  evidence live.
- Linear API failures MUST NOT corrupt internal workflow state.

Recommended flow:

```text
Linear issue/webhook
  -> Linear connector
  -> create-or-link Ticket
  -> create TicketSource(kind=linear)
  -> launch or update WorkflowInstance
  -> optional Linear comment/status sync
```

### 10.3 Connector Idempotency

Connectors MUST deduplicate inbound events. Recommended key:

```text
connector_event:v1:{tenant_id}:{source_kind}:{external_event_id}
```

If no external event id exists, the connector MUST derive a stable fingerprint
from source id, event type, timestamp bucket, and canonical payload.

## 11. Data Model

This section defines the target D1 tables. Existing tables may remain during
migration.

### 11.1 New Tables

```sql
CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  requester TEXT,
  owner TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'CREATED',
  workflow_key TEXT NOT NULL,
  workflow_version INTEGER,
  input_json TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (tenant_id, key)
);

CREATE TABLE ticket_sources (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  external_id TEXT,
  external_key TEXT,
  external_url TEXT,
  sync_status TEXT NOT NULL DEFAULT 'active',
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_ticket_sources_external
  ON ticket_sources(tenant_id, source_kind, external_id)
  WHERE external_id IS NOT NULL;

CREATE TABLE ticket_comments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  author_type TEXT NOT NULL,
  author_id TEXT,
  body TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'internal',
  source_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE workflow_definitions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  source_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, key, version)
);

CREATE TABLE workflow_instances (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  workflow_key TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  current_step_key TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_message TEXT,
  runtime_json TEXT
);

CREATE TABLE workflow_steps (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  workflow_instance_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  step_type TEXT NOT NULL,
  status TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  input_ref TEXT,
  output_ref TEXT,
  summary TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  error_message TEXT,
  UNIQUE (workflow_instance_id, sequence)
);

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  workflow_instance_id TEXT NOT NULL,
  role TEXT NOT NULL,
  adapter_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  memory_scope TEXT NOT NULL,
  memory_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tool_definitions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  input_schema_json TEXT NOT NULL,
  output_schema_json TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  idempotency_required INTEGER NOT NULL DEFAULT 0,
  handler TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (tenant_id, name)
);

CREATE TABLE tool_invocations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  workflow_instance_id TEXT,
  workflow_step_id TEXT,
  agent_session_id TEXT,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  input_ref TEXT NOT NULL,
  output_ref TEXT,
  approval_id TEXT,
  idempotency_key TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  workflow_instance_id TEXT,
  workflow_step_id TEXT,
  kind TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  metadata_json TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  ticket_id TEXT,
  workflow_instance_id TEXT,
  workflow_step_id TEXT,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  summary TEXT NOT NULL,
  payload_ref TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  ticket_id TEXT,
  channel TEXT NOT NULL,
  recipient TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payload_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
```

### 11.2 Required Indexes

```sql
CREATE INDEX idx_tickets_tenant_status
  ON tickets(tenant_id, status) WHERE archived_at IS NULL;

CREATE INDEX idx_tickets_workflow_status
  ON tickets(tenant_id, workflow_key, status) WHERE archived_at IS NULL;

CREATE INDEX idx_ticket_comments_ticket_time
  ON ticket_comments(ticket_id, created_at);

CREATE INDEX idx_workflow_instances_ticket
  ON workflow_instances(ticket_id, started_at);

CREATE INDEX idx_workflow_instances_status
  ON workflow_instances(tenant_id, status, started_at);

CREATE INDEX idx_workflow_steps_instance_seq
  ON workflow_steps(workflow_instance_id, sequence);

CREATE INDEX idx_agent_sessions_ticket
  ON agent_sessions(ticket_id, status);

CREATE INDEX idx_tool_definitions_tenant_active
  ON tool_definitions(tenant_id, status) WHERE archived_at IS NULL;

CREATE INDEX idx_tool_invocations_ticket
  ON tool_invocations(ticket_id, started_at);

CREATE INDEX idx_tool_invocations_step
  ON tool_invocations(workflow_step_id, started_at)
  WHERE workflow_step_id IS NOT NULL;

CREATE INDEX idx_tool_invocations_status
  ON tool_invocations(tenant_id, status, started_at);

CREATE INDEX idx_tool_invocations_idempotency
  ON tool_invocations(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_artifacts_ticket
  ON artifacts(ticket_id, created_at);

CREATE INDEX idx_audit_events_ticket_time
  ON audit_events(ticket_id, created_at);

CREATE INDEX idx_notifications_pending
  ON notifications(status, created_at);
```

### 11.2.1 Existing Approval Table Extensions

The existing `approvals` table remains the reusable approval surface during
migration. Implementations SHOULD extend it additively for generic workflow
references instead of replacing it in G1:

```sql
ALTER TABLE approvals ADD COLUMN ticket_id TEXT;
ALTER TABLE approvals ADD COLUMN workflow_instance_id TEXT;
ALTER TABLE approvals ADD COLUMN workflow_step_id TEXT;
ALTER TABLE approvals ADD COLUMN approver_group TEXT;
ALTER TABLE approvals ADD COLUMN expires_at TEXT;

CREATE INDEX idx_approvals_ticket_status
  ON approvals(ticket_id, status) WHERE ticket_id IS NOT NULL;

CREATE INDEX idx_approvals_workflow_step
  ON approvals(workflow_instance_id, workflow_step_id)
  WHERE workflow_instance_id IS NOT NULL;
```

### 11.3 Existing Table Reinterpretation

| Existing table | vNext role |
|---|---|
| `issues` | external issue mirror / compatibility read model |
| `runs` | coding execution detail or compatibility workflow run detail |
| `run_steps` | technical steps for the coding execution workflow |
| `run_events` | technical event stream; selected events mirror to `audit_events` |
| `tool_calls` | legacy tool invocation table; may merge into generalized tool invocations later |
| `approvals` | reusable approval table; may be extended rather than replaced |
| `idempotency_records` | reusable side-effect replay guard |

## 12. API Specification

All vNext APIs SHOULD live under `/api/v2`.

### 12.1 Create Ticket

```http
POST /api/v2/tickets
Content-Type: application/json
```

Request:

```json
{
  "type": "vendor_review",
  "title": "Review ACME Data Ltd",
  "description": "Need vendor due diligence before signature.",
  "priority": "high",
  "workflowKey": "vendor-due-diligence",
  "tenantId": "default",
  "input": {
    "vendor_name": "ACME Data Ltd",
    "contract_value": 120000,
    "country": "UK"
  },
  "source": {
    "kind": "api"
  }
}
```

Response:

```json
{
  "ticketId": "tkt_...",
  "ticketKey": "TKT-123",
  "workflowInstanceId": "wfi_...",
  "status": "CREATED"
}
```

### 12.2 List Tickets

```http
GET /api/v2/tickets?status=WAITING_HUMAN&workflowKey=vendor-due-diligence
```

### 12.3 Get Ticket

```http
GET /api/v2/tickets/:ticketId
```

Response MUST include ticket metadata, sources, active workflow summary,
current waiting item, artifact count, and recent audit summaries.

### 12.4 Add Ticket Comment

```http
POST /api/v2/tickets/:ticketId/comments
Content-Type: application/json
```

```json
{
  "body": "The requester uploaded the missing vendor policy document.",
  "visibility": "internal"
}
```

### 12.5 Add External Event

```http
POST /api/v2/tickets/:ticketId/events
Content-Type: application/json
```

```json
{
  "type": "external_response_received",
  "correlationKey": "vendor-docs",
  "payload": {
    "from": "vendor@example.com",
    "message": "Supplemental materials uploaded."
  }
}
```

### 12.6 Get Workflow Instance

```http
GET /api/v2/workflow-instances/:workflowInstanceId
```

### 12.7 Get Workflow Steps

```http
GET /api/v2/workflow-instances/:workflowInstanceId/steps
```

### 12.8 Decide Approval

```http
POST /api/v2/approvals/:approvalId/decision
Content-Type: application/json
```

```json
{
  "decision": "approved",
  "comment": "Proceed, but final report must include legal review notes."
}
```

### 12.9 Get Artifacts

```http
GET /api/v2/tickets/:ticketId/artifacts
```

### 12.10 Connector Webhooks

Connector webhooks SHOULD use namespaced routes:

```text
POST /api/v2/connectors/linear/webhook
POST /api/v2/connectors/slack/events
POST /api/v2/connectors/email/inbound
```

Each connector MUST normalize inbound events into canonical ticket, source,
comment, event, or workflow operations.

## 13. Dashboard Specification

The dashboard is the Agent Control Center. It replaces Linear as the primary
workflow-bearing interface.

### 13.1 MVP Pages

The MVP MUST include:

```text
/tickets
/tickets/:ticketId
/approvals
```

### 13.2 Target Pages

The target dashboard SHOULD include:

| Page | Purpose |
|---|---|
| Ticket Inbox | canonical ticket list, filters, priority, SLA, waiting states |
| Ticket Detail | ticket body, comments, workflow summary, sources, artifacts |
| Workflow Timeline | step inputs/outputs, summaries, retries, errors, durations |
| Approval Center | pending decisions, risk, evidence, approve/reject/change actions |
| Agent Console | role, action summary, tool calls, current objective, safe summaries |
| Artifact Library | reports, drafts, attachments, snapshots, approval packs |
| Admin / Workflow Registry | definitions, tool policy, connectors, model policy, SLA |

### 13.3 UI Rules

- The UI MUST show workflow action summaries, not private model reasoning.
- Every approval card MUST show exact effect, risk, evidence, and requester.
- Every artifact link MUST point to metadata; R2 read URLs MUST be authorized.
- Technical coding run detail MAY remain available as a secondary tab.
- Linear/Jira links SHOULD be shown as external source links, not primary state.

## 14. Security and RBAC

### 14.1 Security Boundaries

| Boundary | Rule |
|---|---|
| Operator browser -> Worker | Authenticate through Access or equivalent |
| Worker -> Agent/DO | Validate tenant/profile/ticket authorization |
| Workflow -> ToolGateway | Tool calls require policy and audit |
| ToolGateway -> external APIs | Use idempotency and least-privilege secrets |
| Agent -> secrets | Agents do not receive raw broad secrets by default |
| Worker -> WorkerHost | Shell/process execution stays outside control-plane Worker |
| R2 artifacts | Redact secrets and authorize reads |

### 14.2 RBAC Roles

MVP roles:

```text
admin
operator
approver
viewer
connector
```

Required capability examples:

```text
ticket.read
ticket.create
ticket.comment
workflow.read
workflow.cancel
approval.decide
artifact.read
admin.workflow.write
admin.policy.write
connector.ingest
```

### 14.3 Secret Handling

- Raw secrets MUST live in Worker secrets, Cloudflare Secrets Store, or an
  external vault.
- D1/R2 MUST store secret references and redacted payloads only.
- ToolGateway MUST resolve secrets only for the smallest necessary operation.
- Snapshots, logs, tool payloads, and artifacts MUST run redaction before
  persistence when they may contain user or runtime files.

## 15. Observability

The platform MUST provide:

- structured audit events for business-relevant actions
- technical events for workflow/runtime debugging
- workflow step durations and retry counts
- tool invocation counts, duration, status, risk level
- approval wait time
- artifact creation counts and sizes
- connector ingest and sync failures
- notification delivery failures
- model usage through AI Gateway or adapter telemetry

The dashboard MUST be able to answer:

```text
What is waiting?
Why is it waiting?
Who can unblock it?
What has the agent done?
What tools were called?
What artifacts were produced?
What side effects happened?
What failed and what will retry?
```

## 16. Migration Strategy

### 16.1 Current Baseline

Current main includes:

- Phase 6 WorkerHost work through snapshot extraction.
- Phase 7 PR-A/A.5 foundation for `CodingAgentAdapter`.
- A green `cf-control-plane` baseline: 150 tests, `tsc --noEmit` clean.
- Existing draft PRs that do not represent the latest main review surface.

### 16.2 Migration Principles

1. Add generic ticket workflow structures without deleting current coding paths.
2. Do not rewrite `main` history to create review PRs.
3. Treat Linear as a connector, not canonical workflow state.
4. Treat Codex as a `coding_agent_run` adapter, not product core.
5. Prioritize ticket/workflow/tool/approval/artifact/audit semantics before
   further deepening coding-only compatibility.

### 16.3 Required PR Sequence

Recommended next implementation sequence:

| PR | Name | Scope |
|---|---|---|
| G0 | Generic Ticket + Connector ADR | product pivot, Linear connector rule, coding adapter rule |
| G1 | Generic schema | additive D1 migration and schema tests |
| G2 | Linear-to-Ticket bridge | create/link tickets from Linear issue mirror |
| G3 | Ticket API v2 | create/list/detail/comment/event endpoints |
| G4 | Agent Control Center MVP | `/tickets`, `/tickets/:id`, `/approvals` |
| G5 | GenericTicketWorkflow MVP | mock non-coding workflow lifecycle |
| G6 | Approval resume | approval decision resumes/cancels workflow |
| G7 | ToolGateway MVP | risk policy, audit, mock tools, artifact create |
| G8 | Coding workflow adapter | wrap existing coding execution as `coding_agent_run` |

### 16.4 Review-Only Backfill

Because recent Phase 6/7 commits already landed on `main`, review hygiene SHOULD
be restored through review-only PRs against synthetic base branches. These PRs
SHOULD be marked:

```text
Review-only backfill. Already shipped on vmxmy/symphony main.
Do not merge; use for review findings and follow-up issues.
Verified final head: 150 pass / 0 fail + tsc --noEmit.
```

## 17. MVP Acceptance Criteria

The generic ticket workflow MVP is complete when all criteria are met:

1. `POST /api/v2/tickets` creates a ticket without Linear credentials.
2. Ticket creation creates or selects a workflow definition and starts a
   workflow instance.
3. A non-coding workflow runs at least one agent/mock-agent step.
4. Workflow steps persist to D1 and expose a timeline API.
5. Approval step creates an approval, pauses the workflow, and shows in the
   Approval Center.
6. Approval decision records an immutable decision and resumes or cancels the
   workflow.
7. Artifact creation writes R2 metadata or a mock R2 reference plus D1 row.
8. Audit events record ticket creation, workflow start, step transitions,
   approval request/decision, tool invocation, artifact creation, and completion.
9. Linear issue ingestion can create or link an internal ticket through
   `ticket_sources`.
10. Existing coding workflow tests remain green.
11. `cf-control-plane` test count is not required to stay exactly 150, but the
    suite MUST remain 0-fail and `tsc --noEmit` clean.

## 18. Risks and Mitigations

- **Rebuilding Linear instead of Agent Control Center**
  - Impact: large UI scope and slow delivery.
  - Mitigation: MVP only includes tickets, ticket detail, and approvals; advanced
    issue tracker features are deferred.
- **Duplicating state between `issues` and `tickets`**
  - Impact: drift and confusing source of truth.
  - Mitigation: `tickets` is canonical, `issues` is a compatibility mirror, and
    the bridge writes deterministic links.
- **Breaking current coding path**
  - Impact: regression in existing workflows.
  - Mitigation: use additive migrations, preserve old tables/routes, and run the
    current test gate.
- **Approval hidden in comments**
  - Impact: unsafe or unauditable decisions.
  - Mitigation: approval is a first-class D1/R2 record; comments only
    collaborate.
- **Workflow replay duplicates side effects**
  - Impact: duplicate external writes.
  - Mitigation: ToolGateway idempotency is required before mutating calls.
- **Dashboard exposes private reasoning**
  - Impact: safety and product risk.
  - Mitigation: show summaries, evidence, tool calls, decisions, and outputs
    only.
- **Generic scope explosion**
  - Impact: delayed MVP.
  - Mitigation: start with mock tools and fixed workflows; defer dynamic editing
    and real connectors.

## 19. Future Work

After MVP:

- real connector webhooks for Linear/Jira/Slack/email
- notification inbox and Slack/email delivery
- workflow definition import/export
- workflow version history UI
- advanced search
- SLA escalation workflows
- Cloudflare-native agent adapter
- external approval delegation
- artifact preview/rendering
- tenant-scoped RBAC policy editor
- connector marketplace

## 20. Final Target Statement

Symphony vNext is:

```text
Ticket-native + Workflow-first + Agent-assisted + Human-governed
```

The platform owns canonical tickets, workflow state, approvals, artifacts, and
audit. Linear and similar systems become connectors. Codex and workspace-backed
execution become adapters. The primary user interface becomes the Agent Control
Center, not an external issue tracker.
