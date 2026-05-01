# Phase 1 Implementation Plan: Extract Pure Engine Contracts

Status: Implementation plan only  
Date: 2026-05-01  
Parent target: `docs/cloudflare-agent-native-target.md`  
Phase: Phase 1 - Extract pure engine contracts

## 1. Outcome

Phase 1 prepares Symphony's active TypeScript engine for the Cloudflare Agent native migration by extracting stable contracts around the existing local implementation. The intended result is not a Cloudflare deployment yet. The intended result is a local engine that behaves the same as today while depending on interfaces instead of concrete Linear, local filesystem, Codex, and file logger classes.

After Phase 1, later phases can add Cloudflare implementations for tracker, workspace, coding agent, event sinks, and profile storage without rewriting orchestration logic again.

## 2. Current Evidence

Current hard couplings that Phase 1 must loosen:

| Coupling | Evidence | Phase 1 target |
|---|---|---|
| Runtime composition creates concrete Linear and local workspace classes directly | `ts-engine/src/main.ts:95`, `ts-engine/src/main.ts:96`, `ts-engine/src/main.ts:105` | Composition can still create local implementations, but they satisfy interfaces |
| Orchestrator depends on `LinearClient` and `WorkspaceManager` concrete types | `ts-engine/src/orchestrator.ts:20`, `ts-engine/src/orchestrator.ts:21` | Orchestrator depends on `TrackerAdapter` and `WorkspaceAdapter` |
| Orchestrator calls tracker methods by Linear-specific dependency name | `ts-engine/src/orchestrator.ts:78`, `ts-engine/src/orchestrator.ts:86`, `ts-engine/src/orchestrator.ts:111` | Use tracker-neutral names while preserving behavior |
| AgentRunner depends on concrete Linear and Workspace classes | `ts-engine/src/agent.ts:21`, `ts-engine/src/agent.ts:22` | AgentRunner depends on adapter interfaces |
| AgentRunner builds Linear dynamic tool handler directly | `ts-engine/src/agent.ts:40`, `ts-engine/src/dynamic_tool.ts:31` | Introduce `ToolGateway` contract, initially backed by current Linear GraphQL handler |
| Workspace lifecycle assumes local `node:fs` and shell execution | `ts-engine/src/workspace.ts:4`, `ts-engine/src/workspace.ts:24`, `ts-engine/src/workspace.ts:58`, `ts-engine/src/workspace.ts:83` | Keep local implementation, expose it through `WorkspaceAdapter` |
| Logger writes local files directly | `ts-engine/src/log.ts:12` | Keep local logger, expose it through `EventSink`/logger contract |
| Agent interface exists but is named generic `Agent` | `ts-engine/src/agent/types.ts:95`, `ts-engine/src/agent/types.ts:106` | Preserve compatibility, optionally alias as `CodingAgentAdapter` for target vocabulary |
| Workflow config only accepts `tracker.kind: linear` | `ts-engine/src/workflow.ts:126` | Phase 1 may keep this runtime restriction, but type boundaries should not make Linear mandatory forever |

## 3. Requirements Summary

Functional requirements:

1. Preserve current local runtime behavior for `bin/symphony`, `bin/symphony-launch`, and existing profiles.
2. Preserve `WORKFLOW.md` parsing, prompt rendering, and current `tracker.kind: linear` compatibility.
3. Preserve Linear polling, issue normalization, GraphQL dynamic tool behavior, retry, reconciliation, workspace hooks, Codex app-server adapter behavior, dashboard routes, and local logging.
4. Introduce explicit adapter contracts for tracker, workspace, coding agent, tool gateway, and event sink/logging.
5. Refactor orchestration and per-issue execution to depend on the new contracts instead of concrete local classes.
6. Add contract tests proving that the orchestration works with non-Linear/mock implementations.
7. Update docs to show Phase 1 boundaries and what remains local-only.

Non-functional requirements:

1. Keep changes narrow; do not introduce Cloudflare dependencies in Phase 1.
2. Maintain current TypeScript/Bun toolchain.
3. Keep exported contracts small and implementation-neutral.
4. Avoid changing public CLI behavior.
5. Avoid changing profile schema beyond optional documentation of future-compatible adapter naming.

Non-goals:

1. Do not implement Cloudflare Workers, D1, R2, Queues, Workflows, Agents, Sandbox, or Containers in Phase 1.
2. Do not add `tracker.kind: cloudflare` behavior yet.
3. Do not remove Linear support.
4. Do not replace Codex with a native Cloudflare coding agent.
5. Do not modify profile secrets, `CODEX_HOME`, or runtime directory layout.
6. Do not reintroduce Elixir.

## 4. Target Contract Shape

Recommended new contract files:

```text
ts-engine/src/contracts/
|-- agent.ts          # CodingAgentAdapter alias/exports around existing Agent contract
|-- events.ts         # EventSink / structured logger contract
|-- index.ts          # public contract re-exports
|-- tools.ts          # ToolGateway contract and tool registry surface
|-- tracker.ts        # TrackerAdapter contract
`-- workspace.ts      # WorkspaceAdapter contract
```

Recommended implementation layout after extraction:

```text
ts-engine/src/adapters/
|-- local_event_sink.ts       # wraps current Logger or receives extracted logger implementation
|-- local_workspace.ts        # wraps or renames current WorkspaceManager
|-- linear_tracker.ts         # wraps or renames current LinearClient
`-- linear_tool_gateway.ts    # backs current linear_graphql dynamic tool
```

A simpler first PR may keep concrete files in place and add interfaces beside them. The important Phase 1 exit condition is dependency direction, not folder naming. If moving files creates too much churn, prefer adding contracts first and moving implementations in a later cleanup.

## 5. Proposed Contracts

### 5.1 TrackerAdapter

Purpose: let Orchestrator and AgentRunner operate on normalized issues without knowing whether the source is Linear, D1-native tracker, or test memory tracker.

```ts
export interface TrackerAdapter {
  fetchActiveIssues(): Promise<Issue[]>;
  fetchTerminalIssues(): Promise<Issue[]>;
  fetchIssuesByIds(ids: string[]): Promise<Issue[]>;
}

export interface RawTrackerToolAdapter {
  graphql?<T>(query: string, variables?: Record<string, unknown>, operationName?: string): Promise<T>;
}
```

Initial implementation:

- `LinearClient` implements `TrackerAdapter` and `RawTrackerToolAdapter` without behavior changes.
- Existing `graphql` stays available for the compatibility `linear_graphql` tool.

Do not add transition/comment methods yet unless needed by tests. Those belong to later ToolGateway typed tools.

### 5.2 WorkspaceAdapter

Purpose: decouple issue execution from local filesystem and shell implementation.

```ts
export type WorkspaceRef = {
  path: string;
  host: string | null;
};

export interface WorkspaceAdapter {
  ensure(issue: Issue): Promise<WorkspaceRef>;
  pathFor(issue: Issue): string;
  remove(issue: Issue): Promise<void>;
  runHook(name: HookName, workspace: WorkspaceRef): Promise<void>;
}
```

Initial implementation:

- Current `WorkspaceManager.ensure()` returns a string. Phase 1 should either:
  - update it to return `{ path, host: null }`, or
  - add `LocalWorkspaceAdapter` that wraps `WorkspaceManager` and returns `WorkspaceRef`.
- Prefer wrapper if minimizing behavior risk is more important than cleanup.

Important migration constraint:

- Current `AgentRunner` passes a string `cwd` to Codex. After this contract, use `workspace.path` as the `cwd` for the local/Codex compatibility path.

### 5.3 CodingAgentAdapter

Purpose: align current generic `Agent` contract with target vocabulary without breaking existing tests.

Existing contract at `ts-engine/src/agent/types.ts:95` is already close:

```ts
export interface Agent {
  start(): Promise<void>;
  startSession(opts: SessionOptions): Promise<string>;
  runTurn(prompt: string, title: string, handlers: TurnHandlers): Promise<TurnResult>;
  stop(): Promise<void>;
}
```

Phase 1 plan:

- Keep `Agent` to avoid churn.
- Add `export type CodingAgentAdapter = Agent` in `contracts/agent.ts` or `agent/types.ts`.
- Add `CodingAgentFactory` alias for `AgentFactory`.
- Keep `CodexAdapter` and `MockAgent` behavior unchanged.

### 5.4 ToolGateway

Purpose: stop `AgentRunner` from constructing Linear tool handling directly, and prepare for Cloudflare ToolGatewayAgent/McpAgent later.

```ts
export interface ToolGateway {
  definitions(): ToolDefinition[];
  handle(call: ToolCall): Promise<ToolResult>;
}
```

Initial implementation:

- `LinearToolGateway` exposes current `linearGraphqlSpec` and current `makeLinearGraphqlHandler` behavior.
- `AgentRunner` receives `toolGateway` in dependencies.
- `AgentRunner.startSession()` uses `toolGateway.definitions()`.
- `onToolCall` calls `toolGateway.handle(call)`.

This is the highest-value Phase 1 seam because later Cloudflare ToolGatewayAgent can preserve the same contract while adding audit, policy, approvals, and MCP.

### 5.5 EventSink / Logger Contract

Purpose: decouple local file logging from future D1/R2/Analytics sinks.

Minimum contract:

```ts
export type EventLevel = "debug" | "info" | "warning" | "error";

export interface EventSink {
  log(level: EventLevel, message: string, meta?: Record<string, unknown>): void | Promise<void>;
  debug(message: string, meta?: Record<string, unknown>): void | Promise<void>;
  info(message: string, meta?: Record<string, unknown>): void | Promise<void>;
  warn(message: string, meta?: Record<string, unknown>): void | Promise<void>;
  error(message: string, meta?: Record<string, unknown>): void | Promise<void>;
}
```

Initial implementation:

- Current `Logger` implements `EventSink` structurally.
- Do not make every call async in Phase 1 unless needed; TypeScript allows a sync implementation where callers do not await.
- A later Cloudflare implementation can write to D1/R2/Analytics through the same surface.

## 6. Dependency Direction After Phase 1

Desired direction:

```text
main composition
  -> concrete local adapters
  -> interfaces
orchestrator / agent runner
  -> interfaces only
concrete adapters
  -> external systems or local process/filesystem
```

Concrete examples:

- `Orchestrator` should import `TrackerAdapter`, `WorkspaceAdapter`, `EventSink`, and `CodingAgentFactory`; it should not import `LinearClient` or `WorkspaceManager` concrete classes.
- `AgentRunner` should import `TrackerAdapter`, `WorkspaceAdapter`, `ToolGateway`, `EventSink`, and `CodingAgentFactory`; it should not import `LinearClient` or call `makeLinearGraphqlHandler` directly.
- `main.ts` remains the composition root and is allowed to import concrete local implementations.

## 7. Implementation Steps

### Step 1: Add contract modules

Files:

- Add `ts-engine/src/contracts/tracker.ts`
- Add `ts-engine/src/contracts/workspace.ts`
- Add `ts-engine/src/contracts/tools.ts`
- Add `ts-engine/src/contracts/events.ts`
- Add `ts-engine/src/contracts/agent.ts`
- Add `ts-engine/src/contracts/index.ts`

Actions:

1. Define the minimal interfaces described above.
2. Re-export existing domain types from `ts-engine/src/types.ts` where useful.
3. Re-export agent tool/turn types from `ts-engine/src/agent/types.ts` instead of duplicating them.
4. Keep all contracts free of `node:*`, Bun, Cloudflare, Linear, and Codex imports.

Acceptance for this step:

- `bun run typecheck` passes before any caller refactor.
- Contract files contain only type/interface exports and tiny helper types.

### Step 2: Make current implementations satisfy contracts

Files:

- Update `ts-engine/src/linear.ts`
- Update `ts-engine/src/workspace.ts`
- Update `ts-engine/src/log.ts`
- Update `ts-engine/src/agent/types.ts` or new `ts-engine/src/contracts/agent.ts`

Actions:

1. Declare `LinearClient implements TrackerAdapter, RawTrackerToolAdapter`.
2. Declare `Logger implements EventSink` if the sync return type remains compatible.
3. Either adapt `WorkspaceManager` to implement `WorkspaceAdapter`, or add a wrapper `LocalWorkspaceAdapter`.
4. Add `CodingAgentAdapter` alias without renaming current `Agent` if a rename would create churn.

Decision point:

- If changing `WorkspaceManager.ensure()` from `Promise<string>` to `Promise<WorkspaceRef>` touches too many files, use a wrapper and leave `WorkspaceManager` behavior unchanged.
- If direct implementation is simple, update `WorkspaceManager` and adjust call sites.

Acceptance for this step:

- Existing local tests still pass or fail only because callers have not yet been updated.
- No behavior changes to Linear API calls, hook execution, or logging output.

### Step 3: Extract Linear dynamic tool into ToolGateway

Files:

- Update `ts-engine/src/dynamic_tool.ts`
- Add optional `ts-engine/src/adapters/linear_tool_gateway.ts` if separating implementation
- Update `ts-engine/src/agent.ts`
- Update tests in `ts-engine/tests/agent_interface.test.ts`

Actions:

1. Add `LinearToolGateway` or `makeLinearToolGateway(client)`.
2. Preserve the `linear_graphql` tool name, schema, validation, success shape, and error shape.
3. Change `AgentRunnerDeps` from a tracker-only dynamic tool path to explicit `toolGateway` dependency.
4. Change session startup from `symphonyDynamicToolSpecs` to `toolGateway.definitions()`.
5. Change `onToolCall` from `linearGraphql(call)` to `toolGateway.handle(call)`.

Acceptance for this step:

- Existing test `AgentRunner dispatches tool calls through the linear_graphql handler` still proves the compatibility behavior.
- Add one new test proving unsupported tool calls return a failed `ToolResult` through the gateway.

### Step 4: Refactor Orchestrator dependencies to interfaces

Files:

- Update `ts-engine/src/orchestrator.ts`
- Update `ts-engine/src/main.ts`
- Update tests if any instantiate Orchestrator directly

Actions:

1. Replace concrete `LinearClient` type with `TrackerAdapter`.
2. Replace concrete `WorkspaceManager` type with `WorkspaceAdapter`.
3. Replace concrete `Logger` type with `EventSink` if no logger-specific methods are used.
4. Rename dependency key from `linear` to `tracker` to prevent future code from assuming Linear.
5. Keep method calls the same where possible: `fetchActiveIssues`, `fetchIssuesByIds`, `fetchTerminalIssues`.
6. Keep workspace cleanup behavior equivalent: `workspace.pathFor(issue)` then existence check then `workspace.remove(issue)`.

Acceptance for this step:

- No runtime behavior changes.
- The orchestrator file no longer imports `LinearClient` or `WorkspaceManager`.
- Existing dashboard/API state behavior remains unchanged.

### Step 5: Refactor AgentRunner dependencies to interfaces

Files:

- Update `ts-engine/src/agent.ts`
- Update `ts-engine/src/main.ts`
- Update `ts-engine/tests/agent_interface.test.ts`

Actions:

1. Replace `linear` dependency with `tracker`.
2. Replace concrete `workspace` dependency with `WorkspaceAdapter`.
3. Add `toolGateway` dependency.
4. Use `WorkspaceRef.path` for `cwd` if WorkspaceAdapter returns refs.
5. Replace all issue-state refreshes with `tracker.fetchIssuesByIds`.
6. Preserve `before_run` and `after_run` hook timing.
7. Preserve token accounting and state update behavior.

Acceptance for this step:

- `AgentRunner` no longer imports `LinearClient`, `WorkspaceManager`, `makeLinearGraphqlHandler`, or `symphonyDynamicToolSpecs` directly.
- Existing `MockAgent` contract tests pass.
- Add or update a mock `ToolGateway` in tests to prove `AgentRunner` is no longer Linear-specific.

### Step 6: Update composition root

Files:

- Update `ts-engine/src/main.ts`

Actions:

1. Instantiate current concrete local implementations as before:
   - `const tracker = new LinearClient(cfg.tracker)`
   - local workspace implementation
   - `const toolGateway = makeLinearToolGateway(tracker)` or `new LinearToolGateway(tracker)`
   - `const logger = new Logger(...)`
   - `CodexAdapter` through existing factory
2. Pass interface-shaped dependencies to Orchestrator and AgentRunner.
3. Keep CLI guardrails, port defaults, workflow load errors, server startup, and shutdown behavior unchanged.

Acceptance for this step:

- `../bin/symphony <WORKFLOW.md> ...` contract remains unchanged.
- No profile files need to change.

### Step 7: Add contract tests

Files:

- Add `ts-engine/tests/tracker_contract.test.ts`
- Add `ts-engine/tests/workspace_contract.test.ts`
- Add `ts-engine/tests/tool_gateway_contract.test.ts`
- Update `ts-engine/tests/agent_interface.test.ts`

Test cases:

1. `TrackerAdapter` memory fake supports active, terminal, and by-id fetches.
2. `Orchestrator` can dispatch using a memory tracker fake, not Linear.
3. `WorkspaceAdapter` local implementation returns a stable path/ref and runs hooks in the same order as before.
4. `ToolGateway` exposes `linear_graphql` and routes calls with the same output shape as before.
5. `AgentRunner` can run with a mock tracker, mock workspace, mock tool gateway, and mock coding agent.

Acceptance for this step:

- At least one test would fail if `AgentRunner` or `Orchestrator` re-imports Linear-specific code.
- Test harness does not require real `LINEAR_API_KEY` or real Codex.

### Step 8: Documentation updates

Files:

- Update `ts-engine/README.md`
- Update `docs/cloudflare-agent-native-target.md` if Phase 1 wording needs a pointer to this plan
- Optionally add `docs/engine-contracts.md` if the contract surface is large enough

Actions:

1. Document new adapter boundaries.
2. State that Phase 1 keeps all runtime behavior local and Linear-compatible.
3. State that `tracker.kind: cloudflare` is not implemented yet.
4. State that Cloudflare implementations begin in Phase 2 and later.

Acceptance for this step:

- A future implementer can find which contract owns tracker/workspace/tool/coding/event responsibilities.
- Docs do not claim Cloudflare deployment exists after Phase 1.

### Step 9: Quality gate

Commands:

```bash
make all
```

If iterating inside `ts-engine/`:

```bash
cd ts-engine
bun run typecheck
bun test
bun run build
```

Acceptance for this step:

- TypeScript typecheck passes.
- Bun tests pass.
- Build passes.
- Existing launcher smoke can still run if desired:

```bash
./bin/symphony-launch list
```

## 8. Suggested PR Breakdown

If Phase 1 is too large for one safe PR, split it this way:

### PR 1: Contract definitions only

Scope:

- Add `ts-engine/src/contracts/*`.
- Add type-only compatibility aliases.
- No runtime call-site changes.

Gate:

- `bun run typecheck`
- `bun test`

### PR 2: ToolGateway extraction

Scope:

- Extract current `linear_graphql` handling behind `ToolGateway`.
- Refactor AgentRunner tool call path.
- Add gateway tests.

Gate:

- `bun run typecheck`
- `bun test ts-engine/tests/agent_interface.test.ts` if selective test invocation is supported, else `bun test`.

### PR 3: Tracker/Workspace/Event dependency inversion

Scope:

- Refactor Orchestrator and AgentRunner dependency types.
- Rename local dependency keys from `linear` to `tracker`.
- Add memory/mock adapter tests.

Gate:

- `make all`

### PR 4: Documentation and cleanup

Scope:

- Update docs and examples.
- Optional file moves to `src/adapters/` if not done earlier.
- No behavior changes.

Gate:

- `make all`

For a single-PR implementation, keep the commit history in the same order.

## 9. File-Level Checklist

| File | Required Phase 1 change |
|---|---|
| `ts-engine/src/types.ts` | Keep domain types stable; add only minimal shared types if needed |
| `ts-engine/src/contracts/tracker.ts` | New `TrackerAdapter` and optional raw tracker tool interface |
| `ts-engine/src/contracts/workspace.ts` | New `WorkspaceAdapter`, `WorkspaceRef`, hook contract exports |
| `ts-engine/src/contracts/tools.ts` | New `ToolGateway` contract |
| `ts-engine/src/contracts/events.ts` | New `EventSink` contract |
| `ts-engine/src/contracts/agent.ts` | New `CodingAgentAdapter` aliases over existing agent contract |
| `ts-engine/src/contracts/index.ts` | Re-export contract types |
| `ts-engine/src/linear.ts` | Implement tracker contract without changing GraphQL behavior |
| `ts-engine/src/workspace.ts` | Implement or wrap workspace contract |
| `ts-engine/src/log.ts` | Implement event sink contract structurally |
| `ts-engine/src/dynamic_tool.ts` | Provide linear tool gateway implementation or factory |
| `ts-engine/src/orchestrator.ts` | Depend on tracker/workspace/event interfaces, not concrete classes |
| `ts-engine/src/agent.ts` | Depend on tracker/workspace/tool gateway/event/coding agent interfaces |
| `ts-engine/src/main.ts` | Act as composition root wiring concrete local adapters |
| `ts-engine/tests/agent_interface.test.ts` | Update harness to inject tracker/tool/workspace contracts |
| `ts-engine/tests/*contract*.test.ts` | Add focused contract regression tests |
| `ts-engine/README.md` | Document adapter boundaries and Phase 1 behavior |

## 10. Detailed Acceptance Criteria

Phase 1 is complete only when all criteria pass:

1. Local engine behavior is unchanged for existing Linear/Codex profiles.
2. `Orchestrator` imports no concrete `LinearClient` or `WorkspaceManager` types.
3. `AgentRunner` imports no concrete `LinearClient`, `WorkspaceManager`, or Linear dynamic tool handler directly.
4. `main.ts` is the only normal runtime composition point that wires Linear, local workspace, local logger, and Codex compatibility adapter together.
5. `ToolGateway` owns dynamic tool definitions and handling.
6. `LinearClient` is one implementation of `TrackerAdapter`, not the tracker abstraction itself.
7. Current `linear_graphql` tool name, schema, success shape, and error shape are preserved.
8. Workspace hook order remains `after_create`, `before_run`, `after_run`, `before_remove` as currently applicable.
9. Current retry/backoff behavior remains unchanged.
10. Current dashboard compatibility routes remain unchanged.
11. Tests include non-Linear or memory fakes for at least AgentRunner and preferably Orchestrator.
12. `make all` passes.
13. Documentation clearly states Cloudflare deployment is not implemented in Phase 1.
14. No Elixir implementation or references are introduced.

## 11. Verification Matrix

| Behavior | Verification |
|---|---|
| Workflow parsing still accepts current profiles | Existing workflow tests plus a smoke run against `profiles/content-wechat/WORKFLOW.md` if safe |
| Linear adapter still fetches/normalizes issues | Unit tests with mocked `fetch`; no live Linear required |
| Orchestrator is tracker-neutral | Memory `TrackerAdapter` test dispatches without `LinearClient` |
| AgentRunner is tool-gateway-neutral | Mock `ToolGateway` test handles a tool call without `makeLinearGraphqlHandler` |
| Local workspace behavior is unchanged | Hook order/path tests on temporary directories |
| Codex adapter contract unchanged | Existing `agent_interface` and typecheck |
| Dashboard state unchanged | Existing `server.test.ts` |
| Build output unchanged enough for launcher | `make all`, optional `./bin/symphony-launch list` |

## 12. Risks and Mitigations

| Risk | Why it matters | Mitigation |
|---|---|---|
| Over-abstracting too early | Creates unused interfaces that obscure simple code | Keep contracts minimal and exactly shaped around current call sites |
| Breaking current local runs | Users still depend on current launcher/profile behavior | Keep `main.ts` as local composition root and run full local gate |
| Renaming `Agent` to `CodingAgentAdapter` causes churn | Existing tests and imports already use `Agent` | Add aliases first; defer renames |
| Changing workspace return type ripples too far | Workspace path is used as `cwd` throughout current flow | Prefer wrapper if direct change gets large |
| Hiding Linear GraphQL too soon | Current profiles may rely on raw `linear_graphql` | Preserve raw tool exactly in `LinearToolGateway` |
| Async logger contract causes unawaited promises | Current logger is synchronous | Allow `void | Promise<void>` return and avoid broad async refactor |
| Future Cloudflare assumptions leak into Phase 1 | Increases implementation risk | Do not import Cloudflare SDKs; document future bindings only |

## 13. Handoff Prompt For Implementation

Use this when starting execution with `$ralph`:

```text
$ralph implement Phase 1 from docs/cloudflare-agent-native-phase1-plan.md.
Scope: extract pure engine contracts and adapter interfaces only.
Do not implement Cloudflare Workers/D1/R2/Queues/Agents/Sandbox yet.
Preserve current local Linear + Codex behavior, profile schema, CLI contract, dashboard routes, retry/reconciliation semantics, and hook order.
Run make all before handoff.
```

Use this when starting execution with `$team`:

```text
$team implement Phase 1 from docs/cloudflare-agent-native-phase1-plan.md with lanes:
1. Contract files and type aliases
2. ToolGateway extraction and tests
3. Tracker/Workspace/Event dependency inversion
4. Documentation and final verification
Do not let lanes modify the same files without coordination. Final verifier runs make all and checks no Cloudflare runtime code was introduced.
```

## 14. Phase 2 Readiness Gates

Phase 1 can be implemented independently, but Phase 2 must not start just because Phase 1 passes. The target-document review added these blockers before any Phase 2 Cloudflare control-plane code:

1. Pin Cloudflare account entitlements and platform limits in `docs/cloudflare-platform-limits.md`.
2. Run a Codex-in-WorkerHost spike comparing VPS Docker and Cloudflare-managed substrates, then choose the Phase 6/7 default substrate or document a dual-path risk.
3. Finalize the ToolGateway idempotency contract, including key format, D1 persistence, and replay behavior.
4. Finalize v1-to-v2 profile import/migration policy and dry-run validator behavior.
5. Pick the developer loop for profile import, preview refresh, debugging, and reset.
6. Define a reconciliation diff harness for Phase 3 parity with the current `Orchestrator.tick` behavior.

These gates are intentionally out of scope for Phase 1 implementation, but the Phase 1 contracts should not make any of them harder.

The Phase 1 `WorkspaceAdapter` contract (`ts-engine/src/contracts/workspace.ts`) is the stable boundary above the future Phase 6 `WorkerHost` substrate. Phase 6 introduces `WorkerHost` underneath as a separate layer (see `docs/cloudflare-agent-native-target.md` §6 "Layering: WorkspaceAdapter and WorkerHost") without breaking Phase 1 callers. Phase 2 work must not collapse the two layers into one interface.

## 15. Stop Conditions

Stop implementation and re-plan if any of these happen:

1. A contract requires changing profile schema or existing `WORKFLOW.md` behavior.
2. Codex app-server behavior changes from the perspective of `AgentRunner` tests.
3. A Cloudflare SDK dependency becomes necessary during Phase 1.
4. Linear raw GraphQL tool compatibility cannot be preserved.
5. Workspace hook behavior changes for existing local profiles.
6. The plan starts requiring production secrets or live external services for normal tests.

