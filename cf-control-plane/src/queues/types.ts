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

export type SymphonyQueueMessage = TrackerRefreshMessage;
