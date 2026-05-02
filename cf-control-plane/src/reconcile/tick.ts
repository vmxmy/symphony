// Pure reconcile decision function.
//
// Mirrors the current ts-engine `Orchestrator.tick()` decision branches
// without doing any I/O. See `types.ts` for the data shape contract.
//
// Determinism: decisions are produced in a stable order:
//   1. reconcile_* decisions (sessions whose issue left the active set),
//      in `running` snapshot order.
//   2. dispatch decisions, in `active` snapshot order.
//   3. cleanup decisions, in `terminal` snapshot order.
// Equivalent ts-engine behavior follows the same loop ordering.

import type { ReconcileInput, Decision, RunningSession, RetryEntry } from "./types.js";
import type { Issue } from "../types.js";

/** Per-state concurrency cap key normalization (mirrors ts-engine state.canDispatch). */
function stateKey(s: string): string {
  return s.toLowerCase();
}

function dispatchableUnderConcurrency(
  active: Issue[],
  cfg: ReconcileInput["cfg"],
  running: RunningSession[],
): Set<string> {
  const maxGlobal = cfg.agent.maxConcurrentAgents;
  const maxByState = cfg.agent.maxConcurrentAgentsByState ?? {};

  // Count currently-running issues globally and per state.
  const runningByState = new Map<string, number>();
  for (const r of running) {
    const key = stateKey(r.state);
    runningByState.set(key, (runningByState.get(key) ?? 0) + 1);
  }
  const runningGlobal = running.length;

  const eligible = new Set<string>();
  let projectedGlobal = runningGlobal;
  const projectedByState = new Map(runningByState);

  // Already-running issues are not re-dispatched.
  const runningIds = new Set(running.map((r) => r.issueId));

  for (const issue of active) {
    if (runningIds.has(issue.id)) continue;
    if (projectedGlobal >= maxGlobal) break;

    const key = stateKey(issue.state);
    const cap = maxByState[key];
    if (cap !== undefined) {
      const cur = projectedByState.get(key) ?? 0;
      if (cur >= cap) continue;
      projectedByState.set(key, cur + 1);
    }
    projectedGlobal++;
    eligible.add(issue.id);
  }
  return eligible;
}

function isDueRetry(retry: RetryEntry, now: string): boolean {
  // PR-D uses issue_retries rows with empty/null due_at as informational
  // failed-state rows. They must never become dispatch decisions.
  if (!retry.dueAt) return false;
  return retry.dueAt <= now;
}

export function reconcileTick(input: ReconcileInput): Decision[] {
  const decisions: Decision[] = [];
  const { cfg, active, terminal, running, byIdLookup, retries, workspaceExists, now } = input;

  // ---- 1. Reconcile sessions whose issue left the active set ----
  const activeIds = new Set(active.map((i) => i.id));
  for (const session of running) {
    if (activeIds.has(session.issueId)) continue;
    const fresh = byIdLookup[session.issueId] ?? null;
    if (!fresh) {
      decisions.push({
        kind: "reconcile_not_visible",
        issueId: session.issueId,
        issueIdentifier: session.issueIdentifier,
      });
      continue;
    }
    if (cfg.tracker.terminalStates.includes(fresh.state)) {
      decisions.push({
        kind: "reconcile_terminal",
        issueId: session.issueId,
        issueIdentifier: session.issueIdentifier,
        newState: fresh.state,
      });
    } else if (!cfg.tracker.activeStates.includes(fresh.state)) {
      decisions.push({
        kind: "reconcile_pause",
        issueId: session.issueId,
        issueIdentifier: session.issueIdentifier,
        newState: fresh.state,
      });
    }
    // else: state changed but still active — treated as a normal active
    // candidate by the next branch.
  }

  // ---- 2. Dispatch new candidates respecting concurrency caps ----
  const eligible = dispatchableUnderConcurrency(active, cfg, running);
  const retryAttempt = new Map(retries.map((r) => [r.issueId, r.attempt]));
  for (const issue of active) {
    if (!eligible.has(issue.id)) continue;
    const retry = retries.find((r) => r.issueId === issue.id);
    if (retry && !isDueRetry(retry, now)) continue;
    const prev = retryAttempt.get(issue.id) ?? 0;
    decisions.push({
      kind: "dispatch",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      attempt: prev + 1,
    });
  }

  // ---- 3. Cleanup terminal-state workspaces ----
  for (const t of terminal) {
    if (workspaceExists(t)) {
      decisions.push({
        kind: "cleanup",
        issueId: t.id,
        issueIdentifier: t.identifier,
      });
    }
  }

  return decisions;
}
