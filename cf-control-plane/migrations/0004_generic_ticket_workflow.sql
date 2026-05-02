-- G1: additive generic ticket workflow schema.
--
-- This migration introduces the vNext canonical Ticket -> WorkflowInstance
-- model from docs/generic-ticket-workflow-spec.md section 11. It intentionally does
-- not alter or drop the existing coding compatibility tables (`issues`, `runs`,
-- `run_steps`, `run_events`, `tool_calls`, `approvals`, or
-- `idempotency_records`).
--
-- Tables are created without IF NOT EXISTS so incompatible pre-existing objects
-- fail loudly during D1 migration review.

-- ---------------------------------------------------------------------------
-- tickets: canonical internal work item, independent of Linear/Jira/etc.
-- External system identity lives in ticket_sources, not in tickets.id.
-- ---------------------------------------------------------------------------
CREATE TABLE tickets (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  key               TEXT NOT NULL,
  type              TEXT NOT NULL,
  title             TEXT NOT NULL,
  description       TEXT,
  requester         TEXT,
  owner             TEXT,
  priority          TEXT NOT NULL DEFAULT 'normal',
  status            TEXT NOT NULL DEFAULT 'CREATED',
  workflow_key      TEXT NOT NULL,
  workflow_version  INTEGER,
  input_json        TEXT,
  tags_json         TEXT NOT NULL DEFAULT '[]',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  archived_at       TEXT,
  UNIQUE (tenant_id, key)
);

CREATE INDEX idx_tickets_tenant_status
  ON tickets(tenant_id, status) WHERE archived_at IS NULL;
CREATE INDEX idx_tickets_workflow_status
  ON tickets(tenant_id, workflow_key, status) WHERE archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- ticket_sources: connector identity and sync metadata.
-- ---------------------------------------------------------------------------
CREATE TABLE ticket_sources (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  ticket_id       TEXT NOT NULL,
  source_kind     TEXT NOT NULL,
  external_id     TEXT,
  external_key    TEXT,
  external_url    TEXT,
  sync_status     TEXT NOT NULL DEFAULT 'active',
  last_synced_at  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_ticket_sources_external
  ON ticket_sources(tenant_id, source_kind, external_id)
  WHERE external_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- ticket_comments: internal collaboration plus optional connector provenance.
-- ---------------------------------------------------------------------------
CREATE TABLE ticket_comments (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  ticket_id    TEXT NOT NULL,
  author_type  TEXT NOT NULL,
  author_id    TEXT,
  body         TEXT NOT NULL,
  visibility   TEXT NOT NULL DEFAULT 'internal',
  source_id    TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_ticket_comments_ticket_time
  ON ticket_comments(ticket_id, created_at);

-- ---------------------------------------------------------------------------
-- workflow_definitions: versioned declarative workflow contract.
-- ---------------------------------------------------------------------------
CREATE TABLE workflow_definitions (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  key              TEXT NOT NULL,
  version          INTEGER NOT NULL,
  name             TEXT NOT NULL,
  status           TEXT NOT NULL,
  definition_json  TEXT NOT NULL,
  source_ref       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (tenant_id, key, version)
);

-- ---------------------------------------------------------------------------
-- workflow_instances: durable long-running execution state.
-- ---------------------------------------------------------------------------
CREATE TABLE workflow_instances (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  ticket_id         TEXT NOT NULL,
  workflow_key      TEXT NOT NULL,
  workflow_version  INTEGER NOT NULL,
  status            TEXT NOT NULL,
  current_step_key  TEXT,
  started_at        TEXT NOT NULL,
  completed_at      TEXT,
  error_message     TEXT,
  runtime_json      TEXT
);

CREATE INDEX idx_workflow_instances_ticket
  ON workflow_instances(ticket_id, started_at);
CREATE INDEX idx_workflow_instances_status
  ON workflow_instances(tenant_id, status, started_at);

-- ---------------------------------------------------------------------------
-- workflow_steps: queryable step timeline for agents, tools, waits, approval,
-- validation, delivery, and coding compatibility steps.
-- ---------------------------------------------------------------------------
CREATE TABLE workflow_steps (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL,
  ticket_id             TEXT NOT NULL,
  workflow_instance_id  TEXT NOT NULL,
  step_key              TEXT NOT NULL,
  step_type             TEXT NOT NULL,
  status                TEXT NOT NULL,
  sequence              INTEGER NOT NULL,
  input_ref             TEXT,
  output_ref            TEXT,
  summary               TEXT,
  retry_count           INTEGER NOT NULL DEFAULT 0,
  started_at            TEXT,
  completed_at          TEXT,
  error_message         TEXT,
  UNIQUE (workflow_instance_id, sequence)
);

CREATE INDEX idx_workflow_steps_instance_seq
  ON workflow_steps(workflow_instance_id, sequence);

-- ---------------------------------------------------------------------------
-- agent_sessions: role-scoped agent context for a ticket workflow.
-- ---------------------------------------------------------------------------
CREATE TABLE agent_sessions (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL,
  ticket_id             TEXT NOT NULL,
  workflow_instance_id  TEXT NOT NULL,
  role                  TEXT NOT NULL,
  adapter_kind          TEXT NOT NULL,
  status                TEXT NOT NULL,
  memory_scope          TEXT NOT NULL,
  memory_ref            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX idx_agent_sessions_ticket
  ON agent_sessions(ticket_id, status);

-- ---------------------------------------------------------------------------
-- tool_definitions: tenant-visible tool contracts and risk policy metadata.
-- G7 will add ToolGateway behavior; G1 only creates the additive contract table.
-- ---------------------------------------------------------------------------
CREATE TABLE tool_definitions (
  id                     TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL,
  name                   TEXT NOT NULL,
  description            TEXT NOT NULL,
  input_schema_json      TEXT NOT NULL,
  output_schema_json     TEXT NOT NULL,
  risk_level             TEXT NOT NULL,
  requires_approval      INTEGER NOT NULL DEFAULT 0,
  idempotency_required   INTEGER NOT NULL DEFAULT 0,
  handler                TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'active',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  archived_at            TEXT,
  UNIQUE (tenant_id, name)
);

CREATE INDEX idx_tool_definitions_tenant_active
  ON tool_definitions(tenant_id, status) WHERE archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- tool_invocations: generic workflow tool-call audit records.
-- The existing tool_calls table stays intact for coding compatibility.
-- ---------------------------------------------------------------------------
CREATE TABLE tool_invocations (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL,
  ticket_id             TEXT NOT NULL,
  workflow_instance_id  TEXT,
  workflow_step_id      TEXT,
  agent_session_id      TEXT,
  tool_name             TEXT NOT NULL,
  status                TEXT NOT NULL,
  risk_level            TEXT NOT NULL,
  input_ref             TEXT NOT NULL,
  output_ref            TEXT,
  approval_id           TEXT,
  idempotency_key       TEXT,
  started_at            TEXT NOT NULL,
  completed_at          TEXT
);

CREATE INDEX idx_tool_invocations_ticket
  ON tool_invocations(ticket_id, started_at);
CREATE INDEX idx_tool_invocations_step
  ON tool_invocations(workflow_step_id, started_at)
  WHERE workflow_step_id IS NOT NULL;
CREATE INDEX idx_tool_invocations_status
  ON tool_invocations(tenant_id, status, started_at);
CREATE INDEX idx_tool_invocations_idempotency
  ON tool_invocations(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- artifacts: R2-backed deliverables and workflow outputs.
-- ---------------------------------------------------------------------------
CREATE TABLE artifacts (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL,
  ticket_id             TEXT NOT NULL,
  workflow_instance_id  TEXT,
  workflow_step_id      TEXT,
  kind                  TEXT NOT NULL,
  r2_key                TEXT NOT NULL,
  mime_type             TEXT NOT NULL,
  metadata_json         TEXT,
  created_by            TEXT NOT NULL,
  created_at            TEXT NOT NULL
);

CREATE INDEX idx_artifacts_ticket
  ON artifacts(ticket_id, created_at);

-- ---------------------------------------------------------------------------
-- audit_events: append-only audit surface for tickets and workflow actions.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_events (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL,
  ticket_id             TEXT,
  workflow_instance_id  TEXT,
  workflow_step_id      TEXT,
  actor_type            TEXT NOT NULL,
  actor_id              TEXT,
  action                TEXT NOT NULL,
  severity              TEXT NOT NULL DEFAULT 'info',
  summary               TEXT NOT NULL,
  payload_ref           TEXT,
  created_at            TEXT NOT NULL
);

CREATE INDEX idx_audit_events_ticket_time
  ON audit_events(ticket_id, created_at);

-- ---------------------------------------------------------------------------
-- notifications: pending/sent notification records for connector channels.
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  ticket_id    TEXT,
  channel      TEXT NOT NULL,
  recipient    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  payload_ref  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  sent_at      TEXT
);

CREATE INDEX idx_notifications_pending
  ON notifications(status, created_at);

-- ---------------------------------------------------------------------------
-- approvals: additive generic workflow pointers on the existing reusable table.
-- Existing coding approval columns and constraints remain unchanged.
-- ---------------------------------------------------------------------------
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
