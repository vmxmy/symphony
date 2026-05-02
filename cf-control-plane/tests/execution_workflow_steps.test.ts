import { describe, expect, mock, test } from "bun:test";
import { asD1, createMigratedDatabase } from "./support/sqlite_d1.js";

// Mock cloudflare:workers BEFORE importing the workflow module so the
// WorkflowEntrypoint base class can resolve. We don't construct the
// class in this test (we exercise recordStep directly), but the import
// chain requires the module to load cleanly.
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

// Provide both exports so tests run in any order — earlier files in the
// suite may have mocked cloudflare:workers with just DurableObject, and
// re-asserting both keeps the workflow import resolvable.
mock.module("cloudflare:workers", () => ({
  DurableObject: MockDurableObject,
  WorkflowEntrypoint: MockWorkflowEntrypoint,
}));

const { recordStep } = await import("../src/workflows/execution.js");

type FakeStep = {
  do: <T>(
    name: string,
    optsOrBody:
      | { retries: { limit: number; delay?: string; backoff?: string } }
      | (() => Promise<T>),
    body?: () => Promise<T>,
  ) => Promise<T>;
};

const fakeStep: FakeStep = {
  do: async (_name, optsOrBody, body) => {
    const fn = typeof optsOrBody === "function" ? optsOrBody : body;
    if (!fn) throw new Error("fakeStep.do: body required");
    return fn();
  },
};

const RUN_ID = "run:tenant:profile:issue-1:0";

function envWithDb() {
  const db = createMigratedDatabase();
  return {
    db,
    env: {
      DB: asD1(db),
      ARTIFACTS: {} as R2Bucket,
      ISSUE_AGENT: {} as DurableObjectNamespace,
    },
  };
}

function rowsForRun(db: ReturnType<typeof createMigratedDatabase>, runId: string) {
  return {
    steps: db
      .query(
        `SELECT id, step_sequence, status, error FROM run_steps WHERE run_id = ? ORDER BY step_sequence`,
      )
      .all(runId) as Array<{ id: string; step_sequence: number; status: string; error: string | null }>,
    events: db
      .query(`SELECT id, event_type, severity FROM run_events WHERE run_id = ? ORDER BY id`)
      .all(runId) as Array<{ id: string; event_type: string; severity: string }>,
  };
}

describe("recordStep (Phase 5 PR-C)", () => {
  test("success path writes one run_steps row + start/complete events", async () => {
    const { db, env } = envWithDb();
    const result = await recordStep(
      env as unknown as Parameters<typeof recordStep>[0],
      RUN_ID,
      1,
      "loadProfileAndIssue",
      fakeStep as unknown as Parameters<typeof recordStep>[4],
      async () => ({ result: { ok: true }, eventDetail: { mock: true } }),
    );
    expect(result).toEqual({ ok: true });

    const { steps, events } = rowsForRun(db, RUN_ID);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ step_sequence: 1, status: "completed", error: null });
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.event_type))).toEqual(
      new Set(["step.loadProfileAndIssue.started", "step.loadProfileAndIssue.completed"]),
    );
  });

  test("replay with same (run_id, sequence) keeps a single run_steps row", async () => {
    const { db, env } = envWithDb();
    await recordStep(
      env as unknown as Parameters<typeof recordStep>[0],
      RUN_ID,
      2,
      "acquireLease",
      fakeStep as unknown as Parameters<typeof recordStep>[4],
      async () => ({ result: { lease: "abc" } }),
    );
    await recordStep(
      env as unknown as Parameters<typeof recordStep>[0],
      RUN_ID,
      2,
      "acquireLease",
      fakeStep as unknown as Parameters<typeof recordStep>[4],
      async () => ({ result: { lease: "abc" } }),
    );

    const { steps, events } = rowsForRun(db, RUN_ID);
    expect(steps).toHaveLength(1);
    // INSERT OR IGNORE keeps both started and completed events at one each.
    expect(events).toHaveLength(2);
  });

  test("failure path writes failed status + error event with severity error", async () => {
    const { db, env } = envWithDb();

    let thrown: unknown;
    try {
      await recordStep(
        env as unknown as Parameters<typeof recordStep>[0],
        RUN_ID,
        8,
        "runAgentTurnLoop",
        fakeStep as unknown as Parameters<typeof recordStep>[4],
        async () => {
          throw new Error("boom");
        },
      );
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error).message).toBe("boom");

    const { steps, events } = rowsForRun(db, RUN_ID);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ status: "failed", error: "boom" });
    const errEvent = events.find((e) => e.event_type === "step.runAgentTurnLoop.failed");
    expect(errEvent?.severity).toBe("error");
  });
});
