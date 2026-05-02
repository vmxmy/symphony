// Phase 7 PR-A coding agent factory tests.
//
// Plan ref: docs/cloudflare-agent-native-phase7-plan.md §3 R1 + §5 PR-A.
// Covers parseCodingAgentKind parsing matrix and pickCodingAgent dispatch.

import { describe, expect, it } from "bun:test";

import { parseCodingAgentKind, pickCodingAgent } from "../src/runtime/factory.js";
import { MockCodingAgent } from "../src/coding_agents/mock_coding_agent.js";

describe("parseCodingAgentKind", () => {
  it("returns mock for null input", () => {
    // #given / #when
    const result = parseCodingAgentKind(null);

    // #then
    expect(result).toBe("mock");
  });

  it("returns mock for undefined input", () => {
    // #given / #when
    const result = parseCodingAgentKind(undefined);

    // #then
    expect(result).toBe("mock");
  });

  it("returns mock for non-JSON string", () => {
    // #given / #when
    const result = parseCodingAgentKind("not valid json");

    // #then
    expect(result).toBe("mock");
  });

  it("returns mock for JSON with unknown coding_agent value", () => {
    // #given / #when
    const result = parseCodingAgentKind('{"runtime":{"coding_agent":"unknown"}}');

    // #then
    expect(result).toBe("mock");
  });

  it("returns mock for JSON explicitly specifying mock", () => {
    // #given / #when
    const result = parseCodingAgentKind('{"runtime":{"coding_agent":"mock"}}');

    // #then
    expect(result).toBe("mock");
  });

  it("returns codex_compat for JSON specifying codex_compat", () => {
    // #given / #when
    const result = parseCodingAgentKind('{"runtime":{"coding_agent":"codex_compat"}}');

    // #then
    expect(result).toBe("codex_compat");
  });
});

describe("pickCodingAgent", () => {
  it("returns MockCodingAgent for kind=mock", () => {
    // #given / #when
    const agent = pickCodingAgent({}, "mock");

    // #then
    expect(agent).toBeInstanceOf(MockCodingAgent);
  });

  it("throws not_implemented_yet for kind=codex_compat", () => {
    // #given / #when / #then
    expect(() => pickCodingAgent({}, "codex_compat")).toThrow(/not_implemented_yet/);
  });
});
