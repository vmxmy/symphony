// MockCodingAgent — Phase 7 PR-A reference adapter for tests + the
// Phase 5/6 path until PR-C swaps execution.ts step 8.
//
// Plan: docs/cloudflare-agent-native-phase7-plan.md §3 R1 + §4 Step 2 + §5 PR-A.

import type {
  AgentTokenUsage,
  CodingAgentAdapter,
  SessionOptions,
  TurnHandlers,
  TurnResult,
} from "../contracts/coding_agent.js";

export type MockCodingAgentOptions = {
  sessionIdPrefix?: string;
};

const DEFAULT_TOKENS: AgentTokenUsage = {
  totalTokens: 42,
  inputTokens: 30,
  outputTokens: 12,
};

export class MockCodingAgent implements CodingAgentAdapter {
  private readonly sessionIdPrefix: string;
  private sessionCounter = 0;
  private lastSessionId: string | null = null;
  private stopped = false;

  constructor(options: MockCodingAgentOptions = {}) {
    this.sessionIdPrefix = options.sessionIdPrefix ?? "mock-session";
  }

  async start(): Promise<void> {
    // no-op for mock
  }

  async startSession(_opts: SessionOptions): Promise<string> {
    this.sessionCounter += 1;
    const id = `${this.sessionIdPrefix}-${this.sessionCounter}`;
    this.lastSessionId = id;
    return id;
  }

  async runTurn(
    _prompt: string,
    _title: string,
    handlers: TurnHandlers,
  ): Promise<TurnResult> {
    handlers.onActivity?.({ label: "message", text: "mock turn" });
    handlers.onTokenUsage?.(DEFAULT_TOKENS);
    return { status: "completed", sessionId: this.lastSessionId };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
  }
}
