// Queue message types for the symphony-tracker-events queue.
//
// Producer: Worker scheduled() handler enqueues one TrackerRefreshMessage
// per active profile every cron tick. The synchronous /api/v1/admin/run-
// scheduled and /api/v1/projects/:t/:s/actions/refresh routes still call
// poll() directly; only the cron path goes through the queue. This keeps
// fast-feedback operator paths sync while making the scheduled path
// failure-isolated and retryable.
//
// Consumer: Worker queue() handler dispatches each message to a typed
// handler in queues/handlers.ts. Failures throw, which causes Cloudflare
// Queues to retry with the queue's configured retry/backoff policy.
//
// Schema versioning: every message carries a `version` field so future
// shape changes can coexist with in-flight messages during a rollout.

export type TrackerRefreshMessage = {
  kind: "tracker.refresh";
  version: 1;
  /** Tenant id; validated by handler against control-plane id rules. */
  tenant_id: string;
  /** Profile slug; validated by handler. */
  slug: string;
  /** ISO timestamp at which the cron tick produced this message. */
  scheduled_at: string;
};

/**
 * Phase 4 sub-cut 2: enqueued by handleTrackerRefresh for each `dispatch`
 * decision the reconcile harness emits. Consumer calls IssueAgent.dispatch
 * which transitions the agent state to `queued`. Phase 4 explicitly does
 * not start runs from this signal yet — Phase 5 ExecutionWorkflow picks
 * up from `queued`.
 */
export type IssueDispatchMessage =
  | {
      kind: "issue.dispatch";
      version: 1;
      tenant_id: string;
      slug: string;
      /** Tracker-side stable id (Linear UUID for linear, native id for cloudflare). */
      external_id: string;
      /** Human-readable issue identifier (e.g. SYM-42), echoed for logging. */
      identifier: string;
      /** reconcile-decided attempt counter (1-indexed). */
      attempt: number;
      /** ISO timestamp at which the producing poll fired. */
      scheduled_at: string;
    }
  | {
      kind: "issue.dispatch";
      version: 2;
      tenant_id: string;
      slug: string;
      external_id: string;
      identifier: string;
      attempt: number;
      scheduled_at: string;
      /** Phase 4 PR-C test seam: when true, route through IssueAgent.markFailed instead of dispatch. Removed in Phase 5 once ExecutionWorkflow reports real failure outcomes. */
      inject_failure: true;
      /** Synthetic error string passed to markFailed. */
      error?: string;
    };

export type SymphonyQueueMessage = TrackerRefreshMessage | IssueDispatchMessage;
