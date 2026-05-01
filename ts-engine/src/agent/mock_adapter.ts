// MockAgent: a programmable in-memory Agent for tests.
//
// The whole point of having this is to *validate* the Agent interface by
// proving AgentRunner can drive a second, totally different implementation
// without changes. If a future change requires modifying AgentRunner to
// accommodate Codex specifics, that's a signal the abstraction is leaking.
//
// Each test scripts a sequence of `MockTurn` directives; the adapter walks
// through them on successive runTurn() calls and emits the corresponding
// activity / token usage / tool call / completion events.

import type {
  Agent,
  AgentTokenUsage,
  SessionOptions,
  ToolCall,
  ToolResult,
  TurnHandlers,
  TurnResult,
} from "./types.js";

export type MockEvent =
  | { kind: "activity"; label: string; text?: string }
  | { kind: "tokens"; usage: AgentTokenUsage }
  | { kind: "tool_call"; call: ToolCall };

export type MockTurn = {
  /** Events emitted before the turn finishes, in order. */
  events?: MockEvent[];
  /** How the turn ends. Defaults to completed. */
  outcome?: { status: TurnResult["status"]; reason?: unknown };
  /** Optional per-turn delay (ms) before emitting events. Defaults to 0. */
  delayMs?: number;
};

export type MockAgentScript = {
  sessionId?: string;
  turns: MockTurn[];
  /** If true, throw on subsequent runTurn calls past the script's length. */
  strict?: boolean;
};

export class MockAgent implements Agent {
  private cwd: string | null = null;
  private turnIndex = 0;
  private startCalls = 0;
  private sessionStartCalls = 0;
  private stopCalls = 0;
  private toolResults: ToolResult[] = [];

  constructor(private script: MockAgentScript) {}

  // ---- Agent interface --------------------------------------------------

  async start(): Promise<void> {
    this.startCalls += 1;
  }

  async startSession(opts: SessionOptions): Promise<string> {
    this.sessionStartCalls += 1;
    this.cwd = opts.cwd;
    return this.script.sessionId ?? `mock-session-${this.sessionStartCalls}`;
  }

  async runTurn(_prompt: string, _title: string, handlers: TurnHandlers): Promise<TurnResult> {
    const turn = this.script.turns[this.turnIndex];
    this.turnIndex += 1;

    if (!turn) {
      if (this.script.strict) throw new Error(`mock_agent: turn ${this.turnIndex} not scripted`);
      return { status: "completed", sessionId: this.script.sessionId ?? null };
    }

    if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));

    for (const ev of turn.events ?? []) {
      if (ev.kind === "activity") {
        handlers.onActivity?.({ label: ev.label, text: ev.text });
      } else if (ev.kind === "tokens") {
        handlers.onTokenUsage?.(ev.usage);
      } else if (ev.kind === "tool_call") {
        const handler = handlers.onToolCall;
        if (handler) {
          const result = await handler(ev.call);
          this.toolResults.push(result);
        }
      }
    }

    const outcome = turn.outcome ?? { status: "completed" as const };
    return {
      status: outcome.status,
      reason: outcome.reason,
      sessionId: this.script.sessionId ?? null,
    };
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  // ---- test introspection -----------------------------------------------

  inspect() {
    return {
      cwd: this.cwd,
      startCalls: this.startCalls,
      sessionStartCalls: this.sessionStartCalls,
      stopCalls: this.stopCalls,
      turnsConsumed: this.turnIndex,
      toolResults: [...this.toolResults],
    };
  }
}
