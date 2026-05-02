// MockWorkerHost — Phase 6 PR-A reference adapter.
//
// Plan ref: docs/cloudflare-agent-native-phase6-plan.md §3 R1 + §4 Step 1.
// Path-preserving reference impl that satisfies the WorkerHost contract
// without any real filesystem or container side effects. Used by tests and
// by the Phase 5 ExecutionWorkflow once PR-C wires the seam in.
//
// Idempotency guarantees (US-001 AC 5/6/9):
//   - prepareWorkspace with the same WorkspaceRef returns the same handle
//     reference (===) until releaseWorkspace clears the entry.
//   - materializeAssets is a no-op for a (handle, bundle.hash) pair already
//     materialized.
//   - releaseWorkspace is a no-op on an unknown / already-released handle.

import type {
  AssetBundleRef,
  HookName,
  HookResult,
  R2ObjectRef,
  SnapshotOptions,
  WorkerHost,
  WorkerHostKind,
  WorkspaceHandle,
  WorkspaceRef,
} from "./worker_host.js";

export type MockWorkerHostOptions = {
  artifactsBucketName?: string;
};

const DEFAULT_ARTIFACTS_BUCKET = "symphony-runs";

function refKey(ref: WorkspaceRef): string {
  return `${ref.tenant}:${ref.profile}:${ref.issue}`;
}

export class MockWorkerHost implements WorkerHost {
  readonly id: WorkerHostKind = "mock";

  private readonly artifactsBucketName: string;
  private readonly handles: Map<string, WorkspaceHandle> = new Map();
  private readonly materializedByHandle: Map<string, Set<string>> = new Map();
  private readonly releasedHandleIds: Set<string> = new Set();
  private nextHandleSeq = 0;

  constructor(options: MockWorkerHostOptions = {}) {
    this.artifactsBucketName = options.artifactsBucketName ?? DEFAULT_ARTIFACTS_BUCKET;
  }

  get materialized(): ReadonlyMap<string, ReadonlySet<string>> {
    return this.materializedByHandle;
  }

  async prepareWorkspace(ref: WorkspaceRef): Promise<WorkspaceHandle> {
    const key = refKey(ref);
    const existing = this.handles.get(key);
    if (existing) {
      return existing;
    }
    const seq = this.nextHandleSeq++;
    const handle: WorkspaceHandle = {
      id: `mock-${ref.tenant}-${ref.profile}-${ref.issue}-${seq}`,
      tenant: ref.tenant,
      profile: ref.profile,
      issue: ref.issue,
      createdAt: new Date().toISOString(),
      substrate: "mock",
    };
    this.handles.set(key, handle);
    this.materializedByHandle.set(handle.id, new Set());
    return handle;
  }

  async materializeAssets(handle: WorkspaceHandle, bundle: AssetBundleRef): Promise<void> {
    const set = this.materializedByHandle.get(handle.id) ?? new Set<string>();
    if (!this.materializedByHandle.has(handle.id)) {
      this.materializedByHandle.set(handle.id, set);
    }
    if (set.has(bundle.hash)) {
      return;
    }
    set.add(bundle.hash);
  }

  async runHook(
    _handle: WorkspaceHandle,
    _name: HookName,
    _env: Record<string, string>,
  ): Promise<HookResult> {
    return {
      success: true,
      exit_code: 0,
      stdout: "",
      stderr: "",
      duration_ms: 1,
    };
  }

  async snapshotWorkspace(handle: WorkspaceHandle, _opts: SnapshotOptions): Promise<R2ObjectRef> {
    return {
      bucket: this.artifactsBucketName,
      key: `runs/${handle.tenant}/${handle.profile}/${handle.issue}/0/snapshot.tar.zst`,
    };
  }

  async releaseWorkspace(handle: WorkspaceHandle): Promise<void> {
    if (this.releasedHandleIds.has(handle.id)) {
      return;
    }
    this.releasedHandleIds.add(handle.id);
    const key = refKey({
      tenant: handle.tenant,
      profile: handle.profile,
      issue: handle.issue,
    });
    const cached = this.handles.get(key);
    if (cached && cached.id === handle.id) {
      this.handles.delete(key);
    }
  }
}
