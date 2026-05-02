import { describe, expect, mock, test } from "bun:test";
import type { IssueAgentState, IssueAgentStatus } from "../src/agents/issue.js";

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
  };

  return {
    storage: storage as unknown as DurableObjectStorage,
    readState: () => values.get("state") as IssueAgentState | undefined,
  };
}

function makeAgent(initial?: IssueAgentState): {
  agent: InstanceType<typeof IssueAgent>;
  readState: () => IssueAgentState | undefined;
} {
  const { storage, readState } = makeStorage(initial);
  const ctx = { storage } as DurableObjectState;
  const env = { ISSUE_AGENT: {} as DurableObjectNamespace };
  return { agent: new IssueAgent(ctx, env), readState };
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
