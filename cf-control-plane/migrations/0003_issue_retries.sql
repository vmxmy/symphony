-- Phase 4 sub-cut 3 retry mirror for ProjectAgent reconcile gating.
--
-- Implements Step 4 of docs/cloudflare-agent-native-phase4-plan.md. The
-- issue_id column intentionally matches D1.issues.id, which is
-- `${profile_id}:${external_id}` for tracker-backed issues.
--
-- This table is the queryable retry mirror used by ProjectAgent.poll();
-- IssueAgent Durable Object storage remains the source of truth. Rows here
-- are best-effort: IssueAgent.markFailed writes them in PR-C, and the
-- dispatch transition DELETEs them when an issue leaves retry_wait.
--
-- Tables are created without IF NOT EXISTS on purpose. New D1 migrations
-- should fail loudly if an incompatible object already exists.

CREATE TABLE issue_retries (
  issue_id     TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  profile_id   TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  attempt      INTEGER NOT NULL,
  due_at       TEXT NOT NULL,
  last_error   TEXT,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_issue_retries_due ON issue_retries (due_at);
CREATE INDEX idx_issue_retries_profile ON issue_retries (profile_id);
