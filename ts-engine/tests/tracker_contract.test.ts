// Phase 1 contract regression: orchestration types must accept a non-Linear
// TrackerAdapter implementation. If anything in src/* re-imports LinearClient
// concretely or assumes its shape, this test breaks compilation.

import { describe, expect, test } from "bun:test";
import { Orchestrator } from "../src/orchestrator.js";
import { State } from "../src/state.js";
import { Logger } from "../src/log.js";
import { PromptBuilder } from "../src/prompt.js";
import { LinearToolGateway } from "../src/dynamic_tool.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrackerAdapter } from "../src/contracts/tracker.js";
import type { WorkspaceAdapter } from "../src/contracts/workspace.js";
import type { Issue, WorkflowConfig } from "../src/types.js";
import type { LinearClient } from "../src/linear.js";

function makeIssue(id: string, identifier: string, state: string): Issue {
  return {
    id,
    identifier,
    title: identifier,
    description: null,
    state,
    priority: null,
    url: null,
    branchName: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}

class MemoryTracker implements TrackerAdapter {
  active: Issue[] = [];
  terminal: Issue[] = [];
  fetchedByIds: string[][] = [];

  async fetchActiveIssues(): Promise<Issue[]> {
    return this.active;
  }
  async fetchTerminalIssues(): Promise<Issue[]> {
    return this.terminal;
  }
  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    this.fetchedByIds.push(ids);
    const all = [...this.active, ...this.terminal];
    return all.filter((i) => ids.includes(i.id));
  }
}

class NoopWorkspace implements WorkspaceAdapter {
  async ensure(issue: Issue) {
    return { path: `/tmp/noop/${issue.identifier}`, host: null };
  }
  pathFor(issue: Issue): string {
    return `/tmp/noop/${issue.identifier}`;
  }
  async remove(_issue: Issue): Promise<void> {
    // no-op
  }
  async runHook(): Promise<void> {
    // no-op
  }
}

describe("TrackerAdapter contract", () => {
  test("MemoryTracker round-trips active, terminal, and by-id fetches", async () => {
    // #given
    const t = new MemoryTracker();
    t.active = [makeIssue("a", "X-1", "Todo")];
    t.terminal = [makeIssue("b", "X-2", "Done")];

    // #when
    const active = await t.fetchActiveIssues();
    const terminal = await t.fetchTerminalIssues();
    const found = await t.fetchIssuesByIds(["a", "missing"]);

    // #then
    expect(active.map((i) => i.identifier)).toEqual(["X-1"]);
    expect(terminal.map((i) => i.identifier)).toEqual(["X-2"]);
    expect(found.map((i) => i.identifier)).toEqual(["X-1"]);
    expect(t.fetchedByIds).toEqual([["a", "missing"]]);
  });

  test("Orchestrator accepts a memory tracker without any Linear dependency", () => {
    // #given - a fully non-Linear deps bundle. If Orchestrator re-imports
    // LinearClient or names its dep `linear`, this stops compiling.
    const tracker = new MemoryTracker();
    const tmpRoot = mkdtempSync(join(tmpdir(), "tracker-contract-"));
    const logger = new Logger({ logsRoot: join(tmpRoot, "log") });
    const cfg: WorkflowConfig = baselineConfig();

    // #when
    const orchestrator = new Orchestrator({
      tracker,
      workspace: new NoopWorkspace(),
      state: new State(),
      promptBuilder: new PromptBuilder("noop"),
      log: logger,
      config: () => cfg,
      agentFactory: () => {
        throw new Error("unused in this test");
      },
      // Gateway needs *some* graphql-capable client at construction time, but
      // is not exercised by this test. Satisfy the type with a stub.
      toolGateway: new LinearToolGateway({
        graphql: async () => ({}),
      } as unknown as LinearClient),
    });

    // #then
    expect(orchestrator).toBeInstanceOf(Orchestrator);
  });
});

function baselineConfig(): WorkflowConfig {
  return {
    schemaVersion: 1,
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "fake",
      projectSlug: "fake",
      assignee: null,
      activeStates: ["Todo"],
      terminalStates: ["Done"],
    },
    polling: { intervalMs: 60_000 },
    workspace: { root: "/tmp/unused" },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 1000,
    },
    agent: {
      maxConcurrentAgents: 1,
      maxTurns: 1,
      maxRetryBackoffMs: 1000,
      maxConcurrentAgentsByState: {},
    },
    codex: {
      command: "unused",
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: "workspace-write",
      turnTimeoutMs: 1000,
      readTimeoutMs: 1000,
      stallTimeoutMs: 0,
    },
  };
}
