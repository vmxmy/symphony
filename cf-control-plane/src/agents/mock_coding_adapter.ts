// Mock CodingAgentAdapter for Phase 5 ExecutionWorkflow.
//
// Deterministic. No DO storage, no D1, no env binding. Mirrors the event
// sequence of ts-engine/src/agent/mock_adapter.ts so the same dashboard /
// manifest readers can absorb either implementation. Phase 6 swaps the
// caller (step 8 of ExecutionWorkflow) over to a real WorkerHost-backed
// adapter; Phase 7 ships codex_compat. PR-C ships only the mock.

export type MockTurnInput = {
  prompt: string;
  attempt: number;
};

export type MockTokenUsage = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  secondsRunning: number;
};

export type MockToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result: { status: "ok"; value: unknown };
};

export type MockTurnResult = {
  status: "completed";
  tokenUsage: MockTokenUsage;
  toolCalls: MockToolCall[];
  agentMessage: string;
};

/**
 * Phase 5 mock coding agent. The shape is intentionally compact —
 * Phase 6/7 will introduce a richer Agent contract once the
 * CodingAgentAdapter / WorkspaceAdapter seams from ADR-0001 are wired
 * to a real substrate. PR-C uses the minimal surface step 8 needs.
 */
export class MockCodingAgentAdapter {
  async runTurn(input: MockTurnInput): Promise<MockTurnResult> {
    const tokenUsage: MockTokenUsage = {
      totalTokens: 100,
      inputTokens: 70,
      outputTokens: 30,
      secondsRunning: 1,
    };
    const toolCalls: MockToolCall[] = [
      {
        id: "mock-tool-1",
        name: "linear_graphql",
        arguments: { query: "{}", attempt: input.attempt },
        result: { status: "ok", value: { rows: 1 } },
      },
    ];
    const truncated = input.prompt.length > 32 ? `${input.prompt.slice(0, 32)}...` : input.prompt;
    return {
      status: "completed",
      tokenUsage,
      toolCalls,
      agentMessage: `mock turn for prompt: ${truncated}`,
    };
  }
}
