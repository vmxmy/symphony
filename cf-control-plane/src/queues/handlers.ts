// Queue message handlers for the symphony-tracker-events queue.
//
// Each handler is responsible for a single `kind` of message. The Worker
// queue() entrypoint dispatches based on the message kind and re-throws
// errors so Cloudflare Queues' retry/backoff policy applies.

import type { ProjectAgent } from "../agents/project.js";
import type { TrackerRefreshMessage } from "./types.js";
import { assertControlPlaneId, durableObjectName } from "../identity.js";

type Env = {
  DB: D1Database;
  PROJECT_AGENT: DurableObjectNamespace<ProjectAgent>;
  LINEAR_API_KEY?: string;
};

export type TrackerRefreshOutcome = {
  tenant_id: string;
  slug: string;
  decisions: number;
  cleaned_up: number;
  duration_ms: number;
};

/**
 * Handle one tracker.refresh message: call ProjectAgent.poll for the named
 * project, return summary metrics. Errors propagate so the queue retries.
 *
 * Phase 3 invariant: poll() never starts a run, only mirrors + emits
 * decisions. The message-driven path therefore has no execution side
 * effect, only D1 writes (issue UPSERT + cleanup archive). Re-delivery
 * during a retry is safe because poll() is idempotent on stable input.
 */
export async function handleTrackerRefresh(
  env: Env,
  message: TrackerRefreshMessage,
): Promise<TrackerRefreshOutcome> {
  const startedAt = Date.now();
  assertControlPlaneId("tenant", message.tenant_id);
  assertControlPlaneId("profile", message.slug);

  const id = env.PROJECT_AGENT.idFromName(
    durableObjectName("project", message.tenant_id, message.slug),
  );
  const stub = env.PROJECT_AGENT.get(id);
  const result = await stub.poll(message.tenant_id, message.slug);

  return {
    tenant_id: message.tenant_id,
    slug: message.slug,
    decisions: result.decisions.length,
    cleaned_up: result.cleaned_up,
    duration_ms: Date.now() - startedAt,
  };
}
