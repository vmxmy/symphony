// Phase 6 PR-A US-001 idempotency regression tests.
//
// Plan ref: docs/cloudflare-agent-native-phase6-plan.md §3 R1 + §4 Step 1.
// Locks in the contract guarantees of MockWorkerHost so future real
// adapters (vps_docker, cloudflare_container) can be swapped behind the
// same WorkerHost interface without breaking ExecutionWorkflow callers.

import { describe, expect, it } from "bun:test";

import { MockWorkerHost } from "../src/runtime/mock_worker_host.js";
import type { WorkspaceRef } from "../src/runtime/worker_host.js";

const sampleRef: WorkspaceRef = {
  tenant: "acme",
  profile: "content-wechat",
  issue: "ENG-123",
};

describe("MockWorkerHost idempotency (Phase 6 PR-A US-001)", () => {
  it("prepareWorkspace returns the identical handle reference for the same ref", async () => {
    // #given
    const host = new MockWorkerHost();

    // #when
    const a = await host.prepareWorkspace(sampleRef);
    const b = await host.prepareWorkspace(sampleRef);

    // #then
    expect(a).toBe(b);
    expect(a.id).toBe(b.id);
    expect(a.createdAt).toBe(b.createdAt);
    expect(a.substrate).toBe("mock");
  });

  it("materializeAssets does not duplicate state for the same bundle hash", async () => {
    // #given
    const host = new MockWorkerHost();
    const handle = await host.prepareWorkspace(sampleRef);
    const bundle = { hash: "sha256:deadbeef" };

    // #when
    await host.materializeAssets(handle, bundle);
    await host.materializeAssets(handle, bundle);
    await host.materializeAssets(handle, { hash: "sha256:cafef00d" });

    // #then
    const set = host.materialized.get(handle.id);
    expect(set).toBeDefined();
    expect(set?.size).toBe(2);
    expect(set?.has("sha256:deadbeef")).toBe(true);
    expect(set?.has("sha256:cafef00d")).toBe(true);
  });

  it("releaseWorkspace called twice on the same handle does not throw", async () => {
    // #given
    const host = new MockWorkerHost();
    const handle = await host.prepareWorkspace(sampleRef);

    // #when / #then
    await expect(host.releaseWorkspace(handle)).resolves.toBeUndefined();
    await expect(host.releaseWorkspace(handle)).resolves.toBeUndefined();
  });

  it("prepareWorkspace after release returns a fresh handle", async () => {
    // #given
    const host = new MockWorkerHost();
    const first = await host.prepareWorkspace(sampleRef);

    // #when
    await host.releaseWorkspace(first);
    const second = await host.prepareWorkspace(sampleRef);

    // #then
    expect(second).not.toBe(first);
    expect(second.id).not.toBe(first.id);
    expect(second.tenant).toBe(first.tenant);
    expect(second.profile).toBe(first.profile);
    expect(second.issue).toBe(first.issue);
  });

  it("runHook returns a deterministic success HookResult", async () => {
    // #given
    const host = new MockWorkerHost();
    const handle = await host.prepareWorkspace(sampleRef);

    // #when
    const result = await host.runHook(handle, "after_create", { FOO: "bar" });

    // #then
    expect(result.success).toBe(true);
    expect(result.exit_code).toBe(0);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("snapshotWorkspace returns the deterministic R2 key shape", async () => {
    // #given
    const host = new MockWorkerHost({ artifactsBucketName: "symphony-runs" });
    const handle = await host.prepareWorkspace(sampleRef);

    // #when
    const ref = await host.snapshotWorkspace(handle, { redact: [] });

    // #then
    expect(ref.bucket).toBe("symphony-runs");
    expect(ref.key).toBe("runs/acme/content-wechat/ENG-123/0/snapshot.tar.zst");
  });
});
