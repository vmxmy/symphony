// Reconciliation contract: 5 fixtures cover every decision branch in
// `Orchestrator.tick()` so future Phase 3 production code (ProjectAgent
// .poll() in cf-control-plane) can be black-box validated against the
// same shapes.
//
// If any of these tests fail because Phase 3 code intentionally diverges,
// update the fixture AND the corresponding behavior in
// `ts-engine/src/orchestrator.ts` so both impls stay in lockstep.

import { describe, expect, test } from "bun:test";
import { reconcileTick } from "../src/reconcile/tick.js";
import type { ReconcileInput, Decision } from "../src/reconcile/types.js";
import type { Issue } from "../src/types.js";

const ACTIVE_STATES = ["Todo", "In Progress", "Drafting"];
const TERMINAL_STATES = ["Done", "Cancelled", "Closed"];
// Pause states are anything not in active or terminal lists; the harness
// recognizes them implicitly. Listed here for fixture readability:
//   ["Backlog", "Draft Review", "Final Review"]

function makeIssue(overrides: Partial<Issue> & { id: string; identifier: string; state: string }): Issue {
  return {
    title: overrides.identifier,
    description: null,
    priority: null,
    url: null,
    branchName: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function baseInput(overrides: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    cfg: {
      tracker: {
        activeStates: ACTIVE_STATES,
        terminalStates: TERMINAL_STATES,
      },
      agent: {
        maxConcurrentAgents: 2,
        maxConcurrentAgentsByState: {},
      },
    },
    active: [],
    terminal: [],
    byIdLookup: {},
    running: [],
    retries: [],
    workspaceExists: () => false,
    now: "2026-05-02T00:00:00Z",
    ...overrides,
  };
}

describe("reconcileTick contract", () => {
  test("fixture 0001 — empty tracker + empty state → no decisions", () => {
    const decisions = reconcileTick(baseInput());
    expect(decisions).toEqual([]);
  });

  test("fixture 0002 — single active issue, nothing running → dispatch attempt=1", () => {
    const issue = makeIssue({ id: "i-1", identifier: "SYM-1", state: "Todo" });
    const decisions = reconcileTick(baseInput({ active: [issue] }));
    expect(decisions).toEqual<Decision[]>([
      { kind: "dispatch", issueId: "i-1", issueIdentifier: "SYM-1", attempt: 1 },
    ]);
  });

  test("fixture 0003 — running session, issue moved to terminal → reconcile_terminal", () => {
    const session = { issueId: "i-1", issueIdentifier: "SYM-1", state: "Todo" };
    const fresh = makeIssue({ id: "i-1", identifier: "SYM-1", state: "Done" });
    const decisions = reconcileTick(
      baseInput({
        active: [],
        running: [session],
        byIdLookup: { "i-1": fresh },
      }),
    );
    expect(decisions).toEqual<Decision[]>([
      {
        kind: "reconcile_terminal",
        issueId: "i-1",
        issueIdentifier: "SYM-1",
        newState: "Done",
      },
    ]);
  });

  test("fixture 0004 — running session, issue moved to a pause state → reconcile_pause", () => {
    const session = { issueId: "i-1", issueIdentifier: "SYM-1", state: "Todo" };
    const fresh = makeIssue({ id: "i-1", identifier: "SYM-1", state: "Backlog" });
    const decisions = reconcileTick(
      baseInput({
        active: [],
        running: [session],
        byIdLookup: { "i-1": fresh },
      }),
    );
    expect(decisions).toEqual<Decision[]>([
      {
        kind: "reconcile_pause",
        issueId: "i-1",
        issueIdentifier: "SYM-1",
        newState: "Backlog",
      },
    ]);
  });

  test("fixture 0005 — issue with retry due → dispatch with attempt=N+1", () => {
    const issue = makeIssue({ id: "i-1", identifier: "SYM-1", state: "Todo" });
    const decisions = reconcileTick(
      baseInput({
        active: [issue],
        retries: [{ issueId: "i-1", attempt: 2, dueAt: "2026-05-01T23:59:00Z" }],
      }),
    );
    expect(decisions).toEqual<Decision[]>([
      { kind: "dispatch", issueId: "i-1", issueIdentifier: "SYM-1", attempt: 3 },
    ]);
  });

  test("fixture 0006 — retry not yet due → no dispatch", () => {
    const issue = makeIssue({ id: "i-1", identifier: "SYM-1", state: "Todo" });
    const decisions = reconcileTick(
      baseInput({
        active: [issue],
        retries: [{ issueId: "i-1", attempt: 2, dueAt: "2026-05-02T01:00:00Z" }],
      }),
    );
    expect(decisions).toEqual([]);
  });

  test("fixture 0007 — global concurrency cap respected", () => {
    const issues = [
      makeIssue({ id: "i-1", identifier: "SYM-1", state: "Todo" }),
      makeIssue({ id: "i-2", identifier: "SYM-2", state: "Todo" }),
      makeIssue({ id: "i-3", identifier: "SYM-3", state: "Todo" }),
    ];
    const decisions = reconcileTick(
      baseInput({
        active: issues,
        cfg: {
          tracker: { activeStates: ACTIVE_STATES, terminalStates: TERMINAL_STATES },
          agent: { maxConcurrentAgents: 2, maxConcurrentAgentsByState: {} },
        },
      }),
    );
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toMatchObject({ kind: "dispatch", issueIdentifier: "SYM-1" });
    expect(decisions[1]).toMatchObject({ kind: "dispatch", issueIdentifier: "SYM-2" });
  });

  test("fixture 0008 — per-state concurrency cap respected", () => {
    const issues = [
      makeIssue({ id: "i-1", identifier: "SYM-1", state: "Drafting" }),
      makeIssue({ id: "i-2", identifier: "SYM-2", state: "Drafting" }),
      makeIssue({ id: "i-3", identifier: "SYM-3", state: "Todo" }),
    ];
    const decisions = reconcileTick(
      baseInput({
        active: issues,
        cfg: {
          tracker: { activeStates: ACTIVE_STATES, terminalStates: TERMINAL_STATES },
          agent: { maxConcurrentAgents: 5, maxConcurrentAgentsByState: { drafting: 1 } },
        },
      }),
    );
    // Only one Drafting issue dispatches; Todo unrelated to the per-state cap.
    expect(decisions).toHaveLength(2);
    expect(decisions.map((d) => d.kind === "dispatch" && d.issueIdentifier)).toEqual(["SYM-1", "SYM-3"]);
  });

  test("fixture 0009 — terminal issue with workspace → cleanup", () => {
    const t = makeIssue({ id: "i-1", identifier: "SYM-1", state: "Done" });
    const decisions = reconcileTick(
      baseInput({
        terminal: [t],
        workspaceExists: (issue) => issue.id === "i-1",
      }),
    );
    expect(decisions).toEqual<Decision[]>([
      { kind: "cleanup", issueId: "i-1", issueIdentifier: "SYM-1" },
    ]);
  });

  test("fixture 0010 — issue in byIdLookup is null → reconcile_not_visible", () => {
    const session = { issueId: "i-1", issueIdentifier: "SYM-1", state: "Todo" };
    const decisions = reconcileTick(
      baseInput({
        running: [session],
        byIdLookup: { "i-1": null },
      }),
    );
    expect(decisions).toEqual<Decision[]>([
      {
        kind: "reconcile_not_visible",
        issueId: "i-1",
        issueIdentifier: "SYM-1",
      },
    ]);
  });
});
