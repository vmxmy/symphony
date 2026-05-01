// Pure v1->v2 profile upgrade logic.
//
// Given the parsed contents of a v1 profile bundle (profile.yaml +
// WORKFLOW.md front matter), produce the v2 normalized config plus the
// import bookkeeping required by docs/cloudflare-agent-native-target.md
// §10.1: list of fields that were defaulted, list of warnings.
//
// This module is deliberately pure (no node:fs, no wrangler, no D1) so it
// can be reused by:
//   - scripts/import-profile.ts (the operator CLI in this commit),
//   - the future Worker-side import endpoint,
//   - unit tests.

export type V1ProfileYaml = {
  name?: string;
  version?: string;
  description?: string;
  maintainer?: string;
  schema_version?: number;
  symphony?: Record<string, unknown>;
  linear?: Record<string, unknown>;
  preflight?: Record<string, unknown>;
  [extra: string]: unknown;
};

export type V1WorkflowFrontMatter = {
  tracker?: {
    kind?: string;
    project_slug?: string;
    api_key?: string;
    active_states?: string[];
    terminal_states?: string[];
    [k: string]: unknown;
  };
  polling?: { interval_ms?: number; mode?: string };
  workspace?: { root?: string; isolation?: string; image?: string };
  hooks?: Record<string, unknown>;
  agent?: {
    adapter?: string;
    max_concurrent_agents?: number;
    max_turns?: number;
    max_concurrent_agents_by_state?: Record<string, number>;
    [k: string]: unknown;
  };
  codex?: Record<string, unknown>;
  tools?: { gateway?: boolean; allowed?: string[] };
  approvals?: { require_human_for?: string[] };
  observability?: { r2_logs?: boolean; d1_events?: boolean; analytics_engine?: boolean };
  runtime?: { kind?: string; tenant?: string; profile?: string };
  schema_version?: number;
  [extra: string]: unknown;
};

export type V2NormalizedConfig = {
  schema_version: 2;
  runtime: { kind: string; tenant: string; profile: string };
  tracker: V1WorkflowFrontMatter["tracker"] & { kind: string };
  polling: { mode: string; interval_ms?: number };
  workspace: { isolation: string; image?: string; root?: string };
  agent: {
    adapter: string;
    max_concurrent_agents?: number;
    max_turns?: number;
    max_concurrent_agents_by_state?: Record<string, number>;
  };
  codex?: Record<string, unknown>;
  tools: { gateway: boolean; allowed: string[] };
  approvals: { require_human_for: string[] };
  observability: { r2_logs: boolean; d1_events: boolean; analytics_engine: boolean };
  hooks?: Record<string, unknown>;
};

export type ImportRecord = {
  source_schema_version: 1 | 2;
  imported_schema_version: 2;
  defaults_applied: string[];
  warnings: string[];
  v2: V2NormalizedConfig;
};

function parseSourceSchemaVersion(raw: unknown): 1 | 2 {
  const version = raw ?? 1;
  if (version === 1 || version === 2) return version;
  throw new Error(`unsupported source schema_version: ${String(version)} (expected 1 or 2)`);
}

/**
 * Pure upgrade. Inputs are JSON-parsed objects; output is the v2 normalized
 * config plus the bookkeeping metadata. Does not perform any side effects.
 */
export function upgradeV1ToV2(input: {
  tenant: string;
  profile: string;
  profileYaml: V1ProfileYaml;
  workflowFrontMatter: V1WorkflowFrontMatter;
}): ImportRecord {
  const { tenant, profile, profileYaml, workflowFrontMatter: wfm } = input;
  const defaults_applied: string[] = [];
  const warnings: string[] = [];

  const sourceSchema = parseSourceSchemaVersion(wfm.schema_version ?? profileYaml.schema_version ?? 1);

  // ---- runtime --------------------------------------------------------
  let runtimeKind = wfm.runtime?.kind;
  if (!runtimeKind) {
    runtimeKind = "cloudflare-agent-native";
    defaults_applied.push("runtime.kind");
  }

  // ---- tracker --------------------------------------------------------
  if (!wfm.tracker?.kind) {
    warnings.push("tracker.kind missing in WORKFLOW.md front matter; defaulting to 'linear'");
  }
  const tracker = {
    ...(wfm.tracker ?? {}),
    kind: wfm.tracker?.kind ?? "linear",
  };

  // ---- polling --------------------------------------------------------
  let pollingMode = wfm.polling?.mode;
  if (!pollingMode) {
    pollingMode = "schedule";
    defaults_applied.push("polling.mode");
  }
  const polling = { mode: pollingMode, interval_ms: wfm.polling?.interval_ms };

  // ---- workspace ------------------------------------------------------
  let workspaceIsolation = wfm.workspace?.isolation;
  if (!workspaceIsolation) {
    workspaceIsolation = "container";
    defaults_applied.push("workspace.isolation");
  }
  const workspace = {
    isolation: workspaceIsolation,
    image: wfm.workspace?.image,
    root: wfm.workspace?.root,
  };

  // ---- agent ----------------------------------------------------------
  let agentAdapter = wfm.agent?.adapter;
  if (!agentAdapter) {
    agentAdapter = "codex_compat";
    defaults_applied.push("agent.adapter");
  }
  const agent = {
    adapter: agentAdapter,
    max_concurrent_agents: wfm.agent?.max_concurrent_agents,
    max_turns: wfm.agent?.max_turns,
    max_concurrent_agents_by_state: wfm.agent?.max_concurrent_agents_by_state,
  };

  // ---- tools ----------------------------------------------------------
  let toolsGateway = wfm.tools?.gateway;
  if (toolsGateway === undefined) {
    toolsGateway = true;
    defaults_applied.push("tools.gateway");
  }
  const tools = {
    gateway: toolsGateway,
    allowed: wfm.tools?.allowed ?? [],
  };

  // ---- approvals ------------------------------------------------------
  const approvals = {
    require_human_for: wfm.approvals?.require_human_for ?? [],
  };
  if (!wfm.approvals) defaults_applied.push("approvals.require_human_for");

  // ---- observability --------------------------------------------------
  let r2Logs = wfm.observability?.r2_logs;
  let d1Events = wfm.observability?.d1_events;
  let analyticsEngine = wfm.observability?.analytics_engine;
  if (r2Logs === undefined) {
    r2Logs = true;
    defaults_applied.push("observability.r2_logs");
  }
  if (d1Events === undefined) {
    d1Events = true;
    defaults_applied.push("observability.d1_events");
  }
  if (analyticsEngine === undefined) {
    analyticsEngine = true;
    defaults_applied.push("observability.analytics_engine");
  }
  const observability = {
    r2_logs: r2Logs,
    d1_events: d1Events,
    analytics_engine: analyticsEngine,
  };

  // ---- v1-only signals -> warnings -----------------------------------
  if (profileYaml.symphony?.bypass_guardrails === true) {
    warnings.push("profile.yaml symphony.bypass_guardrails=true; will not transfer to v2 (Cloudflare control plane requires Access)");
  }
  if (profileYaml.preflight) {
    warnings.push("profile.yaml preflight.* is launcher-only; not represented in v2 control-plane config");
  }
  if (wfm.hooks && Object.keys(wfm.hooks).length > 0) {
    warnings.push("WORKFLOW.md hooks are imported for audit only; Cloudflare-native execution requires explicit WorkerHost substitutes");
  }
  if (JSON.stringify(wfm.codex ?? {}).includes("danger")) {
    warnings.push("WORKFLOW.md codex settings include danger/full-access controls; Cloudflare runtime will enforce its own sandbox policy");
  }

  const v2: V2NormalizedConfig = {
    schema_version: 2,
    runtime: { kind: runtimeKind, tenant, profile },
    tracker: tracker as V2NormalizedConfig["tracker"],
    polling,
    workspace,
    agent,
    codex: wfm.codex,
    tools,
    approvals,
    observability,
    hooks: wfm.hooks,
  };

  return {
    source_schema_version: sourceSchema,
    imported_schema_version: 2,
    defaults_applied,
    warnings,
    v2,
  };
}
