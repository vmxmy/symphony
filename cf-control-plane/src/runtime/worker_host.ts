// WorkerHost contract for Phase 6 PR-A.
//
// Plan ref: docs/cloudflare-agent-native-phase6-plan.md §3 R1.
// Defines the substrate-neutral seam between ExecutionWorkflow and the
// place where workspaces actually live (mock today, vps_docker / Cloudflare
// containers in later cuts). PR-A only ships the interface, value types,
// and a reference MockWorkerHost. Wiring into ExecutionWorkflow is PR-C.

export type WorkerHostKind = "vps_docker" | "cloudflare_container" | "mock";

export type WorkspaceRef = {
  tenant: string;
  profile: string;
  issue: string;
  branch?: string;
};

export type WorkspaceHandle = {
  id: string;
  tenant: string;
  profile: string;
  issue: string;
  createdAt: string;
  substrate: WorkerHostKind;
};

export type AssetBundleRef = {
  hash: string;
  r2_key?: string;
};

export type HookName = "after_create" | "before_run" | "after_run" | "before_remove";

export type HookResult = {
  success: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  truncated_to_r2?: string;
};

export type R2ObjectRef = {
  bucket: string;
  key: string;
  size_bytes?: number;
};

export type SnapshotOptions = {
  redact: string[];
  max_size_bytes?: number;
};

export interface WorkerHost {
  id: WorkerHostKind;
  prepareWorkspace(ref: WorkspaceRef): Promise<WorkspaceHandle>;
  materializeAssets(handle: WorkspaceHandle, bundle: AssetBundleRef): Promise<void>;
  runHook(handle: WorkspaceHandle, name: HookName, env: Record<string, string>): Promise<HookResult>;
  snapshotWorkspace(handle: WorkspaceHandle, opts: SnapshotOptions): Promise<R2ObjectRef>;
  releaseWorkspace(handle: WorkspaceHandle): Promise<void>;
}
