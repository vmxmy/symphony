// WORKFLOW.md loader.
// Parses YAML frontmatter + Liquid prompt body, applies SPEC §6 defaults,
// resolves env vars and ~ in paths.
//
// CLI usage (smoke test):
//   bun run src/workflow.ts /abs/path/to/WORKFLOW.md

import { readFileSync, existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import type {
  WorkflowConfig,
  LoadedWorkflow,
  HooksConfig,
  AgentConfig,
  CodexConfig,
} from "./types.js";

const FRONTMATTER_DELIM = /^---\s*$/m;

// ---- defaults (per SPEC §6) ------------------------------------------------

const DEFAULT_POLLING_INTERVAL_MS = 30_000;
const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CONCURRENT_AGENTS = 10;
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_RETRY_BACKOFF_MS = 300_000;
const DEFAULT_TURN_TIMEOUT_MS = 3_600_000;
const DEFAULT_READ_TIMEOUT_MS = 5_000;
const DEFAULT_STALL_TIMEOUT_MS = 300_000;
const DEFAULT_LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_TERMINAL_STATES = [
  "Closed",
  "Cancelled",
  "Canceled",
  "Duplicate",
  "Done",
];
const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"];

const DEFAULT_APPROVAL_POLICY = {
  reject: { sandbox_approval: true, rules: true, mcp_elicitations: true },
};
const DEFAULT_THREAD_SANDBOX = "workspace-write";

// ---- utility ---------------------------------------------------------------

function expandPath(p: string): string {
  if (!p) return p;
  let out = p;
  if (out.startsWith("~")) out = homedir() + out.slice(1);
  // $VAR or ${VAR} expansion
  out = out.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/gi, (_, name) => {
    return process.env[name] ?? `$${name}`;
  });
  return out;
}

function readEnvIndirect(value: unknown, envVar: string): string {
  // For tracker.api_key: if unset or `$LINEAR_API_KEY`, read from env.
  if (typeof value !== "string" || value === "" || value === `$${envVar}`) {
    return process.env[envVar] ?? "";
  }
  return value;
}

function lowerKeyMap<V>(input: unknown): Record<string, V> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, V> = {};
  for (const [k, v] of Object.entries(input as Record<string, V>)) {
    out[String(k).toLowerCase()] = v;
  }
  return out;
}

// ---- main loader -----------------------------------------------------------

export function loadWorkflow(path: string): LoadedWorkflow {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (!existsSync(absolute)) {
    throw new Error(`workflow_not_found: ${absolute}`);
  }
  const raw = readFileSync(absolute, "utf8");

  // Split frontmatter (between the first two --- delimiters)
  const parts = raw.split(FRONTMATTER_DELIM);
  if (parts.length < 3) {
    throw new Error(
      `workflow_no_frontmatter: file ${absolute} must start with YAML frontmatter delimited by '---' lines`,
    );
  }
  // parts[0] is content before first --- (usually empty)
  // parts[1] is the YAML frontmatter
  // parts[2] is the prompt body
  const frontmatterRaw = parts[1] ?? "";
  const body = parts.slice(2).join("---").trimStart();

  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseYaml(frontmatterRaw) ?? {};
  } catch (err) {
    throw new Error(
      `workflow_invalid_yaml: ${(err as Error).message} in ${absolute}`,
    );
  }
  if (typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new Error(`workflow_invalid_yaml: top level must be a map`);
  }

  return {
    config: buildConfig(frontmatter),
    promptTemplate: body,
    rawPath: absolute,
  };
}

function buildConfig(fm: Record<string, unknown>): WorkflowConfig {
  const tracker = (fm.tracker ?? {}) as Record<string, unknown>;
  const polling = (fm.polling ?? {}) as Record<string, unknown>;
  const workspace = (fm.workspace ?? {}) as Record<string, unknown>;
  const hooks = (fm.hooks ?? {}) as Record<string, unknown>;
  const agent = (fm.agent ?? {}) as Record<string, unknown>;
  const codex = (fm.codex ?? {}) as Record<string, unknown>;

  if (tracker.kind !== "linear") {
    throw new Error(
      `workflow_invalid: only tracker.kind: linear is supported (got ${JSON.stringify(tracker.kind)})`,
    );
  }
  if (typeof tracker.project_slug !== "string" || tracker.project_slug === "") {
    throw new Error(`workflow_invalid: tracker.project_slug is required`);
  }

  const trackerCfg: WorkflowConfig["tracker"] = {
    kind: "linear",
    endpoint:
      typeof tracker.endpoint === "string"
        ? tracker.endpoint
        : DEFAULT_LINEAR_ENDPOINT,
    apiKey: readEnvIndirect(tracker.api_key, "LINEAR_API_KEY"),
    projectSlug: tracker.project_slug,
    assignee:
      typeof tracker.assignee === "string" ? tracker.assignee : null,
    activeStates: Array.isArray(tracker.active_states)
      ? (tracker.active_states as string[])
      : DEFAULT_ACTIVE_STATES,
    terminalStates: Array.isArray(tracker.terminal_states)
      ? (tracker.terminal_states as string[])
      : DEFAULT_TERMINAL_STATES,
  };

  const pollingCfg: WorkflowConfig["polling"] = {
    intervalMs:
      typeof polling.interval_ms === "number"
        ? polling.interval_ms
        : DEFAULT_POLLING_INTERVAL_MS,
  };

  const workspaceCfg: WorkflowConfig["workspace"] = {
    root:
      typeof workspace.root === "string"
        ? expandPath(workspace.root)
        : expandPath("$TMPDIR/symphony-workspaces"),
  };

  const hooksCfg: HooksConfig = {
    afterCreate: typeof hooks.after_create === "string" ? hooks.after_create : null,
    beforeRun: typeof hooks.before_run === "string" ? hooks.before_run : null,
    afterRun: typeof hooks.after_run === "string" ? hooks.after_run : null,
    beforeRemove:
      typeof hooks.before_remove === "string" ? hooks.before_remove : null,
    timeoutMs:
      typeof hooks.timeout_ms === "number"
        ? hooks.timeout_ms
        : DEFAULT_HOOK_TIMEOUT_MS,
  };

  const agentCfg: AgentConfig = {
    maxConcurrentAgents:
      typeof agent.max_concurrent_agents === "number"
        ? agent.max_concurrent_agents
        : DEFAULT_MAX_CONCURRENT_AGENTS,
    maxTurns:
      typeof agent.max_turns === "number" ? agent.max_turns : DEFAULT_MAX_TURNS,
    maxRetryBackoffMs:
      typeof agent.max_retry_backoff_ms === "number"
        ? agent.max_retry_backoff_ms
        : DEFAULT_MAX_RETRY_BACKOFF_MS,
    maxConcurrentAgentsByState: lowerKeyMap<number>(
      agent.max_concurrent_agents_by_state,
    ),
  };

  const codexCfg: CodexConfig = {
    command:
      typeof codex.command === "string" ? codex.command : "codex app-server",
    approvalPolicy:
      typeof codex.approval_policy === "string" ||
      (typeof codex.approval_policy === "object" && codex.approval_policy)
        ? (codex.approval_policy as string | Record<string, unknown>)
        : DEFAULT_APPROVAL_POLICY,
    threadSandbox:
      typeof codex.thread_sandbox === "string"
        ? codex.thread_sandbox
        : DEFAULT_THREAD_SANDBOX,
    turnSandboxPolicy:
      typeof codex.turn_sandbox_policy === "string" ||
      (typeof codex.turn_sandbox_policy === "object" &&
        codex.turn_sandbox_policy)
        ? (codex.turn_sandbox_policy as string | Record<string, unknown>)
        : { type: "workspaceWrite" },
    turnTimeoutMs:
      typeof codex.turn_timeout_ms === "number"
        ? codex.turn_timeout_ms
        : DEFAULT_TURN_TIMEOUT_MS,
    readTimeoutMs:
      typeof codex.read_timeout_ms === "number"
        ? codex.read_timeout_ms
        : DEFAULT_READ_TIMEOUT_MS,
    stallTimeoutMs:
      typeof codex.stall_timeout_ms === "number"
        ? codex.stall_timeout_ms
        : DEFAULT_STALL_TIMEOUT_MS,
  };

  const schemaVersion =
    typeof fm.schema_version === "number" ? fm.schema_version : 1;

  return {
    schemaVersion,
    tracker: trackerCfg,
    polling: pollingCfg,
    workspace: workspaceCfg,
    hooks: hooksCfg,
    agent: agentCfg,
    codex: codexCfg,
  };
}

// ---- standalone CLI smoke test --------------------------------------------

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: bun run src/workflow.ts <WORKFLOW.md path>");
    process.exit(1);
  }
  try {
    const loaded = loadWorkflow(path);
    console.log("✓ loaded:", loaded.rawPath);
    console.log("schemaVersion:", loaded.config.schemaVersion);
    console.log(
      "tracker.activeStates:",
      JSON.stringify(loaded.config.tracker.activeStates),
    );
    console.log(
      "tracker.terminalStates:",
      JSON.stringify(loaded.config.tracker.terminalStates),
    );
    console.log("polling.intervalMs:", loaded.config.polling.intervalMs);
    console.log("workspace.root:", loaded.config.workspace.root);
    console.log("agent:", JSON.stringify(loaded.config.agent, null, 2));
    console.log("codex.command:", loaded.config.codex.command);
    console.log("codex.threadSandbox:", loaded.config.codex.threadSandbox);
    console.log("promptTemplate length:", loaded.promptTemplate.length);
    console.log("promptTemplate first 200 chars:");
    console.log(loaded.promptTemplate.slice(0, 200));
  } catch (err) {
    console.error("✗ failed:", (err as Error).message);
    process.exit(1);
  }
}
