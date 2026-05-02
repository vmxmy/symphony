// Reconciliation contract: the decision shape that any tracker poll +
// reconcile pass must produce for Phase 3 to be considered behaviorally
// equivalent to the local ts-engine `Orchestrator.tick()` loop.
//
// The contract is intentionally pure: a `reconcileTick(input)` function
// takes a snapshot of tracker + state at one moment in time and returns
// a list of decisions. No side effects here. Both `ts-engine`'s in-process
// loop and the future cf-control-plane `ProjectAgent.poll()` must emit
// the same decision list for the same input — that's how we know the
// Cloudflare path mirrors local behavior.
//
// Decision shape mirrors the four logical branches in the current
// orchestrator (see ts-engine/src/orchestrator.ts:76-120):
//   1. Sessions whose issues are no longer in the active set get a
//      reconcile decision — not_visible | terminal | pause.
//   2. Active issues that satisfy `state.canDispatch` get a dispatch
//      decision with the next attempt number.
//   3. Terminal issues with an existing workspace get a cleanup
//      decision.

import type { Issue, WorkflowConfig } from "../types.js";

/** A running session (a subset of ts-engine's AgentSession). */
export type RunningSession = {
  issueId: string;
  issueIdentifier: string;
  /** Issue state recorded when the session started (used for diagnostics). */
  state: string;
};

/** A pending retry (a subset of ts-engine's RetryEntry). */
export type RetryEntry = {
  issueId: string;
  attempt: number;
  /** ISO due_at; if in the past, the issue is eligible for re-dispatch. Empty/null means not dispatchable. */
  dueAt: string | null;
};

export type ReconcileInput = {
  cfg: Pick<WorkflowConfig, "tracker" | "agent">;
  /** Issues currently in any active state (from tracker.fetchActiveIssues). */
  active: Issue[];
  /** Issues currently in any terminal state (from tracker.fetchTerminalIssues). */
  terminal: Issue[];
  /**
   * Per-issue lookup for sessions whose issue is not in `active`. The
   * orchestrator fetches fresh state for those issues; the harness expects
   * the caller to have done that fetch and pass the result here. `null`
   * means the issue is not visible to the tracker anymore.
   */
  byIdLookup: Record<string, Issue | null>;
  /** Snapshot of currently-running sessions. */
  running: RunningSession[];
  /** Snapshot of pending retries. */
  retries: RetryEntry[];
  /** Returns true iff this issue currently has an on-disk (or in-substrate) workspace. */
  workspaceExists: (issue: Issue) => boolean;
  /** ISO timestamp at which this reconcile pass is running. */
  now: string;
};

export type Decision =
  | {
      kind: "reconcile_not_visible";
      issueId: string;
      issueIdentifier: string;
    }
  | {
      kind: "reconcile_terminal";
      issueId: string;
      issueIdentifier: string;
      newState: string;
    }
  | {
      kind: "reconcile_pause";
      issueId: string;
      issueIdentifier: string;
      newState: string;
    }
  | {
      kind: "dispatch";
      issueId: string;
      issueIdentifier: string;
      attempt: number;
    }
  | {
      kind: "cleanup";
      issueId: string;
      issueIdentifier: string;
    };
