import { describe, expect, test } from "bun:test";
import { enqueueScheduledPolls, runScheduledPoll } from "../src/orchestration/scheduled_poll.js";
import type { TrackerRefreshMessage } from "../src/queues/types.js";
import { asD1, createMigratedDatabase } from "./support/sqlite_d1.js";

type SentBatch = Array<{ body: TrackerRefreshMessage }>;

function seedTenant(db: ReturnType<typeof createMigratedDatabase>, id: string, status: "active" | "paused" | "suspended" = "active") {
  db.query(`
    INSERT INTO tenants (id, name, status, policy_json, created_at, updated_at)
    VALUES (?, ?, ?, '{}', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')
  `).run(id, id, status);
}

function seedProfile(db: ReturnType<typeof createMigratedDatabase>, tenantId: string, slug: string, status = "active") {
  db.query(`
    INSERT INTO profiles (
      id, tenant_id, slug, active_version, tracker_kind, runtime_kind, status,
      config_json, source_schema_version, imported_schema_version,
      defaults_applied, imported_at, created_at, updated_at
    ) VALUES (?, ?, ?, '1.0.0', 'linear', 'cloudflare-agent-native', ?,
      '{}', 1, 2, '[]', '2026-05-01T00:00:00Z',
      '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')
  `).run(`${tenantId}/${slug}`, tenantId, slug, status);
}

function queueRecorder() {
  const batches: SentBatch[] = [];
  return {
    batches,
    queue: {
      async sendBatch(messages: SentBatch) {
        batches.push([...messages]);
        return {};
      },
    } as unknown as Queue<TrackerRefreshMessage>,
  };
}

function projectAgentRecorder() {
  const polls: Array<{ tenant_id: string; slug: string }> = [];
  return {
    polls,
    namespace: {
      idFromName(name: string) {
        return name;
      },
      get() {
        return {
          async poll(tenant_id: string, slug: string) {
            polls.push({ tenant_id, slug });
            return { decisions: [], cleaned_up: 0 };
          },
        };
      },
    } as unknown as DurableObjectNamespace,
  };
}

describe("scheduled polling", () => {
  test("enqueueScheduledPolls chunks queue sends at the Cloudflare batch limit", async () => {
    const db = createMigratedDatabase();
    seedTenant(db, "tenant");
    for (let i = 0; i < 101; i++) seedProfile(db, "tenant", `profile-${i}`);
    const { batches, queue } = queueRecorder();

    const summary = await enqueueScheduledPolls({
      DB: asD1(db),
      TRACKER_EVENTS: queue,
    } as unknown as Parameters<typeof enqueueScheduledPolls>[0]);

    expect(summary.enqueued).toBe(101);
    expect(batches.map((batch) => batch.length)).toEqual([100, 1]);
  });

  test("scheduled enqueue and sync poll skip profiles under inactive tenants", async () => {
    const db = createMigratedDatabase();
    seedTenant(db, "active-tenant", "active");
    seedTenant(db, "paused-tenant", "paused");
    seedProfile(db, "active-tenant", "profile");
    seedProfile(db, "paused-tenant", "profile");
    const { batches, queue } = queueRecorder();
    const { polls, namespace } = projectAgentRecorder();

    const enqueueSummary = await enqueueScheduledPolls({
      DB: asD1(db),
      TRACKER_EVENTS: queue,
    } as unknown as Parameters<typeof enqueueScheduledPolls>[0]);
    const pollSummary = await runScheduledPoll({
      DB: asD1(db),
      PROJECT_AGENT: namespace,
    } as unknown as Parameters<typeof runScheduledPoll>[0]);

    expect(enqueueSummary.projects).toEqual([{ tenant_id: "active-tenant", slug: "profile" }]);
    expect(batches.flat().map((message) => message.body.tenant_id)).toEqual(["active-tenant"]);
    expect(polls).toEqual([{ tenant_id: "active-tenant", slug: "profile" }]);
    expect(pollSummary.projects_total).toBe(1);
    expect(pollSummary.projects_failed).toBe(0);
  });
});
