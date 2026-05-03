// Queue message handlers for the symphony-tracker-events queue.
//
// Each handler is responsible for a single `kind` of message. The Worker
// queue() entrypoint dispatches based on the message kind and re-throws
// errors so Cloudflare Queues' retry/backoff policy applies.

import type { ProjectAgent } from "../agents/project.js";
import type { IssueAgent } from "../agents/issue.js";
import type { TrackerRefreshMessage, IssueDispatchMessage } from "./types.js";
import { assertControlPlaneId, durableObjectName } from "../identity.js";

type Env = {
  DB: D1Database;
  PROJECT_AGENT: DurableObjectNamespace<ProjectAgent>;
  ISSUE_AGENT: DurableObjectNamespace<IssueAgent>;
  DISPATCH: Queue<IssueDispatchMessage>;
  EXECUTION_WORKFLOW: Workflow<import("../workflows/execution.js").ExecutionWorkflowParams>;
  LINEAR_API_KEY?: string;
};

export type TrackerRefreshOutcome = {
  tenant_id: string;
  slug: string;
  decisions: number;
  cleaned_up: number;
  dispatched: number;
  duration_ms: number;
};

export type IssueDispatchOutcome = {
  external_id: string;
  identifier: string;
  agent_status: string;
  dispatch_count: number;
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

  // Enqueue one IssueDispatchMessage per dispatch decision. The dispatch
  // consumer transitions IssueAgent into `queued`, then starts the Phase 5
  // ExecutionWorkflow run.
  const dispatchMessages = result.decisions
    .filter((d) => d.kind === "dispatch")
    .map((d) => ({
      body: {
        kind: "issue.dispatch" as const,
        version: 1 as const,
        tenant_id: message.tenant_id,
        slug: message.slug,
        external_id: d.issueId,
        identifier: d.issueIdentifier,
        attempt: d.attempt,
        scheduled_at: new Date().toISOString(),
      },
    }));
  if (dispatchMessages.length > 0) {
    await env.DISPATCH.sendBatch(dispatchMessages);
  }

  return {
    tenant_id: message.tenant_id,
    slug: message.slug,
    decisions: result.decisions.length,
    cleaned_up: result.cleaned_up,
    dispatched: dispatchMessages.length,
    duration_ms: Date.now() - startedAt,
  };
}

/**
 * Handle one issue.dispatch message.
 *
 * The default v1 path routes through IssueAgent.dispatch, which transitions
 * the agent into `queued`, then IssueAgent.startRun acquires the workflow
 * lease and creates the ExecutionWorkflow instance.
 *
 * Retry layers are deliberately split: Cloudflare Queue retries protect this
 * handler when the DO call itself fails, while IssueAgent.markFailed bumps the
 * business-layer attempt only when a dispatched issue outcome is failed. The
 * v2 inject_failure branch is the Phase 4 test seam for that future outcome.
 */
export async function handleIssueDispatch(
  env: Env,
  message: IssueDispatchMessage,
): Promise<IssueDispatchOutcome> {
  const startedAt = Date.now();
  assertControlPlaneId("tenant", message.tenant_id);
  assertControlPlaneId("profile", message.slug);
  assertControlPlaneId("issue", message.external_id);

  const id = env.ISSUE_AGENT.idFromName(
    durableObjectName("issue", message.tenant_id, message.slug, message.external_id),
  );
  const stub = env.ISSUE_AGENT.get(id);
  if (message.version === 2 && message.inject_failure === true) {
    const state = await stub.markFailed(
      message.tenant_id,
      message.slug,
      message.external_id,
      message.error ?? "inject_failure (test seam)",
    );

    return {
      external_id: message.external_id,
      identifier: message.identifier,
      agent_status: state.status,
      dispatch_count: state.dispatchCount,
      duration_ms: Date.now() - startedAt,
    };
  }

  // Dispatch is the idempotent discovered/retry -> queued transition; startRun
  // then moves queued -> running and creates the workflow instance.
  await stub.dispatch(
    message.tenant_id,
    message.slug,
    message.external_id,
    "scheduled-poll",
    `attempt=${message.attempt}`,
    message.attempt,
  );
  const runningState = await stub.startRun(
    message.tenant_id,
    message.slug,
    message.external_id,
    "scheduled-poll",
    `attempt=${message.attempt}`,
  );

  return {
    external_id: message.external_id,
    identifier: message.identifier,
    agent_status: runningState.status,
    dispatch_count: runningState.dispatchCount,
    duration_ms: Date.now() - startedAt,
  };
}
