import { describe, expect, mock, test } from "bun:test";
import type { IssueAgentState, IssueAgentStatus } from "../src/agents/issue.js";
import type { IssueDispatchMessage } from "../src/queues/types.js";
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
] as const satisfies readonly IssueAgentStatus[];

const LEGAL_TRANSITIONS = {
  discovered: ["queued", "cancelled"],
  queued: ["paused", "cancelled", "retry_wait", "failed"],
  paused: ["queued", "cancelled"],
  cancelled: [],
  retry_wait: ["queued", "paused", "cancelled"],
  failed: ["queued", "cancelled"],
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
} {
  const { storage, readState, alarmTimestamps, deleteAlarmCalls } = makeStorage(initial);
  const ctx = { storage } as DurableObjectState;
  const db = options.db ?? createMigratedDatabase();
  const { messages, queue } = queueRecorder();
  const env = {
    DB: asD1(db),
    DISPATCH: queue,
    ISSUE_AGENT: {} as DurableObjectNamespace,
  };
  return {
    agent: new IssueAgent(ctx, env),
    readState,
    alarmTimestamps,
    deleteAlarmCalls,
    db,
    sentMessages: messages,
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
