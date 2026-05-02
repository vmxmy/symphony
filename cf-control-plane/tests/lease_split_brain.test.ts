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

type StorageMock = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(timestamp: number): Promise<void>;
  deleteAlarm(): Promise<void>;
};

type WorkflowCreateRecord = {
  id?: string;
  params?: ExecutionWorkflowParams;
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
    dispatchCount: 0,
    attempt: 0,
    ...overrides,
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

function makeAgentHarness(initial: IssueAgentState) {
  const values = new Map<string, unknown>([["state", initial]]);
  const storage: StorageMock = {
    async get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      values.set(key, value);
    },
    async setAlarm() {},
    async deleteAlarm() {},
  };
  const { workflow, creates } = workflowRecorder();
  const env = {
    DB: asD1(createMigratedDatabase()),
    DISPATCH: {
      async metrics() {
        return { backlogCount: 0, backlogBytes: 0 };
      },
      async send(_message: IssueDispatchMessage) {
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
      async sendBatch(_messages: Iterable<MessageSendRequest<IssueDispatchMessage>>) {
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    },
    ISSUE_AGENT: {} as DurableObjectNamespace,
    EXECUTION_WORKFLOW: workflow,
  };

  return {
    agent: new IssueAgent({ storage: storage as unknown as DurableObjectStorage } as DurableObjectState, env),
    workflowCreates: creates,
  };
}

describe("IssueAgent startRun lease split-brain guard", () => {
  test("two startRun calls produce one workflow instance", async () => {
    const harness = makeAgentHarness(makeState("queued"));

    // Race two starts in JS — not true CF concurrency, but verifies the
    // idempotency check sees the first call's in-flight lease acquisition.
    const [a, b] = await Promise.all([
      harness.agent.startRun(IDS.tenantId, IDS.slug, IDS.externalId, "scheduled-poll", "attempt=0"),
      harness.agent.startRun(IDS.tenantId, IDS.slug, IDS.externalId, "scheduled-poll", "attempt=0"),
    ]);

    expect(a.workflow_instance_id).toBe(b.workflow_instance_id);
    expect(harness.workflowCreates).toHaveLength(1);
  });

  test("startRun then startRun returns same instance", async () => {
    const harness = makeAgentHarness(makeState("queued"));

    const first = await harness.agent.startRun(IDS.tenantId, IDS.slug, IDS.externalId, "scheduled-poll", "attempt=0");
    const second = await harness.agent.startRun(IDS.tenantId, IDS.slug, IDS.externalId, "scheduled-poll", "attempt=0");

    expect(second.workflow_instance_id).toBe(first.workflow_instance_id);
    expect(harness.workflowCreates).toHaveLength(1);
  });
});
