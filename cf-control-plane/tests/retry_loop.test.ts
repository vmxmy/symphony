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
}));

const { IssueAgent } = await import("../src/agents/issue.js");
const { handleIssueDispatch } = await import("../src/queues/handlers.js");

const IDS = {
  tenantId: "tenant",
  slug: "profile",
  externalId: "issue-1",
} as const;
const PROFILE_ID = `${IDS.tenantId}/${IDS.slug}`;

type StorageMock = {
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
    dispatchCount: 0,
    attempt: 0,
    ...overrides,
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

function workflowRecorder() {
  const creates: Array<{ id?: string; params?: ExecutionWorkflowParams }> = [];
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

function makeAgentHarness(initial?: IssueAgentState) {
  const values = new Map<string, unknown>();
  if (initial) values.set("state", initial);
  const alarmTimestamps: number[] = [];
  let pendingAlarm: number | undefined;
  let deleteAlarmCalls = 0;
  const storage: StorageMock = {
    async get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      values.set(key, value);
    },
    async setAlarm(timestamp: number) {
      alarmTimestamps.push(timestamp);
      pendingAlarm = timestamp;
    },
    async deleteAlarm() {
      pendingAlarm = undefined;
      deleteAlarmCalls++;
    },
  };
  const db = createMigratedDatabase();
  seedTenantAndProfile(db);
  const { messages, queue } = queueRecorder();
  const { workflow, creates } = workflowRecorder();
  const env = {
    DB: asD1(db),
    DISPATCH: queue,
    PROJECT_AGENT: {} as DurableObjectNamespace,
    ISSUE_AGENT: {} as DurableObjectNamespace,
    EXECUTION_WORKFLOW: workflow,
  };
  const agent = new IssueAgent({ storage: storage as unknown as DurableObjectStorage } as DurableObjectState, env);

  async function triggerAlarm() {
    pendingAlarm = undefined;
    await agent.alarm();
  }

  return {
    agent,
    db,
    env,
    alarmTimestamps,
    sentMessages: messages,
    workflowCreates: creates,
    readState: () => values.get("state") as IssueAgentState | undefined,
    pendingAlarm: () => pendingAlarm,
    deleteAlarmCalls: () => deleteAlarmCalls,
    triggerAlarm,
  };
}

function seedTenantAndProfile(db: ReturnType<typeof createMigratedDatabase>) {
  db.query(`
    INSERT INTO tenants (id, name, status, policy_json, created_at, updated_at)
    VALUES (?, ?, 'active', '{}', '2026-05-02T00:00:00Z', '2026-05-02T00:00:00Z')
  `).run(IDS.tenantId, IDS.tenantId);

  db.query(`
    INSERT INTO profiles (
      id, tenant_id, slug, active_version, tracker_kind, runtime_kind, status,
      config_json, source_schema_version, imported_schema_version,
      defaults_applied, imported_at, created_at, updated_at
    ) VALUES (?, ?, ?, '1.0.0', 'linear', 'cloudflare-agent-native', 'active',
      '{}', 1, 2, '[]', '2026-05-02T00:00:00Z',
      '2026-05-02T00:00:00Z', '2026-05-02T00:00:00Z')
  `).run(PROFILE_ID, IDS.tenantId, IDS.slug);
}

function retryRows(db: ReturnType<typeof createMigratedDatabase>) {
  return db.query("SELECT issue_id, attempt, due_at, last_error FROM issue_retries ORDER BY issue_id").all() as Array<{
    issue_id: string;
    attempt: number;
    due_at: string;
    last_error: string | null;
  }>;
}

function issueAgentNamespace(agent: InstanceType<typeof IssueAgent>) {
  return {
    idFromName(name: string) {
      return name;
    },
    get() {
      return agent;
    },
  } as unknown as DurableObjectNamespace;
}

describe("retry loop", () => {
  test("v1 issue.dispatch starts the execution workflow after queueing", async () => {
    const harness = makeAgentHarness(makeState("discovered"));
    harness.env.ISSUE_AGENT = issueAgentNamespace(harness.agent);

    const outcome = await handleIssueDispatch(harness.env as unknown as Parameters<typeof handleIssueDispatch>[0], {
      kind: "issue.dispatch",
      version: 1,
      tenant_id: IDS.tenantId,
      slug: IDS.slug,
      external_id: IDS.externalId,
      identifier: IDS.externalId,
      attempt: 0,
      scheduled_at: new Date().toISOString(),
    });

    expect(outcome).toMatchObject({
      external_id: IDS.externalId,
      identifier: IDS.externalId,
      agent_status: "running",
      dispatch_count: 1,
    });
    expect(harness.readState()).toMatchObject({
      status: "running",
      workflow_instance_id: "run:tenant:profile:issue-1:0",
    });
    expect(harness.workflowCreates).toHaveLength(1);
    expect(harness.workflowCreates[0]).toMatchObject({
      id: "run:tenant:profile:issue-1:0",
      params: {
        tenant_id: IDS.tenantId,
        slug: IDS.slug,
        external_id: IDS.externalId,
        identifier: IDS.externalId,
        attempt: 0,
        workflow_instance_id: "run:tenant:profile:issue-1:0",
      },
    });
  });

  test("failure injection enters retry_wait, alarm re-dispatches, max attempts fails, and resume preserves attempts", async () => {
    const harness = makeAgentHarness(makeState("discovered"));
    harness.env.ISSUE_AGENT = issueAgentNamespace(harness.agent);

    const queued = await harness.agent.dispatch(IDS.tenantId, IDS.slug, IDS.externalId, "test", "initial-dispatch");
    expect(queued.status).toBe("queued");
    expect(queued.attempt).toBe(0);

    await handleIssueDispatch(harness.env as unknown as Parameters<typeof handleIssueDispatch>[0], {
      kind: "issue.dispatch",
      version: 2,
      tenant_id: IDS.tenantId,
      slug: IDS.slug,
      external_id: IDS.externalId,
      identifier: IDS.externalId,
      attempt: 1,
      scheduled_at: new Date().toISOString(),
      inject_failure: true,
      error: "synthetic failure 1",
    });
    expect(harness.readState()).toMatchObject({
      status: "retry_wait",
      attempt: 1,
      lastError: "synthetic failure 1",
    });
    expect(retryRows(harness.db)).toHaveLength(1);
    expect(harness.alarmTimestamps).toHaveLength(1);

    await harness.triggerAlarm();
    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0]).toMatchObject({
      kind: "issue.dispatch",
      version: 1,
      attempt: 1,
    });
    expect(harness.readState()).toMatchObject({ status: "queued", attempt: 1 });
    expect(retryRows(harness.db)).toHaveLength(0);

    await harness.agent.markFailed(IDS.tenantId, IDS.slug, IDS.externalId, "synthetic failure 2", {
      maxAttempts: 3,
    });
    expect(harness.readState()).toMatchObject({ status: "retry_wait", attempt: 2 });
    expect(retryRows(harness.db)).toHaveLength(1);

    await harness.triggerAlarm();
    expect(harness.sentMessages).toHaveLength(2);
    expect(harness.sentMessages[1]).toMatchObject({
      kind: "issue.dispatch",
      version: 1,
      attempt: 2,
    });
    expect(harness.readState()).toMatchObject({ status: "queued", attempt: 2 });
    expect(retryRows(harness.db)).toHaveLength(0);

    const failed = await harness.agent.markFailed(IDS.tenantId, IDS.slug, IDS.externalId, "synthetic failure 3", {
      maxAttempts: 3,
    });
    expect(failed).toMatchObject({
      status: "failed",
      attempt: 3,
      lastError: "synthetic failure 3",
    });
    expect(failed.nextRetryAt).toBeUndefined();
    expect(retryRows(harness.db)).toHaveLength(1);
    expect(retryRows(harness.db)[0]).toMatchObject({
      issue_id: `${IDS.tenantId}/${IDS.slug}:${IDS.externalId}`,
      attempt: 3,
      due_at: "",
      last_error: "synthetic failure 3",
    });
    expect(harness.alarmTimestamps).toHaveLength(2);
    expect(harness.pendingAlarm()).toBeUndefined();

    const resumed = await harness.agent.resume(IDS.tenantId, IDS.slug, IDS.externalId, "operator", "resume-failed");
    expect(resumed.status).toBe("queued");
    expect(resumed.attempt).toBe(3);
    expect(retryRows(harness.db)).toHaveLength(0);
    expect(harness.deleteAlarmCalls()).toBe(0);
  });
});
