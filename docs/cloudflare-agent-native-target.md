# Cloudflare Agent Native Target Architecture

Status: Target document / planning artifact  
Date: 2026-05-01  
Scope: Migrate the current TypeScript-only Symphony architecture toward a Cloudflare Agent native architecture. This document defines the target and migration phases; it does not implement code.

## 1. Executive Summary

Symphony should move from a local long-running Bun daemon that polls Linear and launches `codex app-server` in local workspaces to a Cloudflare-native control plane built around Cloudflare Agents, Workflows, Workers, D1, R2, Queues, Access, and Analytics Engine, plus a pluggable WorkerHost execution plane for isolated coding workspaces.

The target is not "Elixir on Cloudflare" and not "lift the current daemon into one Worker." Elixir is already deprecated and removed from the active architecture. The target is a Cloudflare-native decomposition:

- Cloudflare Agents own durable per-tenant, per-project, and per-issue state.
- Cloudflare Workflows own long-running, retryable execution paths.
- WorkerHost implementations own isolated coding workspaces: VPS Docker for the current dev loop, Cloudflare Containers/Sandbox for managed Cloudflare execution, and local Docker for compatibility debugging.
- D1 stores normalized control-plane records and queryable history.
- R2 stores large artifacts, logs, transcripts, workspace snapshots, and run bundles.
- Queues decouple polling, webhooks, dispatch, execution events, and cleanup.
- Access protects dashboards and operator APIs.
- Analytics Engine stores high-cardinality runtime metrics.
- Linear becomes an optional tracker adapter, not a required core dependency.

The first production cut should keep Codex compatibility by running `codex app-server` inside a WorkerHost. The current development WorkerHost is VPS Docker on `dev@74.48.189.45`; Cloudflare Containers/Sandbox remain the managed Cloudflare execution options. The later native cut can replace Codex process execution with Cloudflare Agents SDK tool orchestration, MCP Agent tools, AI Gateway routing, and Cloudflare-native coding-agent capabilities when those surfaces are mature enough for the required workload.

## 2. Current Baseline

Current dependency direction from `docs/architecture.md`:

```text
PROFILE (workflow bundle) -> LAUNCHER (bridge) -> SYMPHONY TS ENGINE -> CODEX
```

Current active implementation:

| Area | Current file(s) | Current responsibility |
|---|---|---|
| CLI entry/composition | `ts-engine/src/main.ts`, `bin/symphony`, `bin/symphony-launch` | Load `WORKFLOW.md`, configure Linear/workspace/state/prompt/agent, start server and orchestrator |
| Workflow/profile config | `ts-engine/src/workflow.ts`, `docs/profile-spec.md`, `profiles/<name>/` | YAML front matter, Liquid prompt body, profile env, skills, `CODEX_HOME`, runtime dirs |
| Tracker | `ts-engine/src/linear.ts` | Linear GraphQL polling and issue normalization |
| Orchestration | `ts-engine/src/orchestrator.ts`, `ts-engine/src/state.ts` | Poll loop, dispatch, retries, reconciliation, concurrency |
| Issue execution | `ts-engine/src/agent.ts` | Per-issue workspace setup, prompt turn loop, state polling, token accounting |
| Agent adapter | `ts-engine/src/agent/codex_adapter.ts` | `codex app-server` JSON-RPC over stdio |
| Dynamic tools | `ts-engine/src/dynamic_tool.ts` | Inject `linear_graphql` into agent turns |
| Workspace | `ts-engine/src/workspace.ts` | Local filesystem workspace and lifecycle hooks |
| Dashboard/API | `ts-engine/src/server.ts`, `ts-engine/src/dashboard/*` | Bun HTTP routes, state snapshot, HTML dashboard |
| Logs/runtime | profile `runtime/`, configured logs root | Process logs, session state, runtime artifacts |

Current hard constraints to preserve:

1. Every active issue has an isolated workspace.
2. Agents run with the issue workspace as `cwd`.
3. Concurrency is bounded globally and optionally by issue state.
4. Retry, backoff, reconciliation, terminal cleanup, and pause semantics are explicit.
5. Prompts are rendered from the profile-owned `WORKFLOW.md` body.
6. Profile-specific skills and credentials are isolated from other profiles.
7. Operator observability is available while runs are active.

## 3. Target Principles

This is the RALPLAN-DR planning baseline.

1. Cloudflare-native core: orchestration state, schedules, durable steps, storage, dashboard, and auth should live on Cloudflare services.
2. Adapter boundaries over product lock-in: Linear, Codex, GitHub, MCP, and future trackers/tools must be replaceable behind stable interfaces.
3. Durable issue ownership: a single issue/run must have one authoritative Cloudflare Agent owner to avoid duplicate dispatch and split-brain retries.
4. Execution isolation first: untrusted code, shell hooks, repo checkouts, tests, and generated artifacts must run in a WorkerHost adapter, never directly in a control-plane Worker.
5. Observable and replayable by default: every decision, tool call, workflow step, token event, artifact pointer, and state transition must be persisted or reconstructable.

## 4. Decision Drivers

Top drivers, in order:

1. Remove local daemon/process fragility while retaining long-running automation semantics.
2. Support 100% Cloudflare-managed deployment for control plane, state, execution routing, dashboard, and artifacts.
3. Keep migration incremental so the existing TypeScript engine/profile contracts can run during the transition.

## 5. Options Considered

| Option | Summary | Pros | Cons | Verdict |
|---|---|---|---|---|
| A. Lift current Bun engine into one Worker/Container | Package the daemon as-is and run it on Cloudflare | Fastest compatibility path; minimal rewrite | Preserves monolith, local process assumptions, weak native state model; still couples orchestration to process lifetime | Reject as final target; useful only as temporary escape hatch |
| B. Cloudflare-native Agents + Workflows + pluggable WorkerHosts | Decompose orchestration into Agents, durable steps into Workflows, execution into isolated workspace adapters | Best fit for durable orchestration, state ownership, scale-out, observability, and Cloudflare-native operations while allowing VPS Docker for cost-sensitive execution | More design work; requires adapters and migration phases | Chosen target |
| C. Keep Linear/Codex as permanent required core | Move hosting to Cloudflare but retain external tracker and Codex process as mandatory | Lowest behavior risk; current user workflow preserved | Not 100% Cloudflare native; Linear remains a hard dependency; Cloudflare Agents underused | Reject as final target; keep as compatibility mode |
| D. Build only a Cloudflare-native task tracker and drop Linear immediately | D1/Agents own all issues, no external tracker compatibility | Cleanest Cloudflare-only core | High cutover risk; loses current Linear workflow and live issue metadata | Defer until after adapter parity |

Chosen path: Option B, with compatibility bridges for Linear and Codex during early phases.

## 6. Target Architecture Overview

```text
                        +------------------------------+
                        | Cloudflare Access / Zero Trust|
                        +---------------+--------------+
                                        |
                                        v
+------------------+       +----------------------------+       +-------------------+
| Pages/Worker UI  +------>+ Control API Worker         +------>+ TenantAgent       |
| dashboard        | WS/RPC| routeAgentRequest / REST   |       | account boundary  |
+------------------+       +-------------+--------------+       +---------+---------+
                                          |                                |
                                          v                                v
                                +---------+----------+          +----------+---------+
                                | ProjectAgent       | schedule | Profile Registry   |
                                | poll/reconcile     +--------->+ D1 + R2 metadata   |
                                +----+---------+-----+          +----------+---------+
                                     |         |                           |
                      webhook/tick   |         | dispatch                  |
                                     v         v                           v
                              +------+---------+------+            +--------+---------+
                              | Queue: dispatch/events |<----------+ Tracker adapters |
                              +------+---------+------+            | Linear / D1 native|
                                     |                              +------------------+
                                     v
                              +------+---------+
                              | IssueAgent     |
                              | one per issue  |
                              +------+---------+
                                     |
                                     | runWorkflow
                                     v
+------------------+        +--------+----------------+        +----------------------+
| ToolGatewayAgent |<------>+ ExecutionWorkflow       +------->+ WorkerHost adapter   |
| MCP/tools/audit  |        | durable issue run steps |        | workspace + commands |
+------------------+        +--------+----------------+        +----------+-----------+
                                     |                                      |
                                     v                                      v
                              +------+---------+                  +---------+----------+
                              | D1 run/event   |                  | R2 artifacts/logs  |
                              | records        |                  | snapshots/bundles  |
                              +----------------+                  +--------------------+
```

### Control Plane

The control plane is Workers + Agents:

- Control API Worker exposes dashboard/API routes and routes WebSocket/RPC calls to Agents.
- TenantAgent owns account-level quotas, secrets references, policy defaults, and profile registry pointers.
- ProjectAgent owns one profile/project workflow: polling schedule, tracker adapter, queue dispatch, global concurrency, reconciliation, and cleanup policy.
- IssueAgent owns one issue state machine: run status, active workflow instance, retry state, cancellation, pause/resume, turn count, artifact pointers, and terminal cleanup.

### Data Plane

The data plane is Workflows + WorkerHosts:

- ExecutionWorkflow is a durable multi-step workflow per issue run or continuation attempt.
- A WorkerHost adapter provides isolated filesystem/process execution for repo checkout, hooks, tests, `codex app-server`, and generated artifacts.
- ToolGatewayAgent mediates external tools and MCP calls, enforces allowlists, writes audit logs, and hides raw secrets from coding agents.

### WorkerHost Abstraction

WorkerHost is the execution-plane contract behind `WorkspaceAdapter`. It is deliberately outside the Cloudflare Agent state model: Agents and Workflows decide what should happen, while WorkerHosts provide the isolated Linux workspace where shell commands and coding agents actually run.

```ts
type WorkerHostKind =
  | "vps_docker"
  | "cloudflare_container"
  | "cloudflare_sandbox"
  | "local_docker";

interface WorkerHost {
  kind: WorkerHostKind;
  prepare(input: PrepareWorkspaceInput): Promise<WorkspaceRef>;
  runCommand(input: RunCommandInput): Promise<CommandResult>;
  runCodexTurn(input: CodexTurnInput): Promise<CodexTurnResult>;
  snapshot(input: SnapshotInput): Promise<ArtifactRef>;
  cleanup(input: CleanupInput): Promise<void>;
}
```

Current adapter decisions:

- `VpsDockerWorkspace`: current development default on `dev@74.48.189.45`; validated with Codex `@openai/codex@0.128.0`, local third-party provider config, JSON-RPC streaming, and file writes.
- `CloudflareContainerWorkspace`: hosted Cloudflare default when the execution plane must also be Cloudflare-managed.
- `CloudflareSandboxWorkspace`: opt-in after parity testing proves persistent sessions, command-heavy agent loops, and artifact capture meet the runtime contract.
- `LocalDockerWorkspace`: local compatibility/debug adapter, not the production default.

#### Layering: WorkspaceAdapter and WorkerHost

`WorkspaceAdapter` and `WorkerHost` are deliberately two layers, not two names for the same thing. Phase 1 already shipped `WorkspaceAdapter`; Phase 6 introduces `WorkerHost` underneath.

| Layer | Phase | Contract | Owns |
|---|---|---|---|
| `WorkspaceAdapter` | Phase 1 (shipped) | `ts-engine/src/contracts/workspace.ts` — `ensure(issue)`, `pathFor(issue)`, `remove(issue)`, `runHook(name, ref)` | Per-issue workspace lifecycle, `WorkflowConfig.hooks` execution, identifier-to-path mapping |
| `WorkerHost` | Phase 6 (upcoming) | `WorkerHost` interface in this section — `prepare`, `runCommand`, `runCodexTurn`, `snapshot`, `cleanup` | Substrate-level isolated execution: which Linux box hosts the workspace, how shell commands and Codex are spawned, how snapshots reach R2 |

Phase 6 wiring rule:

- The current `WorkspaceManager` (`ts-engine/src/workspace.ts`) is replaced by `WorkerHostBackedWorkspaceManager(host: WorkerHost)`. The new class still implements `WorkspaceAdapter`; control-plane callers (`Orchestrator`, `AgentRunner`) do not change.
- `WorkerHostBackedWorkspaceManager.runHook(name, ref)` resolves the hook command from `WorkflowConfig.hooks` and forwards a `runCommand` call to `host.runCommand`. `runHook` does not become public-tool surface; it remains the profile's hook contract.
- `host.runCodexTurn` is invoked by the future Codex compatibility adapter (Phase 7), not by hooks. `WorkspaceAdapter` callers never reach `runCodexTurn` directly.
- `host.snapshot` is invoked by `ExecutionWorkflow` cleanup steps, not by `WorkspaceAdapter`. Snapshot-on-failure is workflow policy, not workspace API.
- `WorkerHost.kind` selects the substrate per profile (`vps_docker`, `cloudflare_container`, `cloudflare_sandbox`, `local_docker`). Substrate choice never leaks into `WorkspaceAdapter` callers.

Phase 1 callers therefore stay forward-compatible without code changes; Phase 6 simply provides a different concrete implementation behind the same contract.

### Storage Plane

- Agent state: authoritative hot state for TenantAgent, ProjectAgent, and IssueAgent.
- D1: queryable relational records for profiles, issues, runs, steps, tool calls, events, and operator actions.
- R2: large immutable artifacts: JSONL logs, Codex transcripts, workspace snapshots, generated images, run bundles, hook output, and exported reports.
- Queues: async dispatch/events/cleanup transport; never the source of truth.
- Analytics Engine: metrics and high-cardinality observability events.

### 6.1 Platform Limits Baseline And Phase 2 Gate

These limits are pinned from Cloudflare docs as of 2026-05-01 and must be re-verified during Phase 0 before Phase 2 starts. If the account plan, beta access, or product documentation changes, the Phase 0 limits register becomes authoritative for implementation.

The current Phase 0 limits register is `docs/cloudflare-platform-limits.md`.

Default execution-substrate decision for planning:

- Current development default: `VpsDockerWorkspace` on `dev@74.48.189.45`, because the spike proved Codex app-server can use the same local third-party provider config, write files, and stream JSON-RPC events while avoiding Cloudflare Container runtime cost.
- Hosted Cloudflare default: `CloudflareContainerWorkspace`, because Codex compatibility needs a full Linux process environment, dependency installs, background process management, and predictable workspace semantics.
- Sandbox SDK: allowed as an opt-in execution adapter only after the Phase 0 spike proves Codex app-server, file operations, long-running process handling, and log/artifact capture work with acceptable limits.
- Worker/control-plane code must treat VPS Docker, Cloudflare Containers, Cloudflare Sandbox, and Local Docker as different WorkspaceAdapter implementations, not as a behavior-free runtime flag.

Pinned platform constraints:

| Product | Current relevant limit | Design implication |
|---|---|---|
| Workers | Paid plan CPU can be configured up to 5 minutes; memory per isolate is 128 MB; default paid subrequest limit is 10,000/request and configurable higher | Control-plane Workers must stay light; large payloads and logs go to R2; high-frequency Sandbox SDK calls should use WebSocket transport or split steps |
| Workflows | Paid plan CPU per step defaults to 30 seconds and can be configured to 5 minutes; wall clock per step is unlimited; max steps default is 10,000 and configurable to 25,000; non-stream step result is 1 MiB; persisted instance state is 1 GB; completed state retention is 30 days | ExecutionWorkflow must stream or externalize large outputs to R2, keep step results small, and count each turn-loop operation against the step budget |
| Durable Objects / Agents | SQLite-backed DOs have unlimited object count within an account/class, up to 10 GB per object, 32 MiB received WebSocket messages, and CPU per request defaults to 30 seconds/configurable to 5 minutes | IssueAgent can be one DO-backed agent per issue, but archived IssueAgents need retention/compaction policy and large logs must not live in Agent state |
| D1 | Paid plan allows 50,000 databases/account, 10 GB/database, 1 TB/account storage, 30 second maximum SQL query duration, 100 columns/table, 100 KB SQL statement length, and 100 bound parameters/query | Keep D1 rows narrow, index hot queries, shard by tenant/profile if needed, and keep large payloads in R2 with D1 pointers |
| R2 | Object keys are limited to 1,024 bytes; object size is up to 5 TiB; single-part upload is up to 5 GiB; multipart upload is up to 4.995 TiB; concurrent writes to the same key are limited to 1 per second | Use deterministic run/artifact keys, avoid hot same-key appends, write event streams as segmented JSONL objects, and use manifests for aggregation |
| Queues | Message size is 128 KB; max consumer batch size is 100; max sendBatch is 100 messages or 256 KB total; per-queue throughput is 5,000 messages/second; consumer wall clock is 15 minutes; message retention configurable up to 14 days | Queue messages carry ids/pointers, not payloads; consumers invoke Agents/Workflows rather than doing long work inline |
| Containers | Predefined instance types range from lite to standard-4; custom instance types can use up to 4 vCPU, 12 GiB memory, and 20 GB disk; account-level paid limits include 6 TiB live container memory, 1,500 vCPU, and 30 TB disk | Codex compatibility image should start with standard-1/standard-2 sizing, then benchmark; workspace snapshots must fit disk budget or stream to R2 |
| Sandbox SDK | Built on Containers; SDK operations from Workers/DOs count as subrequests unless WebSocket transport is enabled | Sandbox implementation must use WebSocket transport for command-heavy agent loops or split operations across Workflow steps |

Required Phase 0 outputs before Phase 2 code:

1. `docs/cloudflare-platform-limits.md` with the account plan, enabled products, exact limits, requested limit increases, and source URLs.
2. A selected default workspace substrate for Phase 6/7: `vps_docker`, `cloudflare_container`, `cloudflare_sandbox`, or `dual`, with evidence from a Codex app-server spike.
3. A workflow budget calculation for one representative issue run: expected steps, subrequests, R2 writes, D1 rows, queue messages, and container minutes.
4. A fallback/rollback rule if the selected substrate cannot run Codex app-server reliably.

## 7. Component Mapping

| Current component | Target Cloudflare-native component | Notes |
|---|---|---|
| `bin/symphony-launch` | Control API Worker + Access-protected operator actions | Local launcher becomes dev-only compatibility adapter |
| `profiles/<name>/profile.yaml` | Profile registry record in D1 + canonical source bundle in R2/Git | Profile can still be exported/imported as files |
| `profiles/<name>/WORKFLOW.md` | Workflow bundle artifact + parsed D1 metadata | Prompt body remains portable; config schema evolves with target bindings |
| `profiles/<name>/env` | Worker secrets / Secrets Store references | Never store raw secrets in D1/R2 |
| `profiles/<name>/skills/` | R2 skill bundle + mounted/synced Sandbox workspace assets | Profile-specific overrides remain supported |
| `codex-home/` | Compatibility runtime bundle in R2 + Sandbox/Container materialization | Required only while Codex process compatibility remains |
| `ts-engine/src/workflow.ts` | Profile Parser library used by Worker/Workflow | Refactor as pure TS package, no local filesystem assumptions |
| `ts-engine/src/orchestrator.ts` | ProjectAgent + Queues + scheduled tasks | Poll/reconcile logic becomes durable and idempotent |
| `ts-engine/src/state.ts` | IssueAgent state + D1 run state | Hot state in Agent; history in D1 |
| `ts-engine/src/agent.ts` | ExecutionWorkflow + IssueAgent run state machine | Durable steps replace in-process loop |
| `ts-engine/src/agent/codex_adapter.ts` | Phase 1: Codex process in a WorkerHost; Phase 2: native CodingAgent adapter | Keep an `AgentAdapter` interface |
| `ts-engine/src/workspace.ts` | WorkerHost-backed workspace manager | Hooks run in isolated execution, not Worker process |
| `ts-engine/src/linear.ts` | TrackerAdapter: Linear bridge + D1-native tracker | Linear optional, not mandatory |
| `ts-engine/src/dynamic_tool.ts` | ToolGatewayAgent / McpAgent | All tool calls audited and policy-gated |
| `ts-engine/src/server.ts` | Worker API + Pages/Worker dashboard | Read state through Agents/D1, stream events over WebSocket |
| local logs | R2 JSONL + D1 event index + Analytics Engine | R2 for raw logs, D1 for query, Analytics for metrics |

## 8. Agent Model

### 8.1 TenantAgent

Identity: `tenant:{account_or_org_id}`

Responsibilities:

- Own tenant-level policy: max concurrent projects, max concurrent issue agents, budgets, allowed tools, allowed trackers.
- Resolve profile registry entries.
- Hold references to secret bindings and access policy names, never raw secret values.
- Aggregate project health and enforce emergency stop.

Persistent state shape:

```ts
type TenantState = {
  tenantId: string;
  status: "active" | "paused" | "suspended";
  policy: {
    maxProjects: number;
    maxRunningIssues: number;
    requireHumanApprovalFor: string[];
    allowedTrackerKinds: string[];
    allowedToolNames: string[];
  };
  projectIds: string[];
  updatedAt: string;
};
```

### 8.2 ProjectAgent

Identity: `project:{tenant_id}:{profile_slug}`

Responsibilities:

- Load profile configuration and workflow prompt template.
- Own polling schedule or receive tracker webhooks.
- Reconcile active, paused, terminal, retrying, and orphaned issues.
- Enforce global and per-state concurrency.
- Enqueue dispatch events for IssueAgents.
- Own profile-level pause/resume and draining.

Important methods:

```ts
pollTracker(): Promise<void>
reconcile(): Promise<void>
dispatchIssue(issueRef: IssueRef): Promise<void>
setProjectStatus(status: "active" | "paused" | "draining"): Promise<void>
refreshProfile(): Promise<void>
```

### 8.3 IssueAgent

Identity: `issue:{tenant_id}:{profile_slug}:{issue_id}`

Responsibilities:

- Be the single owner of issue execution state.
- Start/continue/cancel/retry an ExecutionWorkflow.
- Store current state, attempt number, turn count, active workflow ID, cancellation token, and artifact pointers.
- Guard against duplicate dispatch by rejecting starts when an active workflow exists.
- Apply state transitions after tracker changes or workflow events.

State machine:

```text
discovered
  -> queued
  -> preparing_workspace
  -> running_agent
  -> validating
  -> publishing_results
  -> completed
  -> cleanup_pending
  -> archived

Any non-terminal execution state -> paused | cancelling | retry_wait | failed
failed -> retry_wait -> queued
paused -> queued | archived
```

### 8.4 ExecutionWorkflow

Identity: `run:{tenant_id}:{profile_slug}:{issue_id}:{attempt}`

Responsibilities:

- Execute deterministic, resumable steps.
- Persist step outputs and artifact pointers.
- Retry transient failures with policy-specific backoff.
- Emit events to D1, R2, Queues, and Analytics Engine.
- Notify IssueAgent after each major state transition.

Canonical steps:

1. Load profile and issue snapshot.
2. Acquire issue execution lease from IssueAgent.
3. Prepare isolated workspace.
4. Materialize repo, skills, `WORKFLOW.md`, and compatibility runtime assets.
5. Run `after_create` hook if workspace is new.
6. Render prompt with issue context and attempt number.
7. Run `before_run` hook.
8. Execute agent turn loop.
9. Handle tool calls through ToolGatewayAgent.
10. Poll tracker or native issue state between turns.
11. Persist token usage, logs, transcripts, and artifacts.
12. Run `after_run` hook.
13. Validate completion criteria.
14. Transition tracker/native issue state.
15. Snapshot/archive workspace or schedule cleanup.
16. Release lease and notify ProjectAgent.

### 8.5 CodingAgent Adapter

The target keeps an adapter boundary so execution strategy can evolve.

```ts
interface CodingAgentAdapter {
  startSession(input: StartSessionInput): Promise<SessionRef>;
  runTurn(input: TurnInput): Promise<TurnResult>;
  stop(input: StopInput): Promise<void>;
}
```

Compatibility adapter:

- Starts `codex app-server` inside a WorkerHost adapter.
- Uses the existing JSON-RPC semantics from `CodexAdapter`.
- Mounts/materializes `CODEX_HOME`, profile skills, auth, config, and workspace assets.
- Captures stdout/stderr and JSON-RPC events into R2 JSONL.

Native adapter:

- Uses Cloudflare Agents SDK, MCP tools, AI Gateway, and Cloudflare-native model/tool orchestration.
- Keeps the same `CodingAgentAdapter` interface so IssueAgent and ExecutionWorkflow do not care which coding engine is selected.
- Replaces process-level stdio with callable methods, WebSocket streaming, and audited tool execution.

### 8.6 ToolGatewayAgent / McpAgent

Responsibilities:

- Expose typed tools to CodingAgent: tracker, GitHub, artifacts, approvals, profile metadata, web research, and publishing tools.
- Enforce tool allowlists from TenantAgent/ProjectAgent policy.
- Resolve secrets server-side; never send raw secret values to coding agent prompts.
- Persist every tool call and result pointer to D1/R2.
- Support human-in-the-loop approval for dangerous tools.

The current `linear_graphql` dynamic tool becomes one tool implementation under this gateway.

### 8.7 OperatorAgent

Optional but useful for human operations:

- Exposes pause/resume/cancel/retry/drain controls.
- Streams live issue state to dashboard clients.
- Records operator action audit events.
- Can summarize failing runs and recommend remediation.

## 9. Tracker Model: Is Linear Required?

No. Linear is not required in the target architecture.

Target rule:

- Tracker is an adapter boundary.
- Cloudflare-native task state in D1 + IssueAgent state is the core source of truth for 100% Cloudflare deployments.
- Linear is an optional external adapter for teams that still want Linear as their human-facing issue tracker.

Two supported modes:

| Mode | Source of truth | Use when |
|---|---|---|
| Linear compatibility mode | Linear issue state + mirrored D1 records | During migration or when humans continue using Linear boards |
| Cloudflare-native mode | D1 `issues` + IssueAgent state | For strict Cloudflare-native operation with no required Linear dependency |

Adapter contract:

```ts
interface TrackerAdapter {
  listActiveIssues(project: ProjectRef): Promise<IssueSnapshot[]>;
  listTerminalIssues(project: ProjectRef): Promise<IssueSnapshot[]>;
  getIssuesByIds(ids: string[]): Promise<IssueSnapshot[]>;
  transitionIssue(input: TransitionInput): Promise<IssueSnapshot>;
  appendComment(input: CommentInput): Promise<void>;
  rawTool?(call: ToolCall): Promise<ToolResult>;
}
```

Migration implication:

- Phase 1 keeps Linear behavior exactly compatible.
- Phase 2 mirrors Linear issues into D1 and makes IssueAgent state authoritative for execution leases.
- Phase 3 allows profiles to set `tracker.kind: cloudflare` and run without Linear.
- Phase 4 can remove Linear from required environment variables and make it a plugin.

## 10. Profile and Configuration Model

Current profiles are file bundles. Target profiles are Cloudflare-managed bundles that remain exportable as files.

### Target profile sources

- `profile.yaml`: profile metadata, owner, policy, tracker mode, deployment bindings.
- `WORKFLOW.md`: prompt template plus operational config.
- `skills/`: profile-specific skills and tool definitions.
- `runtime policy`: tool allowlist, approval rules, sandbox/container image, network policy, budget limits.
- `secret references`: names of Worker secrets / Secrets Store entries, not values.

### Target storage layout

D1:

- profile metadata and parsed operational config.
- active version pointer.
- deployment status.
- compatibility schema version.

R2:

```text
r2://symphony-profiles/{tenant}/{profile}/versions/{version}/profile.yaml
r2://symphony-profiles/{tenant}/{profile}/versions/{version}/WORKFLOW.md
r2://symphony-profiles/{tenant}/{profile}/versions/{version}/skills/{skill}/...
r2://symphony-profiles/{tenant}/{profile}/versions/{version}/bundle.tar.zst
```

Workers secrets / Secrets Store:

```text
SYMPHONY_{TENANT}_{PROFILE}_LINEAR_API_KEY
SYMPHONY_{TENANT}_{PROFILE}_GITHUB_TOKEN
SYMPHONY_{TENANT}_{PROFILE}_CODEX_AUTH_REF
SYMPHONY_{TENANT}_{PROFILE}_PUBLISHING_SECRET
```

### Target config example

```yaml
schema_version: 2
runtime:
  kind: cloudflare-agent-native
  tenant: personal
  profile: content-wechat
tracker:
  kind: cloudflare # or linear
  bridge:
    linear:
      enabled: false
polling:
  mode: schedule # schedule | webhook | manual
  interval_ms: 8000
workspace:
  isolation: sandbox # sandbox | container
  image: symphony-codex-compat:2026-05-01
  snapshot_policy: on_failure
agent:
  adapter: codex_compat # codex_compat | cloudflare_native
  max_concurrent_agents: 2
  max_turns: 25
  max_concurrent_agents_by_state:
    publishing: 1
tools:
  gateway: true
  allowed:
    - tracker.transition
    - tracker.comment
    - github.pull_request
    - artifacts.write
approvals:
  require_human_for:
    - destructive_shell
    - production_publish
    - secret_read
observability:
  r2_logs: true
  d1_events: true
  analytics_engine: true
```

### 10.1 Profile Schema Migration Policy: v1 To v2

Current repository profiles are v1 file bundles as documented in `docs/profile-spec.md`. Phase 1 must not change that runtime contract. Cloudflare import in Phase 2 introduces a v2 internal profile record, but v1 remains accepted at import time.

Migration rules:

| Topic | Policy |
|---|---|
| v1 acceptance | v1 profiles remain valid for local runtime and Cloudflare import through the first production Cloudflare cutover |
| Import behavior | Phase 2 importer auto-upgrades v1 file bundles into D1 v2 records and stores the original v1 bundle unchanged in R2 |
| Source of new fields | Cloudflare-only runtime fields live in `profile.yaml` v2 metadata or D1 imported config; `WORKFLOW.md` prompt body stays portable |
| Required defaults | Missing v2 runtime defaults to `runtime.kind: cloudflare-agent-native`, `agent.adapter: codex_compat`, `workspace.isolation: container`, `polling.mode: schedule`, `tools.gateway: true`, and `observability.r2_logs/d1_events: true` |
| Explicit migration | A future `symphony profile migrate --to v2 <profile>` command should write v2 files locally only when the operator requests it |
| Deprecation window | Do not reject v1 profiles until at least one production profile has run on Cloudflare and rollback has been tested |
| Validation | Phase 2 must add a profile validator that reports missing secrets, unsupported hooks, unavailable skills, incompatible runtime options, and fields that were defaulted during import |

Import metadata to persist in D1:

```ts
type ProfileImportRecord = {
  sourceSchemaVersion: 1 | 2;
  importedSchemaVersion: 2;
  sourceBundleRef: string;
  normalizedConfigRef: string;
  defaultsApplied: string[];
  warnings: string[];
  importedAt: string;
};
```

Phase 2 is blocked until the importer can perform a dry-run validation of `profiles/<name>/profile.yaml` and `WORKFLOW.md` without requiring Cloudflare execution.

## 11. Data Model

D1 is not the only source of truth; Agent state owns live leases. D1 is the queryable durable control-plane index.

### Core D1 tables

```sql
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  active_version TEXT NOT NULL,
  tracker_kind TEXT NOT NULL,
  runtime_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, slug)
);

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  external_id TEXT,
  identifier TEXT NOT NULL,
  title TEXT,
  state TEXT NOT NULL,
  priority INTEGER,
  url TEXT,
  snapshot_json TEXT NOT NULL,
  archived_at TEXT,
  purge_after TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (profile_id, identifier)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  workflow_id TEXT,
  adapter_kind TEXT NOT NULL,
  workspace_ref TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  token_usage_json TEXT,
  artifact_manifest_ref TEXT,
  retention_class TEXT NOT NULL DEFAULT 'standard',
  purge_after TEXT,
  UNIQUE (issue_id, attempt)
);

CREATE TABLE run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  input_ref TEXT,
  output_ref TEXT,
  error TEXT
);

CREATE TABLE run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  issue_id TEXT,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT,
  payload_ref TEXT,
  retention_class TEXT NOT NULL DEFAULT 'standard',
  archive_ref TEXT,
  purge_after TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  turn_number INTEGER,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  input_ref TEXT NOT NULL,
  output_ref TEXT,
  approval_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  issue_id TEXT,
  run_id TEXT,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_by TEXT,
  decided_by TEXT,
  request_ref TEXT NOT NULL,
  decision_ref TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE idempotency_records (
  key TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  issue_id TEXT,
  run_id TEXT,
  tool_call_id TEXT,
  operation_type TEXT NOT NULL,
  operation_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  external_ref TEXT,
  result_ref TEXT,
  first_seen_at TEXT NOT NULL,
  completed_at TEXT,
  expires_at TEXT
);
```

Required indexes for Phase 2 migrations:

```sql
CREATE INDEX idx_profiles_tenant_slug ON profiles (tenant_id, slug);
CREATE INDEX idx_issues_profile_state ON issues (profile_id, state);
CREATE INDEX idx_issues_profile_identifier ON issues (profile_id, identifier);
CREATE INDEX idx_runs_issue_status ON runs (issue_id, status);
CREATE INDEX idx_run_steps_run_step ON run_steps (run_id, step_name);
CREATE INDEX idx_run_events_run_created ON run_events (run_id, created_at);
CREATE INDEX idx_tool_calls_run_status ON tool_calls (run_id, status);
CREATE INDEX idx_approvals_status_created ON approvals (status, created_at);
CREATE INDEX idx_idempotency_records_run ON idempotency_records (run_id, operation_type);
```

Schema retention/archival rules:

| Record | Retention fields | Rule |
|---|---|---|
| `issues` | `archived_at`, `purge_after` | Terminal/native issues can be archived while keeping identifier and final snapshot queryable until `purge_after` |
| `runs` | `retention_class`, `purge_after`, `artifact_manifest_ref` | Run rows stay queryable after raw artifacts move to R2 lifecycle storage; purge only after manifest retention expires |
| `run_events` | `retention_class`, `archive_ref`, `purge_after` | Hot event rows may be compacted to R2 JSONL and replaced by `archive_ref` before purge |
| `tool_calls` | `output_ref`, `approval_id` | Large inputs/outputs stay in R2; D1 keeps only pointers and status |
| `idempotency_records` | `expires_at`, `result_ref` | Records for external side effects must outlive Workflow replay and rollback windows |
| `approvals` | `request_ref`, `decision_ref` | Approval payloads remain audit records even after run event compaction |

The minimum Phase 2 migration must include `idx_issues_profile_state`, `idx_runs_issue_status`, and `idx_run_events_run_created`; without these indexes dashboard state, retry inspection, and run timeline queries are not acceptable.

### R2 artifact layout

```text
r2://symphony-runs/{tenant}/{profile}/{issue}/{run}/manifest.json
r2://symphony-runs/{tenant}/{profile}/{issue}/{run}/events.jsonl
r2://symphony-runs/{tenant}/{profile}/{issue}/{run}/codex/session.jsonl
r2://symphony-runs/{tenant}/{profile}/{issue}/{run}/hooks/{hook}.stdout.txt
r2://symphony-runs/{tenant}/{profile}/{issue}/{run}/hooks/{hook}.stderr.txt
r2://symphony-runs/{tenant}/{profile}/{issue}/{run}/workspace/snapshot.tar.zst
r2://symphony-runs/{tenant}/{profile}/{issue}/{run}/artifacts/{name}
r2://symphony-runs/{tenant}/{profile}/{issue}/{run}/tool-calls/{tool_call_id}.json
```

### Queue topics

| Queue | Producer | Consumer | Purpose |
|---|---|---|---|
| `symphony-tracker-events` | Webhooks, ProjectAgent schedules | ProjectAgent | Normalize external tracker changes |
| `symphony-dispatch` | ProjectAgent | IssueAgent / dispatch Worker | Start or continue issue execution |
| `symphony-run-events` | ExecutionWorkflow, ToolGatewayAgent | Event persistence Worker | Persist event stream and dashboard updates |
| `symphony-cleanup` | IssueAgent, ProjectAgent | Cleanup Workflow | Archive/delete workspaces and stale artifacts |
| `symphony-operator-actions` | Dashboard/API | OperatorAgent | Pause/resume/cancel/retry/drain actions |

Queue consumer rule: Cloudflare Queue consumers are Workers. Queue messages should be handled by a queue-consumer Worker that validates the message, loads the relevant Agent stub, invokes ProjectAgent/IssueAgent/OperatorAgent, and returns quickly. Agents are the decision owners, not direct queue consumers.

## 12. Execution Model

### Lease and heartbeat contract

IssueAgent is the lease authority. ExecutionWorkflow must acquire a lease before doing work. Do not move this lease into D1; D1 records history and query state, while IssueAgent prevents duplicate active writers.

Lease rules:

- `startRun` succeeds only if no active `workflow_id` exists for the issue.
- Lease identity is `lease:{issue_id}:{run_id}:{attempt}:{workflow_instance_id}`.
- Each workflow step writes a heartbeat to IssueAgent with `run_id`, `step_name`, `step_sequence`, `last_event_id`, and `heartbeat_at`.
- ProjectAgent reconciliation may mark a lease stale only after `heartbeat_at + stale_after_ms` and only if the Workflow status check cannot prove the instance is still running.
- A stale lease transitions to `stale_pending_review` before retry if the last step may have executed an external side effect.
- Duplicate dispatch events are safe because IssueAgent rejects a second active run.
- Cancellation is cooperative: IssueAgent records `cancel_requested_at`; ExecutionWorkflow checks before each step and ToolGateway checks before external side effects.
- Paused issues may transition to `cancelling`; operators must be able to cancel paused or waiting runs.

### Turn loop translation

Current in-process loop:

```text
ensure workspace -> before_run -> start Codex -> run turn -> poll Linear -> continue/finish -> after_run
```

Target durable loop:

```text
Workflow step prepareWorkspace
Workflow step beforeRunHook
Workflow step startOrResumeCodingSession
repeat until max_turns or issue leaves active state:
  Workflow step renderPrompt
  Workflow step runAgentTurn
  Workflow step persistTurnEvents
  Workflow step refreshIssueState
  Workflow step decideContinuation
Workflow step afterRunHook
Workflow step finalizeRun
```

Each repeat iteration must be resumable and must write enough state to avoid replaying destructive side effects without idempotency keys.

### WorkerHost substrate policy

| Execution type | Preferred target | Reason |
|---|---|---|
| Current dev Codex execution | VPS Docker WorkerHost on `dev@74.48.189.45` | Lowest cost, fastest debug loop, and already validated with local third-party provider config |
| Short shell hooks, file transforms, package-less tools | Sandbox SDK | Lower operational overhead if account capability is available |
| Hosted repo checkout, dependency install, tests, Codex process, long-lived sessions | Cloudflare Containers or Sandbox with persistent session support | Stronger compatibility with current local workspace assumptions when execution must be Cloudflare-managed |
| Publishing tools needing fixed network/IP or browser/UI automation | Container with explicit network policy or external worker adapter | Avoid leaking this into the control plane |
| Native Cloudflare tool-only agent | Agents SDK + ToolGatewayAgent | No process workspace needed unless code execution is requested |

Target principle: the control-plane Worker never runs arbitrary project shell commands; it only schedules and observes WorkerHost execution.

Phase 0 execution-substrate spike:

- Run `codex app-server` in `VpsDockerWorkspace` with the intended profile skill bundle and `CODEX_HOME` materialization.
- Run the same smoke in Cloudflare Container and Sandbox SDK if account access is available.
- Measure startup time, dependency install behavior, stdout/stderr capture, JSON-RPC streaming, file I/O, long-running process behavior, R2 artifact export, and cleanup.
- Pick the Phase 6/7 default before Phase 2 code starts, because D1/R2 schema, workflow step boundaries, and developer loop depend on the execution substrate.

## 13. Security and Approval Model

### Trust boundaries

| Boundary | Rule |
|---|---|
| Operator browser -> Worker/API | Protected by Cloudflare Access and explicit role policy |
| Worker/API -> Agents | Only internal route/RPC methods; validate tenant/profile/issue authorization |
| Agent -> D1/R2/Queues | Use least-privilege bindings per deployment environment |
| Coding workspace -> secrets | Secrets are brokered by ToolGatewayAgent; do not mount broad credentials by default |
| Coding agent -> external APIs | Tool allowlist, per-tool policy, audit, optional human approval |
| Shell hooks -> production actions | Require explicit profile policy and approval for destructive or publishing actions |

### Human-in-the-loop gates

Require approval for:

- Deleting or force-pushing repositories.
- Publishing to production channels.
- Reading or exporting sensitive secrets.
- Creating high-cost cloud resources.
- Running shell commands outside the isolated workspace.
- Sending external messages/comments if profile policy marks them as gated.

Approval records live in D1, payloads in R2, and decisions are surfaced through OperatorAgent and dashboard UI.

### 13.1 Tool Allowlist, Approval, And Idempotency Mapping

`tools.allowed` defines what a profile may call. `approvals.require_human_for` defines when an allowed tool still pauses for human decision. Idempotency defines which allowed tool calls must be replay-safe. These three lists must map to one policy table so a tool cannot be allowed without a known approval and idempotency posture.

Initial mapping:

| `tools.allowed` entry | Idempotency operation type | Default approval category | Default human gate |
|---|---|---|---|
| `tracker.transition` | `tracker.transition` | `issue_state_change` | No, unless moving into terminal/publishing states configured as gated |
| `tracker.comment` | `tracker.comment` | `external_notification` | No for internal comments; yes when profile marks user-visible comments as gated |
| `github.pull_request` | `github.pull_request` | `repo_write` | Yes for create/merge/force-push; no for read-only PR inspection |
| `artifacts.write` | `workspace.snapshot` or `artifact.publish` | `artifact_write` / `production_publish` | No for private R2 artifacts; yes for production/public publish targets |
| `workspace.shell` | Tool-specific, usually none for local-only commands | `destructive_shell` | Yes when command escapes workspace, deletes data, or touches production resources |
| `secret.resolve` | `approval.request` if gated | `secret_read` | Yes unless the secret is explicitly pre-approved for that tool and scope |
| `external.notification` | `external.notification` | `external_notification` | Yes by default until the profile declares the destination safe |
| `approval.request` | `approval.request` | `approval_request` | No; this creates the gate rather than bypassing it |

Policy rules:

1. A tool call is rejected if its tool name is not present in `tools.allowed`.
2. A mutating tool call is rejected at profile validation time if no idempotency operation type is mapped.
3. A tool call pauses when its mapped approval category appears in `approvals.require_human_for`.
4. ToolGatewayAgent writes the selected policy decision into the `tool_calls` record before executing the tool.
5. Later typed tools may split broad entries like `github.pull_request` into narrower actions, but each action must still map back to one approval category and one idempotency posture.

### 13.2 Idempotency Contract

Any operation that can create, mutate, publish, charge money, or notify humans must be idempotent through ToolGatewayAgent. ExecutionWorkflow replay must never create duplicate Linear comments, duplicate GitHub PRs, duplicate published artifacts, or duplicate external messages.

Idempotency key format:

```text
idem:v1:{tenant_id}:{profile_id}:{issue_id}:{run_id}:{operation_type}:{sha256(canonical_operation_payload)}
```

Rules:

1. ToolGatewayAgent derives the key from a canonical JSON payload after removing volatile fields such as timestamps, request ids, and retry counters.
2. ToolGatewayAgent performs read-before-write against D1 `idempotency_records` before calling an external API.
3. If a completed record exists with the same key, ToolGatewayAgent returns the stored `result_ref` and does not call the external API again.
4. If an in-progress record exists, ToolGatewayAgent returns `retry_later` unless the caller owns the same `tool_call_id` and is resuming the same operation.
5. If no record exists, ToolGatewayAgent inserts `status: in_progress`, performs the external side effect, writes the result payload to R2, then marks the record `completed` with `external_ref` and `result_ref`.
6. If the external call returns a provider-native idempotency conflict, ToolGatewayAgent stores that provider result and marks the record `completed` instead of retrying blindly.
7. Retry is different from replay: retry may call an external API only when there is no completed idempotency record and policy says the previous failure was safely retryable.

Operations that require idempotency keys from the first Cloudflare execution phase:

| Operation type | Examples |
|---|---|
| `tracker.transition` | Move issue state, assign issue, update labels |
| `tracker.comment` | Add Linear/native issue comment |
| `github.pull_request` | Create or update PR, post review comment |
| `artifact.publish` | Publish generated asset or report to a production channel |
| `workspace.snapshot` | Store final workspace snapshot under a manifest pointer |
| `approval.request` | Create human approval item |
| `external.notification` | Send email/chat/webhook/message |

Non-mutating reads do not require idempotency records, but they still require tool call audit records.

### Secret handling

- Raw secret values stay in Cloudflare secrets/secrets store or external provider vaults.
- D1 stores secret reference names and access policy metadata only.
- ToolGatewayAgent resolves secrets only inside the smallest necessary tool call.
- R2 logs must redact known secret patterns before persistence.
- Workspace snapshots must run a redaction pass before archival.

## 14. Observability and Dashboard Model

### Dashboard target

- Cloudflare Pages or Worker-rendered UI.
- Access-protected routes.
- Reads summary state from D1 and live state from Agents.
- Streams live updates via Agent WebSockets or server-sent event equivalent.
- Supports operator actions: refresh, pause project, drain project, cancel issue, retry issue, approve action, archive issue.

### API target

Compatibility routes should remain initially:

| Current route | Target behavior |
|---|---|
| `GET /` | Dashboard UI |
| `GET /api/v1/state` | Aggregate ProjectAgent/D1 snapshot |
| `GET /api/v1/<issue-id-or-identifier>` | IssueAgent + D1 run details |
| `POST /api/v1/projects/:tenant/:slug/actions/refresh` | Ask ProjectAgent to poll/reconcile now |

New routes:

| Route | Purpose |
|---|---|
| `POST /api/v2/projects/:project/actions/pause` | Pause dispatch |
| `POST /api/v2/projects/:project/actions/drain` | Stop new runs, let active runs finish |
| `POST /api/v2/issues/:issue/actions/cancel` | Cancel active workflow/session |
| `POST /api/v2/issues/:issue/actions/retry` | Clear failure and enqueue retry |
| `POST /api/v2/approvals/:approval/decision` | Approve/reject gated action |
| `GET /api/v2/runs/:run/events` | Paged event stream from D1/R2 |
| `GET /api/v2/runs/:run/artifacts` | Artifact manifest |

### Metrics

Emit metrics for:

- poll duration and result counts.
- dispatch accepted/rejected counts and reasons.
- running issues by profile/state.
- workflow step duration and failure class.
- tool call duration, failure class, approval wait time.
- token usage and model/provider cost dimensions.
- workspace setup time, test time, snapshot size.
- queue lag and retry depth.

Use Analytics Engine for high-cardinality operational analytics, D1 for queryable events, and R2 for raw logs.

### 14.1 Developer Loop

The target developer loop must preserve the current fast local iteration path while adding a realistic Cloudflare preview path.

Recommended loop by phase:

| Phase | Primary loop | Purpose |
|---|---|---|
| Phase 1 | Local Bun tests and `bin/symphony-launch` | Preserve current engine behavior while extracting contracts |
| Phase 2-4 | Wrangler local/remote preview with mocked execution | Validate Worker routes, D1 schema, R2 profile import, Queue consumer Worker, and Agent state without running Codex |
| Phase 5 | Preview environment with MockCodingAgentAdapter | Validate Workflows, IssueAgent lease, events, dashboard, and retry semantics |
| Phase 6-7 | Remote preview with Container/Sandbox execution | Validate real workspace/Codex behavior under Cloudflare isolation |

Developer commands to define before Phase 2 implementation:

```bash
# Import and validate a local profile bundle without starting execution.
symphony profile validate profiles/content-wechat
symphony profile import --env preview profiles/content-wechat

# Run Cloudflare control plane in preview mode.
wrangler dev --env preview

# Trigger no-op polling/reconciliation without running Codex.
symphony cloud refresh --profile content-wechat --dry-run
```

Debugging source of truth:

1. D1 `run_events` and Agent state are the primary control-plane debugging surfaces.
2. R2 run bundles are the primary raw-log and replay surface.
3. `wrangler tail` is for Worker/Queue/Workflow runtime errors, not the durable source of truth.
4. Analytics Engine is for aggregate metrics, not single-run debugging.

Profile iteration rule: Phase 2 import must support a dry-run mode and a preview overwrite mode so developers can edit a local profile and re-import without manually editing D1/R2 objects.

## 15. Compatibility Strategy

### Compatibility mode contract

The first Cloudflare deployment should run the same profile semantics:

- Same `WORKFLOW.md` prompt rendering.
- Same issue fields used in Liquid templates.
- Same `max_turns`, `max_concurrent_agents`, and state names.
- Same `linear_graphql` capability, but routed through ToolGatewayAgent.
- Same hook names: `after_create`, `before_run`, `after_run`, `before_remove`.
- Same Codex app-server behavior from the perspective of prompts and tool calls.

### Differences allowed in compatibility mode

- Workspace paths are virtual/container paths, not local machine paths.
- Logs are R2/D1 records, not local files.
- `CODEX_HOME` is materialized from profile runtime assets rather than symlinked local files.
- Secrets are Cloudflare bindings, not sourced from `env` files.
- Launcher actions become API/dashboard actions.

## 16. Migration Phases

### Phase 0: Target contract and inventory

Goal: freeze the target contract before implementation.

Deliverables:

- This target document.
- Inventory of current profile fields, hooks, skills, and runtime env variables.
- Compatibility matrix: current local behavior vs target Cloudflare behavior.
- `docs/cloudflare-platform-limits.md`: product entitlement and platform limits register for Workers, Agents/Durable Objects, Workflows, D1, R2, Queues, Containers, Sandbox SDK, Access, AI Gateway, and Analytics Engine.
- Codex-in-WorkerHost spike comparing VPS Docker and Cloudflare-managed options, with a recommended Phase 6/7 default.
- Idempotency contract accepted by architecture review.
- v1-to-v2 profile migration policy accepted by architecture review.
- Developer-loop decision: local, preview, or hybrid mode for Phase 2-5 development.
- Reconciliation parity harness design for Phase 3.

Exit criteria:

- Target architecture reviewed and accepted.
- Linear is explicitly classified as optional adapter, not required core.
- Codex compatibility vs native coding path decision is documented.
- Phase 6/7 default execution substrate is selected, including a separate current-dev default if it differs from hosted Cloudflare execution.
- Phase 2 implementation is blocked until platform limits, idempotency, schema migration, and developer loop documents exist.

### Phase 1: Extract pure engine contracts

Goal: make the TS engine separable from local process/filesystem assumptions.

Deliverables:

- `WorkflowParser` pure package: parse/validate/render profile config and prompt templates.
- `TrackerAdapter` interface with current Linear implementation.
- `CodingAgentAdapter` interface with current Codex implementation.
- `WorkspaceAdapter` interface with current local implementation.
- `EventSink` interface for local logs now and Cloudflare sinks later.

Likely files:

- `ts-engine/src/workflow.ts`
- `ts-engine/src/linear.ts`
- `ts-engine/src/agent.ts`
- `ts-engine/src/agent/codex_adapter.ts`
- `ts-engine/src/workspace.ts`
- `ts-engine/src/log.ts`
- `ts-engine/src/types.ts`

Exit criteria:

- Existing local tests pass.
- Existing profile runs unchanged through `bin/symphony-launch`.
- New interfaces are covered by adapter contract tests.

### Phase 2: Cloudflare control-plane skeleton

Goal: deploy a non-executing Cloudflare control plane that can load profiles and show state.

Deliverables:

- Worker entrypoint with Access-protected dashboard/API routes.
- D1 schema migrations for tenants, profiles, issues, runs, events.
- R2 bucket layout and profile bundle upload/import command.
- TenantAgent and ProjectAgent minimal state.
- Read-only dashboard backed by D1/Agent state.

Exit criteria:

- A profile bundle can be imported from `profiles/<name>/` into Cloudflare storage.
- Dashboard shows profile metadata and no-op project status.
- Access policy protects all operator routes.
- D1 migrations include required indexes, retention fields, tenant policy persistence, and idempotency records.
- Profile import dry-run reports v1-to-v2 defaults and warnings.
- The developer preview loop can import, refresh, inspect, and reset a no-op profile without manual D1/R2 edits.

### Phase 3: Tracker adapter bridge

Goal: move polling/reconciliation into ProjectAgent while keeping Linear compatibility.

Deliverables:

- LinearTrackerAdapter running on Cloudflare Workers (commit 4b1c0aa).
- Scheduled ProjectAgent polling (commit 48d085e).
- D1 issue mirror (commit 4b1c0aa).
- Queue-based tracker event ingestion (commit f185bf7).
- `POST /api/v1/projects/:tenant/:slug/actions/refresh` compatibility route (commit 4b1c0aa).

Exit criteria:

- ProjectAgent mirrors active and terminal Linear issues into D1 (verified via live smoke against the deployed Worker).
- Reconciliation decisions match the current local engine for a test profile.
- No issue execution starts yet unless explicitly enabled.

### Phase 4: IssueAgent dispatch and lease model

Goal: create durable per-issue ownership without running coding workloads yet.

Deliverables:

- IssueAgent class and state machine.
- Dispatch queue consumer.
- Lease acquire/release semantics.
- Retry/backoff state.
- Cancel/pause/resume operator actions.

Exit criteria:

- Duplicate dispatch messages result in one active issue owner.
- Retry/backoff behavior matches current `State.scheduleRetry` semantics.
- Dashboard can show queued/running/retrying/paused/terminal issue state.

Status sync (2026-05-02, Phase 4 sub-cut 3 PR-D):

- IssueAgent ownership, dispatch queue ingestion, retry_wait/failed transitions, alarm-driven retry dispatch, and the D1 `issue_retries` mirror are implemented in `cf-control-plane`.
- Failed-state visibility uses the existing `issue_retries` row with `due_at = ""`; reconcile treats empty/null due dates as informational and does not emit dispatch decisions.
- The dashboard exposes retry_wait/failed rows read-only with CLI/curl Bearer endpoint hints. Session-cookie dashboard auth is not extended to mutation actions until Phase 8 ToolGatewayAgent and Access JWT validation.
- Run lease / `workflow_instance_id` semantics remain part of Phase 5 ExecutionWorkflow integration; Phase 4 still does not start coding workloads.

### Phase 5: ExecutionWorkflow without real coding

Status: shipped 2026-05-03 (PRs A-E). Real WorkerHost workspace
operations remain deferred to Phase 6; codex_compat to Phase 7.

Goal: prove durable workflow orchestration with a mock agent.

Deliverables:

- [x] ExecutionWorkflow skeleton with steps, event emission, D1 run records, R2 manifest (PR-A scaffold; PR-C 16-step bodies + manifest writer).
- [x] MockCodingAgentAdapter equivalent to current mock adapter behavior (PR-C; ts-engine mock parity preserved).
- [x] Hook placeholders that do not execute shell commands (PR-C — steps 5/7/12 are mock no-ops emitting deterministic events).
- [x] Artifact manifest format (PR-C — `runs/{tenant}/{slug}/{external_id}/{attempt}/manifest.json`, schema v1).

Exit criteria:

- [x] A mirrored issue can complete a mock workflow (`tests/execution_workflow_e2e.test.ts` — 16 steps green end-to-end with R2 manifest).
- [x] Failure at any workflow step can resume or retry without duplicate terminal side effects (`tests/execution_workflow_steps.test.ts` — `recordStep` idempotency on replay; `tests/cancel_mid_run.test.ts` — step 2 lease conflict goes to `runs.status='failed'` + `IssueAgent.onRunFinished('retry')`; queue redelivery is absorbed by IssueAgent transition idempotency).
- [x] Run events are visible in dashboard and persisted to R2/D1 (`/dashboard/runs/:t/:s/:e/:attempt` server-rendered HTML with 16-step grid + paged events; manifest at `runs/{tenant}/{slug}/{external_id}/{attempt}/manifest.json`).

Status sync (2026-05-03, Phase 5 PR-E):

- ExecutionWorkflow runs entirely on Cloudflare Workflows step semantics; `MockCodingAgentAdapter` is the only shipped adapter. Phase 6 swaps step 8 over to a real `WorkerHost`-backed adapter; Phase 7 ships `codex_compat`.
- Step 2 / 8 / 16 use `retries.limit=0` per phase5-plan §9 R-1 — their side effects (lease check / mutating tool calls / lease release) are not replay-safe. The Phase 4 sub-cut 3 retry layer (`IssueAgent.markFailed` + alarm) owns business-layer retries; Cloudflare Queues retries protect transient infra failures only.
- IssueAgent gains `running` + `completed` states + `workflow_instance_id` lease. `startRun` is idempotent in two layers (in-flight Promise dedup + already-running early-return) so concurrent dispatches and queue at-least-once redelivery never spawn a duplicate workflow instance.
- Operator surface: `/api/v1/runs/:t/:s/:e/:attempt/{state,events}` (read), `actions/cancel` (write:run.cancel). Dashboard run view at `/dashboard/runs/:t/:s/:e/:attempt`.
- `executeMockRun` marked `@deprecated`; the synchronous admin route stays alive for Phase 5 bring-up; Phase 6 removes both.

Status sync (2026-05-03, Phase 6 PR-A):

- `WorkerHost` contract (`src/runtime/worker_host.ts`) and `MockWorkerHost` (`src/runtime/mock_worker_host.ts`) land Phase 6 F-5 + F-6. ADR-0001 dispatch isolation enforced by grep gate (`scripts/check-phase6-invariants.ts`). Canonical 16-step names locked in the same gate.
- Phase 6 PR-A commit: TBD-PR-A

### Phase 6: Workspace execution on WorkerHosts

Goal: run real workspace operations under an isolated WorkerHost, starting with VPS Docker for the dev loop and keeping Cloudflare-managed execution as an adapter target.

Deliverables:

- WorkspaceAdapter for VPS Docker first, then Cloudflare Containers/Sandbox as managed adapters.
- Profile skill and `WORKFLOW.md` materialization.
- Repo checkout and hook execution.
- Workspace snapshot/archive to R2.
- Redaction pass before snapshot persistence.

Exit criteria:

- A workspace can be created, populated, hooked, snapshotted, and cleaned up.
- Shell commands never run in the control-plane Worker.
- Hook stdout/stderr are persisted as run artifacts.

### Phase 7: Codex compatibility adapter on WorkerHosts

Goal: run the existing Codex app-server execution loop inside the selected WorkerHost substrate.

Deliverables:

- Codex compatibility image/runtime bundle.
- `CODEX_HOME` materialization strategy.
- JSON-RPC bridge from ExecutionWorkflow to isolated Codex process.
- Tool call bridge to ToolGatewayAgent.
- Token usage and transcript persistence.

Exit criteria:

- A real issue can run at least one Codex turn in an isolated workspace.
- Existing prompt template and `linear_graphql` behavior are preserved through the gateway.
- Stall, read, and turn timeout behavior has parity with current config.

### Phase 8: ToolGatewayAgent and approval system

Goal: replace ad-hoc dynamic tools with a governed tool platform.

Deliverables:

- Tool registry and policy model.
- Linear tool implementation equivalent to `linear_graphql` plus safer typed tracker tools.
- Artifact, GitHub, approval, and profile metadata tools.
- D1/R2 tool call audit persistence.
- Human approval flow in dashboard.

Exit criteria:

- Tool calls are policy checked and auditable.
- Dangerous actions can pause for approval and resume correctly.
- Raw secrets are not visible in agent transcripts unless explicitly approved by policy.

### Phase 9: Cloudflare-native tracker mode

Goal: make Linear optional.

Deliverables:

- `tracker.kind: cloudflare` implementation backed by D1 + IssueAgent state.
- Cloudflare-native issue creation/update/comment APIs.
- Dashboard views for native issue queue.
- Optional Linear sync bridge, disabled by default for native profiles.

Exit criteria:

- A profile can run end-to-end with no Linear API key.
- Native issues support active, pause, terminal, retry, and dependency/blocking metadata.
- Linear compatibility mode still passes regression tests.

### Phase 10: Native CodingAgent path

Goal: reduce or remove dependency on a long-running Codex subprocess where practical.

Deliverables:

- Native `CodingAgentAdapter` using Agents SDK, MCP, AI Gateway, and Cloudflare-native model/tool orchestration.
- Same prompt/turn/tool/result contract as compatibility adapter.
- Capability flags per profile: `codex_compat`, `cloudflare_native`, or hybrid.
- Evaluation harness comparing native vs compatibility results.

Exit criteria:

- Native adapter can complete representative tasks with comparable quality.
- Profiles can select adapter kind without changing orchestration code.
- Codex compatibility remains available for workloads that need full local CLI semantics.

### Phase 11: Cutover and local daemon retirement

Goal: make Cloudflare the default production runtime.

Deliverables:

- Deployment docs and runbooks.
- Import/export commands for profiles.
- Backfill/migration scripts for profile metadata and run history.
- Local launcher marked dev/compat only.
- Production readiness review.

Exit criteria:

- At least one production profile runs on Cloudflare without local daemon dependency.
- Rollback plan is tested.
- Operator runbook covers pause, drain, retry, restore profile, and inspect failed run.

## 17. Acceptance Criteria

### 17.1 Document-Level Acceptance

Target architecture acceptance:

- The document identifies all current TS components and maps each to a Cloudflare target component.
- Linear is optional in the final architecture; Cloudflare-native tracker mode is defined.
- Codex compatibility and native coding-agent paths are both represented behind an adapter boundary.
- Per-issue durable ownership and duplicate-dispatch prevention are defined.
- Workspace isolation never executes arbitrary shell code in a control-plane Worker.
- D1/R2/Queues/Analytics responsibilities are separated clearly.
- Dashboard/API compatibility routes and future routes are defined.
- Migration phases include deliverables and exit criteria.
- Security, approval, secrets, and audit boundaries are explicit.
- Verification strategy is concrete enough to drive later implementation plans.

Implementation readiness acceptance for the next phase:

- A developer can start Phase 1 without asking what to extract first.
- A reviewer can reject implementation that reintroduces Elixir or hard-requires Linear in the core.
- A reviewer can reject implementation that runs shell hooks directly in Workers.
- A reviewer can test whether local profile behavior remains compatible during the first migration phase.

### 17.2 System-Level Acceptance Before Phase 2

Phase 2 cannot start until these are true:

- Platform limits and account entitlements are pinned in `docs/cloudflare-platform-limits.md`.
- Codex compatibility substrate is selected by spike evidence or explicitly carried as a dual-path risk.
- Idempotency records, keys, and ToolGateway read-before-write behavior are specified.
- v1-to-v2 profile import/migration policy is specified and dry-run behavior is defined.
- Developer loop for preview import, refresh, debug, and reset is specified.
- D1 schema includes indexes and retention/archival fields.
- Queue consumer Worker to Agent invocation flow is specified.

## 18. Verification Strategy

### Unit tests

- Workflow parsing and config defaults.
- TrackerAdapter contract for Linear and native D1 tracker.
- CodingAgentAdapter contract for mock, Codex compatibility, and native adapter.
- WorkspaceAdapter contract for local and Cloudflare execution.
- IssueAgent state machine transitions.
- Tool policy checks and redaction.

### Integration tests

- ProjectAgent polling against a mocked Linear API.
- Dispatch queue idempotency with duplicate messages.
- ExecutionWorkflow resume after injected step failures.
- R2 artifact manifest write/read.
- D1 event/run query consistency.
- Dashboard API compatibility routes.

### End-to-end tests

- Linear compatibility profile: mirror issue, dispatch, run mock, transition terminal.
- Cloudflare-native tracker profile: create native issue, run mock, complete without Linear env.
- Codex compatibility smoke: run one real turn in isolated execution if credentials are available.
- Approval flow: dangerous tool call pauses, dashboard approves, workflow resumes.
- Cleanup flow: terminal issue snapshots workspace and archives/removes runtime state.

### Observability checks

- Each run emits start, step, tool, token, artifact, completion/failure events.
- Dashboard shows live running count, retry queue, token totals, and failure reason.
- Analytics can answer: failures by profile, average run duration, queue lag, tool failure rate, and cost by model/provider.
- R2 run bundle can reconstruct a failed run without relying on ephemeral logs.

## 19. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| WorkerHost capability gaps for Codex | Real coding workload may not run with full CLI parity on one substrate | Keep compatibility spike early; maintain fallback adapters; define minimum runtime contract before cutover |
| Agents/Workflows replay side effects | Duplicate comments, PRs, or state transitions | Idempotency keys for every external side effect; ToolGatewayAgent records operation IDs |
| Linear and native issue state divergence | Wrong dispatch or missed terminal cleanup | Declare one source of truth per profile; mirror with version stamps; reconciliation reports drift |
| Secret leakage into logs/snapshots | Security incident | Broker secrets through tools, redact logs/snapshots, approval gates for secret reads |
| Cost runaway from autonomous agents | Budget breach | TenantAgent budgets, per-profile concurrency, AI Gateway limits, kill switches |
| Platform limits drift | Phase 2+ design may rely on stale product limits | Re-pin limits during Phase 0 and before each Cloudflare implementation phase |
| Weak developer loop | Migration becomes too slow to iterate safely | Require preview import/dry-run/reset flow before Phase 2 code starts |
| Profile migration ambiguity | v1 profiles may break or fork unexpectedly | Auto-upgrade v1 on import, store original bundle, and keep explicit deprecation window |
| Dashboard stale state | Operators make wrong decisions | Read hot state from IssueAgent, history from D1; show generated timestamps and workflow heartbeat |
| Over-migration before parity | Existing profile workflows break | Phase gates require compatibility tests before replacing local behavior |
| Treating Linear as required forever | Fails 100% Cloudflare goal | Build `tracker.kind: cloudflare` as explicit Phase 9 deliverable |

## 20. ADR: Cloudflare Agent Native Decomposition

### Decision

Adopt Cloudflare Agents + Workflows + pluggable WorkerHosts as the target architecture. Decompose Symphony into TenantAgent, ProjectAgent, IssueAgent, ExecutionWorkflow, ToolGatewayAgent, and dashboard/API Workers. Use D1/R2/Queues/Analytics Engine for durable storage and observability. Keep Linear and Codex as adapters, not core requirements.

### Drivers

- Need durable, cloud-managed orchestration instead of a local long-running daemon.
- Need 100% Cloudflare-native operating mode.
- Need incremental migration from the current TypeScript engine without breaking profiles.

### Alternatives considered

- Lift current daemon into one Worker/Container.
- Keep Linear/Codex as permanent mandatory core.
- Drop Linear immediately and build only a native task tracker.

### Why chosen

The chosen architecture aligns ownership boundaries with Cloudflare primitives and explicit execution adapters: Agents own durable entity state, Workflows own resumable long-running jobs, WorkerHosts own isolated code execution, D1/R2 own durable query/artifact storage, and Access/Analytics own operations. It also provides a safe migration path: start with compatibility adapters, then replace external dependencies progressively.

### Consequences

Positive:

- Removes local daemon as the production control-plane dependency.
- Enables strict Cloudflare-native operation.
- Makes trackers, coding engines, tools, and workspaces replaceable.
- Improves auditability and replayability.

Negative:

- Requires a significant refactor into interfaces and distributed state machines.
- Requires careful idempotency design around Workflows and external side effects.
- Requires early validation of WorkerHost runtime compatibility.

### Follow-ups

- Build Phase 1 extraction plan before coding.
- Spike WorkerHost compatibility with Codex app-server before Phase 2 starts and select the Phase 6/7 default substrate.
- Pin Cloudflare platform limits and account entitlements in a Phase 0 limits register.
- Define Cloudflare-native tracker UX and API in detail.
- Decide production Access policy and tenant model.
- Define retention policy for D1 events and R2 run bundles.

## 21. Architect Review Record

Strongest counterargument against the chosen path:

A Cloudflare-native decomposition may over-distribute a currently small system. The current Bun engine is simple, inspectable, and has local process semantics that are easy to debug. Moving to Agents, Workflows, Queues, D1, R2, and isolated execution introduces distributed-systems failure modes: duplicate messages, replayed steps, partial writes, stale dashboards, and more complex local development.

Tradeoff tension:

- Compatibility wants to preserve Codex subprocess semantics and local profile behavior.
- Cloudflare-native purity wants to remove subprocess assumptions and external dependencies.

Synthesis:

Use adapter seams and phase gates. First extract contracts and run a Codex compatibility adapter in isolated execution; then introduce a native adapter only after the orchestration, tool gateway, and tracker core are stable. Do not force native coding execution before it can pass representative quality/e2e checks.

## 22. Critic Review Record

Critic verdict: Approved for target-document stage, with required later validation.

Checks:

- Principle-option consistency: passes. Option B best satisfies Cloudflare-native core plus adapter boundaries.
- Fair alternatives: passes. Lift-and-shift, permanent Linear/Codex, and immediate Linear removal are considered and bounded.
- Risk mitigation clarity: passes for architecture planning; implementation plans must add exact test fixtures and failure injection.
- Testable acceptance criteria: passes. Criteria can be verified through docs review and later contract/e2e tests.
- Concrete verification: passes. Unit, integration, e2e, and observability checks are listed.

Required follow-up before Phase 2 implementation:

- Confirm Cloudflare account access to Agents, Workflows, Sandbox SDK, Containers, D1, R2, Queues, Access, and Analytics Engine.
- Pin current platform limits and budget assumptions in `docs/cloudflare-platform-limits.md`.
- Run the Codex-in-WorkerHost spike and decide the initial isolated runtime.
- Finalize idempotency, profile migration, and developer-loop specs.
- Define exact D1 migration files and Wrangler bindings in the Phase 2 implementation plan.

## 23. Follow-up Staffing Guidance

### `$ralph` path: sequential implementation

Recommended when implementing one phase at a time with tight review.

Suggested handoff:

```text
$ralph implement Phase 1 from docs/cloudflare-agent-native-target.md.
Scope only: extract pure engine contracts and adapter interfaces; preserve current local behavior and tests.
Do not start Cloudflare deployment code yet.
```

Suggested role focus:

- Architect pass: verify adapter boundaries do not leak local filesystem/process assumptions.
- Executor pass: implement narrow interface extraction.
- Test engineer pass: add contract tests and local regression tests.
- Verifier pass: run `make all` or equivalent repo gate.

### `$team` path: parallel implementation

Recommended after Phase 1 when work can split safely.

Suggested launch hint:

```text
$team implement Phase 2 from docs/cloudflare-agent-native-target.md with lanes:
1. D1/R2 schema and profile import
2. Worker/API/dashboard skeleton
3. TenantAgent/ProjectAgent minimal state
4. Access/security and deployment docs
Team must verify integration through a no-op imported profile before shutdown.
```

Suggested lanes:

| Lane | Role | Output |
|---|---|---|
| Schema/storage | backend executor | D1 migrations, R2 layout, artifact manifest types |
| Worker/API | Cloudflare executor | Worker routes, compatibility APIs, bindings |
| Agents | architect/executor | TenantAgent and ProjectAgent skeleton |
| Dashboard | frontend executor | Access-protected status UI |
| Verification | test engineer/verifier | Integration smoke and deployment checks |

Team verification path:

1. Import a local profile bundle into Cloudflare storage.
2. Load it through ProjectAgent without dispatch.
3. Show it on dashboard.
4. Confirm Access protects operator routes.
5. Confirm D1/R2 records match the imported profile bundle.

## 24. Source References

Cloudflare docs consulted on 2026-05-01:

- Cloudflare Agents: https://developers.cloudflare.com/agents/
- Agents + Workflows: https://developers.cloudflare.com/agents/concepts/workflows/
- Agents MCP: https://developers.cloudflare.com/agents/model-context-protocol/
- Agents Think API: https://developers.cloudflare.com/agents/api-reference/think/
- Agents Code Mode: https://developers.cloudflare.com/agents/api-reference/codemode/
- Cloudflare Workflows: https://developers.cloudflare.com/workflows/
- Cloudflare Sandbox SDK: https://developers.cloudflare.com/sandbox/
- Cloudflare Containers: https://developers.cloudflare.com/containers/
- Cloudflare D1: https://developers.cloudflare.com/d1/
- Cloudflare R2: https://developers.cloudflare.com/r2/
- Cloudflare Queues: https://developers.cloudflare.com/queues/
- Analytics Engine: https://developers.cloudflare.com/analytics/analytics-engine/
- Cloudflare Access applications: https://developers.cloudflare.com/cloudflare-one/applications/
- AI Gateway: https://developers.cloudflare.com/ai-gateway/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Workflows limits: https://developers.cloudflare.com/workflows/reference/limits/
- Durable Objects limits: https://developers.cloudflare.com/durable-objects/platform/limits/
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- R2 limits: https://developers.cloudflare.com/r2/platform/limits/
- Queues limits: https://developers.cloudflare.com/queues/platform/limits/
- Containers limits: https://developers.cloudflare.com/containers/platform-details/limits/
- Sandbox limits: https://developers.cloudflare.com/sandbox/platform/limits/

Repository references:

- `docs/architecture.md`
- `docs/profile-spec.md`
- `ts-engine/README.md`
- `ts-engine/src/main.ts`
- `ts-engine/src/orchestrator.ts`
- `ts-engine/src/agent.ts`
- `ts-engine/src/agent/codex_adapter.ts`
- `ts-engine/src/workspace.ts`
- `ts-engine/src/linear.ts`
- `ts-engine/src/dynamic_tool.ts`
- `ts-engine/src/server.ts`
- `ts-engine/src/state.ts`
