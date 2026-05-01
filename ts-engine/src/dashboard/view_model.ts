import type { State } from "../state.js";

type StateSnapshot = ReturnType<State["snapshot"]>;
type RunningSnapshot = StateSnapshot["running"][number];
type RetryingSnapshot = StateSnapshot["retrying"][number];

export type DashboardSummary = {
  runningCount: number;
  retryingCount: number;
  totalTokens: string;
  generatedAt: string;
};

export type RunningAgentRow = {
  issueIdentifier: string;
  state: string;
  turnCount: number;
  totalTokens: string;
  lastEvent: string;
  lastEventAt: string;
};

export type RetryRow = {
  issueIdentifier: string;
  attempt: number;
  dueAt: string;
  error: string;
};

export type DashboardViewModel = {
  summary: DashboardSummary;
  runningRows: RunningAgentRow[];
  retryRows: RetryRow[];
  hasRunning: boolean;
  hasRetries: boolean;
  stateApiPath: string;
  refreshMethod: "POST";
  refreshPath: string;
};

export function dashboardViewModelFromSnapshot(snapshot: StateSnapshot): DashboardViewModel {
  const runningRows = snapshot.running.map(toRunningAgentRow);
  const retryRows = snapshot.retrying.map(toRetryRow);

  return {
    summary: {
      runningCount: snapshot.counts.running,
      retryingCount: snapshot.counts.retrying,
      totalTokens: formatCount(snapshot.codex_totals.total_tokens),
      generatedAt: snapshot.generated_at,
    },
    runningRows,
    retryRows,
    hasRunning: runningRows.length > 0,
    hasRetries: retryRows.length > 0,
    stateApiPath: "/api/v1/state",
    refreshMethod: "POST",
    refreshPath: "/api/v1/refresh",
  };
}

function toRunningAgentRow(row: RunningSnapshot): RunningAgentRow {
  return {
    issueIdentifier: row.issueIdentifier,
    state: row.state,
    turnCount: row.turnCount,
    totalTokens: formatCount(row.tokens.totalTokens),
    lastEvent: row.lastEvent ?? "",
    lastEventAt: row.lastEventAt ?? "",
  };
}

function toRetryRow(row: RetryingSnapshot): RetryRow {
  return {
    issueIdentifier: row.issueIdentifier,
    attempt: row.attempt,
    dueAt: row.dueAt,
    error: row.error.slice(0, 80),
  };
}

function formatCount(value: number): string {
  return value.toLocaleString();
}
