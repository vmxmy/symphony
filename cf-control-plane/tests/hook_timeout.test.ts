// Phase 6 PR-D-1 hook timeout tests.
//
// Plan ref: docs/cloudflare-agent-native-phase6-plan.md §3 R5.
// Verifies runHookWithTimeout happy path, timeout fires, and opts override.

import { describe, expect, it } from "bun:test";

import { MockWorkerHost } from "../src/runtime/mock_worker_host.js";
import { runHookWithTimeout } from "../src/runtime/hooks.js";
import type { HookResult, WorkerHost, WorkspaceHandle } from "../src/runtime/worker_host.js";

const sampleHandle: WorkspaceHandle = {
  id: "mock-acme-content-wechat-ENG-42-0",
  tenant: "acme",
  profile: "content-wechat",
  issue: "ENG-42",
  createdAt: new Date().toISOString(),
  substrate: "mock",
};

function slowWorkerHost(delayMs: number, result: HookResult): WorkerHost {
  return {
    id: "mock",
    prepareWorkspace: async () => { throw new Error("not used"); },
    materializeAssets: async () => { throw new Error("not used"); },
    runHook: async () => {
      await new Promise(r => setTimeout(r, delayMs));
      return result;
    },
    snapshotWorkspace: async () => { throw new Error("not used"); },
    releaseWorkspace: async () => {},
  };
}

describe("runHookWithTimeout (Phase 6 PR-D-1)", () => {
  it("happy path — returns success result from MockWorkerHost", async () => {
    // #given
    const host = new MockWorkerHost();

    // #when
    const result = await runHookWithTimeout(host, sampleHandle, "after_create", { FOO: "bar" });

    // #then
    expect(result.success).toBe(true);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("timeout fires — slow host exceeds timeoutMs, returns timeout sentinel", async () => {
    // #given
    const slowResult: HookResult = {
      success: true,
      exit_code: 0,
      stdout: "done",
      stderr: "",
      duration_ms: 50,
    };
    const host = slowWorkerHost(50, slowResult);

    // #when
    const result = await runHookWithTimeout(host, sampleHandle, "before_run", {}, { timeoutMs: 10 });

    // #then
    expect(result.success).toBe(false);
    expect(result.exit_code).toBe(-1);
    expect(result.stderr).toBe("hook_timeout: 10ms");
    expect(result.duration_ms).toBeGreaterThanOrEqual(10);
  });

  it("opts.timeoutMs override — generous timeout lets slow host finish first", async () => {
    // #given
    const slowResult: HookResult = {
      success: true,
      exit_code: 0,
      stdout: "finished",
      stderr: "",
      duration_ms: 20,
    };
    const host = slowWorkerHost(20, slowResult);

    // #when
    const result = await runHookWithTimeout(host, sampleHandle, "after_run", {}, { timeoutMs: 100 });

    // #then
    expect(result.success).toBe(true);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("finished");
    expect(result.stderr).toBe("");
  });
});
