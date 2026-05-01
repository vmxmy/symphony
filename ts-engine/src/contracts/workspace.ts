// WorkspaceAdapter contract.
//
// Decouples per-issue execution from local filesystem and shell semantics.
// Phase 1 keeps the local implementation; later phases add Sandbox/Container
// implementations under the same surface. See phase1-plan §5.2.

import type { Issue } from "../types.js";

export type HookName =
  | "after_create"
  | "before_run"
  | "after_run"
  | "before_remove";

/**
 * Opaque reference to a workspace. `path` is the cwd to give a coding agent;
 * `host` identifies which sandbox/container (or null for local) the path
 * lives on, so a runner can route shell hooks to the right execution surface.
 */
export type WorkspaceRef = {
  path: string;
  host: string | null;
};

export interface WorkspaceAdapter {
  /**
   * Idempotent: create the workspace if absent (running `after_create`),
   * otherwise return its existing ref.
   */
  ensure(issue: Issue): Promise<WorkspaceRef>;
  /** Where this issue's workspace would live, without creating it. */
  pathFor(issue: Issue): string;
  /** Run `before_remove` (best-effort) then delete. No-op if absent. */
  remove(issue: Issue): Promise<void>;
  /** Execute a profile-defined shell hook inside the workspace. */
  runHook(name: HookName, workspace: WorkspaceRef): Promise<void>;
}
