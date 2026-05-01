// Per-issue agent execution loop. Spawns a fresh CodexAppServer per dispatch,
// drives initialize → thread/start → loop(turn/start → turn/completed) until
// the issue leaves active states or max_turns is reached.

import type { Issue, WorkflowConfig, TokenUsage } from "./types.js";
import type { Logger } from "./log.js";
import type { LinearClient } from "./linear.js";
import type { WorkspaceManager } from "./workspace.js";
import type { State } from "./state.js";
import { CodexAppServer, type ToolResult } from "./codex.js";
import { PromptBuilder } from "./prompt.js";
import { makeLinearGraphqlHandler, symphonyDynamicToolSpecs } from "./dynamic_tool.js";

export type AgentRunOutcome =
  | { status: "completed" }
  | { status: "issue_state_changed"; newState: string }
  | { status: "max_turns_exceeded" }
  | { status: "error"; error: string };

export class AgentRunner {
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

  /**
   * Defensive token-usage extractor. Codex emits usage data in multiple
   * shapes (direct camelCase, snake_case, nested .usage / .tokens, etc).
   * No-op if all extracted numbers are zero.
   */
  private recordUsage(
    issueId: string,
    usage: Record<string, unknown>,
    accum: TokenUsage,
  ): void {
    // Codex sends thread/tokenUsage/updated as:
    //   params.tokenUsage.total = {totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens}
    // earlier shapes (camel/snake/wrapped) are kept as fallbacks for safety.
    const tu = usage.tokenUsage as Record<string, unknown> | undefined;
    const u: Record<string, unknown> =
      (tu?.total as Record<string, unknown>) ??
      (tu as Record<string, unknown>) ??
      (usage.usage as Record<string, unknown>) ??
      (usage.tokens as Record<string, unknown>) ??
      usage;
    const total = num(u.totalTokens) + num(u.total_tokens);
    const inT = num(u.inputTokens) + num(u.input_tokens);
    const outT = num(u.outputTokens) + num(u.output_tokens);
    if (total === 0 && inT === 0 && outT === 0) return;
    accum.totalTokens = Math.max(accum.totalTokens, total);
    accum.inputTokens = Math.max(accum.inputTokens, inT);
    accum.outputTokens = Math.max(accum.outputTokens, outT);
    this.deps.state.updateAgent(issueId, { tokens: { ...accum } });
  }

  async run(issue: Issue, attempt: number): Promise<AgentRunOutcome> {
    const cfg = this.deps.config();
    const workspacePath = await this.deps.workspace.ensure(issue);
    const session = this.deps.state.startAgent(issue, workspacePath);

    const codex = new CodexAppServer(
      {
        command: cfg.codex.command,
        cwd: workspacePath,
        approvalPolicy: cfg.codex.approvalPolicy,
        threadSandbox: cfg.codex.threadSandbox,
        turnSandboxPolicy: cfg.codex.turnSandboxPolicy,
        turnTimeoutMs: cfg.codex.turnTimeoutMs,
        readTimeoutMs: cfg.codex.readTimeoutMs,
        stallTimeoutMs: cfg.codex.stallTimeoutMs,
        autoApproveRequests: true,
        dynamicTools: symphonyDynamicToolSpecs,
      },
      this.deps.log,
    );

    const linearGraphql = makeLinearGraphqlHandler(this.deps.linear);
    const tokens: TokenUsage = { totalTokens: 0, inputTokens: 0, outputTokens: 0, secondsRunning: 0 };
    const startedAt = Date.now();

    try {
      // before_run hook (if defined)
      try { await this.deps.workspace.runHook("before_run", workspacePath); }
      catch (e) { this.deps.log.warn(`before_run failed: ${(e as Error).message}`); }

      await codex.start();
      await codex.startThread();

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
            const fresh = await this.deps.linear.fetchIssuesByIds([issue.id]);
            if (fresh[0]) {
              this.deps.state.updateAgent(issue.id, { state: fresh[0].state });
              issue.state = fresh[0].state;
            }
          } catch { /* poll failures are non-fatal */ }
        }, 5000);

        const turnResult = await codex.runTurn(prompt, title, {
          onItem: (item) => {
            const last = (item.text ?? item.kind ?? item.type ?? "") as string;
            this.deps.state.updateAgent(issue.id, {
              lastEvent: "notification",
              lastEventAt: new Date().toISOString(),
              lastMessage: typeof last === "string" ? last.slice(0, 240) : null,
            });
            // Some Codex builds emit usage inside item events
            if (typeof (item as { usage?: unknown }).usage === "object" && (item as { usage?: unknown }).usage) {
              this.recordUsage(issue.id, (item as { usage: Record<string, unknown> }).usage, tokens);
            }
          },
          onTokenUsage: (usage) => {
            this.recordUsage(issue.id, usage, tokens);
          },
          onAnyNotification: (method) => {
            // Surface the method name in lastEvent for diagnosability
            if (method === "thread/tokenUsage/updated" || method === "account/rateLimits/updated"
                || method.startsWith("item/")) {
              this.deps.state.updateAgent(issue.id, {
                lastEvent: method,
                lastEventAt: new Date().toISOString(),
              });
            }
          },
          onToolCall: async (call): Promise<ToolResult> => {
            this.deps.log.debug(`tool_call: ${call.name}`, { issue: issue.identifier });
            return await linearGraphql(call);
          },
        });

        clearInterval(statePoll);

        if (turnResult.status === "failed" || turnResult.status === "cancelled" || turnResult.status === "timeout") {
          tokens.secondsRunning = Math.floor((Date.now() - startedAt) / 1000);
          this.deps.state.finishAgent(issue.id, tokens);
          await codex.stop();
          return { status: "error", error: `turn_${turnResult.status}: ${JSON.stringify(turnResult.reason ?? "")}` };
        }

        // Re-fetch issue state from Linear to decide continuation
        const fresh = await this.deps.linear.fetchIssuesByIds([issue.id]);
        const updated = fresh[0];
        const stillActive =
          updated && cfg.tracker.activeStates.includes(updated.state);

        if (!updated) {
          // Issue not visible (terminal/cancelled/etc)
          tokens.secondsRunning = Math.floor((Date.now() - startedAt) / 1000);
          this.deps.state.finishAgent(issue.id, tokens);
          await codex.stop();
          return { status: "issue_state_changed", newState: "missing" };
        }

        if (!stillActive) {
          tokens.secondsRunning = Math.floor((Date.now() - startedAt) / 1000);
          this.deps.state.finishAgent(issue.id, tokens);
          await codex.stop();
          return { status: "issue_state_changed", newState: updated.state };
        }
        // sync session.state to actual state
        this.deps.state.updateAgent(issue.id, { state: updated.state });
        // mutate the issue object so subsequent prompt rebuilds see latest state
        issue.state = updated.state;

        // session ID surfaces post first turn — best-effort grab
        if (!session.sessionId && (turnResult.reason as { session_id?: string })?.session_id) {
          this.deps.state.updateAgent(issue.id, {
            sessionId: (turnResult.reason as { session_id: string }).session_id,
          });
        }
      }

      // max_turns exhausted
      tokens.secondsRunning = Math.floor((Date.now() - startedAt) / 1000);
      this.deps.state.finishAgent(issue.id, tokens);
      await codex.stop();
      return { status: "max_turns_exceeded" };
    } catch (e) {
      tokens.secondsRunning = Math.floor((Date.now() - startedAt) / 1000);
      this.deps.state.finishAgent(issue.id, tokens);
      try { await codex.stop(); } catch { /* ignore */ }
      try { await this.deps.workspace.runHook("after_run", workspacePath); } catch { /* ignore */ }
      return { status: "error", error: (e as Error).message };
    } finally {
      try { await this.deps.workspace.runHook("after_run", workspacePath); } catch { /* ignore */ }
    }
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
