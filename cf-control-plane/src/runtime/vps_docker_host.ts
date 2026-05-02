// VpsDockerHost — Phase 6 PR-B HTTP adapter.
//
// Plan ref: docs/cloudflare-agent-native-phase6-plan.md §3 R2 + §4 Step 2.
// Conforms to the WorkerHost contract by issuing authenticated HTTPS calls
// to the symphony-vps-bridge daemon. PR-B ships the client only; the bridge
// server materializes workspaces under /symphony/workspaces/{tenant}/{profile}/{issue}
// (path convention enforced server-side, not by this client).
//
// Bridge endpoint contract:
//   POST   /workspaces                       -> WorkspaceHandle
//   POST   /workspaces/{id}/materialize      -> 200 OK (idempotent by hash)
//   POST   /workspaces/{id}/hooks/{name}     -> HookResult
//   POST   /workspaces/{id}/snapshot         -> R2ObjectRef
//   DELETE /workspaces/{id}                  -> 204 (404 == idempotent success)
//
// All requests carry `Authorization: Bearer ${authToken}`. POSTs with bodies
// also send `Content-Type: application/json`. Workspace ids and hook names
// are URL-encoded before interpolation.
//
// Idempotency notes (US-001 AC 5/6/9):
//   - materializeAssets is server-side idempotent (keyed by `hash`); 5xx is
//     safe to retry from the caller's perspective.
//   - releaseWorkspace treats 404 as success (already released).
//   - prepareWorkspace idempotency lives on the bridge server (keyed by
//     `(tenant, profile, issue)`); this client does not cache handles.

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

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type VpsDockerHostOptions = {
  bridgeBaseUrl: string;
  authToken: string;
  fetchImpl?: FetchLike;
};

type BridgeErrorBody = {
  message?: string;
  error?: string;
};

export class VpsBridgeError extends Error {
  constructor(
    public readonly status: number,
    public readonly bridgeMessage: string,
    public readonly endpoint: string,
  ) {
    super(`VpsBridgeError [${status}] ${endpoint}: ${bridgeMessage}`);
    this.name = "VpsBridgeError";
  }
}

export class VpsDockerHost implements WorkerHost {
  readonly id: WorkerHostKind = "vps_docker";

  private readonly bridgeBaseUrl: string;
  private readonly authToken: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: VpsDockerHostOptions) {
    this.bridgeBaseUrl = options.bridgeBaseUrl.replace(/\/+$/, "");
    this.authToken = options.authToken;
    const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
  }

  async prepareWorkspace(ref: WorkspaceRef): Promise<WorkspaceHandle> {
    const endpoint = "/workspaces";
    const body: Record<string, string> = {
      tenant: ref.tenant,
      profile: ref.profile,
      issue: ref.issue,
    };
    if (ref.branch !== undefined) {
      body.branch = ref.branch;
    }
    const response = await this.postJson(endpoint, body);
    const parsed = (await response.json()) as WorkspaceHandle;
    return parsed;
  }

  async materializeAssets(handle: WorkspaceHandle, bundle: AssetBundleRef): Promise<void> {
    const endpoint = `/workspaces/${encodeURIComponent(handle.id)}/materialize`;
    const body: Record<string, string> = { hash: bundle.hash };
    if (bundle.r2_key !== undefined) {
      body.r2_key = bundle.r2_key;
    }
    await this.postJson(endpoint, body);
  }

  async runHook(
    handle: WorkspaceHandle,
    name: HookName,
    env: Record<string, string>,
  ): Promise<HookResult> {
    const endpoint = `/workspaces/${encodeURIComponent(handle.id)}/hooks/${encodeURIComponent(name)}`;
    const response = await this.postJson(endpoint, { env });
    const parsed = (await response.json()) as HookResult;
    return parsed;
  }

  async snapshotWorkspace(handle: WorkspaceHandle, opts: SnapshotOptions): Promise<R2ObjectRef> {
    const endpoint = `/workspaces/${encodeURIComponent(handle.id)}/snapshot`;
    const body: Record<string, unknown> = { redact: opts.redact };
    if (opts.max_size_bytes !== undefined) {
      body.max_size_bytes = opts.max_size_bytes;
    }
    const response = await this.postJson(endpoint, body);
    const parsed = (await response.json()) as R2ObjectRef;
    return parsed;
  }

  async releaseWorkspace(handle: WorkspaceHandle): Promise<void> {
    const endpoint = `/workspaces/${encodeURIComponent(handle.id)}`;
    const response = await this.fetchImpl(`${this.bridgeBaseUrl}${endpoint}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${this.authToken}`,
      },
    });
    if (response.status === 404) {
      return;
    }
    if (!response.ok) {
      await this.throwBridgeError(response, endpoint);
    }
  }

  private async postJson(endpoint: string, body: unknown): Promise<Response> {
    const response = await this.fetchImpl(`${this.bridgeBaseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await this.throwBridgeError(response, endpoint);
    }
    return response;
  }

  private async throwBridgeError(response: Response, endpoint: string): Promise<never> {
    let message = response.statusText;
    try {
      const parsed = (await response.json()) as BridgeErrorBody;
      message = parsed.message ?? parsed.error ?? response.statusText;
    } catch {
      // Body was empty or non-JSON; fall back to statusText.
    }
    throw new VpsBridgeError(response.status, message, endpoint);
  }
}
