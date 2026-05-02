// Phase 6 PR-C runtime factory tests.
//
// Plan ref: docs/cloudflare-agent-native-phase6-plan.md §3 R9 + §5 PR-C.
// Covers parseRuntimeConfig parsing matrix and pickWorkerHost dispatch.

import { describe, expect, it } from "bun:test";

import { parseRuntimeConfig, pickWorkerHost } from "../src/runtime/factory.js";
import { MockWorkerHost } from "../src/runtime/mock_worker_host.js";
import { VpsDockerHost } from "../src/runtime/vps_docker_host.js";

describe("parseRuntimeConfig", () => {
  it("returns host=mock for null input", () => {
    // #given / #when
    const result = parseRuntimeConfig(null);

    // #then
    expect(result.host).toBe("mock");
  });

  it("returns host=mock for undefined input", () => {
    // #given / #when
    const result = parseRuntimeConfig(undefined);

    // #then
    expect(result.host).toBe("mock");
  });

  it("returns host=mock for empty string input", () => {
    // #given / #when
    const result = parseRuntimeConfig("");

    // #then
    expect(result.host).toBe("mock");
  });

  it("returns host=mock for non-JSON string", () => {
    // #given / #when
    const result = parseRuntimeConfig("not valid json");

    // #then
    expect(result.host).toBe("mock");
  });

  it("returns host=mock for JSON with unknown host value", () => {
    // #given / #when
    const result = parseRuntimeConfig('{"runtime":{"host":"unknown"}}');

    // #then
    expect(result.host).toBe("mock");
  });

  it("returns host=mock for JSON explicitly specifying mock", () => {
    // #given / #when
    const result = parseRuntimeConfig('{"runtime":{"host":"mock"}}');

    // #then
    expect(result.host).toBe("mock");
  });

  it("returns host=vps_docker for JSON specifying vps_docker", () => {
    // #given / #when
    const result = parseRuntimeConfig('{"runtime":{"host":"vps_docker"}}');

    // #then
    expect(result.host).toBe("vps_docker");
  });

  it("returns host=cloudflare_container for JSON specifying cloudflare_container", () => {
    // #given / #when
    const result = parseRuntimeConfig('{"runtime":{"host":"cloudflare_container"}}');

    // #then
    expect(result.host).toBe("cloudflare_container");
  });
});

describe("pickWorkerHost", () => {
  it("returns MockWorkerHost for host=mock", () => {
    // #given
    const config = { host: "mock" } as const;

    // #when
    const host = pickWorkerHost({}, config);

    // #then
    expect(host).toBeInstanceOf(MockWorkerHost);
  });

  it("returns VpsDockerHost for host=vps_docker with credentials present", () => {
    // #given
    const env = { VPS_BRIDGE_BASE_URL: "https://bridge.example.com", VPS_BRIDGE_TOKEN: "tok" };
    const config = { host: "vps_docker" } as const;

    // #when
    const host = pickWorkerHost(env, config);

    // #then
    expect(host).toBeInstanceOf(VpsDockerHost);
  });

  it("throws vps_docker_runtime_misconfigured when env vars are missing for vps_docker", () => {
    // #given
    const config = { host: "vps_docker" } as const;

    // #when / #then
    expect(() => pickWorkerHost({}, config)).toThrow("vps_docker_runtime_misconfigured");
  });

  it("throws not_implemented_yet for host=cloudflare_container", () => {
    // #given
    const config = { host: "cloudflare_container" } as const;

    // #when / #then
    expect(() => pickWorkerHost({}, config)).toThrow("not_implemented_yet");
  });
});
