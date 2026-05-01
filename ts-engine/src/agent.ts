// Per-issue agent execution loop. Drives the generic Agent contract
// (start → startSession → runTurn loop → stop) until the issue leaves
// active states or max_turns is reached. Adapter-agnostic: the actual
// agent (Codex / mock / future SDK) is injected via `agentFactory`.

import type { Issue, WorkflowConfig, TokenUsage } from "./types.js";
import type { State } from "./state.js";
import type { Agent, AgentFactory, ToolResult, AgentTokenUsage } from "./agent/types.js";
import type { TrackerAdapter } from "./contracts/tracker.js";
import type { WorkspaceAdapter } from "./contracts/workspace.js";
import type { EventSink } from "./contracts/events.js";
import type { ToolGateway } from "./contracts/tools.js";
import { PromptBuilder } from "./prompt.js";

export type AgentRunOutcome =
  | { status: "completed" }
  | { status: "issue_state_changed"; newState: string }
  | { status: "max_turns_exceeded" }
  | { status: "error"; error: string };

export type AgentRunnerDeps = {
  tracker: TrackerAdapter;
  workspace: WorkspaceAdapter;
  state: State;
  promptBuilder: PromptBuilder;
  log: EventSink;
  config: () => WorkflowConfig;
  agentFactory: AgentFactory;
  toolGateway: ToolGateway;
};

export class AgentRunner {
  constructor(private deps: AgentRunnerDeps) {}

  async run(issue: Issue, attempt: number): Promise<AgentRunOutcome> {
    const cfg = this.deps.config();
    const workspace = await this.deps.workspace.ensure(issue);
    const workspacePath = workspace.path;
    const session = this.deps.state.startAgent(issue, workspacePath);

    const agent: Agent = this.deps.agentFactory({ cwd: workspacePath });
    const tokens: TokenUsage = { totalTokens: 0, inputTokens: 0, outputTokens: 0, secondsRunning: 0 };
    const startedAt = Date.now();

    try {
      try { await this.deps.workspace.runHook("before_run", workspace); }
      catch (e) { this.deps.log.warn(`before_run failed: ${(e as Error).message}`); }

      await agent.start();
      await agent.startSession({ cwd: workspacePath, tools: this.deps.toolGateway.definitions() });

      let turnNumber = 0;
      while (turnNumber < cfg.agent.maxTurns) {
        turnNumber++;
        const prompt = this.deps.promptBuilder.build(issue, turnNumber === 1 ? attempt : null);
        const title = `${issue.identifier}: ${issue.title ?? ""}`.slice(0, 200);

        this.deps.state.updateAgent(issue.id, { turnCount: turnNumber });

        // Mid-turn state poll: agent may transition Linear state via linear_graphql
        // tool calls. Refresh dashboard every 5s so users see real-time progress.
        const statePoll = setInterval(async () => {
          try {
            const fresh = await this.deps.tracker.fetchIssuesByIds([issue.id]);
            if (fresh[0]) {
              this.deps.state.updateAgent(issue.id, { state: fresh[0].state });
              issue.state = fresh[0].state;
            }
          } catch { /* poll failures are non-fatal */ }
        }, 5000);

        const turnResult = await agent.runTurn(prompt, title, {
          onActivity: (info) => {
            this.deps.state.updateAgent(issue.id, {
              lastEvent: info.label,
              lastEventAt: new Date().toISOString(),
              lastMessage: info.text ?? null,
            });
          },
          onTokenUsage: (usage: AgentTokenUsage) => {
            tokens.totalTokens = Math.max(tokens.totalTokens, usage.totalTokens);
            tokens.inputTokens = Math.max(tokens.inputTokens, usage.inputTokens);
            tokens.outputTokens = Math.max(tokens.outputTokens, usage.outputTokens);
            this.deps.state.updateAgent(issue.id, { tokens: { ...tokens } });
          },
          onToolCall: async (call): Promise<ToolResult> => {
            this.deps.log.debug(`tool_call: ${call.name}`, { issue: issue.identifier });
            return await this.deps.toolGateway.handle(call);
          },
        });

        clearInterval(statePoll);

        // Adapter may surface a session id mid-flight; record the first one we see.
        if (!session.sessionId && turnResult.sessionId) {
          this.deps.state.updateAgent(issue.id, { sessionId: turnResult.sessionId });
        }

        if (turnResult.status === "failed" || turnResult.status === "cancelled" || turnResult.status === "timeout") {
          tokens.secondsRunning = Math.floor((Date.now() - startedAt) / 1000);
          this.deps.state.finishAgent(issue.id, tokens);
          await agent.stop();
          return { status: "error", error: `turn_${turnResult.status}: ${JSON.stringify(turnResult.reason ?? "")}` };
        }

        // Re-fetch issue state from Linear to decide continuation
        const fresh = await this.deps.tracker.fetchIssuesByIds([issue.id]);
        const updated = fresh[0];
        const stillActive =
          updated && cfg.tracker.activeStates.includes(updated.state);

        if (!updated) {
          tokens.secondsRunning = Math.floor((Date.now() - startedAt) / 1000);
          this.deps.state.finishAgent(issue.id, tokens);
          await agent.stop();
          return { status: "issue_state_changed", newState: "missing" };
        }

        if (!stillActive) {
          tokens.secondsRunning = Math.floor((Date.now() - startedAt) / 1000);
          this.deps.state.finishAgent(issue.id, tokens);
          await agent.stop();
          return { status: "issue_state_changed", newState: updated.state };
        }
        this.deps.state.updateAgent(issue.id, { state: updated.state });
        issue.state = updated.state;
      }

      tokens.secondsRunning = Math.floor((Date.now() - startedAt) / 1000);
      this.deps.state.finishAgent(issue.id, tokens);
      await agent.stop();
      return { status: "max_turns_exceeded" };
    } catch (e) {
      tokens.secondsRunning = Math.floor((Date.now() - startedAt) / 1000);
      this.deps.state.finishAgent(issue.id, tokens);
      try { await agent.stop(); } catch { /* ignore */ }
      try { await this.deps.workspace.runHook("after_run", workspace); } catch { /* ignore */ }
      return { status: "error", error: (e as Error).message };
    } finally {
      try { await this.deps.workspace.runHook("after_run", workspace); } catch { /* ignore */ }
    }
  }
}
