import { describe, expect, test } from "bun:test";
import { renderDashboardHtml } from "../src/dashboard/render.js";
import type { DashboardViewModel } from "../src/dashboard/view_model.js";
import { dashboardViewModelFromSnapshot } from "../src/dashboard/view_model.js";
import { State } from "../src/state.js";
import type { Issue } from "../src/types.js";

describe("dashboard view model", () => {
  test("adapts running, retrying, empty-state, and token summary data", () => {
    const state = new State();
    state.codexTotals = {
      totalTokens: 34_567,
      inputTokens: 12_000,
      outputTokens: 22_567,
      secondsRunning: 90,
    };

    state.startAgent(issue("issue-1", "SYM-1", "In Progress"), "/tmp/sym-1");
    state.updateAgent("issue-1", {
      turnCount: 3,
      tokens: { totalTokens: 1_234, inputTokens: 1_000, outputTokens: 234, secondsRunning: 12 },
      lastEvent: "tool_call",
      lastEventAt: "2026-05-01T00:00:00.000Z",
    });
    state.scheduleRetry(
      issue("issue-2", "SYM-2", "Todo"),
      "retry later because of a transient upstream failure",
      "/tmp/sym-2",
      null,
      1_000,
    );

    const viewModel = dashboardViewModelFromSnapshot(state.snapshot());

    expect(viewModel.summary.runningCount).toBe(1);
    expect(viewModel.summary.retryingCount).toBe(1);
    expect(viewModel.summary.totalTokens).toBe("35,801");
    expect(viewModel.hasRunning).toBe(true);
    expect(viewModel.hasRetries).toBe(true);
    expect(viewModel.runningRows[0]).toMatchObject({
      issueIdentifier: "SYM-1",
      state: "In Progress",
      turnCount: 3,
      totalTokens: "1,234",
      lastEvent: "tool_call",
    });
    expect(viewModel.retryRows[0]).toMatchObject({
      issueIdentifier: "SYM-2",
      attempt: 1,
      error: "retry later because of a transient upstream failure",
    });
  });

  test("marks running and retrying empty states explicitly", () => {
    const viewModel = dashboardViewModelFromSnapshot(new State().snapshot());

    expect(viewModel.hasRunning).toBe(false);
    expect(viewModel.hasRetries).toBe(false);
    expect(viewModel.runningRows).toEqual([]);
    expect(viewModel.retryRows).toEqual([]);
  });
});

describe("dashboard renderer", () => {
  test("escapes untrusted running and retrying fields", () => {
    const html = renderDashboardHtml(dangerousViewModel());

    expect(html).toContain("&lt;SYM&amp;&quot;1&#39;&gt;");
    expect(html).toContain("&lt;state&gt;");
    expect(html).toContain("&lt;event&gt;&amp;");
    expect(html).toContain("&lt;retry-error&gt;&amp;");
    expect(html).not.toContain("<SYM&\"1'>");
    expect(html).not.toContain("<event>&");
    expect(html).not.toContain("<retry-error>&");
  });

  test("renders dashboard smoke content and empty states", () => {
    const html = renderDashboardHtml({
      summary: {
        runningCount: 0,
        retryingCount: 0,
        totalTokens: "0",
        generatedAt: "2026-05-01T00:00:00.000Z",
      },
      runningRows: [],
      retryRows: [],
      hasRunning: false,
      hasRetries: false,
      stateApiPath: "/api/v1/state",
      refreshMethod: "POST",
      refreshPath: "/api/v1/refresh",
    });

    expect(html).toContain("Symphony TS");
    expect(html).toContain("No active agents");
    expect(html).toContain("No retries queued");
    expect(html).toContain("/api/v1/state");
  });
});

function dangerousViewModel(): DashboardViewModel {
  return {
    summary: {
      runningCount: 1,
      retryingCount: 1,
      totalTokens: "1,000",
      generatedAt: "2026-05-01T00:00:00.000Z",
    },
    runningRows: [
      {
        issueIdentifier: `<SYM&"1'>`,
        state: "<state>",
        turnCount: 2,
        totalTokens: "5",
        lastEvent: "<event>&",
        lastEventAt: "<time>",
      },
    ],
    retryRows: [
      {
        issueIdentifier: "<SYM-2>",
        attempt: 1,
        dueAt: "<due>",
        error: "<retry-error>&",
      },
    ],
    hasRunning: true,
    hasRetries: true,
    stateApiPath: "/api/v1/state",
    refreshMethod: "POST",
    refreshPath: "/api/v1/refresh",
  };
}

function issue(id: string, identifier: string, state: string): Issue {
  return {
    id,
    identifier,
    title: null,
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
