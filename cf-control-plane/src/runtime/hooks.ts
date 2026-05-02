// Header: plan ref docs/cloudflare-agent-native-phase6-plan.md §3 R5.
// Wraps WorkerHost.runHook with a per-name default timeout matching
// ts-engine semantics. Used by ExecutionWorkflow steps 5/7/12/15
// (PR-D-2 wires them).

import type { HookName, HookResult, WorkerHost, WorkspaceHandle } from "./worker_host.js";

export const DEFAULT_HOOK_TIMEOUTS_MS: Readonly<Record<HookName, number>> = Object.freeze({
  after_create: 60_000,
  before_run: 30_000,
  after_run: 60_000,
  before_remove: 30_000,
});

export type RunHookOptions = {
  timeoutMs?: number;
};

export async function runHookWithTimeout(
  workerHost: WorkerHost,
  handle: WorkspaceHandle,
  name: HookName,
  env: Record<string, string>,
  opts: RunHookOptions = {},
): Promise<HookResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HOOK_TIMEOUTS_MS[name];
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<HookResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        success: false,
        exit_code: -1,
        stdout: "",
        stderr: `hook_timeout: ${timeoutMs}ms`,
        duration_ms: Date.now() - start,
      });
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([workerHost.runHook(handle, name, env), timeoutPromise]);
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
