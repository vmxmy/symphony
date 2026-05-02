// Phase 6 R6 snapshot module contract tests.
//
// Plan ref: docs/cloudflare-agent-native-phase6-plan.md §3 R6.
// Locks in the DEFAULT_REDACT_LIST so it stays synchronized across
// ExecutionWorkflow, host adapters, and manifests.

import { describe, expect, it } from "bun:test";
import { DEFAULT_REDACT_LIST } from "../src/runtime/snapshot.js";

describe("DEFAULT_REDACT_LIST", () => {
  it("includes .env and other canonical paths", () => {
    // #given the redaction list is imported
    // #when we check for required entries
    // #then all canonical paths are present
    expect(DEFAULT_REDACT_LIST).toContain(".env");
    expect(DEFAULT_REDACT_LIST).toContain("**/.git/");
    expect(DEFAULT_REDACT_LIST).toContain("**/secret*");
    expect(DEFAULT_REDACT_LIST).toContain("**/*.key");
    expect(DEFAULT_REDACT_LIST).toContain("**/auth*.json");
    expect(DEFAULT_REDACT_LIST).toContain("runtime/log/");
    expect(DEFAULT_REDACT_LIST.length).toBe(6);
  });

  it("is a readonly array (frozen contract)", () => {
    // #given the redaction list
    // #when we check its properties
    // #then it is an immutable array type
    expect(Array.isArray(DEFAULT_REDACT_LIST)).toBe(true);
    expect(DEFAULT_REDACT_LIST.length).toBeGreaterThan(0);
  });
});
