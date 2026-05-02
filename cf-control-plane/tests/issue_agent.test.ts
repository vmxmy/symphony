import { describe, expect, mock, test } from "bun:test";
import type { IssueAgentState, IssueAgentStatus } from "../src/agents/issue.js";
import type { IssueDispatchMessage } from "../src/queues/types.js";
import type { ExecutionWorkflowParams } from "../src/workflows/execution.js";
import { asD1, createMigratedDatabase } from "./support/sqlite_d1.js";

class MockDurableObject {
  protected ctx: DurableObjectState;
  protected env: unknown;

  constructor(ctx: DurableObjectState, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

mock.module("cloudflare:workers", () => ({
  DurableObject: MockDurableObject,
  WorkflowEntrypoint: class { constructor(_c: unknown, env: unknown) { (this as any).env = env; } },
}));

const { IssueAgent } = await import("../src/agents/issue.js");

const IDS = {
  tenantId: "tenant",
  slug: "profile",
  externalId: "issue-1",
} as const;

const STATUSES = [
  "discovered",
  "queued",
  "paused",
  "cancelled",
  "retry_wait",
  "failed",
  "running",
  "completed",
] as const satisfies readonly IssueAgentStatus[];

const LEGAL_TRANSITIONS = {
  discovered: ["queued", "cancelled"],
  queued: ["paused", "cancelled", "retry_wait", "failed", "running"],
  paused: ["queued", "cancelled"],
  cancelled: [],
  retry_wait: ["queued", "paused", "cancelled"],
  failed: ["queued", "cancelled"],
  running: ["queued", "retry_wait", "failed", "cancelled", "completed"],
  completed: [],
} as const satisfies Record<IssueAgentStatus, readonly IssueAgentStatus[]>;

type TestStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(timestamp: number): Promise<void>;
  deleteAlarm(): Promise<void>;
};

function makeState(
  status: IssueAgentStatus,
  overrides: Partial<IssueAgentState> = {},
): IssueAgentState {
  return {
    issueKey: `${IDS.tenantId}:${IDS.slug}:${IDS.externalId}`,
    tenantId: IDS.tenantId,
    slug: IDS.slug,
    externalId: IDS.externalId,
    status,
    updatedAt: "2026-05-02T00:00:00.000Z",
    reason: "seed",
    decidedBy: "test",
    dispatchCount: 0,
    attempt: 0,
    ...overrides,
  };
}

function makeStorage(initial?: IssueAgentState): {
  storage: DurableObjectStorage;
  readState: () => IssueAgentState | undefined;
  alarmTimestamps: number[];
  deleteAlarmCalls: () => number;
} {
  const values = new Map<string, unknown>();
  if (initial) values.set("state", initial);
  const alarmTimestamps: number[] = [];
  let deleteAlarmCalls = 0;

  const storage: TestStorage = {
    async get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      values.set(key, value);
    },
    async setAlarm(timestamp: number) {
      alarmTimestamps.push(timestamp);
    },
    async deleteAlarm() {
      deleteAlarmCalls++;
    },
  };

  return {
    storage: storage as unknown as DurableObjectStorage,
    readState: () => values.get("state") as IssueAgentState | undefined,
    alarmTimestamps,
    deleteAlarmCalls: () => deleteAlarmCalls,
  };
}

function queueRecorder() {
  const messages: IssueDispatchMessage[] = [];
  return {
    messages,
    queue: {
      async send(message: IssueDispatchMessage) {
        messages.push(message);
      },
    } as unknown as Queue<IssueDispatchMessage>,
  };
}

class MockWorkflowInstance implements WorkflowInstance {
  constructor(public id: string) {}

  async pause(): Promise<void> {}

  async resume(): Promise<void> {}

  async terminate(): Promise<void> {}

  async restart(): Promise<void> {}

  async status(): Promise<InstanceStatus> {
    return { status: "running" };
  }

  async sendEvent(_event: { type: string; payload: unknown }): Promise<void> {}
}

type WorkflowCreateRecord = {
  id?: string;
  params?: ExecutionWorkflowParams;
};

function workflowRecorder() {
  const creates: WorkflowCreateRecord[] = [];
  const workflow = {
    async get(id: string) {
      return new MockWorkflowInstance(id);
    },
    async create(options?: WorkflowInstanceCreateOptions<ExecutionWorkflowParams>) {
      creates.push({ id: options?.id, params: options?.params });
      return new MockWorkflowInstance(options?.id ?? "generated");
    },
    async createBatch(batch: WorkflowInstanceCreateOptions<ExecutionWorkflowParams>[]) {
      for (const options of batch) creates.push({ id: options.id, params: options.params });
      return batch.map((options) => new MockWorkflowInstance(options.id ?? "generated"));
    },
  } satisfies Workflow<ExecutionWorkflowParams>;

  return { workflow, creates };
}

function retryRows(db: ReturnType<typeof createMigratedDatabase>) {
  return db.query("SELECT issue_id, attempt, due_at, last_error FROM issue_retries ORDER BY issue_id").all() as Array<{
    issue_id: string;
    attempt: number;
    due_at: string;
    last_error: string | null;
  }>;
}

function makeAgent(initial?: IssueAgentState, options: { db?: ReturnType<typeof createMigratedDatabase> } = {}): {
  agent: InstanceType<typeof IssueAgent>;
  readState: () => IssueAgentState | undefined;
  alarmTimestamps: number[];
  deleteAlarmCalls: () => number;
  db: ReturnType<typeof createMigratedDatabase>;
  sentMessages: IssueDispatchMessage[];
  workflowCreates: WorkflowCreateRecord[];
} {
  const { storage, readState, alarmTimestamps, deleteAlarmCalls } = makeStorage(initial);
  const ctx = { storage } as DurableObjectState;
  const db = options.db ?? createMigratedDatabase();
  const { messages, queue } = queueRecorder();
  const { workflow, creates } = workflowRecorder();
  const env = {
    DB: asD1(db),
    DISPATCH: queue,
    ISSUE_AGENT: {} as DurableObjectNamespace,
    EXECUTION_WORKFLOW: workflow,
  };
  return {
    agent: new IssueAgent(ctx, env),
    readState,
    alarmTimestamps,
    deleteAlarmCalls,
    db,
    sentMessages: messages,
    workflowCreates: creates,
  };
}

function expectedInvalidTransitionMessage(
  from: IssueAgentStatus,
  to: IssueAgentStatus,
): string {
  const terminalLabel = "(none \u2014 terminal)";
  const allowed = LEGAL_TRANSITIONS[from] as readonly IssueAgentStatus[];
  return `issue_invalid_transition: ${from} -> ${to} (allowed: ${allowed.join(", ") || terminalLabel})`;
}

async function expectInvalidTransition(
  from: IssueAgentStatus,
  to: IssueAgentStatus,
): Promise<void> {
  const { agent } = makeAgent(makeState(from));
  let thrown: unknown;
  try {
    await agent.transition(IDS.tenantId, IDS.slug, IDS.externalId, to, "test", "illegal");
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe(expectedInvalidTransitionMessage(from, to));
}

describe("IssueAgent state machine", () => {
  describe("allowed transitions", () => {
    for (const from of STATUSES) {
      for (const to of LEGAL_TRANSITIONS[from]) {
        test(`${from} -> ${to}`, async () => {
          const { agent } = makeAgent(makeState(from));
          const state = await agent.transition(IDS.tenantId, IDS.slug, IDS.externalId, to, "test", "allowed");

          expect(state.status).toBe(to);
        });
      }
    }
  });

  test("illegal transitions throw deterministic errors", async () => {
    for (const from of STATUSES) {
      const allowed = LEGAL_TRANSITIONS[from] as readonly IssueAgentStatus[];
      for (const to of STATUSES) {
        if (from === to || allowed.includes(to)) continue;
        await expectInvalidTransition(from, to);
      }
    }
  });

  test("initial state starts discovered with attempt zero", async () => {
    const { agent, readState } = makeAgent();
    const state = await agent.getStatus(IDS.tenantId, IDS.slug, IDS.externalId);

    expect(state.status).toBe("discovered");
    expect(state.attempt).toBe(0);
    expect(readState()).toMatchObject({ status: "discovered", attempt: 0 });
  });

  test("transition preserves attempt counter for PR-C failure handling", async () => {
    const { agent, readState } = makeAgent(
      makeState("failed", {
        attempt: 4,
        dispatchCount: 7,
        lastError: "synthetic failure",
        nextRetryAt: "2026-05-02T00:01:00.000Z",
      }),
    );

    const state = await agent.transition(IDS.tenantId, IDS.slug, IDS.externalId, "queued", "operator", "resume");

    expect(state.status).toBe("queued");
    expect(state.attempt).toBe(4);
    expect(readState()?.attempt).toBe(4);
  });
});

describe("IssueAgent.startRun + onRunFinished (Phase 5 PR-B)", () => {
  test("startRun from queued creates one workflow and enters running", async () => {
    const { agent, readState, workflowCreates } = makeAgent(makeState("queued"));

    const state = await agent.startRun(IDS.tenantId, IDS.slug, IDS.externalId, "scheduled-poll", "attempt=0");

    expect(state.status).toBe("running");
    expect(state.workflow_instance_id).toBe("run:tenant:profile:issue-1:0");
    expect(readState()).toMatchObject({
      status: "running",
      workflow_instance_id: "run:tenant:profile:issue-1:0",
    });
    expect(workflowCreates).toEqual([
      {
        id: "run:tenant:profile:issue-1:0",
        params: {
          tenant_id: IDS.tenantId,
          slug: IDS.slug,
          external_id: IDS.externalId,
          identifier: IDS.externalId,
          attempt: 0,
          workflow_instance_id: "run:tenant:profile:issue-1:0",
        },
      },
    ]);
  });

  test("startRun is idempotent while already running", async () => {
    const { agent, workflowCreates } = makeAgent(makeState("queued"));

    const first = await agent.startRun(IDS.tenantId, IDS.slug, IDS.externalId, "scheduled-poll", "attempt=0");
    const second = await agent.startRun(IDS.tenantId, IDS.slug, IDS.externalId, "scheduled-poll", "attempt=0");

    expect(second.workflow_instance_id).toBe(first.workflow_instance_id);
    expect(workflowCreates).toHaveLength(1);
  });

  test("startRun rejects non-queued states", async () => {
    const { agent, workflowCreates } = makeAgent(makeState("failed"));

    await expect(agent.startRun(IDS.tenantId, IDS.slug, IDS.externalId)).rejects.toThrow(
      "issue_startrun_invalid_state: failed",
    );
    expect(workflowCreates).toHaveLength(0);
  });

  test("onRunFinished completed moves running to completed and clears the lease", async () => {
    const { agent, readState } = makeAgent(
      makeState("running", { workflow_instance_id: "run:tenant:profile:issue-1:0" }),
    );

    const state = await agent.onRunFinished(IDS.tenantId, IDS.slug, IDS.externalId, "completed");

    expect(state.status).toBe("completed");
    expect(state.workflow_instance_id).toBeUndefined();
    expect(readState()).toMatchObject({ status: "completed" });
    expect(readState()?.workflow_instance_id).toBeUndefined();
  });

  test("onRunFinished failed moves running to failed and clears the lease", async () => {
    const { agent, readState } = makeAgent(
      makeState("running", { workflow_instance_id: "run:tenant:profile:issue-1:0" }),
    );

    const state = await agent.onRunFinished(IDS.tenantId, IDS.slug, IDS.externalId, "failed");

    expect(state.status).toBe("failed");
    expect(state.workflow_instance_id).toBeUndefined();
    expect(readState()?.workflow_instance_id).toBeUndefined();
  });

  test("onRunFinished cancelled moves running to cancelled and clears the lease", async () => {
    const { agent, readState } = makeAgent(
      makeState("running", { workflow_instance_id: "run:tenant:profile:issue-1:0" }),
    );

    const state = await agent.onRunFinished(IDS.tenantId, IDS.slug, IDS.externalId, "cancelled");

    expect(state.status).toBe("cancelled");
    expect(state.workflow_instance_id).toBeUndefined();
    expect(readState()?.workflow_instance_id).toBeUndefined();
  });

  test("onRunFinished retry moves running to queued, clears the lease, and preserves attempt", async () => {
    const { agent, readState } = makeAgent(
      makeState("running", {
        attempt: 3,
        workflow_instance_id: "run:tenant:profile:issue-1:3",
      }),
    );

    const state = await agent.onRunFinished(IDS.tenantId, IDS.slug, IDS.externalId, "retry");

    expect(state.status).toBe("queued");
    expect(state.attempt).toBe(3);
    expect(state.workflow_instance_id).toBeUndefined();
    expect(readState()).toMatchObject({ status: "queued", attempt: 3 });
    expect(readState()?.workflow_instance_id).toBeUndefined();
  });

  test("onRunFinished is idempotent on already-terminal outcome", async () => {
    const { agent, readState } = makeAgent(
      makeState("running", { workflow_instance_id: "run:tenant:profile:issue-1:0" }),
    );

    const first = await agent.onRunFinished(IDS.tenantId, IDS.slug, IDS.externalId, "completed");
    const second = await agent.onRunFinished(IDS.tenantId, IDS.slug, IDS.externalId, "completed");

    expect(second).toEqual(first);
    expect(readState()).toEqual(first);
  });

  test("onRunFinished rejects non-running states", async () => {
    const { agent } = makeAgent(makeState("queued"));

    await expect(agent.onRunFinished(IDS.tenantId, IDS.slug, IDS.externalId, "completed")).rejects.toThrow(
      "issue_onrunfinished_invalid_state: queued",
    );
  });
});

describe("IssueAgent retry loop entrypoints", () => {
  test("markFailed transitions queued to retry_wait when attempt is below max", async () => {
    const startedAt = Date.now();
    const { agent, alarmTimestamps, db } = makeAgent(makeState("queued", { attempt: 0 }));

    const state = await agent.markFailed(IDS.tenantId, IDS.slug, IDS.externalId, "boom");

    expect(state.status).toBe("retry_wait");
    expect(state.attempt).toBe(1);
    expect(state.lastError).toBe("boom");
    expect(typeof state.nextRetryAt).toBe("string");
    expect(new Date(state.nextRetryAt!).getTime()).toBeGreaterThanOrEqual(startedAt + 900);
    expect(new Date(state.nextRetryAt!).getTime()).toBeLessThanOrEqual(Date.now() + 1_200);
    expect(alarmTimestamps).toHaveLength(1);
    expect(alarmTimestamps[0]!).toBeGreaterThanOrEqual(startedAt + 900);
    expect(alarmTimestamps[0]!).toBeLessThanOrEqual(Date.now() + 1_200);
    expect(retryRows(db)).toHaveLength(1);
    expect(retryRows(db)[0]).toMatchObject({
      issue_id: `${IDS.tenantId}/${IDS.slug}:${IDS.externalId}`,
      attempt: 1,
      last_error: "boom",
    });
  });

  test("markFailed transitions queued to failed at maxAttempts", async () => {
    const { agent, alarmTimestamps, db } = makeAgent(makeState("queued", { attempt: 0 }));

    const retrying = await agent.markFailed(IDS.tenantId, IDS.slug, IDS.externalId, "first", {
      maxAttempts: 2,
    });
    await agent.retryNow(IDS.tenantId, IDS.slug, IDS.externalId, "test", "requeue");
    const failed = await agent.markFailed(IDS.tenantId, IDS.slug, IDS.externalId, "second", {
      maxAttempts: 2,
    });

    expect(retrying.status).toBe("retry_wait");
    expect(failed.status).toBe("failed");
    expect(failed.attempt).toBe(2);
    expect(failed.nextRetryAt).toBeUndefined();
    expect(alarmTimestamps).toHaveLength(1);
    expect(retryRows(db)).toHaveLength(1);
    expect(retryRows(db)[0]).toMatchObject({
      issue_id: `${IDS.tenantId}/${IDS.slug}:${IDS.externalId}`,
      attempt: 2,
      due_at: "",
      last_error: "second",
    });
  });

  test("markFailed throws deterministic error outside queued", async () => {
    const { agent } = makeAgent(makeState("failed"));

    await expect(agent.markFailed(IDS.tenantId, IDS.slug, IDS.externalId, "boom")).rejects.toThrow(
      "issue_markfailed_invalid_state: failed",
    );
  });

  test("alarm returns early outside retry_wait", async () => {
    const { agent, readState, sentMessages } = makeAgent(makeState("cancelled"));

    await agent.alarm();

    expect(sentMessages).toHaveLength(0);
    expect(readState()?.status).toBe("cancelled");
  });

  test("cancel clears retry mirror row", async () => {
    const { agent, db } = makeAgent(
      makeState("retry_wait", {
        attempt: 1,
        nextRetryAt: new Date(Date.now() + 1_000).toISOString(),
      }),
    );
    db.query(`
      INSERT INTO issue_retries (
        issue_id, tenant_id, profile_id, external_id, attempt, due_at, last_error, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, 'boom', ?)
    `).run(
      `${IDS.tenantId}/${IDS.slug}:${IDS.externalId}`,
      IDS.tenantId,
      `${IDS.tenantId}/${IDS.slug}`,
      IDS.externalId,
      new Date(Date.now() + 1_000).toISOString(),
      new Date().toISOString(),
    );

    const state = await agent.cancel(IDS.tenantId, IDS.slug, IDS.externalId, "operator", "operator-cancel");

    expect(state.status).toBe("cancelled");
    expect(retryRows(db)).toHaveLength(0);
  });

  test("alarm in retry_wait enqueues issue.dispatch and transitions to queued", async () => {
    const { agent, readState, sentMessages, db } = makeAgent(
      makeState("retry_wait", {
        attempt: 2,
        nextRetryAt: new Date(Date.now() + 1_000).toISOString(),
      }),
    );
    db.query(`
      INSERT INTO issue_retries (
        issue_id, tenant_id, profile_id, external_id, attempt, due_at, last_error, updated_at
      ) VALUES (?, ?, ?, ?, 2, ?, 'boom', ?)
    `).run(
      `${IDS.tenantId}/${IDS.slug}:${IDS.externalId}`,
      IDS.tenantId,
      `${IDS.tenantId}/${IDS.slug}`,
      IDS.externalId,
      new Date(Date.now() + 1_000).toISOString(),
      new Date().toISOString(),
    );

    await agent.alarm();

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      kind: "issue.dispatch",
      version: 1,
      tenant_id: IDS.tenantId,
      slug: IDS.slug,
      external_id: IDS.externalId,
      identifier: IDS.externalId,
      attempt: 2,
    });
    expect(readState()?.status).toBe("queued");
    expect(retryRows(db)).toHaveLength(0);
  });

  test("retryNow transitions retry_wait to queued without enqueueing", async () => {
    const { agent, readState, sentMessages, deleteAlarmCalls, db } = makeAgent(
      makeState("retry_wait", {
        attempt: 1,
        nextRetryAt: new Date(Date.now() + 1_000).toISOString(),
      }),
    );
    db.query(`
      INSERT INTO issue_retries (
        issue_id, tenant_id, profile_id, external_id, attempt, due_at, last_error, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, 'boom', ?)
    `).run(
      `${IDS.tenantId}/${IDS.slug}:${IDS.externalId}`,
      IDS.tenantId,
      `${IDS.tenantId}/${IDS.slug}`,
      IDS.externalId,
      new Date(Date.now() + 1_000).toISOString(),
      new Date().toISOString(),
    );

    const state = await agent.retryNow(IDS.tenantId, IDS.slug, IDS.externalId, "operator", "operator-retry-now");

    expect(state.status).toBe("queued");
    expect(readState()?.status).toBe("queued");
    expect(deleteAlarmCalls()).toBe(1);
    expect(sentMessages).toHaveLength(0);
    expect(retryRows(db)).toHaveLength(0);
  });
});
