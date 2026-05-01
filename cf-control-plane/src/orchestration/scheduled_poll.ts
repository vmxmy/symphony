// Scheduled poll: enumerate active projects and fan out ProjectAgent.poll().
//
// Phase 3 second cut. Replaces the manual `POST /api/v1/projects/:t/:s/
// actions/refresh` requirement for everyday operation. The cron handler
// in worker.ts calls runScheduledPoll on the Cloudflare Cron schedule
// declared in wrangler.toml; an admin route mirrors the same path so
// operators can trigger it on demand without waiting for the next tick.
//
// Phase 3 invariant preserved: ProjectAgent.poll only mirrors tracker
// state and emits decisions; it never starts a run. Cron firing every
// 5 minutes therefore only refreshes the D1 issue mirror — no
// dispatch, no codex spawn, no shell side effects.
//
// Failure containment: per-project errors are captured into the summary;
// one project's failure does not stop the others. Cron deliveries are
// at-least-once so poll() must be idempotent on stable input — we
// verified this end-to-end with the live refresh probe (decisions=[]
// cleaned_up=0 across consecutive runs).

import type { ProjectAgent } from "../agents/project.js";
import type { TrackerRefreshMessage } from "../queues/types.js";
import { assertControlPlaneId, durableObjectName } from "../identity.js";

type Env = {
  DB: D1Database;
  PROJECT_AGENT: DurableObjectNamespace<ProjectAgent>;
  // The remaining bindings (LINEAR_API_KEY, etc.) are read by
  // ProjectAgent.poll directly via this.env.
};

type EnqueueEnv = Env & {
  TRACKER_EVENTS: Queue<TrackerRefreshMessage>;
};

const MAX_QUEUE_SEND_BATCH = 100;

type PollTarget = { tenant_id: string; slug: string };

export type EnqueueSummary = {
  scheduled_at: string;
  enqueued: number;
  projects: PollTarget[];
};

async function listActivePollTargets(env: Pick<Env, "DB">): Promise<PollTarget[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.tenant_id, p.slug
       FROM profiles p
       JOIN tenants t ON t.id = p.tenant_id AND t.archived_at IS NULL
      WHERE p.archived_at IS NULL
        AND p.status = 'active'
        AND t.status = 'active'
      ORDER BY p.tenant_id, p.slug`,
  ).all<PollTarget>();
  return results ?? [];
}

function chunks<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

/**
 * Enumerate active profiles and enqueue one TrackerRefreshMessage per
 * project on the symphony-tracker-events queue. The queue() handler in
 * worker.ts consumes each message and calls ProjectAgent.poll. This is
 * the cron-driven path; sync routes (refresh, admin/run-scheduled) still
 * call poll directly for immediate operator feedback.
 *
 * Failure isolation: if a single sendBatch entry fails, Cloudflare Queues
 * retries that entry; other projects in the batch are unaffected. We
 * therefore prefer one sendBatch over many sequential send calls.
 */
export async function enqueueScheduledPolls(env: EnqueueEnv): Promise<EnqueueSummary> {
  const scheduledAt = new Date().toISOString();
  const targets = await listActivePollTargets(env);

  for (const batch of chunks(targets, MAX_QUEUE_SEND_BATCH)) {
    await env.TRACKER_EVENTS.sendBatch(
      batch.map((t) => ({
        body: {
          kind: "tracker.refresh" as const,
          version: 1 as const,
          tenant_id: t.tenant_id,
          slug: t.slug,
          scheduled_at: scheduledAt,
        },
      })),
    );
  }

  return { scheduled_at: scheduledAt, enqueued: targets.length, projects: targets };
}

export type ScheduledPollSummary = {
  started_at: string;
  finished_at: string;
  duration_ms: number;
  projects_total: number;
  projects_succeeded: number;
  projects_failed: number;
  decisions_total: number;
  cleaned_up_total: number;
  failures: Array<{ tenant_id: string; slug: string; error: string }>;
};

export async function runScheduledPoll(env: Env): Promise<ScheduledPollSummary> {
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const targets = await listActivePollTargets(env);

  const failures: ScheduledPollSummary["failures"] = [];
  let succeeded = 0;
  let decisionsTotal = 0;
  let cleanedUpTotal = 0;

  // Fan out in parallel with bounded concurrency. Workers' subrequest
  // limit applies here; for the current single-tenant single-project
  // shape this is just one DO call. As project count grows we should
  // batch via Promise.all chunks; defer until we see > ~50 projects.
  const polls = await Promise.allSettled(
    targets.map(async ({ tenant_id, slug }) => {
      assertControlPlaneId("tenant", tenant_id);
      assertControlPlaneId("profile", slug);
      const id = env.PROJECT_AGENT.idFromName(durableObjectName("project", tenant_id, slug));
      const stub = env.PROJECT_AGENT.get(id);
      const result = await stub.poll(tenant_id, slug);
      return { tenant_id, slug, result };
    }),
  );

  for (let i = 0; i < polls.length; i++) {
    const settled = polls[i]!;
    const target = targets[i]!;
    if (settled.status === "fulfilled") {
      succeeded++;
      decisionsTotal += settled.value.result.decisions.length;
      cleanedUpTotal += settled.value.result.cleaned_up;
    } else {
      failures.push({
        tenant_id: target.tenant_id,
        slug: target.slug,
        error: String((settled.reason as Error)?.message ?? settled.reason),
      });
    }
  }

  const finishedAt = Date.now();
  return {
    started_at: startedAtIso,
    finished_at: new Date(finishedAt).toISOString(),
    duration_ms: finishedAt - startedAt,
    projects_total: targets.length,
    projects_succeeded: succeeded,
    projects_failed: failures.length,
    decisions_total: decisionsTotal,
    cleaned_up_total: cleanedUpTotal,
    failures,
  };
}
