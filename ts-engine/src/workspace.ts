// Per-issue workspace lifecycle. Mirrors SPEC §9 + the WORKFLOW.md hooks
// (after_create / before_run / after_run / before_remove).

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { HooksConfig, WorkflowConfig, Issue } from "./types.js";
import type { Logger } from "./log.js";
import type {
  HookName,
  WorkspaceAdapter,
  WorkspaceRef,
} from "./contracts/workspace.js";

export type { HookName, WorkspaceRef };

export class WorkspaceManager implements WorkspaceAdapter {
  constructor(
    private cfg: { root: string; hooks: HooksConfig },
    private log: Logger,
  ) {
    mkdirSync(cfg.root, { recursive: true });
  }

  /**
   * Idempotent: returns the workspace ref, creating the directory and
   * running after_create only if it did not already exist.
   */
  async ensure(issue: Issue): Promise<WorkspaceRef> {
    const path = this.pathFor(issue);
    const fresh = !existsSync(path);
    if (fresh) {
      mkdirSync(path, { recursive: true });
      await this.runHook("after_create", { path, host: null });
    }
    return { path, host: null };
  }

  pathFor(issue: Issue): string {
    return join(this.cfg.root, sanitize(issue.identifier));
  }

  async remove(issue: Issue): Promise<void> {
    const path = this.pathFor(issue);
    if (!existsSync(path)) return;
    try {
      await this.runHook("before_remove", { path, host: null });
    } catch (e) {
      // hook failures are non-fatal per SPEC
      this.log.warn(`before_remove hook failed: ${(e as Error).message}`, {
        issue: issue.identifier,
      });
    }
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (e) {
      this.log.warn(`workspace removal failed: ${(e as Error).message}`, {
        issue: issue.identifier,
      });
    }
  }

  async runHook(name: HookName, workspace: WorkspaceRef): Promise<void> {
    const cmd = this.cfg.hooks[hookKey(name)];
    if (!cmd) return;
    await runShell(cmd, workspace.path, this.cfg.hooks.timeoutMs);
  }
}

type HookKey = "afterCreate" | "beforeRun" | "afterRun" | "beforeRemove";
function hookKey(name: HookName): HookKey {
  switch (name) {
    case "after_create": return "afterCreate";
    case "before_run": return "beforeRun";
    case "after_run": return "afterRun";
    case "before_remove": return "beforeRemove";
  }
}

function sanitize(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Runs `bash -lc <cmd>` in cwd with timeout. Resolves on exit 0,
 * rejects on non-zero or timeout.
 */
export function runShell(cmd: string, cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bash", ["-lc", cmd], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
    proc.stdout.on("data", (b) => { stdout += b.toString(); });
    proc.stderr.on("data", (b) => { stderr += b.toString(); });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`hook_timeout (${timeoutMs}ms): ${cmd.slice(0, 80)}`));
      if (code !== 0) {
        return reject(
          new Error(
            `hook_exit:${code} ${cmd.slice(0, 80)}\nstderr: ${stderr.slice(0, 800)}\nstdout: ${stdout.slice(0, 400)}`,
          ),
        );
      }
      resolve();
    });
  });
}

// Convenience: build manager from a full WorkflowConfig
export function makeWorkspaceManager(config: WorkflowConfig, log: Logger): WorkspaceManager {
  return new WorkspaceManager(
    { root: config.workspace.root, hooks: config.hooks },
    log,
  );
}
