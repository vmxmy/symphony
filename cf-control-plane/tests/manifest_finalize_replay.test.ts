import { describe, expect, mock, test } from "bun:test";
import { asD1, createMigratedDatabase } from "./support/sqlite_d1.js";

// Mock cloudflare:workers BEFORE importing the workflow class. Earlier
// test files in the same suite may have mocked the same module with
// just DurableObject; we re-assert both exports so the workflow import
// resolves regardless of file order.
class MockDurableObject {
  protected ctx: DurableObjectState;
  protected env: unknown;
  constructor(ctx: DurableObjectState, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}
class MockWorkflowEntrypoint {
  protected env: unknown;
  constructor(_ctx: unknown, env: unknown) {
    this.env = env;
  }
}

mock.module("cloudflare:workers", () => ({
  DurableObject: MockDurableObject,
  WorkflowEntrypoint: MockWorkflowEntrypoint,
}));

const { ExecutionWorkflow } = await import("../src/workflows/execution.js");
import type { ExecutionWorkflowParams } from "../src/workflows/execution.js";
import { manifestKey } from "../src/runs/manifest.js";

const TENANT_ID = "tenant";
const SLUG = "profile";
const EXTERNAL_ID = "issue-1";
const ATTEMPT = 0;
const RUN_ID = `run:${TENANT_ID}:${SLUG}:${EXTERNAL_ID}:${ATTEMPT}`;
const ISSUE_ID = `${TENANT_ID}/${SLUG}:${EXTERNAL_ID}`;
const PROFILE_ID = `${TENANT_ID}/${SLUG}`;
const WORKFLOW_INSTANCE_ID = RUN_ID;

function seedTenantProfileIssue(db: ReturnType<typeof createMigratedDatabase>) {
  db.query(`
    INSERT INTO tenants (id, name, status, policy_json, created_at, updated_at)
    VALUES (?, ?, 'active', '{}', '2026-05-03T00:00:00Z', '2026-05-03T00:00:00Z')
  `).run(TENANT_ID, TENANT_ID);
  db.query(`
    INSERT INTO profiles (
      id, tenant_id, slug, active_version, tracker_kind, runtime_kind, status,
      config_json, source_schema_version, imported_schema_version,
      defaults_applied, imported_at, created_at, updated_at
    ) VALUES (?, ?, ?, '1.0.0', 'linear', 'cloudflare-agent-native', 'active',
      '{}', 1, 2, '[]', '2026-05-03T00:00:00Z',
      '2026-05-03T00:00:00Z', '2026-05-03T00:00:00Z')
  `).run(PROFILE_ID, TENANT_ID, SLUG);
  db.query(`
    INSERT INTO issues (
      id, tenant_id, profile_id, external_id, identifier, title, state,
      snapshot_json, first_seen_at, last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'SYM-1', 'Test issue', 'Todo',
      '{}', '2026-05-03T00:00:00Z', '2026-05-03T00:00:00Z',
      '2026-05-03T00:00:00Z', '2026-05-03T00:00:00Z')
  `).run(ISSUE_ID, TENANT_ID, PROFILE_ID, EXTERNAL_ID);
}

type R2WriteRecord = { key: string; body: string };

function fakeR2() {
  const objects = new Map<string, { body: string; contentType?: string }>();
  const writes: R2WriteRecord[] = [];
  return {
    objects,
    writes,
    bucket: {
      async put(key: string, value: string | ArrayBuffer | ReadableStream, options?: R2PutOptions) {
        const meta = options?.httpMetadata;
        const contentType =
          meta && !(meta instanceof Headers) ? meta.contentType : undefined;
        const body = typeof value === "string" ? value : "<binary>";
        objects.set(key, { body, contentType });
        writes.push({ key, body });
        return { key } as R2Object;
      },
      async get(key: string) {
        const obj = objects.get(key);
        if (!obj) return null;
        return { text: async () => obj.body } as R2ObjectBody;
      },
    } as unknown as R2Bucket,
  };
}

function fakeIssueAgentNamespace(opts: {
  agentStatus: string;
  agentLease: string | undefined;
  recordOnRunFinished?: (call: { tenant_id: string; slug: string; external_id: string; outcome: string }) => void;
}) {
  return {
    idFromName(name: string) {
      return name;
    },
    get(_id: string) {
      return {
        async getStatus(t: string, s: string, e: string) {
          return {
            tenantId: t,
            slug: s,
            externalId: e,
            status: opts.agentStatus,
            workflow_instance_id: opts.agentLease,
          };
        },
        async onRunFinished(t: string, s: string, e: string, outcome: string) {
          opts.recordOnRunFinished?.({ tenant_id: t, slug: s, external_id: e, outcome });
          return {};
        },
      };
    },
  } as unknown as DurableObjectNamespace;
}

// Replay-aware fake step.do. Cloudflare Workflows caches each step's
// result by name; a replay returns the cached result without re-running
// the body. We model the same behavior keyed by step name and track
// per-step body invocation counts so tests can assert that
// "finalizeManifest" body executes exactly once across an initial run +
// any number of replays.
function replayingStep() {
  const cache = new Map<string, unknown>();
  const bodyInvocations = new Map<string, number>();
  return {
    cache,
    bodyInvocations,
    step: {
      do: async <T>(
        name: string,
        optsOrBody: unknown,
        body?: () => Promise<T>,
      ): Promise<T> => {
        const fn = (typeof optsOrBody === "function" ? optsOrBody : body) as () => Promise<T>;
        if (cache.has(name)) {
          return cache.get(name) as T;
        }
        bodyInvocations.set(name, (bodyInvocations.get(name) ?? 0) + 1);
        const result = await fn();
        cache.set(name, result as unknown);
        return result;
      },
    },
  };
}

function makeParams(): ExecutionWorkflowParams {
  return {
    tenant_id: TENANT_ID,
    slug: SLUG,
    external_id: EXTERNAL_ID,
    identifier: "SYM-1",
    attempt: ATTEMPT,
    workflow_instance_id: WORKFLOW_INSTANCE_ID,
  };
}

describe("ExecutionWorkflow finalizeManifest boundary (Phase 6 F-6)", () => {
  test("finalizeManifest body runs exactly once across initial run + replay", async () => {
    // #given a seeded D1 + fake R2 + a replay-aware step.do
    const db = createMigratedDatabase();
    seedTenantProfileIssue(db);
    const r2 = fakeR2();
    const env = {
      DB: asD1(db),
      ARTIFACTS: r2.bucket,
      ISSUE_AGENT: fakeIssueAgentNamespace({
        agentStatus: "running",
        agentLease: WORKFLOW_INSTANCE_ID,
      }),
    };
    const workflow = new ExecutionWorkflow(
      {} as unknown as ConstructorParameters<typeof ExecutionWorkflow>[0],
      env as unknown as ConstructorParameters<typeof ExecutionWorkflow>[1],
    );
    const replay = replayingStep();
    const params = makeParams();

    // #when running the workflow once
    await workflow.run(
      { payload: params } as unknown as Parameters<typeof workflow.run>[0],
      replay.step as unknown as Parameters<typeof workflow.run>[1],
    );

    // #then finalizeManifest body executed once
    expect(replay.bodyInvocations.get("finalizeManifest")).toBe(1);

    // #when replaying the same workflow instance against the same step cache
    await workflow.run(
      { payload: params } as unknown as Parameters<typeof workflow.run>[0],
      replay.step as unknown as Parameters<typeof workflow.run>[1],
    );

    // #then finalizeManifest body still executed exactly once (replay returned cached result)
    expect(replay.bodyInvocations.get("finalizeManifest")).toBe(1);
  });

  test("manifest content is stable across replay", async () => {
    // #given a seeded D1 + fake R2
    const db = createMigratedDatabase();
    seedTenantProfileIssue(db);
    const r2 = fakeR2();
    const env = {
      DB: asD1(db),
      ARTIFACTS: r2.bucket,
      ISSUE_AGENT: fakeIssueAgentNamespace({
        agentStatus: "running",
        agentLease: WORKFLOW_INSTANCE_ID,
      }),
    };
    const workflow = new ExecutionWorkflow(
      {} as unknown as ConstructorParameters<typeof ExecutionWorkflow>[0],
      env as unknown as ConstructorParameters<typeof ExecutionWorkflow>[1],
    );
    const replay = replayingStep();
    const params = makeParams();
    const key = manifestKey({
      tenant_id: TENANT_ID,
      slug: SLUG,
      external_id: EXTERNAL_ID,
      attempt: ATTEMPT,
    });

    // #when running once and capturing manifest body, then replaying
    await workflow.run(
      { payload: params } as unknown as Parameters<typeof workflow.run>[0],
      replay.step as unknown as Parameters<typeof workflow.run>[1],
    );
    const initialManifestBody = r2.objects.get(key)?.body;

    await workflow.run(
      { payload: params } as unknown as Parameters<typeof workflow.run>[0],
      replay.step as unknown as Parameters<typeof workflow.run>[1],
    );

    // #then manifest content is byte-identical (replay reused cached step results)
    const replayedManifestBody = r2.objects.get(key)?.body;
    expect(replayedManifestBody).toBe(initialManifestBody);
  });

  test("finalizeManifest does NOT add a run_steps row (16-row invariant holds)", async () => {
    // #given a seeded D1 + fake R2
    const db = createMigratedDatabase();
    seedTenantProfileIssue(db);
    const r2 = fakeR2();
    const env = {
      DB: asD1(db),
      ARTIFACTS: r2.bucket,
      ISSUE_AGENT: fakeIssueAgentNamespace({
        agentStatus: "running",
        agentLease: WORKFLOW_INSTANCE_ID,
      }),
    };
    const workflow = new ExecutionWorkflow(
      {} as unknown as ConstructorParameters<typeof ExecutionWorkflow>[0],
      env as unknown as ConstructorParameters<typeof ExecutionWorkflow>[1],
    );
    const replay = replayingStep();

    // #when running a successful 16-step workflow
    await workflow.run(
      { payload: makeParams() } as unknown as Parameters<typeof workflow.run>[0],
      replay.step as unknown as Parameters<typeof workflow.run>[1],
    );

    // #then run_steps has exactly 16 rows — finalizeManifest did NOT add a 17th
    const stepCountRow = db
      .query(`SELECT COUNT(*) AS n FROM run_steps WHERE run_id = ?`)
      .get(RUN_ID) as { n: number } | null;
    expect(stepCountRow?.n).toBe(16);

    // #and no run_steps row carries the finalizeManifest name
    const finalizeRows = db
      .query(`SELECT step_name FROM run_steps WHERE run_id = ? AND step_name = 'finalizeManifest'`)
      .all(RUN_ID) as Array<{ step_name: string }>;
    expect(finalizeRows).toHaveLength(0);
  });
});
