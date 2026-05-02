// Phase 6 PR-A US-002 — F-5 lease ordering regression test.
//
// Verifies that IssueAgent.startRun creates the EXECUTION_WORKFLOW instance
// BEFORE persisting workflow_instance_id + running to DO storage. If the
// workflow creation throws, the agent must remain in `queued` with no lease
// so a follow-up dispatch can re-attempt cleanly (Phase 6 plan §3 R14).

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
} {
  const values = new Map<string, unknown>();
  if (initial) values.set("state", initial);

  const storage: TestStorage = {
    async get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      values.set(key, value);
    },
    async setAlarm(_timestamp: number) {},
    async deleteAlarm() {},
  };

  return {
    storage: storage as unknown as DurableObjectStorage,
    readState: () => values.get("state") as IssueAgentState | undefined,
  };
}

type WorkflowCreateRecord = {
  id?: string;
  params?: ExecutionWorkflowParams;
};

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

function failingWorkflow(): {
  workflow: Workflow<ExecutionWorkflowParams>;
  creates: WorkflowCreateRecord[];
} {
  const creates: WorkflowCreateRecord[] = [];
  const workflow = {
    async get(id: string) {
      return new MockWorkflowInstance(id);
    },
    async create(options?: WorkflowInstanceCreateOptions<ExecutionWorkflowParams>) {
      creates.push({ id: options?.id, params: options?.params });
      throw new Error("create_failed: simulated");
    },
    async createBatch(_batch: WorkflowInstanceCreateOptions<ExecutionWorkflowParams>[]) {
      throw new Error("not_used");
    },
  } satisfies Workflow<ExecutionWorkflowParams>;
  return { workflow, creates };
}

function recordingWorkflow(): {
  workflow: Workflow<ExecutionWorkflowParams>;
  creates: WorkflowCreateRecord[];
} {
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

function makeAgent(
  initial: IssueAgentState | undefined,
  workflow: Workflow<ExecutionWorkflowParams>,
): {
  agent: InstanceType<typeof IssueAgent>;
  readState: () => IssueAgentState | undefined;
} {
  const { storage, readState } = makeStorage(initial);
  const ctx = { storage } as DurableObjectState;
  const db = createMigratedDatabase();
  const { queue } = queueRecorder();
  const env = {
    DB: asD1(db),
    DISPATCH: queue,
    ISSUE_AGENT: {} as DurableObjectNamespace,
    EXECUTION_WORKFLOW: workflow,
  };
  return {
    agent: new IssueAgent(ctx, env),
    readState,
  };
}

describe("IssueAgent.startRun lease ordering (Phase 6 PR-A F-5)", () => {
  test("create() failure leaves state queued with no lease", async () => {
    // #given a queued IssueAgent and a workflow binding whose create() throws
    const { workflow, creates } = failingWorkflow();
    const { agent, readState } = makeAgent(makeState("queued"), workflow);

    // #when startRun is invoked
    let thrown: unknown;
    try {
      await agent.startRun(IDS.tenantId, IDS.slug, IDS.externalId, "scheduled-poll", "attempt=0");
    } catch (error) {
      thrown = error;
    }

    // #then the original error propagates
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("create_failed: simulated");
    // create() was attempted exactly once
    expect(creates).toHaveLength(1);
    // and DO storage still says queued, with no lease
    const persisted = readState();
    expect(persisted?.status).toBe("queued");
    expect(persisted?.workflow_instance_id).toBeUndefined();
  });

  test("follow-up dispatch with successful create transitions to running", async () => {
    // #given a queued IssueAgent that just saw create() throw, then is retried
    const failing = failingWorkflow();
    const { agent, readState } = makeAgent(makeState("queued"), failing.workflow);
    await expect(
      agent.startRun(IDS.tenantId, IDS.slug, IDS.externalId, "scheduled-poll", "attempt=0"),
    ).rejects.toThrow("create_failed: simulated");
    expect(readState()?.status).toBe("queued");

    // #when a fresh agent for the same DO key uses a working workflow binding
    const success = recordingWorkflow();
    const { agent: agent2, readState: readState2 } = makeAgent(readState(), success.workflow);
    const state = await agent2.startRun(
      IDS.tenantId,
      IDS.slug,
      IDS.externalId,
      "scheduled-poll",
      "attempt=0",
    );

    // #then the second attempt transitions to running with a single create
    expect(state.status).toBe("running");
    expect(state.workflow_instance_id).toBe("run:tenant:profile:issue-1:0");
    expect(success.creates).toHaveLength(1);
    expect(readState2()).toMatchObject({
      status: "running",
      workflow_instance_id: "run:tenant:profile:issue-1:0",
    });
  });

  test("concurrent startRun calls dedup via startRunInFlight Promise map", async () => {
    // #given a queued IssueAgent whose create() succeeds but is observable
    const { workflow, creates } = recordingWorkflow();
    const { agent } = makeAgent(makeState("queued"), workflow);

    // #when two startRun calls race on the same key
    const [first, second] = await Promise.all([
      agent.startRun(IDS.tenantId, IDS.slug, IDS.externalId, "scheduled-poll", "attempt=0"),
      agent.startRun(IDS.tenantId, IDS.slug, IDS.externalId, "scheduled-poll", "attempt=0"),
    ]);

    // #then both share the same lease and only one create() ran
    expect(first.workflow_instance_id).toBe("run:tenant:profile:issue-1:0");
    expect(second.workflow_instance_id).toBe(first.workflow_instance_id);
    expect(creates).toHaveLength(1);
  });
});
