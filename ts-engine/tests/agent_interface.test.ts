// Validates the Agent interface shape by running AgentRunner against
// MockAgent (a non-Codex implementation). If AgentRunner ever needs to be
// modified to accommodate Codex specifics, this test will fail to compile
// or fail at runtime — that's the abstraction-leak signal.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunner } from "../src/agent.js";
import { MockAgent, type MockAgentScript } from "../src/agent/mock_adapter.js";
import { Logger } from "../src/log.js";
import { PromptBuilder } from "../src/prompt.js";
import { State } from "../src/state.js";
import { WorkspaceManager } from "../src/workspace.js";
import type { Issue, WorkflowConfig } from "../src/types.js";
import type { LinearClient } from "../src/linear.js";

describe("Agent interface contract", () => {
  test("AgentRunner drives MockAgent through start → session → turn → stop", async () => {
    const harness = makeHarness({
      script: {
        sessionId: "mock-session-abc",
        turns: [
          {
            events: [
              { kind: "activity", label: "message", text: "starting work" },
              { kind: "tokens", usage: { totalTokens: 100, inputTokens: 60, outputTokens: 40 } },
            ],
            outcome: { status: "completed" },
          },
        ],
      },
      issueStateAfterTurn: ["Done"],
    });

    const outcome = await harness.runner.run(harness.issue, 1);

    expect(outcome).toEqual({ status: "issue_state_changed", newState: "Done" });

    const inspect = harness.mock.inspect();
    expect(inspect.startCalls).toBe(1);
    expect(inspect.sessionStartCalls).toBe(1);
    expect(inspect.stopCalls).toBe(1);
    expect(inspect.turnsConsumed).toBe(1);
    expect(inspect.cwd).toBe(harness.expectedWorkspace);
  });

  test("AgentRunner records adapter session id, last event, and token totals", async () => {
    const harness = makeHarness({
      script: {
        sessionId: "mock-session-xyz",
        turns: [
          {
            events: [
              { kind: "activity", label: "tool_call", text: "linear_graphql" },
              { kind: "tokens", usage: { totalTokens: 200, inputTokens: 150, outputTokens: 50 } },
              { kind: "tokens", usage: { totalTokens: 350, inputTokens: 200, outputTokens: 150 } },
            ],
          },
        ],
      },
      issueStateAfterTurn: ["Done"],
    });

    await harness.runner.run(harness.issue, 1);

    expect(harness.state.codexTotals.totalTokens).toBe(350);
    expect(harness.state.codexTotals.inputTokens).toBe(200);
    expect(harness.state.codexTotals.outputTokens).toBe(150);
    // No running session left after the run
    expect(harness.state.running.size).toBe(0);
  });

  test("AgentRunner dispatches tool calls through the linear_graphql handler", async () => {
    const seenQueries: string[] = [];
    const harness = makeHarness({
      script: {
        turns: [
          {
            events: [
              {
                kind: "tool_call",
                call: {
                  id: "tc-1",
                  name: "linear_graphql",
                  arguments: { query: "query { viewer { id } }" },
                },
              },
            ],
          },
        ],
      },
      issueStateAfterTurn: ["Done"],
      onGraphql: async (query) => {
        seenQueries.push(query);
        return { viewer: { id: "user-123" } };
      },
    });

    await harness.runner.run(harness.issue, 1);

    expect(seenQueries).toEqual(["query { viewer { id } }"]);
    const toolResults = harness.mock.inspect().toolResults;
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.success).toBe(true);
    expect(toolResults[0]?.output).toContain("user-123");
  });

  test("AgentRunner reports max_turns_exceeded when issue stays active", async () => {
    const harness = makeHarness({
      script: {
        turns: [
          { outcome: { status: "completed" } },
          { outcome: { status: "completed" } },
          { outcome: { status: "completed" } },
        ],
      },
      maxTurns: 2,
      issueStateAfterTurn: ["In Progress", "In Progress", "In Progress"],
    });

    const outcome = await harness.runner.run(harness.issue, 1);

    expect(outcome).toEqual({ status: "max_turns_exceeded" });
    // Stopped agent even when bailing for max_turns
    expect(harness.mock.inspect().stopCalls).toBe(1);
    expect(harness.mock.inspect().turnsConsumed).toBe(2);
  });

  test("AgentRunner converts adapter failure into error outcome", async () => {
    const harness = makeHarness({
      script: {
        turns: [
          { outcome: { status: "failed", reason: { message: "boom" } } },
        ],
      },
      issueStateAfterTurn: ["In Progress"],
    });

    const outcome = await harness.runner.run(harness.issue, 1);

    expect(outcome.status).toBe("error");
    if (outcome.status === "error") {
      expect(outcome.error).toContain("turn_failed");
      expect(outcome.error).toContain("boom");
    }
    expect(harness.mock.inspect().stopCalls).toBe(1);
  });
});

// ---- harness ------------------------------------------------------------

type HarnessOptions = {
  script: MockAgentScript;
  /** Linear states the stub returns from fetchIssuesByIds, one per turn. */
  issueStateAfterTurn: string[];
  maxTurns?: number;
  onGraphql?: (query: string, variables: Record<string, unknown>) => Promise<unknown>;
};

function makeHarness(opts: HarnessOptions): {
  runner: AgentRunner;
  mock: MockAgent;
  issue: Issue;
  state: State;
  expectedWorkspace: string;
} {
  const tmpRoot = mkdtempSync(join(tmpdir(), "agent-iface-"));
  const logger = new Logger({ logsRoot: join(tmpRoot, "log") });
  const wsRoot = join(tmpRoot, "workspaces");

  const issue: Issue = {
    id: "issue-1",
    identifier: "SYM-42",
    title: "test",
    description: null,
    state: "In Progress",
    priority: null,
    url: null,
    branchName: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };

  const cfg: WorkflowConfig = {
    schemaVersion: 1,
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "fake",
      projectSlug: "fake",
      assignee: null,
      activeStates: ["In Progress"],
      terminalStates: ["Done"],
    },
    polling: { intervalMs: 1000 },
    workspace: { root: wsRoot },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 5000,
    },
    agent: {
      maxConcurrentAgents: 1,
      maxTurns: opts.maxTurns ?? 10,
      maxRetryBackoffMs: 1000,
      maxConcurrentAgentsByState: {},
    },
    codex: {
      command: "unused",
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: "workspace-write",
      turnTimeoutMs: 60_000,
      readTimeoutMs: 5000,
      stallTimeoutMs: 0,
    },
  };

  const state = new State();
  const workspace = new WorkspaceManager(
    { root: wsRoot, hooks: cfg.hooks },
    logger,
  );
  const promptBuilder = new PromptBuilder("Issue: {{ issue.identifier }}");

  // Stub LinearClient: fetchIssuesByIds returns scripted state per call.
  let callIdx = 0;
  const linear = {
    async fetchIssuesByIds(_ids: string[]): Promise<Issue[]> {
      const stateName = opts.issueStateAfterTurn[callIdx] ?? opts.issueStateAfterTurn.at(-1) ?? "Done";
      callIdx += 1;
      return [{ ...issue, state: stateName }];
    },
    async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      if (!opts.onGraphql) throw new Error("graphql not stubbed");
      return (await opts.onGraphql(query, variables)) as T;
    },
    async fetchActiveIssues(): Promise<Issue[]> { return []; },
    async fetchTerminalIssues(): Promise<Issue[]> { return []; },
  } satisfies Partial<LinearClient> as unknown as LinearClient;

  const mock = new MockAgent(opts.script);

  const runner = new AgentRunner({
    linear,
    workspace,
    state,
    promptBuilder,
    log: logger,
    config: () => cfg,
    agentFactory: () => mock,
  });

  return {
    runner,
    mock,
    issue,
    state,
    expectedWorkspace: join(wsRoot, "SYM-42"),
  };
}
