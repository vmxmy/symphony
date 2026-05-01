-- Symphony Cloudflare-native control plane: initial schema.
--
-- Phase 2 of docs/cloudflare-agent-native-target.md. Tables match §11 of the
-- target doc plus three additions surfaced during the planning review:
--   - tenants.policy_json (TenantState.policy persistence)
--   - hot indexes for dashboard / reconciliation queries
--   - retention/archival columns
--   - profile import bookkeeping (source_schema_version, defaults_applied,
--     warnings) per §10.1 v1->v2 migration policy
--   - idempotency_records per §13.1 (gates external side effects from
--     ExecutionWorkflow replay)
--
-- Tables are created without IF NOT EXISTS on purpose. This initial migration
-- must fail loudly if a remote D1 database already has incompatible tables;
-- use the schema validation script after applying migrations to detect drift.
--
-- D1 = SQLite. Notes:
--   - JSON payloads are TEXT; decode at the application layer.
--   - Foreign keys are documented but not enforced (D1 doesn't enable
--     PRAGMA foreign_keys by default; relations live in app logic).
--   - Timestamps are ISO-8601 TEXT (UTC) for portability.
--   - Large payloads (event bodies, tool inputs/outputs, snapshots) live
--     in R2; D1 stores `*_ref` pointers only.

-- ---------------------------------------------------------------------------
-- tenants: TenantAgent ownership root.
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('active', 'paused', 'suspended')),
  policy_json     TEXT NOT NULL,        -- TenantState.policy (max projects, allowed tools, ...)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  archived_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_tenants_status_active
  ON tenants(status) WHERE archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- profiles: profile registry pointer + parsed v2 metadata + import bookkeeping.
-- The canonical bundle (profile.yaml + WORKFLOW.md + skills/) lives in R2.
-- ---------------------------------------------------------------------------
CREATE TABLE profiles (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL,
  slug                     TEXT NOT NULL,
  active_version           TEXT NOT NULL,
  tracker_kind             TEXT NOT NULL CHECK (tracker_kind IN ('linear', 'cloudflare')),
  runtime_kind             TEXT NOT NULL CHECK (runtime_kind IN ('cloudflare-agent-native', 'local')),
  status                   TEXT NOT NULL CHECK (status IN ('active', 'paused', 'draining', 'archived')),
  config_json              TEXT NOT NULL,        -- parsed v2 operational config
  source_schema_version    INTEGER NOT NULL CHECK (source_schema_version IN (1, 2)),
  imported_schema_version  INTEGER NOT NULL CHECK (imported_schema_version = 2),
  defaults_applied         TEXT NOT NULL,        -- JSON array of field names defaulted during import
  warnings                 TEXT,                 -- JSON array of import-time warnings
  source_bundle_ref        TEXT,                 -- R2 path to original v1/v2 bundle
  normalized_config_ref    TEXT,                 -- R2 path to canonical v2 config
  imported_at              TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  archived_at              TEXT,
  UNIQUE (tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_profiles_tenant_active
  ON profiles(tenant_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_status
  ON profiles(status) WHERE archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- issues: normalized tracker-or-native issues. snapshot_json carries the full
-- normalized Issue shape (see ts-engine/src/types.ts Issue) so the dashboard
-- doesn't need to refetch from the tracker for read-only views.
-- ---------------------------------------------------------------------------
CREATE TABLE issues (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  profile_id      TEXT NOT NULL,
  external_id     TEXT,                 -- tracker-side ID (e.g. Linear issue.id)
  identifier      TEXT NOT NULL,        -- human-readable (e.g. SYM-42)
  title           TEXT,
  state           TEXT NOT NULL,        -- tracker state name
  priority        INTEGER,
  url             TEXT,
  snapshot_json   TEXT NOT NULL,        -- full normalized Issue snapshot
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  archived_at     TEXT,
  UNIQUE (profile_id, identifier)
);

CREATE INDEX IF NOT EXISTS idx_issues_profile_state
  ON issues(profile_id, state) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_issues_external
  ON issues(external_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_profile_external_unique
  ON issues(profile_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_issues_last_seen
  ON issues(last_seen_at);

-- ---------------------------------------------------------------------------
-- runs: durable per-issue execution attempts. Each run corresponds to one
-- IssueAgent lease + one ExecutionWorkflow instance. attempt increments on
-- retry; workflow_id is the Cloudflare Workflows instance id.
-- ---------------------------------------------------------------------------
CREATE TABLE runs (
  id                       TEXT PRIMARY KEY,
  issue_id                 TEXT NOT NULL,
  attempt                  INTEGER NOT NULL,
  status                   TEXT NOT NULL,        -- queued|running|completed|failed|cancelled|paused|retry_wait|stale_pending_review
  workflow_id              TEXT,                 -- Cloudflare Workflows instance id
  adapter_kind             TEXT NOT NULL,        -- 'codex_compat' | 'cloudflare_native' | 'mock'
  workspace_ref            TEXT,                 -- WorkspaceRef JSON ({ path, host })
  started_at               TEXT NOT NULL,
  finished_at              TEXT,
  error                    TEXT,
  token_usage_json         TEXT,
  artifact_manifest_ref    TEXT,                 -- R2 path to manifest.json
  archived_at              TEXT,
  UNIQUE (issue_id, attempt)
);

CREATE INDEX IF NOT EXISTS idx_runs_issue_status
  ON runs(issue_id, status) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_runs_status_started
  ON runs(status, started_at) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_runs_workflow
  ON runs(workflow_id);

-- ---------------------------------------------------------------------------
-- run_steps: durable Workflow steps within one run (prepareWorkspace,
-- beforeRunHook, runAgentTurn, ...). Bulky inputs/outputs live in R2.
-- ---------------------------------------------------------------------------
CREATE TABLE run_steps (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  step_name       TEXT NOT NULL,
  step_sequence   INTEGER NOT NULL,     -- ordering within a run
  status          TEXT NOT NULL,        -- pending|running|completed|failed|skipped
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  input_ref       TEXT,                 -- R2 path
  output_ref      TEXT,                 -- R2 path
  error           TEXT,
  archived_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_run_steps_run_seq
  ON run_steps(run_id, step_sequence) WHERE archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- run_events: queryable event index. Severity-keyed for fast dashboard look-up.
-- payload_ref points to the full JSON in R2 when message is a summary only.
-- ---------------------------------------------------------------------------
CREATE TABLE run_events (
  id              TEXT PRIMARY KEY,
  run_id          TEXT,
  issue_id        TEXT,
  event_type      TEXT NOT NULL,        -- e.g. 'turn.started', 'tool.call.failed', 'workspace.snapshot'
  severity        TEXT NOT NULL,        -- debug|info|warning|error
  message         TEXT,
  payload_ref     TEXT,                 -- R2 path for large payloads
  created_at      TEXT NOT NULL,
  archived_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_run_events_run_time
  ON run_events(run_id, created_at) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_run_events_issue_time
  ON run_events(issue_id, created_at) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_run_events_severity_time
  ON run_events(severity, created_at) WHERE archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- tool_calls: audit log of every dynamic tool invocation through ToolGateway.
-- input_ref is mandatory (the call envelope); output_ref is null until the
-- call settles; approval_id links to approvals when policy gates the call.
-- ---------------------------------------------------------------------------
CREATE TABLE tool_calls (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  turn_number     INTEGER,
  tool_name       TEXT NOT NULL,
  status          TEXT NOT NULL,        -- pending|running|completed|failed|rejected|approval_wait
  input_ref       TEXT NOT NULL,        -- R2 path
  output_ref      TEXT,                 -- R2 path
  approval_id     TEXT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  archived_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_run
  ON tool_calls(run_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tool_calls_name_time
  ON tool_calls(tool_name, started_at) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tool_calls_status
  ON tool_calls(status, started_at) WHERE archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- approvals: human-in-the-loop gate records. Bodies in R2; this table is the
-- queryable dashboard surface for "what's waiting for me".
-- ---------------------------------------------------------------------------
CREATE TABLE approvals (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  profile_id      TEXT NOT NULL,
  issue_id        TEXT,
  run_id          TEXT,
  action          TEXT NOT NULL,        -- e.g. 'destructive_shell', 'production_publish'
  status          TEXT NOT NULL,        -- pending|approved|rejected|expired
  requested_by    TEXT,
  decided_by      TEXT,
  request_ref     TEXT NOT NULL,        -- R2 path
  decision_ref    TEXT,                 -- R2 path (set when status leaves pending)
  created_at      TEXT NOT NULL,
  decided_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_approvals_status_created
  ON approvals(status, created_at);
CREATE INDEX IF NOT EXISTS idx_approvals_run
  ON approvals(run_id);
CREATE INDEX IF NOT EXISTS idx_approvals_tenant_status
  ON approvals(tenant_id, status);

-- ---------------------------------------------------------------------------
-- idempotency_records: read-before-write guard for external side effects.
-- See docs/cloudflare-agent-native-target.md §13.1.
-- Key shape: idem:v1:{tenant_id}:{profile_id}:{issue_id}:{run_id}:{operation_type}:{sha256(canonical_payload)}
-- A record is created with status=in_progress before the external call;
-- finalized to completed/failed once the external system responds.
-- Replay safety: if a record with the same idem_key already exists in
-- status=completed, the gateway returns the stored result_ref instead of
-- repeating the external call.
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_records (
  idem_key        TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  profile_id      TEXT NOT NULL,
  issue_id        TEXT,
  run_id          TEXT,
  tool_call_id    TEXT,                 -- originating tool_calls.id (so audit can join)
  operation_type  TEXT NOT NULL,        -- e.g. 'tracker.transition', 'github.pull_request'
  status          TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed', 'expired')),
  lease_owner     TEXT,
  lease_expires_at TEXT,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  retry_after     TEXT,
  failure_class   TEXT,
  external_ref    TEXT,                 -- provider-side ID once known
  result_ref      TEXT,                 -- R2 path to stored result envelope
  created_at      TEXT NOT NULL,
  finalized_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_idempotency_run
  ON idempotency_records(run_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_tool_call
  ON idempotency_records(tool_call_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_status_created
  ON idempotency_records(status, created_at);
CREATE INDEX IF NOT EXISTS idx_idempotency_lease_expires
  ON idempotency_records(lease_expires_at) WHERE status = 'in_progress';

-- ---------------------------------------------------------------------------
-- Sanity: a SELECT that returns the table count helps wrangler exit cleanly
-- with a visible signal that the migration completed.
-- ---------------------------------------------------------------------------
SELECT COUNT(*) AS table_count
  FROM sqlite_master
  WHERE type = 'table'
    AND name NOT LIKE 'sqlite_%'
    AND name NOT LIKE 'd1_%'
    AND name NOT LIKE '_cf_%';
