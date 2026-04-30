// In-memory runtime state of the orchestrator. Pure data + simple decisions,
// no IO. Mirrors the portion of SPEC §3.2 (Orchestrator) and §10 (concurrency).

import type {
  AgentSession,
  RetryEntry,
  TokenUsage,
  WorkflowConfig,
  Issue,
} from "./types.js";

export class State {
  running = new Map<string, AgentSession>(); // key = issue.id
  retrying = new Map<string, RetryEntry>(); // key = issue.id
  codexTotals: TokenUsage = {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    secondsRunning: 0,
  };
  startedAt = Date.now();

  // ---- snapshot (HTTP /api/v1/state) -------------------------------------

  snapshot() {
    return {
      running: [...this.running.values()],
      retrying: [...this.retrying.values()].map((r) => ({
        ...r,
        // launcher-friendly fields
      })),
      codex_totals: {
        total_tokens: this.codexTotals.totalTokens,
        input_tokens: this.codexTotals.inputTokens,
        output_tokens: this.codexTotals.outputTokens,
        seconds_running: this.codexTotals.secondsRunning,
      },
      counts: {
        running: this.running.size,
        retrying: this.retrying.size,
      },
      rate_limits: null,
      generated_at: new Date().toISOString(),
    };
  }

  // ---- dispatch decisions (used by Orchestrator) -------------------------

  /**
   * Returns true if the issue can be dispatched right now considering global
   * + per-state concurrency limits AND not already running/retrying.
   */
  canDispatch(issue: Issue, config: WorkflowConfig): boolean {
    if (this.running.has(issue.id)) return false;
    if (this.retrying.has(issue.id)) {
      const r = this.retrying.get(issue.id)!;
      if (Date.parse(r.dueAt) > Date.now()) return false;
    }
    if (this.running.size >= config.agent.maxConcurrentAgents) return false;

    const stateKey = issue.state.toLowerCase();
    const stateLimit = config.agent.maxConcurrentAgentsByState[stateKey];
    if (stateLimit !== undefined) {
      const inState = this.runningInState(issue.state);
      if (inState >= stateLimit) return false;
    }
    return true;
  }

  runningInState(state: string): number {
    let n = 0;
    for (const s of this.running.values()) {
      if (s.state.toLowerCase() === state.toLowerCase()) n++;
    }
    return n;
  }

  // ---- mutations ---------------------------------------------------------

  startAgent(issue: Issue, workspacePath: string): AgentSession {
    const session: AgentSession = {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      state: issue.state,
      workspacePath,
      startedAt: new Date().toISOString(),
      sessionId: null,
      workerHost: null,
      turnCount: 0,
      tokens: { totalTokens: 0, inputTokens: 0, outputTokens: 0, secondsRunning: 0 },
      lastEvent: null,
      lastEventAt: null,
      lastMessage: null,
    };
    this.running.set(issue.id, session);
    this.retrying.delete(issue.id);
    return session;
  }

  updateAgent(issueId: string, patch: Partial<AgentSession>): void {
    const s = this.running.get(issueId);
    if (!s) return;
    this.running.set(issueId, { ...s, ...patch, lastEventAt: new Date().toISOString() });
  }

  finishAgent(issueId: string, tokens: TokenUsage): void {
    this.running.delete(issueId);
    this.codexTotals.totalTokens += tokens.totalTokens;
    this.codexTotals.inputTokens += tokens.inputTokens;
    this.codexTotals.outputTokens += tokens.outputTokens;
    this.codexTotals.secondsRunning += tokens.secondsRunning;
  }

  scheduleRetry(
    issue: Issue,
    error: string,
    workspacePath: string | null,
    workerHost: string | null,
    delayMs: number,
  ): void {
    const prev = this.retrying.get(issue.id);
    const attempt = (prev?.attempt ?? 0) + 1;
    this.retrying.set(issue.id, {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      attempt,
      dueAt: new Date(Date.now() + delayMs).toISOString(),
      error,
      workspacePath,
      workerHost,
    });
  }

  retryAttempt(issueId: string): number {
    return this.retrying.get(issueId)?.attempt ?? 0;
  }

  clearRetry(issueId: string): void {
    this.retrying.delete(issueId);
  }
}

/**
 * Exponential backoff with cap, per SPEC §11.
 * delay = min(maxRetryBackoffMs, base * 2^(attempt-1))
 */
export function nextBackoffMs(attempt: number, maxBackoffMs: number, baseMs = 1000): number {
  const exp = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(maxBackoffMs, exp);
}
