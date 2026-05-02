import { describe, expect, test } from "bun:test";
import { MockCodingAgentAdapter } from "../src/agents/mock_coding_adapter.js";

describe("MockCodingAgentAdapter (Phase 5 PR-C)", () => {
  test("returns deterministic token usage and tool call shape", async () => {
    const adapter = new MockCodingAgentAdapter();
    const result = await adapter.runTurn({ prompt: "hello", attempt: 1 });

    expect(result.status).toBe("completed");
    expect(result.tokenUsage).toEqual({
      totalTokens: 100,
      inputTokens: 70,
      outputTokens: 30,
      secondsRunning: 1,
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      id: "mock-tool-1",
      name: "linear_graphql",
      result: { status: "ok" },
    });
  });

  test("agent message echoes the prompt prefix and includes attempt", async () => {
    const adapter = new MockCodingAgentAdapter();
    const short = await adapter.runTurn({ prompt: "short", attempt: 2 });
    expect(short.agentMessage).toBe("mock turn for prompt: short");

    const long = await adapter.runTurn({
      prompt: "this prompt is intentionally long enough to truncate at 32 chars",
      attempt: 2,
    });
    expect(long.agentMessage).toMatch(/^mock turn for prompt: .{32}\.\.\.$/);
  });

  test("tool call carries the attempt number in arguments", async () => {
    const adapter = new MockCodingAgentAdapter();
    const result = await adapter.runTurn({ prompt: "x", attempt: 7 });
    expect(result.toolCalls[0]?.arguments).toEqual({ query: "{}", attempt: 7 });
  });

  test("repeated runTurn calls are deterministic on token shape", async () => {
    const adapter = new MockCodingAgentAdapter();
    const a = await adapter.runTurn({ prompt: "p", attempt: 1 });
    const b = await adapter.runTurn({ prompt: "p", attempt: 1 });
    expect(a.tokenUsage).toEqual(b.tokenUsage);
    expect(a.toolCalls).toEqual(b.toolCalls);
  });
});
