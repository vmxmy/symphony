// File header: plan ref docs/cloudflare-agent-native-phase6-plan.md §3 R9 + §4 + §5 PR-C.
//
// pickWorkerHost is the single dispatch point for selecting which substrate
// runs a profile's workspace operations. Phase 5 default profile carries
// runtime.host = "mock", so this dispatch returns MockWorkerHost and the
// workflow's behaviour is unchanged from Phase 5. Future profiles set to
// "vps_docker" will route through VpsDockerHost (PR-B) using the
// VPS_BRIDGE_BASE_URL + VPS_BRIDGE_TOKEN secrets the Worker is provisioned
// with.

import type { WorkerHost, WorkerHostKind } from "./worker_host.js";
import { MockWorkerHost } from "./mock_worker_host.js";
import { VpsDockerHost } from "./vps_docker_host.js";
import type {
  CodingAgentAdapter,
  CodingAgentKind,
} from "../contracts/coding_agent.js";
import { MockCodingAgent } from "../coding_agents/mock_coding_agent.js";

export type { CodingAgentKind } from "../contracts/coding_agent.js";

export type RuntimeEnv = {
  VPS_BRIDGE_BASE_URL?: string;
  VPS_BRIDGE_TOKEN?: string;
};

export type RuntimeConfig = {
  host: WorkerHostKind;
  coding_agent: CodingAgentKind;
};

const VALID_KINDS: ReadonlySet<WorkerHostKind> = new Set(["mock", "vps_docker", "cloudflare_container"]);

function parseRuntimeHost(rawConfigJson: string | null | undefined): WorkerHostKind {
  if (rawConfigJson === null || rawConfigJson === undefined || rawConfigJson === "") {
    return "mock";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfigJson);
  } catch {
    return "mock";
  }
  if (typeof parsed !== "object" || parsed === null) {
    return "mock";
  }
  const obj = parsed as Record<string, unknown>;
  const runtime = obj.runtime;
  if (typeof runtime !== "object" || runtime === null) {
    return "mock";
  }
  const host = (runtime as Record<string, unknown>).host;
  if (typeof host !== "string" || !VALID_KINDS.has(host as WorkerHostKind)) {
    return "mock";
  }
  return host as WorkerHostKind;
}

export function parseRuntimeConfig(rawConfigJson: string | null | undefined): RuntimeConfig {
  return {
    host: parseRuntimeHost(rawConfigJson),
    coding_agent: parseCodingAgentKind(rawConfigJson),
  };
}

export function pickWorkerHost(env: RuntimeEnv, config: RuntimeConfig): WorkerHost {
  switch (config.host) {
    case "mock":
      return new MockWorkerHost();
    case "vps_docker": {
      if (!env.VPS_BRIDGE_BASE_URL || !env.VPS_BRIDGE_TOKEN) {
        throw new Error(
          "vps_docker_runtime_misconfigured: VPS_BRIDGE_BASE_URL and VPS_BRIDGE_TOKEN must be set",
        );
      }
      return new VpsDockerHost({
        bridgeBaseUrl: env.VPS_BRIDGE_BASE_URL,
        authToken: env.VPS_BRIDGE_TOKEN,
      });
    }
    case "cloudflare_container":
      throw new Error("not_implemented_yet: cloudflare_container WorkerHost is Phase 6.B / PR-E scope");
  }
}

const VALID_CODING_AGENT_KINDS: ReadonlySet<CodingAgentKind> = new Set([
  "mock",
  "codex_compat",
]);

export function parseCodingAgentKind(
  rawConfigJson: string | null | undefined,
): CodingAgentKind {
  if (rawConfigJson === null || rawConfigJson === undefined || rawConfigJson === "") {
    return "mock";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfigJson);
  } catch {
    return "mock";
  }
  if (typeof parsed !== "object" || parsed === null) {
    return "mock";
  }
  const obj = parsed as Record<string, unknown>;
  const runtime = obj.runtime;
  if (typeof runtime !== "object" || runtime === null) {
    return "mock";
  }
  const codingAgent = (runtime as Record<string, unknown>).coding_agent;
  if (
    typeof codingAgent !== "string" ||
    !VALID_CODING_AGENT_KINDS.has(codingAgent as CodingAgentKind)
  ) {
    return "mock";
  }
  return codingAgent as CodingAgentKind;
}

export function pickCodingAgent(_env: RuntimeEnv, kind: CodingAgentKind): CodingAgentAdapter {
  switch (kind) {
    case "mock":
      return new MockCodingAgent();
    case "codex_compat":
      throw new Error("not_implemented_yet: codex_compat is Phase 7 PR-B scope");
  }
}
