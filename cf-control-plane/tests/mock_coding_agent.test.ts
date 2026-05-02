// Phase 7 PR-A MockCodingAgent behavior tests.
//
// Plan ref: docs/cloudflare-agent-native-phase7-plan.md §3 R1 + §5 PR-A.

import { describe, expect, it } from "bun:test";

import { MockCodingAgent } from "../src/coding_agents/mock_coding_agent.js";
import type {
  AgentActivity,
  AgentTokenUsage,
} from "../src/contracts/coding_agent.js";

describe("MockCodingAgent", () => {
  it("start() resolves without error", async () => {
    // #given
    const agent = new MockCodingAgent();

    // #when / #then
    await expect(agent.start()).resolves.toBeUndefined();
  });

  it("startSession() returns deterministic ids using the configured prefix", async () => {
    // #given
    const agent = new MockCodingAgent({ sessionIdPrefix: "test" });

    // #when
    const first = await agent.startSession({ cwd: "/tmp" });
    const second = await agent.startSession({ cwd: "/tmp" });

    // #then
    expect(first).toBe("test-1");
    expect(second).toBe("test-2");
  });

  it("runTurn fires onActivity + onTokenUsage and returns completed status with last session id", async () => {
    // #given
    const agent = new MockCodingAgent();
    const sessionId = await agent.startSession({ cwd: "/tmp" });
    const activities: AgentActivity[] = [];
    const usages: AgentTokenUsage[] = [];

    // #when
    const result = await agent.runTurn("prompt", "title", {
      onActivity: (info) => activities.push(info),
      onTokenUsage: (usage) => usages.push(usage),
    });

    // #then
    expect(activities.length).toBe(1);
    expect(activities[0]?.label).toBe("message");
    expect(usages.length).toBe(1);
    expect(usages[0]?.totalTokens).toBe(42);
    expect(result.status).toBe("completed");
    expect(result.sessionId).toBe(sessionId);
  });

  it("stop() called twice does not throw", async () => {
    // #given
    const agent = new MockCodingAgent();

    // #when / #then
    await expect(agent.stop()).resolves.toBeUndefined();
    await expect(agent.stop()).resolves.toBeUndefined();
  });
});
