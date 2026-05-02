import { describe, expect, mock, test } from "bun:test";
import { asD1, createMigratedDatabase } from "./support/sqlite_d1.js";

// Mock cloudflare:workers BEFORE importing the workflow class. Earlier
// test files (e.g. issue_agent.test.ts) may have mocked the same module
// with just DurableObject; we re-assert both exports so the workflow
// import resolves regardless of file order.
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

function fakeR2() {
  const objects = new Map<string, { body: string; contentType?: string }>();
  return {
    objects,
    bucket: {
      async put(key: string, value: string | ArrayBuffer | ReadableStream, options?: R2PutOptions) {
        const meta = options?.httpMetadata;
        const contentType =
          meta && !(meta instanceof Headers) ? meta.contentType : undefined;
        objects.set(key, {
          body: typeof value === "string" ? value : "<binary>",
          contentType,
        });
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
  recordOnRunFinished: (call: { tenant_id: string; slug: string; external_id: string; outcome: string }) => void;
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
          opts.recordOnRunFinished({ tenant_id: t, slug: s, external_id: e, outcome });
          return {};
        },
      };
    },
  } as unknown as DurableObjectNamespace;
}

function fakeStep() {
  // Accepts both (name, body) and (name, options, body) signatures.
  return {
    do: async <T>(
      _name: string,
      optsOrBody: unknown,
      body?: () => Promise<T>,
    ): Promise<T> => {
      const fn = (typeof optsOrBody === "function" ? optsOrBody : body) as () => Promise<T>;
      return fn();
    },
  };
}

describe("ExecutionWorkflow end-to-end (Phase 5 PR-C)", () => {
  test("full mock run completes 16 steps + writes manifest + notifies IssueAgent", async () => {
    const db = createMigratedDatabase();
    seedTenantProfileIssue(db);
    const r2 = fakeR2();
    const onRunFinishedCalls: Array<{ outcome: string }> = [];
    const env = {
      DB: asD1(db),
      ARTIFACTS: r2.bucket,
      ISSUE_AGENT: fakeIssueAgentNamespace({
        agentStatus: "running",
        agentLease: WORKFLOW_INSTANCE_ID,
        recordOnRunFinished: (c) => onRunFinishedCalls.push({ outcome: c.outcome }),
      }),
    };
    const workflow = new ExecutionWorkflow(
      {} as unknown as ConstructorParameters<typeof ExecutionWorkflow>[0],
      env as unknown as ConstructorParameters<typeof ExecutionWorkflow>[1],
    );

    const params: ExecutionWorkflowParams = {
      tenant_id: TENANT_ID,
      slug: SLUG,
      external_id: EXTERNAL_ID,
      identifier: "SYM-1",
      attempt: ATTEMPT,
      workflow_instance_id: WORKFLOW_INSTANCE_ID,
    };
    await workflow.run(
      { payload: params } as unknown as Parameters<typeof workflow.run>[0],
      fakeStep() as unknown as Parameters<typeof workflow.run>[1],
    );

    // runs row reaches completed
    const runRow = db
      .query(`SELECT id, status, workflow_id, adapter_kind, artifact_manifest_ref, token_usage_json FROM runs WHERE id = ?`)
      .get(RUN_ID) as
      | { id: string; status: string; workflow_id: string; adapter_kind: string; artifact_manifest_ref: string; token_usage_json: string }
      | null;
    expect(runRow).not.toBeNull();
    expect(runRow?.status).toBe("completed");
    expect(runRow?.workflow_id).toBe(WORKFLOW_INSTANCE_ID);
    expect(runRow?.adapter_kind).toBe("mock");
    expect(runRow?.artifact_manifest_ref).toBe(
      `runs/${TENANT_ID}/${SLUG}/${EXTERNAL_ID}/${ATTEMPT}/manifest.json`,
    );
    expect(JSON.parse(runRow?.token_usage_json ?? "{}")).toEqual({
      totalTokens: 100,
      inputTokens: 70,
      outputTokens: 30,
    });

    // 16 run_steps rows, all completed
    const stepRows = db
      .query(`SELECT step_sequence, step_name, status FROM run_steps WHERE run_id = ? ORDER BY step_sequence`)
      .all(RUN_ID) as Array<{ step_sequence: number; step_name: string; status: string }>;
    expect(stepRows).toHaveLength(16);
    expect(stepRows.every((r) => r.status === "completed")).toBe(true);
    expect(stepRows.map((r) => r.step_name)).toEqual([
      "loadProfileAndIssue",
      "acquireLease",
      "prepareWorkspace",
      "materializeAssets",
      "afterCreateHook",
      "renderPrompt",
      "beforeRunHook",
      "runAgentTurnLoop",
      "handleToolCalls",
      "pollTrackerBetweenTurns",
      "persistRunArtifacts",
      "afterRunHook",
      "validateCompletion",
      "transitionIssueState",
      "archiveOrCleanupWorkspace",
      "releaseLeaseAndNotify",
    ]);

    // run_events: at least started + completed for each of the 16 steps
    const eventCount = db
      .query(`SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?`)
      .get(RUN_ID) as { n: number } | null;
    expect(eventCount?.n).toBeGreaterThanOrEqual(32);

    // tool_calls: one linear_graphql row from step 8
    const toolRows = db
      .query(`SELECT tool_name, status FROM tool_calls WHERE run_id = ?`)
      .all(RUN_ID) as Array<{ tool_name: string; status: string }>;
    expect(toolRows).toHaveLength(1);
    expect(toolRows[0]).toEqual({ tool_name: "linear_graphql", status: "completed" });

    // R2 manifest is parseable JSON with the expected shape
    const manifestKey = `runs/${TENANT_ID}/${SLUG}/${EXTERNAL_ID}/${ATTEMPT}/manifest.json`;
    const manifestObj = r2.objects.get(manifestKey);
    expect(manifestObj).toBeDefined();
    const manifest = JSON.parse(manifestObj?.body ?? "{}");
    expect(manifest.schema).toBe("v1");
    expect(manifest.run_id).toBe(RUN_ID);
    expect(manifest.steps).toHaveLength(16);
    expect(manifest.token_usage).toEqual({ totalTokens: 100, inputTokens: 70, outputTokens: 30 });

    // R2 also has the tool-call envelope objects from step 8
    const toolInputKey = `runs/${TENANT_ID}/${SLUG}/${EXTERNAL_ID}/${ATTEMPT}/tool-calls/mock-tool-1.in.json`;
    const toolOutputKey = `runs/${TENANT_ID}/${SLUG}/${EXTERNAL_ID}/${ATTEMPT}/tool-calls/mock-tool-1.out.json`;
    expect(r2.objects.has(toolInputKey)).toBe(true);
    expect(r2.objects.has(toolOutputKey)).toBe(true);

    // IssueAgent.onRunFinished called exactly once with completed
    expect(onRunFinishedCalls).toEqual([{ outcome: "completed" }]);
  });
});
