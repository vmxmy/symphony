-- Phase 2 hardening follow-up for databases that already applied 0001 before
-- architect review fixes landed. Fresh databases replay 0001 + this migration
-- to reach the same final schema as remote D1 databases.

-- Stable tracker identity: Linear issue.id survives identifier renames.
CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_profile_external_unique
  ON issues(profile_id, external_id) WHERE external_id IS NOT NULL;

-- Append-only operational tables still need archival columns so retention
-- sweeps can hide old rows from dashboard queries without deleting audit data.
ALTER TABLE run_steps ADD COLUMN archived_at TEXT;
DROP INDEX IF EXISTS idx_run_steps_run_seq;
CREATE INDEX IF NOT EXISTS idx_run_steps_run_seq
  ON run_steps(run_id, step_sequence) WHERE archived_at IS NULL;

ALTER TABLE run_events ADD COLUMN archived_at TEXT;
DROP INDEX IF EXISTS idx_run_events_run_time;
DROP INDEX IF EXISTS idx_run_events_issue_time;
DROP INDEX IF EXISTS idx_run_events_severity_time;
CREATE INDEX IF NOT EXISTS idx_run_events_run_time
  ON run_events(run_id, created_at) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_run_events_issue_time
  ON run_events(issue_id, created_at) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_run_events_severity_time
  ON run_events(severity, created_at) WHERE archived_at IS NULL;

ALTER TABLE tool_calls ADD COLUMN archived_at TEXT;
DROP INDEX IF EXISTS idx_tool_calls_run;
DROP INDEX IF EXISTS idx_tool_calls_name_time;
DROP INDEX IF EXISTS idx_tool_calls_status;
CREATE INDEX IF NOT EXISTS idx_tool_calls_run
  ON tool_calls(run_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tool_calls_name_time
  ON tool_calls(tool_name, started_at) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tool_calls_status
  ON tool_calls(status, started_at) WHERE archived_at IS NULL;

-- SQLite cannot alter CHECK constraints in place, so rebuild idempotency
-- records to add replay lease/retry semantics and the expired status.
CREATE TABLE idempotency_records_next (
  idem_key        TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  profile_id      TEXT NOT NULL,
  issue_id        TEXT,
  run_id          TEXT,
  tool_call_id    TEXT,
  operation_type  TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed', 'expired')),
  lease_owner     TEXT,
  lease_expires_at TEXT,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  retry_after     TEXT,
  failure_class   TEXT,
  external_ref    TEXT,
  result_ref      TEXT,
  created_at      TEXT NOT NULL,
  finalized_at    TEXT
);

INSERT INTO idempotency_records_next (
  idem_key, tenant_id, profile_id, issue_id, run_id, tool_call_id,
  operation_type, status, external_ref, result_ref, created_at, finalized_at
)
SELECT
  idem_key, tenant_id, profile_id, issue_id, run_id, tool_call_id,
  operation_type, status, external_ref, result_ref, created_at, finalized_at
FROM idempotency_records;

DROP TABLE idempotency_records;
ALTER TABLE idempotency_records_next RENAME TO idempotency_records;

CREATE INDEX IF NOT EXISTS idx_idempotency_profile_status
  ON idempotency_records(profile_id, status);
CREATE INDEX IF NOT EXISTS idx_idempotency_operation
  ON idempotency_records(operation_type, external_ref);
CREATE INDEX IF NOT EXISTS idx_idempotency_run
  ON idempotency_records(run_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_tool_call
  ON idempotency_records(tool_call_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_status_created
  ON idempotency_records(status, created_at);
CREATE INDEX IF NOT EXISTS idx_idempotency_lease_expires
  ON idempotency_records(lease_expires_at) WHERE status = 'in_progress';
