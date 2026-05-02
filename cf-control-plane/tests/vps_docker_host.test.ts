// Phase 6 PR-B VpsDockerHost adapter tests.
//
// Plan ref: docs/cloudflare-agent-native-phase6-plan.md §3 R2 + §4 Step 2.
// Stubs the fetch implementation to lock in the bridge HTTP contract
// (URLs, methods, auth header, request/response shapes) without touching
// a real symphony-vps-bridge daemon.

import { describe, expect, it } from "bun:test";

import {
  type FetchLike,
  VpsBridgeError,
  VpsDockerHost,
} from "../src/runtime/vps_docker_host.js";
import type {
  HookResult,
  R2ObjectRef,
  WorkspaceHandle,
  WorkspaceRef,
} from "../src/runtime/worker_host.js";

const BRIDGE = "https://dev.vps.example.com:8443";
const TOKEN = "secret-bridge-token";

const sampleRef: WorkspaceRef = {
  tenant: "acme",
  profile: "content-wechat",
  issue: "ENG-123",
  branch: "main",
};

function makeHandle(overrides: Partial<WorkspaceHandle> = {}): WorkspaceHandle {
  return {
    id: "ws-acme-content-wechat-ENG-123-0",
    tenant: "acme",
    profile: "content-wechat",
    issue: "ENG-123",
    createdAt: "2026-05-03T00:00:00.000Z",
    substrate: "vps_docker",
    ...overrides,
  };
}

type Captured = {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  body: unknown;
};

function stubFetch(handler: (req: Request) => Response | Promise<Response>): {
  fetchImpl: FetchLike;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const req = new Request(input, init);
    let parsedBody: unknown = undefined;
    const rawBody = init?.body;
    if (typeof rawBody === "string" && rawBody.length > 0) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = rawBody;
      }
    }
    captured.push({
      url: input,
      method: req.method,
      authorization: req.headers.get("authorization"),
      contentType: req.headers.get("content-type"),
      body: parsedBody,
    });
    return handler(req);
  };
  return { fetchImpl, captured };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("VpsDockerHost (Phase 6 PR-B)", () => {
  it("prepareWorkspace POSTs to /workspaces with auth and parses the handle", async () => {
    // #given
    const handle = makeHandle();
    const { fetchImpl, captured } = stubFetch(() => jsonResponse(200, handle));
    const host = new VpsDockerHost({
      bridgeBaseUrl: BRIDGE,
      authToken: TOKEN,
      fetchImpl,
    });

    // #when
    const result = await host.prepareWorkspace(sampleRef);

    // #then
    expect(result).toEqual(handle);
    expect(captured).toHaveLength(1);
    const call = captured[0]!;
    expect(call.url).toBe(`${BRIDGE}/workspaces`);
    expect(call.method).toBe("POST");
    expect(call.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.contentType).toBe("application/json");
    expect(call.body).toEqual({
      tenant: "acme",
      profile: "content-wechat",
      issue: "ENG-123",
      branch: "main",
    });
  });

  it("materializeAssets POSTs to /workspaces/{id}/materialize with hash + r2_key", async () => {
    // #given
    const { fetchImpl, captured } = stubFetch(() => new Response(null, { status: 200 }));
    const host = new VpsDockerHost({
      bridgeBaseUrl: BRIDGE,
      authToken: TOKEN,
      fetchImpl,
    });
    const handle = makeHandle();

    // #when
    await host.materializeAssets(handle, { hash: "sha256:deadbeef", r2_key: "bundles/abc.tar.zst" });

    // #then
    const call = captured[0]!;
    expect(call.url).toBe(`${BRIDGE}/workspaces/${encodeURIComponent(handle.id)}/materialize`);
    expect(call.method).toBe("POST");
    expect(call.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.body).toEqual({ hash: "sha256:deadbeef", r2_key: "bundles/abc.tar.zst" });
  });

  it("runHook POSTs the encoded hook name and parses HookResult", async () => {
    // #given
    const expected: HookResult = {
      success: true,
      exit_code: 0,
      stdout: "ok",
      stderr: "",
      duration_ms: 42,
    };
    const { fetchImpl, captured } = stubFetch(() => jsonResponse(200, expected));
    const host = new VpsDockerHost({
      bridgeBaseUrl: BRIDGE,
      authToken: TOKEN,
      fetchImpl,
    });
    const handle = makeHandle();

    // #when
    const result = await host.runHook(handle, "after_create", { FOO: "bar" });

    // #then
    expect(result).toEqual(expected);
    const call = captured[0]!;
    expect(call.url).toBe(
      `${BRIDGE}/workspaces/${encodeURIComponent(handle.id)}/hooks/${encodeURIComponent("after_create")}`,
    );
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ env: { FOO: "bar" } });
  });

  it("snapshotWorkspace sends redact + max_size_bytes and parses R2ObjectRef", async () => {
    // #given
    const expected: R2ObjectRef = {
      bucket: "symphony-runs",
      key: "runs/acme/content-wechat/ENG-123/0/snapshot.tar.zst",
      size_bytes: 1024,
    };
    const { fetchImpl, captured } = stubFetch(() => jsonResponse(200, expected));
    const host = new VpsDockerHost({
      bridgeBaseUrl: BRIDGE,
      authToken: TOKEN,
      fetchImpl,
    });
    const handle = makeHandle();

    // #when
    const result = await host.snapshotWorkspace(handle, {
      redact: ["AUTH_TOKEN", "API_KEY"],
      max_size_bytes: 50_000_000,
    });

    // #then
    expect(result).toEqual(expected);
    const call = captured[0]!;
    expect(call.url).toBe(`${BRIDGE}/workspaces/${encodeURIComponent(handle.id)}/snapshot`);
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({
      redact: ["AUTH_TOKEN", "API_KEY"],
      max_size_bytes: 50_000_000,
    });
  });

  it("releaseWorkspace issues DELETE without a body and accepts 204", async () => {
    // #given
    const { fetchImpl, captured } = stubFetch(() => new Response(null, { status: 204 }));
    const host = new VpsDockerHost({
      bridgeBaseUrl: BRIDGE,
      authToken: TOKEN,
      fetchImpl,
    });
    const handle = makeHandle();

    // #when
    await host.releaseWorkspace(handle);

    // #then
    const call = captured[0]!;
    expect(call.url).toBe(`${BRIDGE}/workspaces/${encodeURIComponent(handle.id)}`);
    expect(call.method).toBe("DELETE");
    expect(call.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.body).toBeUndefined();
  });

  it("releaseWorkspace treats 404 as idempotent success", async () => {
    // #given
    const { fetchImpl } = stubFetch(() =>
      jsonResponse(404, { message: "workspace not found" }),
    );
    const host = new VpsDockerHost({
      bridgeBaseUrl: BRIDGE,
      authToken: TOKEN,
      fetchImpl,
    });
    const handle = makeHandle();

    // #when / #then
    await expect(host.releaseWorkspace(handle)).resolves.toBeUndefined();
  });

  it("throws VpsBridgeError on non-2xx with status, message, and endpoint", async () => {
    // #given
    const { fetchImpl } = stubFetch(() =>
      jsonResponse(500, { message: "bridge exploded" }),
    );
    const host = new VpsDockerHost({
      bridgeBaseUrl: BRIDGE,
      authToken: TOKEN,
      fetchImpl,
    });

    // #when / #then
    let caught: unknown;
    try {
      await host.prepareWorkspace(sampleRef);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(VpsBridgeError);
    const err = caught as VpsBridgeError;
    expect(err.status).toBe(500);
    expect(err.bridgeMessage).toBe("bridge exploded");
    expect(err.endpoint).toBe("/workspaces");
  });

  it("trims a trailing slash from bridgeBaseUrl when building URLs", async () => {
    // #given
    const { fetchImpl, captured } = stubFetch(() => jsonResponse(200, makeHandle()));
    const host = new VpsDockerHost({
      bridgeBaseUrl: `${BRIDGE}/`,
      authToken: TOKEN,
      fetchImpl,
    });

    // #when
    await host.prepareWorkspace(sampleRef);

    // #then
    expect(captured[0]!.url).toBe(`${BRIDGE}/workspaces`);
  });
});
