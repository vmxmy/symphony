// Orchestrator: poll loop + dispatch + retry queue + reconciliation.
// Mirrors elixir/lib/symphony_elixir/orchestrator.ex behaviour at a high level.

import type { WorkflowConfig, Issue } from "./types.js";
import type { Logger } from "./log.js";
import type { LinearClient } from "./linear.js";
import type { WorkspaceManager } from "./workspace.js";
import { State, nextBackoffMs } from "./state.js";
import { AgentRunner } from "./agent.js";
import { PromptBuilder } from "./prompt.js";

export class Orchestrator {
  private timer: NodeJS.Timeout | null = null;
  private inFlightTick = false;
  private stopped = false;

  constructor(
    private deps: {
      linear: LinearClient;
      workspace: WorkspaceManager;
      state: State;
      promptBuilder: PromptBuilder;
      log: Logger;
      config: () => WorkflowConfig;
    },
  ) {}

  async start(): Promise<void> {
    this.scheduleNextTick();
    this.deps.log.info("orchestrator started", {
      pollIntervalMs: this.deps.config().polling.intervalMs,
    });
  }

  refresh(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.runTick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.deps.log.info("orchestrator stopped");
  }

  // ---- internals ---------------------------------------------------------

  private scheduleNextTick(): void {
    if (this.stopped) return;
    const interval = this.deps.config().polling.intervalMs;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.runTick(), interval);
  }

  private async runTick(): Promise<void> {
    if (this.stopped) return;
    if (this.inFlightTick) {
      this.scheduleNextTick();
      return;
    }
    this.inFlightTick = true;
    try {
      await this.tick();
    } catch (e) {
      this.deps.log.error(`tick failed: ${(e as Error).message}`);
    } finally {
      this.inFlightTick = false;
      this.scheduleNextTick();
    }
  }

  private async tick(): Promise<void> {
    const cfg = this.deps.config();
    const active = await this.deps.linear.fetchActiveIssues();
    this.deps.log.debug(`tick: fetched ${active.length} active`);

    // Reconcile: detect issues that left active states
    const seenIds = new Set(active.map((i) => i.id));
    for (const session of [...this.deps.state.running.values()]) {
      if (!seenIds.has(session.issueId)) {
        // Issue likely moved to terminal or pause — refetch state explicitly
        const fresh = await this.deps.linear.fetchIssuesByIds([session.issueId]);
        const updated = fresh[0];
        if (!updated) {
          this.deps.log.info(`reconcile: ${session.issueIdentifier} not visible — leaving running entry`);
        } else if (cfg.tracker.terminalStates.includes(updated.state)) {
          // terminal — agent process should exit naturally; cleanup handled elsewhere
          this.deps.log.info(`reconcile: ${session.issueIdentifier} terminal=${updated.state}`);
        } else if (!cfg.tracker.activeStates.includes(updated.state)) {
          // PAUSE state — agent process will exit after current turn
          this.deps.log.info(`reconcile: ${session.issueIdentifier} pause=${updated.state}`);
        }
      }
    }

    // Dispatch new candidates
    for (const issue of active) {
      if (!this.deps.state.canDispatch(issue, cfg)) continue;
      const attempt = this.deps.state.retryAttempt(issue.id) + 1;
      this.deps.state.clearRetry(issue.id);
      this.spawnAgent(issue, attempt).catch((e) =>
        this.deps.log.error(`spawn failed: ${(e as Error).message}`, { issue: issue.identifier }),
      );
    }

    // Cleanup terminal-state workspaces
    const terminal = await this.deps.linear.fetchTerminalIssues();
    for (const t of terminal) {
      // best-effort: only remove if a workspace exists
      const path = this.deps.workspace.pathFor(t);
      if (await fileExists(path)) {
        this.deps.log.debug(`cleanup terminal workspace: ${t.identifier}`);
        await this.deps.workspace.remove(t);
      }
    }
  }

  private async spawnAgent(issue: Issue, attempt: number): Promise<void> {
    this.deps.log.info(`dispatch: ${issue.identifier} state=${issue.state} attempt=${attempt}`);
    const runner = new AgentRunner(this.deps);
    const outcome = await runner.run(issue, attempt);

    switch (outcome.status) {
      case "completed":
      case "issue_state_changed":
        this.deps.log.info(`agent finished: ${issue.identifier} → ${outcome.status}`);
        break;
      case "max_turns_exceeded":
        this.deps.log.warn(`max_turns exceeded: ${issue.identifier} (attempt ${attempt})`);
        // schedule short retry per SPEC §11 continuation
        this.deps.state.scheduleRetry(issue, "max_turns_exceeded", null, null, 1000);
        break;
      case "error": {
        const cfg = this.deps.config();
        const next = nextBackoffMs(attempt + 1, cfg.agent.maxRetryBackoffMs);
        this.deps.log.warn(`agent error: ${issue.identifier} retry in ${next}ms — ${outcome.error}`);
        this.deps.state.scheduleRetry(issue, outcome.error, null, null, next);
        break;
      }
    }
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
