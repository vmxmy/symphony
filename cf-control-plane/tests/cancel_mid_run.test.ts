import { describe, expect, mock, test } from "bun:test";
import { asD1, createMigratedDatabase } from "./support/sqlite_d1.js";

// Mock cloudflare:workers BEFORE importing the workflow. Earlier test
// files in the suite may have mocked the same module with just
// DurableObject; re-assert both exports so the workflow import resolves
// regardless of file order.
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
const PROFILE_ID = `${TENANT_ID}/${SLUG}`;
const ISSUE_ID = `${PROFILE_ID}:${EXTERNAL_ID}`;
const WORKFLOW_INSTANCE_ID = "run-tenant-profile-issue-1-0";

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
  const objects = new Map<string, string>();
  return {
    objects,
    bucket: {
      async put(key: string, value: string | ArrayBuffer | ReadableStream) {
        objects.set(key, typeof value === "string" ? value : "<binary>");
        return { key } as R2Object;
      },
    } as unknown as R2Bucket,
  };
}

function fakeIssueAgentNamespace(opts: {
  agentStatus: string;
  agentLease: string | undefined;
  recordCall: (call: { method: string; outcome?: string; status?: string }) => void;
}) {
  return {
    idFromName(name: string) {
      return name;
    },
    get(_id: string) {
      return {
        async getStatus() {
          opts.recordCall({ method: "getStatus" });
          return {
            tenantId: TENANT_ID,
            slug: SLUG,
            externalId: EXTERNAL_ID,
            status: opts.agentStatus,
            workflow_instance_id: opts.agentLease,
          };
        },
        async onRunFinished(_t: string, _s: string, _e: string, outcome: string) {
          opts.recordCall({ method: "onRunFinished", outcome });
          return {};
        },
        async transition(_t: string, _s: string, _e: string, next: string) {
          opts.recordCall({ method: "transition", status: next });
          // Simulate a real IssueAgent rejecting illegal transitions so
          // the catch path's swallow is exercised when the seeded agent
          // is not in the running state.
          if (opts.agentStatus !== "running") {
            throw new Error(
              `issue_invalid_transition: ${opts.agentStatus} -> ${next}`,
            );
          }
          return {};
        },
        async markFailed(_t: string, _s: string, _e: string, error: string) {
          opts.recordCall({ method: "markFailed", outcome: error });
          if (opts.agentStatus !== "running") {
            throw new Error(`issue_markfailed_invalid_state: ${opts.agentStatus}`);
          }
          return {};
        },
      };
    },
  } as unknown as DurableObjectNamespace;
}

function fakeStep() {
  return {
    do: async <T>(_name: string, optsOrBody: unknown, body?: () => Promise<T>): Promise<T> => {
      const fn = (typeof optsOrBody === "function" ? optsOrBody : body) as () => Promise<T>;
      return fn();
    },
  };
}

describe("ExecutionWorkflow cancel mid run (Phase 5 PR-C / PR-E hardening)", () => {
  test("step 2 lease conflict marks run failed, no manifest, catch-path triggers attempt-bumping markFailed", async () => {
    const db = createMigratedDatabase();
    seedTenantProfileIssue(db);
    const r2 = fakeR2();
    const calls: Array<{ method: string; outcome?: string; status?: string }> = [];

    // IssueAgent reports cancelled — step 2 acquireLease will detect the
    // mismatch and throw acquire_lease_conflict.
    const env = {
      DB: asD1(db),
      ARTIFACTS: r2.bucket,
      ISSUE_AGENT: fakeIssueAgentNamespace({
        agentStatus: "cancelled",
        agentLease: undefined,
        recordCall: (c) => calls.push(c),
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

    let thrown: unknown;
    try {
      await workflow.run(
        { payload: params } as unknown as Parameters<typeof workflow.run>[0],
        fakeStep() as unknown as Parameters<typeof workflow.run>[1],
      );
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error)?.message).toMatch(/^acquire_lease_conflict:/);

    // runs row reflects failure
    const runRow = db
      .query(`SELECT status, error, artifact_manifest_ref FROM runs WHERE id = ?`)
      .get(RUN_ID) as { status: string; error: string | null; artifact_manifest_ref: string | null } | null;
    expect(runRow?.status).toBe("failed");
    expect(runRow?.error).toMatch(/^acquire_lease_conflict:/);
    expect(runRow?.artifact_manifest_ref).toBeNull();

    // run_steps shows step 1 completed and step 2 failed; nothing beyond.
    const stepRows = db
      .query(`SELECT step_sequence, step_name, status FROM run_steps WHERE run_id = ? ORDER BY step_sequence`)
      .all(RUN_ID) as Array<{ step_sequence: number; step_name: string; status: string }>;
    expect(stepRows).toHaveLength(2);
    expect(stepRows[0]).toMatchObject({ step_sequence: 1, status: "completed" });
    expect(stepRows[1]).toMatchObject({ step_sequence: 2, step_name: "acquireLease", status: "failed" });

    // R2 has no manifest. Use the exported manifestKey() helper so the
    // path contract stays in one place (manifest.ts).
    const key = manifestKey({
      tenant_id: TENANT_ID,
      slug: SLUG,
      external_id: EXTERNAL_ID,
      attempt: ATTEMPT,
    });
    expect(r2.objects.has(key)).toBe(false);

    // PR-E hardening: catch path attempts to release the lease (running ->
    // queued) and then bump the attempt counter via markFailed. Both fail
    // here because the seeded agent is already 'cancelled' (which is what
    // caused step 2 acquireLease to throw in the first place); the catch
    // path swallows both errors. We assert the catch path *tried* to call
    // both rather than the legacy onRunFinished('retry') so the silent
    // attempt-leak follow-up from architect review stays closed.
    const stepCalls = calls.map((c) => c.method);
    expect(stepCalls).toContain("getStatus");      // step 2 ran
    expect(stepCalls).toContain("transition");     // catch path released lease attempt
    expect(stepCalls).toContain("markFailed");     // catch path bumped attempt attempt
    expect(stepCalls).not.toContain("onRunFinished"); // legacy path no longer used
  });

  test("running agent: catch path bumps attempt via markFailed (no UNIQUE collision on retry)", async () => {
    const db = createMigratedDatabase();
    seedTenantProfileIssue(db);
    const r2 = fakeR2();
    const calls: Array<{ method: string; outcome?: string; status?: string }> = [];

    // Seed an agent in 'running' so catch-path transition + markFailed
    // succeed (the happy failure path). Force a failure mid-step by making
    // step 2 acquireLease detect a lease mismatch — agentLease differs from
    // params.workflow_instance_id.
    const env = {
      DB: asD1(db),
      ARTIFACTS: r2.bucket,
      ISSUE_AGENT: fakeIssueAgentNamespace({
        agentStatus: "running",
        agentLease: "run:other:other:other:0",
        recordCall: (c) => calls.push(c),
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

    let thrown: unknown;
    try {
      await workflow.run(
        { payload: params } as unknown as Parameters<typeof workflow.run>[0],
        fakeStep() as unknown as Parameters<typeof workflow.run>[1],
      );
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error)?.message).toMatch(/^acquire_lease_conflict:/);

    const transitionCall = calls.find((c) => c.method === "transition");
    expect(transitionCall).toBeDefined();
    expect(transitionCall?.status).toBe("queued");
    const markFailedCall = calls.find((c) => c.method === "markFailed");
    expect(markFailedCall).toBeDefined();
    expect(markFailedCall?.outcome).toMatch(/^acquire_lease_conflict:/);
  });
});
