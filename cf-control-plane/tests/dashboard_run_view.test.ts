import { describe, expect, test } from "bun:test";
import { renderRunDetail, type RunDetailView } from "../src/dashboard/render.js";

function sampleRun(): RunDetailView {
  const STEP_NAMES = [
    "loadProfileAndIssue",
    "acquireLease",
    "prepareWorkspace",
    "materializeAssets",
    "afterCreateHook",
    "renderPrompt",
    "beforeRunHook",
    "runAgentTurnLoop",
    "handleToolCalls",
    "pollTrackerBetweenTurns",
    "persistRunArtifacts",
    "afterRunHook",
    "validateCompletion",
    "transitionIssueState",
    "archiveOrCleanupWorkspace",
    "releaseLeaseAndNotify",
  ];
  return {
    generated_at: "2026-05-03T00:00:00Z",
    run: {
      id: "run:tenant:profile:issue-1:0",
      issue_id: "tenant/profile:issue-1",
      issue_identifier: "SYM-1",
      attempt: 0,
      status: "completed",
      workflow_id: "run:tenant:profile:issue-1:0",
      adapter_kind: "mock",
      started_at: "2026-05-03T00:00:00Z",
      finished_at: "2026-05-03T00:00:01Z",
      error: null,
      token_usage_json: JSON.stringify({ totalTokens: 100, inputTokens: 70, outputTokens: 30 }),
      artifact_manifest_ref: "runs/tenant/profile/issue-1/0/manifest.json",
      tenant_id: "tenant",
      slug: "profile",
      external_id: "issue-1",
    },
    steps: STEP_NAMES.map((step_name, i) => ({
      step_sequence: i + 1,
      step_name,
      status: "completed",
      started_at: "2026-05-03T00:00:00Z",
      finished_at: "2026-05-03T00:00:00.500Z",
      error: null,
    })),
    events: [
      {
        id: "run:tenant:profile:issue-1:0:1:started",
        event_type: "step.loadProfileAndIssue.started",
        severity: "info",
        message: "Step 1 started",
        created_at: "2026-05-03T00:00:00Z",
      },
      {
        id: "run:tenant:profile:issue-1:0:1:completed",
        event_type: "step.loadProfileAndIssue.completed",
        severity: "info",
        message: null,
        created_at: "2026-05-03T00:00:00.500Z",
      },
    ],
    runtime: { host: "mock", coding_agent: "mock" },
  };
}

describe("renderRunDetail (Phase 5 PR-D)", () => {
  test("renders a 16-cell step grid with the canonical step names", () => {
    const html = renderRunDetail(sampleRun());
    expect(html).toContain('<ul class="step-grid">');
    // All 16 canonical step names appear as code spans inside the grid.
    const STEP_NAMES = [
      "loadProfileAndIssue",
      "acquireLease",
      "prepareWorkspace",
      "materializeAssets",
      "afterCreateHook",
      "renderPrompt",
      "beforeRunHook",
      "runAgentTurnLoop",
      "handleToolCalls",
      "pollTrackerBetweenTurns",
      "persistRunArtifacts",
      "afterRunHook",
      "validateCompletion",
      "transitionIssueState",
      "archiveOrCleanupWorkspace",
      "releaseLeaseAndNotify",
    ];
    for (const name of STEP_NAMES) {
      expect(html).toContain(`<code>${name}</code>`);
    }
    // Color-coded class: 16 completed cells.
    const completedMatches = html.match(/step-completed/g) ?? [];
    expect(completedMatches.length).toBeGreaterThanOrEqual(16);
  });

  test("renders run metadata: status, tenant/profile, tokens, manifest", () => {
    const html = renderRunDetail(sampleRun());
    expect(html).toContain('<span class="status-completed">completed</span>');
    expect(html).toContain("<code>tenant</code>");
    expect(html).toContain("<code>profile</code>");
    expect(html).toContain("<code>SYM-1</code>");
    expect(html).toContain("total 100 (in 70 / out 30)");
    expect(html).toContain("runs/tenant/profile/issue-1/0/manifest.json");
    expect(html).toContain("Substrate");
    expect(html).toContain("<code>mock</code>");
    expect(html).toContain("Coding Agent");
  });

  test("missing steps render as pending placeholders", () => {
    const state = sampleRun();
    state.steps = state.steps.slice(0, 5).map((s) => ({ ...s, status: "completed" }));
    const html = renderRunDetail(state);
    // Count only the cell class on <li>; the CSS rules also mention
    // step-pending / step-completed and would otherwise double-count.
    const pendingCells = html.match(/<li class="step step-pending"/g) ?? [];
    const completedCells = html.match(/<li class="step step-completed"/g) ?? [];
    expect(pendingCells.length).toBe(11);
    expect(completedCells.length).toBe(5);
  });

  test("events table lists each recorded event", () => {
    const html = renderRunDetail(sampleRun());
    expect(html).toContain("step.loadProfileAndIssue.started");
    expect(html).toContain("step.loadProfileAndIssue.completed");
  });

  test("error row renders when run has an error", () => {
    const state = sampleRun();
    state.run = { ...state.run, status: "failed", error: "boom" };
    const html = renderRunDetail(state);
    expect(html).toContain('<dt>Error</dt>');
    expect(html).toContain("boom");
  });

  test("cancel route hint appears in footer", () => {
    const html = renderRunDetail(sampleRun());
    expect(html).toContain(
      "/api/v1/runs/tenant/profile/issue-1/0/actions/cancel",
    );
    expect(html).toContain("write:run.cancel");
  });
});
