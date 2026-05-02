# Phase 7 Implementation Plan: codex_compat CodingAgentAdapter on WorkerHost

Author: writer pass, 2026-05-03
Companion to: `docs/cloudflare-agent-native-phase1-plan.md`,
`docs/cloudflare-agent-native-phase4-plan.md`,
`docs/cloudflare-agent-native-phase5-plan.md`,
`docs/cloudflare-agent-native-phase6-plan.md`,
`docs/cloudflare-agent-native-target.md` §1208–1224 (Phase 7 deliverables),
ADR-0001 (substrate dispatch boundary),
ADR-0002 (codex_compat as path of record).

Scope: Phase 7 lights up the `codex_compat` adapter_kind by running the
existing Codex app-server execution loop inside the WorkerHost
substrate that Phase 6 productionized. The work is intentionally
narrow — only ExecutionWorkflow step 8 (`runAgentTurnLoop`) swaps
implementations. Steps 1, 2, 9–16 are unchanged from Phase 5/6, and
the WorkerHost substrate is reused as-is from Phase 6.

Phase 6 is the prerequisite. The VPS Docker `WorkerHost` (PR-A through
PR-D of Phase 6) must have shipped, the `parseRuntimeConfig`/
`pickWorkerHost` factory must be live in `cf-control-plane/src/runtime/factory.ts`,
and `runs.adapter_kind` must already accept `codex_compat` as a
declared union value (Phase 5 PR-A schema). This plan does not change
substrate behaviour; it changes which CodingAgent runs inside the
substrate.

---

## 1. Context

Phase 4–6 close the substrate stack:

- Phase 4 sub-cuts 1–3 — `IssueAgent` lease state machine, queue
  ingestion, dispatch enqueueing, `markFailed` retry path.
- Phase 5 — `ExecutionWorkflow` shell, 16 canonical steps,
  `MockCodingAgentAdapter`, run lease (`workflow_instance_id`), R2
  manifest, D1 row trail.
- Phase 6 — `WorkerHost` contract (`mock`, `vps_docker`,
  `cloudflare_container`), real workspace operations, hook execution,
  R2 snapshot/redaction, `runtime.host` profile dispatch.

What is **missing** for the system to do real coding work
(target.md §1208–1224):

1. **Real coding-agent execution.** Step 8 (`runAgentTurnLoop`) still
   calls `MockCodingAgentAdapter` and emits a single canned turn.
   Phase 7 swaps step 8 to a real `CodexCompatAdapter` that talks to
   a `codex app-server` JSON-RPC subprocess inside the WorkerHost.
2. **Per-turn token usage capture.** The mock emits a fixed shape;
   Phase 7 parses `thread/tokenUsage/updated` deltas from real Codex
   notifications and aggregates them across the turn loop.
3. **Multi-turn loop honouring `agent.max_turns`.** Phase 5/6 ship a
   single mock turn; Phase 7 iterates per-turn `step.do` calls and
   marks the run failed via `IssueAgent.markFailed` when the loop
   exits with a non-terminal status after `max_turns` iterations.
4. **`runs.adapter_kind = 'codex_compat'`.** Phase 5/6 hard-code
   `'mock'`; Phase 7 picks the value from the resolved CodingAgent
   factory return type.
5. **CODEX_HOME materialization.** A Codex subprocess needs an
   authenticated `~/.codex` (model creds, MCP config). Phase 7
   documents the secret materialization path inside the WorkerHost.

ADR-0001 §2 names `WorkerHost` and `CodingAgentAdapter` as the two
replaceable seams. Phase 6 shipped the first; Phase 7 ships the
second. ADR-0002 reaffirms `codex_compat` is the path of record (D2)
and any future Phase 10 native CodingAgent must compete on the same
evaluation corpus that Phase 7 produces (ADR-0002 §4).

The boundary is strict: only step 8 swaps. Steps 3, 4, 5, 7, 12, 15
continue to call the WorkerHost from Phase 6; steps 1, 2, 6, 9–11,
13, 14, 16 are untouched. The 16-step canonical list does not grow.
The grep gate from `cf-control-plane/scripts/check-phase6-invariants.ts`
extends to forbid CodingAgent dispatch outside `src/contracts/` +
`src/coding_agents/` (mirroring the WorkerHostKind rule).

## 2. Current Evidence

| What | File / line | What it gives Phase 7 |
|---|---|---|
| Existing CodingAgent contract | `ts-engine/src/contracts/agent.ts` | The interface to port verbatim. Aliases the generic `Agent`/`AgentFactory`/`AgentFactoryContext` from `ts-engine/src/agent/types.ts`. |
| Generic Agent types | `ts-engine/src/agent/types.ts` | `Agent` interface (`start`, `startSession`, `runTurn`, `stop`), `TurnResult`, `TurnHandlers`, `ToolCall`, `ToolResult`, `AgentTokenUsage`, `SessionOptions`. Phase 7's TS port lives at `cf-control-plane/src/contracts/coding_agent.ts`. |
| Working Codex JSON-RPC adapter | `ts-engine/src/agent/codex_adapter.ts` | Battle-tested wire format: `initialize`/`thread/start`/`turn/start`/`turn/completed`, `item/started`, `item/agentMessage/delta`, `thread/tokenUsage/updated`, `item/tool/call`, `execCommandApproval` / `applyPatchApproval`. Phase 7 ports the protocol layer; the substrate-spawn delta is the only material change. |
| Phase 5 mock adapter | `cf-control-plane/src/agents/mock_coding_adapter.ts` | The shape step 8 currently consumes (`runTurn({ prompt, attempt }) -> { tokenUsage, toolCalls, agentMessage }`). Phase 7 PR-A replaces this with a contract-driven implementation under `src/coding_agents/`. |
| Phase 6 WorkerHost contract | `cf-control-plane/src/runtime/worker_host.ts` | `prepareWorkspace`, `materializeAssets`, `runHook`, `snapshotWorkspace`, `releaseWorkspace`. Phase 7's adapter borrows the workspace handle to spawn `codex app-server` inside it. |
| Phase 6 dispatch factory | `cf-control-plane/src/runtime/factory.ts` | `parseRuntimeConfig` + `pickWorkerHost`. Phase 7 extends with `pickCodingAgent` and `runtime.coding_agent` config. |
| Step 8 turn loop | `cf-control-plane/src/workflows/execution.ts` lines 378–431 | The body Phase 7 PR-C swaps. Already wrapped in `NO_RETRY` (`{ retries: { limit: 0 } }`) per phase5-plan §9 R-1. |
| `runs.adapter_kind` enum | Phase 5 PR-A schema | Already accepts `'mock' | 'codex_compat' | 'cloudflare_native'`. Phase 7 lights up the second value; no D1 migration required. |
| Invariants script | `cf-control-plane/scripts/check-phase6-invariants.ts` | Phase 7 extends INVARIANT 1 to also forbid `CodingAgentKind` literal dispatch outside `src/contracts/` + `src/coding_agents/`. |
| Existing Codex spike | `spikes/codex-on-cloudflare/bridge/`, REPORT.md §13 | Spawn-once + persistent-thread pattern; warm 5s vs cold 7s; multi-turn smoke pass. Useful reference for CodexCompatAdapter lifecycle when running inside Cloudflare Container substrate. |

## 3. Requirements Summary

R1. **CodingAgentAdapter contract — verbatim TS port.** A new file
`cf-control-plane/src/contracts/coding_agent.ts` re-declares the
interfaces from `ts-engine/src/contracts/agent.ts` +
`ts-engine/src/agent/types.ts` without runtime deps:
- `Agent` (renamed `CodingAgentAdapter` to match ADR-0001 vocabulary)
  with `start`, `startSession`, `runTurn`, `stop`.
- `TurnResult`, `TurnHandlers`, `ToolCall`, `ToolResult`,
  `AgentTokenUsage`, `SessionOptions`, `ToolDefinition`,
  `AgentActivity`.
- `CodingAgentFactory` + `CodingAgentFactoryContext`.
- `CodingAgentKind = 'mock' | 'codex_compat' | 'cloudflare_native'`.
The contract shape is identical to ts-engine's so the existing Codex
adapter logic ports without semantic drift.

R2. **CodexCompatAdapter implements CodingAgentAdapter.**
File: `cf-control-plane/src/coding_agents/codex_compat_adapter.ts`.
Wire-compatible port of `ts-engine/src/agent/codex_adapter.ts`:
- JSON-RPC envelope identical to Codex 0.128.0
  (`initialize` / `thread/start` / `turn/start` / `thread/status/changed` /
  `item/started` / `item/agentMessage/delta` / `item/completed` /
  `turn/completed` / `thread/tokenUsage/updated`).
- Lifecycle inside WorkerHost: `startSession` requests a child
  process from the substrate (VPS bridge `POST /codex/spawn`,
  Container bridge identical), holds the JSON-RPC stream open over
  stdio piped through the bridge, and tears down on `stop()`.
- Stream parser tolerates partial frames, out-of-order
  notifications, stderr noise (`bubblewrap`, websocket retry).
- Tool-call envelopes (`item/tool/call`) are surfaced via
  `TurnHandlers.onToolCall`; the result is sent back as the JSON-RPC
  reply with the original `id` preserved.
- Token usage parsed from `thread/tokenUsage/updated` and
  `item/started` / `item/completed` `usage` payloads (same defensive
  normalizer as ts-engine's `emitTokenUsage`).

R3. **Step 8 swap from Mock to factory-resolved CodingAgent.**
`cf-control-plane/src/workflows/execution.ts` step 8:
- Constructs the CodingAgent via `pickCodingAgent(env, runtimeConfig, ctx)`.
- The factory dispatch is the single point that branches on
  `CodingAgentKind`; execution.ts itself does not switch on the kind.
- The runs row is opened with `adapter_kind = ?` instead of the
  hard-coded `'mock'`, with the value read from
  `runtimeConfig.codingAgent` (default `'mock'` for missing config to
  preserve Phase 5/6 baseline).
- The mock path stays alive when `runtime.coding_agent === 'mock'`
  is selected (default, used by all Phase 5/6 tests) so the existing
  133-test suite continues to pass.

R4. **Token usage captured per-turn AND aggregated.**
- Each per-turn `step.do('runAgentTurn.{n}', ...)` records a
  `run_steps` row with `step_name = 'runAgentTurn.{n}'`-shape detail
  and a `run_events` row of `event_type = 'turn.tokenUsage'` carrying
  the per-turn `{totalTokens, inputTokens, outputTokens}` delta.
- The `tokenUsage` accumulator inside `ExecutionWorkflow.run()` adds
  the per-turn delta and is used by step 11 + the finalize boundary
  for the manifest's `token_usage` field.
- The per-turn breakdown is queryable from D1 (run_events) and
  surfaced on the dashboard's run detail view.

R5. **Tool calls flow through the existing step 9 boundary
(no change).** Phase 5 step 8 records `tool_calls` D1 rows and writes
input/output envelopes to R2 keyed by `(run_id, tool_call_id)`; step 9
emits a `recordedInStep8` event. Phase 7 keeps this layout: the
adapter's `onToolCall` handler writes the same R2 envelopes + D1 row
inside step 8, and step 9 still emits its mock-style summary event.
Phase 8 will swap step 9 to a real `ToolGatewayAgent`; Phase 7 does
not pre-empt that work.

R6. **Multi-turn loop honours `profile.agent.max_turns`.**
- The turn-loop body iterates from 1 to `cfg.agent.max_turns` with
  `cfg` resolved from the loaded profile in step 1.
- Each iteration is a separate `step.do('runAgentTurn.{n}',
  { retries: { limit: 0 } }, ...)` to preserve the Phase 5 R-1
  no-replay invariant.
- Loop terminates early on `TurnResult.status === 'completed'`
  AND no further turns requested by the agent (Codex emits
  `turn/completed` with no follow-up `turn/start`).
- On `failed` / `cancelled` / `timeout`, the step throws and the
  outer `try/catch` routes through `IssueAgent.markFailed` per Phase 4
  sub-cut 3.
- On exhaustion (loop hits `max_turns` without a terminal completed
  status), the step throws `max_turns_exceeded` and the same
  `markFailed` path applies.

R7. **Codex binary path + CODEX_HOME materialization.**
- The codex CLI is provisioned **inside** the WorkerHost substrate
  (VPS Docker image, Container image), NOT inside the Worker. The
  control plane never spawns a process locally.
- `CODEX_HOME` is a directory the substrate materializes into the
  workspace at `prepareWorkspace` / `materializeAssets` time:
  - VPS Docker: `/symphony/workspaces/{tenant}/{profile}/{issue}/codex-home/`
    populated from the profile bundle and a Worker secret containing
    `auth.json`. The bridge owns the secret expansion.
  - Cloudflare Container: same layout inside the container's
    persistent volume; the secret arrives via Worker secret + bridge
    handshake.
- `CodexCompatAdapter.startSession` accepts `hints.codexHome` and
  passes it as `CODEX_HOME` env to the spawn request.
- **Operator runbook** in `cf-control-plane/README.md` documents the
  rotation procedure: rotate the Worker secret, redeploy, the next
  workspace prepare picks up the new value. Old workspaces keep the
  old `CODEX_HOME` for the run's lifetime.

R8. **`runs.adapter_kind = 'codex_compat'`.** When the resolved
CodingAgent kind is `'codex_compat'`, the runs row is opened with
that string. The existing union (Phase 5 PR-A) accepts the value
without a D1 migration. Mock-kind profiles continue to record
`'mock'`.

R9. **Phase 6 invariants hold.**
- The 16-step canonical list (`check-phase6-invariants.ts`) is
  unchanged. The per-turn `step.do('runAgentTurn.{n}', ...)` calls
  are NESTED inside step 8's body, NOT siblings to the canonical 16.
- ADR-0001 dispatch isolation extends to `CodingAgentKind`:
  `pickCodingAgent` lives in `src/runtime/factory.ts` and is the
  single switch point. `execution.ts` and other callers do not branch
  on the kind. The grep gate enforces.
- Per-turn step.do retries stay at 0; only the outer Phase 4
  `markFailed` path retries the whole run.

R10. **Fakeable for tests.** `CodexCompatAdapter` MUST be testable
without a real Codex binary. Two fakes ship:
- `cf-control-plane/tests/fakes/fake_codex_process.ts` — an in-memory
  JSON-RPC peer that mimics Codex 0.128.0 wire frames using the same
  fixture set as ts-engine's `agent/mock_adapter.ts`.
- `cf-control-plane/tests/fakes/fake_codex_bridge.ts` — a fake VPS
  bridge `POST /codex/spawn` endpoint that returns the in-memory peer
  via a duplex stream, exercising the WorkerHost spawn path without
  touching real network.
Test profiles that opt into `runtime.coding_agent: 'codex_compat'`
plus `runtime.host: 'mock'` exercise the adapter against the fake
without leaving Bun's test process.

R11. **Tests:**
- Unit: `coding_agent_contract.test.ts` — every adapter implements
  every CodingAgentAdapter method with the correct signatures
  (compile-time + runtime structural check).
- Unit: `codex_compat_jsonrpc.test.ts` — frame parser handles partial
  frames, OOO notifications, stderr noise; canned 0.128.0 fixtures.
- Unit: `codex_compat_tool_routing.test.ts` — `item/tool/call` is
  forwarded with correct id; reply round-trips back; D1 `tool_calls`
  row written by the step 8 wrapper.
- Unit: `codex_compat_token_usage.test.ts` — defensive token-usage
  normalizer covers the 4+ shapes Codex emits.
- Integration: `phase7_step8_swap.test.ts` — step 8 dispatches to
  CodexCompatAdapter when the resolved profile config sets
  `runtime.coding_agent: 'codex_compat'`; the run completes; manifest
  token_usage is non-zero.
- Integration: `phase7_max_turns.test.ts` — fake Codex returns
  non-terminal turns; step 8 throws `max_turns_exceeded` after
  configured cap; outer catch routes through `markFailed`.
- Regression: `phase5_phase6_e2e.test.ts` — profiles defaulting to
  `runtime.coding_agent: 'mock'` continue to pass without change.

R12. **Phase 7 invariants:**
- ADR-0001/ADR-0002 boundaries unchanged. CodingAgent stays a
  replaceable seam; the workflow does not branch on adapter kind.
- The 16-step list does not grow in count or order.
- No new D1 schema or migration. `runs.adapter_kind` already accepts
  `'codex_compat'`.
- `MockCodingAgentAdapter` is preserved as a contract implementation
  (used by tests and the `'mock'` profile path); it does not get
  removed.

## 4. Implementation Steps

### Step 1 — CodingAgentAdapter contract (TS port)

`cf-control-plane/src/contracts/coding_agent.ts` (new):

```ts
// Verbatim TS port of ts-engine/src/contracts/agent.ts +
// ts-engine/src/agent/types.ts. No runtime deps; pure types.

export type ToolDefinition = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };
export type ToolResult = { success: boolean; output?: string; contentItems?: { type: string; text: string }[] };
export type AgentTokenUsage = { totalTokens: number; inputTokens: number; outputTokens: number };
export type AgentActivity = { label: string; text?: string };
export type TurnHandlers = {
  onActivity?: (info: AgentActivity) => void;
  onTokenUsage?: (usage: AgentTokenUsage) => void;
  onToolCall?: (call: ToolCall) => Promise<ToolResult>;
};
export type TurnResult = {
  status: "completed" | "failed" | "cancelled" | "timeout";
  reason?: unknown;
  sessionId?: string | null;
};
export type SessionOptions = {
  cwd: string;
  tools?: ToolDefinition[];
  hints?: Record<string, unknown>;
};
export interface CodingAgentAdapter {
  start(): Promise<void>;
  startSession(opts: SessionOptions): Promise<string>;
  runTurn(prompt: string, title: string, handlers: TurnHandlers): Promise<TurnResult>;
  stop(): Promise<void>;
}
export type CodingAgentKind = "mock" | "codex_compat" | "cloudflare_native";
export type CodingAgentFactoryContext = { cwd: string; workspaceHandleId: string };
export type CodingAgentFactory = (ctx: CodingAgentFactoryContext) => CodingAgentAdapter;
```

### Step 2 — Mock CodingAgentAdapter (contract impl)

`cf-control-plane/src/coding_agents/mock_coding_agent.ts` (new):
- Implements every method of `CodingAgentAdapter`.
- `runTurn` returns the same fixed shape as the inline
  `MockCodingAgentAdapter` from `src/agents/mock_coding_adapter.ts`,
  so the manifest token_usage and tool_calls counts are identical
  byte-for-byte (regression-safe).
- Supersedes `src/agents/mock_coding_adapter.ts`. PR-A keeps the old
  file for one PR cycle and deletes it in PR-C after step 8 swap
  lands.

### Step 3 — `pickCodingAgent` factory

`cf-control-plane/src/runtime/factory.ts` (modify):
- Extend `RuntimeConfig` with `codingAgent: CodingAgentKind`.
- Extend `parseRuntimeConfig` to read `runtime.coding_agent` from
  `profile.config_json`; default to `'mock'`.
- Add `pickCodingAgent(env, config, ctx)` returning a
  `CodingAgentAdapter` for the resolved kind. The body is a
  single switch on `CodingAgentKind` and is the ONLY switch in the
  codebase.
- `cloudflare_native` throws `not_implemented_yet` (Phase 10 scope).

### Step 4 — CodexCompatAdapter

`cf-control-plane/src/coding_agents/codex_compat_adapter.ts` (new):
- Wire-compatible port of `ts-engine/src/agent/codex_adapter.ts`.
- Differences:
  - Spawn delegated to a `BridgeSpawner` interface (the WorkerHost
    bridge). The spawner returns a duplex stream pair
    (`{ stdin, stdout, stderr, close }`).
  - No direct use of `node:child_process` (Workers + Bun-test parity).
- JSON-RPC parser, request/notify methods, token-usage normalizer,
  approval responder, stall timer, finishTurn book-keeping all
  ported as-is. The only behaviour delta is the spawn injection.
- Constructor:

```ts
export class CodexCompatAdapter implements CodingAgentAdapter {
  constructor(private cfg: CodexAdapterConfig, private spawner: BridgeSpawner) {}
  // ... port of ts-engine/src/agent/codex_adapter.ts ...
}
```

### Step 5 — BridgeSpawner per-substrate implementations

- VPS Docker: `cf-control-plane/src/runtime/vps_docker_host.ts` adds
  a `spawnCodex(handle, env): Promise<DuplexStream>` method that
  POSTs `/codex/spawn` to the bridge with the workspace handle id
  and `CODEX_HOME` path; the bridge replies with a streaming HTTP
  body that surfaces stdin via a paired POST. Same pattern as the
  Phase 0 spike's persistent-bridge.
- Mock: `MockWorkerHost` exposes a `spawnCodex` that returns a
  fake duplex stream backed by the test fixture in
  `tests/fakes/fake_codex_process.ts`.
- Container (Phase 6.B): identical contract; not in Phase 7's
  required scope but the interface stays uniform.

The `WorkerHost` interface gains `spawnCodex(handle: WorkspaceHandle,
env: Record<string, string>): Promise<DuplexStream>` as an optional
capability. Substrates that do not implement it throw
`not_supported: spawn_codex` (a `mock` host with no fixture wired
will throw, surfacing the configuration error early).

### Step 6 — Step 8 swap

`cf-control-plane/src/workflows/execution.ts` (modify step 8):

```ts
// Resolve CodingAgent kind from the same runtimeConfig that picked WorkerHost.
const codingAgentKind = runtimeConfig.codingAgent;

// Open runs row with the resolved adapter_kind (replaces the hard-coded 'mock').
await this.env.DB.prepare(
  `INSERT OR IGNORE INTO runs (
     id, issue_id, attempt, status, workflow_id, adapter_kind, started_at
   ) VALUES (?, ?, ?, 'running', ?, ?, ?)`,
)
  .bind(runId, issueId, params.attempt, params.workflow_instance_id, codingAgentKind, startedAt)
  .run();

// ...

// Step 8: per-turn loop with no within-step retry.
const adapter = pickCodingAgent(this.env, runtimeConfig, {
  cwd: workspaceHandle.cwd,
  workspaceHandleId: workspaceHandle.id,
});
await adapter.start();
await adapter.startSession({ cwd: workspaceHandle.cwd, tools: [...] });
const maxTurns = profileConfig.agent?.max_turns ?? 16;
let terminal = false;
for (let n = 1; n <= maxTurns && !terminal; n++) {
  await recordStep(this.env, runId, 8, "runAgentTurnLoop", step, async () => {
    // Per-turn body — n is captured for event detail; outer recordStep
    // dedupes on (run_id, 8) so only one run_steps row exists overall.
    const turnResult = await adapter.runTurn(prompt, `turn ${n}`, {
      onTokenUsage: (u) => { /* aggregate into tokenUsage */ },
      onToolCall: async (call) => { /* persist envelopes, return result */ },
    });
    if (turnResult.status === "completed") terminal = true;
    if (turnResult.status === "failed" || turnResult.status === "timeout" ||
        turnResult.status === "cancelled") throw new Error(`turn_${turnResult.status}`);
    return { result: { turn: n, status: turnResult.status }, eventDetail: { turn: n, ...} };
  }, NO_RETRY);
}
if (!terminal) throw new Error("max_turns_exceeded");
await adapter.stop();
```

Per-turn `run_events` rows are emitted inside the body via the
existing `run_events` table, with `event_type = 'turn.tokenUsage'`
and `event_type = 'turn.completed'`.

### Step 7 — Profile schema bump (`runtime.coding_agent`)

The profile schema does NOT need a separate file change: Phase 6
already reads `runtime.host` from `profile.config_json`, and Phase 7
reuses the same JSON path. The factory's `parseRuntimeConfig` is the
source of truth and returns `'mock'` as the default for any missing
or malformed value.

Documentation:
- `cf-control-plane/README.md` documents the new
  `runtime.coding_agent` knob and links to ADR-0002 for the
  `codex_compat`/`cloudflare_native` rationale.

### Step 8 — Invariant gate extension

`cf-control-plane/scripts/check-phase6-invariants.ts` (modify):
- Add INVARIANT 3: `CodingAgentKind` literal dispatch outside
  `src/contracts/` + `src/coding_agents/` is a violation. Patterns:
  `case "codex_compat"`, `case "cloudflare_native"`, equality
  variants. The existing path-exclusion machinery handles the
  factory and contract files.
- Rename script → `check-phase6-7-invariants.ts` (preserves the
  Phase 6 invariants verbatim and adds the Phase 7 ones).

### Step 9 — Dashboard + tests

`cf-control-plane/src/dashboard/render.ts` (modify):
- Run detail view shows `adapter_kind` next to `runtime.host`.
- Per-turn token usage breakdown rendered from the
  `turn.tokenUsage` `run_events` rows.

Tests per R11.

## 5. Suggested PR Breakdown

5 PRs across Phase 7 (PR-E optional). Each ~400–600 net lines.

**PR-A — Contract + Mock + factory.pickCodingAgent (foundational)**
- Steps 1, 2, 3, 8.
- New file: `src/contracts/coding_agent.ts`.
- New file: `src/coding_agents/mock_coding_agent.ts`.
- Modify `src/runtime/factory.ts`: `RuntimeConfig.codingAgent` +
  `parseRuntimeConfig` extension + `pickCodingAgent`.
- Modify `scripts/check-phase6-invariants.ts` (rename →
  `check-phase6-7-invariants.ts`) with INVARIANT 3.
- New tests: `coding_agent_contract.test.ts` exercising both
  `MockCodingAgent` and the factory. The old
  `src/agents/mock_coding_adapter.ts` stays in place; nothing in
  execution.ts changes yet.
- Net: ~400 lines (contract is ~80 lines, mock impl ~80, factory
  diff ~40, invariants ~40, tests ~150).

**PR-B — CodexCompatAdapter implementation**
- Steps 4, 5.
- New file: `src/coding_agents/codex_compat_adapter.ts` — JSON-RPC
  port from ts-engine.
- Modify `src/runtime/worker_host.ts`: add optional `spawnCodex`
  capability to the interface.
- Modify `src/runtime/mock_worker_host.ts`: add `spawnCodex`
  fixture wiring.
- Modify `src/runtime/vps_docker_host.ts`: add `spawnCodex`
  HTTP/duplex implementation.
- New fakes: `tests/fakes/fake_codex_process.ts`,
  `tests/fakes/fake_codex_bridge.ts`.
- New tests: `codex_compat_jsonrpc.test.ts`,
  `codex_compat_tool_routing.test.ts`,
  `codex_compat_token_usage.test.ts`.
- Adapter is implemented but NOT yet wired into step 8.
- Net: ~600 lines.

**PR-C — execution.ts step 8 swap + adapter_kind dispatch**
- Step 6.
- Modify `src/workflows/execution.ts`: replace
  `MockCodingAgentAdapter` import + inline step 8 body with the
  `pickCodingAgent`-resolved per-turn loop sketched in §4 step 6.
- Replace hard-coded `'mock'` in the runs `INSERT` with the
  resolved `codingAgentKind`.
- Delete `src/agents/mock_coding_adapter.ts` (its consumers all
  moved to `src/coding_agents/mock_coding_agent.ts` in PR-A).
- New tests: `phase7_step8_swap.test.ts`, `phase7_max_turns.test.ts`.
- Regression: existing 133-test suite passes (mock profiles default
  unchanged).
- Net: ~450 lines (execution.ts diff ~200, tests ~250).

**PR-D — Dashboard token-per-turn surface + e2e against fake Codex**
- Step 9 (dashboard + e2e).
- Modify `src/dashboard/render.ts`: per-run `adapter_kind` badge,
  per-turn token usage table sourced from `run_events` rows of
  `event_type = 'turn.tokenUsage'`.
- New tests: `phase7_e2e_codex_compat.test.ts` — spins up a fake
  Codex bridge + fake Codex process, runs a real `ExecutionWorkflow`
  invocation against an in-memory D1 + R2 stub, verifies manifest
  records `adapter_kind = 'codex_compat'`, non-zero token_usage,
  and ≥1 tool call envelope round-trip.
- Net: ~400 lines.

**PR-E — CODEX_HOME materialization helper (optional)**
- Step 7 (R7 secrets path).
- New helper:
  `src/runtime/codex_home.ts` — resolves the per-issue
  `CODEX_HOME` directory by combining the profile bundle's
  `codex-home/` subtree with a Worker secret containing
  `auth.json` and writes it to the workspace via
  `WorkerHost.materializeAssets`.
- Operator runbook section in `cf-control-plane/README.md` for
  rotation.
- Optional because PR-B's adapter accepts `hints.codexHome` from any
  source; PR-E formalizes the materialization path. Skip if PR-B's
  inline path is judged sufficient at review.
- Net: ~250 lines.

Sequencing: PR-A → PR-B (independent of A on contract; serialized for
review) → PR-C (depends on A + B) → PR-D (depends on C) → PR-E
(optional, parallelizable with D).

## 6. File-Level Checklist

| File | Status | PR |
|---|---|---|
| `cf-control-plane/src/contracts/coding_agent.ts` | new | PR-A |
| `cf-control-plane/src/coding_agents/mock_coding_agent.ts` | new | PR-A |
| `cf-control-plane/src/coding_agents/codex_compat_adapter.ts` | new | PR-B |
| `cf-control-plane/src/runtime/factory.ts` | modify (`pickCodingAgent` + `RuntimeConfig.codingAgent`) | PR-A |
| `cf-control-plane/src/runtime/worker_host.ts` | modify (optional `spawnCodex`) | PR-B |
| `cf-control-plane/src/runtime/mock_worker_host.ts` | modify (`spawnCodex` fixture) | PR-B |
| `cf-control-plane/src/runtime/vps_docker_host.ts` | modify (`spawnCodex` HTTP/duplex) | PR-B |
| `cf-control-plane/src/runtime/codex_home.ts` | new (optional) | PR-E |
| `cf-control-plane/src/workflows/execution.ts` | modify step 8 + runs INSERT adapter_kind | PR-C |
| `cf-control-plane/src/agents/mock_coding_adapter.ts` | delete | PR-C |
| `cf-control-plane/src/dashboard/render.ts` | modify (per-turn token surface) | PR-D |
| `cf-control-plane/scripts/check-phase6-invariants.ts` | rename + INVARIANT 3 | PR-A |
| `cf-control-plane/README.md` | document `runtime.coding_agent` + CODEX_HOME runbook | PR-A + PR-E |
| `cf-control-plane/tests/fakes/fake_codex_process.ts` | new | PR-B |
| `cf-control-plane/tests/fakes/fake_codex_bridge.ts` | new | PR-B |
| `cf-control-plane/tests/coding_agent_contract.test.ts` | new | PR-A |
| `cf-control-plane/tests/codex_compat_jsonrpc.test.ts` | new | PR-B |
| `cf-control-plane/tests/codex_compat_tool_routing.test.ts` | new | PR-B |
| `cf-control-plane/tests/codex_compat_token_usage.test.ts` | new | PR-B |
| `cf-control-plane/tests/phase7_step8_swap.test.ts` | new | PR-C |
| `cf-control-plane/tests/phase7_max_turns.test.ts` | new | PR-C |
| `cf-control-plane/tests/phase7_e2e_codex_compat.test.ts` | new | PR-D |
| `docs/cloudflare-agent-native-target.md` | §1208–1224 status sync | end of phase |
| `docs/cloudflare-agent-native-phase7-plan.md` | this file | PR-A (initial) |

## 7. Acceptance Criteria

A1. **Contract conformance.** Every `CodingAgentAdapter`
implementation (`MockCodingAgent`, `CodexCompatAdapter`) implements
all interface methods with the correct signatures. `bunx tsc --noEmit`
succeeds; the contract conformance unit test passes by structural
check at runtime.

A2. **Codex e2e on fake bridge.** A single issue completes the full
16-step workflow with `runs.adapter_kind = 'codex_compat'`,
`token_usage.totalTokens > 0`, and at least one `tool_calls` D1 row
written from the `onToolCall` round-trip. Verified by
`phase7_e2e_codex_compat.test.ts`.

A3. **Multi-turn `max_turns` honoured.** Fake Codex configured to
return non-terminal `turn/completed` payloads (no terminal flag)
makes step 8 throw `max_turns_exceeded` after the configured cap; the
outer `try/catch` calls `IssueAgent.markFailed`; the runs row is
`status = 'failed'`; a new `ExecutionWorkflow` instance starts under
the alarm-driven re-dispatch (Phase 4 sub-cut 3 path).

A4. **Mock regression.** All existing Phase 5/6 tests continue to
pass. Profiles defaulting to `runtime.coding_agent: 'mock'` (or
missing config) record `runs.adapter_kind = 'mock'` and produce the
same manifest token_usage and tool_calls counts as before. Test count
remains ≥133 pass / 0 fail.

A5. **Dashboard per-turn token surface.** A run detail view renders
the per-turn breakdown sourced from `run_events` rows of
`event_type = 'turn.tokenUsage'`, with one row per turn showing
`{totalTokens, inputTokens, outputTokens}`.

A6. **Grep gate forbids CodingAgentKind dispatch.** The renamed
invariants script fails on a planted violation
(`case "codex_compat"` outside `src/contracts/` or `src/coding_agents/`)
and passes on the real codebase.

A7. **Phase 4 retry semantics intact.** Forcing a turn-level failure
inside step 8 (any `TurnResult.status !== 'completed'`) produces a
step failure, NOT a within-step retry. The Phase 4 catch path
(`transition` → `markFailed` → alarm) handles the retry; the next
attempt is a fresh `ExecutionWorkflow` instance with a bumped
`attempt` counter.

A8. **Codex binary missing fails fast.** A WorkerHost whose substrate
returns `spawn_codex_failed` (e.g. binary missing,
`CODEX_HOME` unmounted) makes step 8 throw with the substrate's
error message. `runs.error` records the bridge's error string;
`run_events` carries `step.runAgentTurnLoop.failed` with severity
`error`. No replay re-executes the failed turn.

A9. **Phase 6 invariants still pass.** `bun run scripts/check-phase6-invariants.ts`
(or its renamed successor) exits 0. The 16 canonical step names are
unchanged in `execution.ts`. `WorkerHostKind` dispatch isolation
holds.

A10. **Build + test gates.** `bunx tsc --noEmit` clean.
`bun test tests/` ≥150 pass / 0 fail (133 baseline + Phase 7 new
tests). `make all` (or its cf-control-plane equivalent) green.

## 8. Verification Matrix

| Acceptance | How verified | Pass signal |
|---|---|---|
| A1 contract conformance | `tests/coding_agent_contract.test.ts` + `bunx tsc --noEmit` | Both adapters export every method; tsc clean. |
| A2 codex e2e on fake | `tests/phase7_e2e_codex_compat.test.ts` | Manifest rows: `adapter_kind='codex_compat'`, `token_usage.totalTokens>0`, ≥1 tool_calls row. |
| A3 max_turns honoured | `tests/phase7_max_turns.test.ts` | `runs.status='failed'`, `runs.error~='max_turns_exceeded'`, alarm scheduled (per Phase 4 sub-cut 3 fixture). |
| A4 mock regression | `bun test tests/` | 133 baseline tests still pass; new tests stack on top. |
| A5 dashboard surface | dashboard render snapshot test (PR-D) + manual deploy | Per-turn rows visible; counts match `run_events`. |
| A6 grep gate | `bun run scripts/check-phase6-7-invariants.ts` against a planted violation | Script exits 1 on planted violation, 0 on real codebase. |
| A7 retry semantics | `tests/phase7_step8_swap.test.ts` failure path | New workflow instance on attempt 2; same `IssueAgent` lease cycle as Phase 4 sub-cut 3. |
| A8 fail-fast on missing codex | `tests/codex_compat_jsonrpc.test.ts` substrate error path | Step throws; `runs.error` populated. |
| A9 Phase 6 invariants | `bun run scripts/check-phase6-7-invariants.ts` | "phase6 invariants: OK" + "phase7 invariants: OK". |
| A10 build/test gates | `bunx tsc --noEmit && bun test tests/` | tsc 0 errors; bun test ≥150 pass / 0 fail. |

## 9. Risks and Mitigations

R-1 — **Dual-substrate during transition.** Phase 7 ships against VPS
Docker as the primary substrate. Cloudflare Container support is
blocked on Phase 6.B's TLS spike progress (see phase6-7-plan §1
Phase 6.B note); a profile pinned to `runtime.host: 'cloudflare_container'`
+ `runtime.coding_agent: 'codex_compat'` will fail at workspace
prepare, not at step 8.
*Mitigation*: Phase 7 acceptance is captured on VPS Docker only.
A Container substrate validation is queued for the Phase 6.B/7.B
follow-up sub-phase. Document in `cf-control-plane/README.md` that
`codex_compat` is currently certified only on `vps_docker`.

R-2 — **Codex binary version drift across substrates.** Pinning
to Codex 0.128.0 wire format inside the JSON-RPC parser is
brittle; a bridge image upgrade can silently change wire frames.
*Mitigation*: the parser is version-tagged with a guard at
`initialize` time — if the server reports an unsupported
`serverInfo.version`, the adapter throws
`codex_version_unsupported`. The eval corpus pins a Codex version
explicitly via the bridge image tag; bridge image upgrades trigger a
parser version bump rather than mutating the existing one.

R-3 — **JSON-RPC stream framing under Cloudflare Workflows step.do
replay.** Workflows replay caches step.do results, but a duplex stdio
stream is not a result; if step 8 retries (it should not — `NO_RETRY`
is enforced) the in-flight stream would be re-opened and the codex
process would receive duplicate `turn/start` requests.
*Mitigation*: the per-turn `step.do('runAgentTurn.{n}', ...)`
boundary stays at `retries: { limit: 0 }`. Phase 5 §9 R-1's grep gate
already enforces this; Phase 7 adds a unit test that asserts the
literal `NO_RETRY` is in the call site. A multi-turn loop's failure
escalates to the outer Phase 4 `markFailed` path, which spawns a new
ExecutionWorkflow instance — the codex process from the failed run
is torn down via `adapter.stop()` in the catch path.

R-4 — **CODEX_HOME secret materialization (auth.json refresh
token).** `auth.json` contains a long-lived refresh token. Mishandled,
it can leak into snapshots, logs, or transcripts.
*Mitigation*:
- `runtime.snapshot.redact` defaults already include `**/auth*.json`
  (Phase 6 PR-D); Phase 7 verifies the redaction list covers the
  CODEX_HOME path.
- `auth.json` is a Worker secret, not a profile asset; rotation is
  documented in PR-E's runbook.
- The bridge's spawn endpoint accepts `auth_json_b64` over the
  authenticated channel (existing `VPS_BRIDGE_TOKEN`) and writes the
  file with `0600` perms inside the workspace; the value is never
  logged.
- A unit test asserts the spawn request body containing `auth_json`
  is not surfaced in any `run_events` row.

R-5 — **Fake Codex process must match the real codex CLI's JSON-RPC
dialect.** A drift between the fake fixture and real Codex makes
tests pass while production breaks.
*Mitigation*: the fake fixture is generated from a captured trace of
a real Codex 0.128.0 session against the spike's persistent bridge
(see `spikes/codex-on-cloudflare/REPORT.md` §13 trace artifacts).
The fixture file is committed; refreshing it requires a manual
capture + diff review. A nightly job (out of Phase 7 scope, queued
for Phase 8) runs the e2e test against a real Codex via the dev VPS
bridge to catch fixture drift.

## 10. Stop Conditions

S-1. If the JSON-RPC bridge requires a different transport (e.g.
WebSocket) than stdio because of Workers networking limits, **stop**
PR-B and add a spike `spikes/codex-bridge-transport/`. The bridge
contract is the seam; switching transport is a substrate-side change
behind the same `BridgeSpawner` interface, but the spike must
validate framing under Cloudflare's HTTP/WS limits before the
adapter ships.

S-2. If multi-turn replay safety cannot be cleanly modelled inside
`step.do` (e.g. Workflows replay caches per-turn results in a way
that prevents the loop from advancing past a turn that already
completed in a prior workflow incarnation), **stop** PR-C and
re-shape the loop so each turn is keyed by a deterministic
attempt-scoped sequence number captured in D1 rather than a counter
in the workflow body.

S-3. If `profile.config_json` schema layering becomes the
architectural greenfield concern raised in earlier sessions
(`runtime.coding_agent` plus `runtime.host` plus future
`runtime.tracker` accumulating without a versioned envelope), **stop**
PR-A and prioritize a foundational PR that lands a
`profile.runtime.{schema_version, host, coding_agent, ...}` envelope
before Phase 7 takes a dependency on the v1 path.

S-4. If Phase 6.A's VPS Docker substrate has not stabilized
(WorkerHost integration tests not green on `main`) at the time PR-C
is ready to merge, **stop** PR-C until Phase 6.A's regression suite
passes. Phase 7 cannot ship a real CodingAgent against an unstable
substrate.

S-5. If `ToolGateway` design (Phase 8) lands ahead of Phase 7's PR-C,
**stop** PR-C and re-shape step 8's `onToolCall` handler to call the
gateway instead of the inline R2/D1 writes. This is a refactor, not
a re-design — the inline path stays as the gateway's
backward-compatible default.

## 11. Phase 8 Readiness Gates

Phase 8 (`Tool registry, policy model, approval flow`, target.md
§1226–1242) can start when:

- All A1–A10 acceptance criteria pass on `main`.
- The 16-step canonical list is unchanged. `runtime.host` AND
  `runtime.coding_agent` are both profile-resolved via
  `parseRuntimeConfig` + `pickWorkerHost` + `pickCodingAgent`. Both
  factory dispatches are the only switch points in the codebase
  (grep gate enforces).
- A dual-adapter regression suite is green: tests run with
  `runtime.coding_agent: 'mock'` (Phase 5/6 baseline) AND
  `runtime.coding_agent: 'codex_compat'` (Phase 7 path) and produce
  isomorphic 16-step traces. Differences are limited to step 8's
  inner shape (turn count, token usage values, tool call envelopes).
- ADR-0001 (substrate dispatch boundary) and ADR-0002 (codex_compat
  as path of record) are unchanged. No new ADR is required for
  Phase 7; Phase 8 may add one for the gateway/policy boundary.
- `D1.runs.adapter_kind = 'codex_compat'` rows are present in
  production data for at least one production-shaped run, enabling
  Phase 8 routing decisions per substrate.
- Eval corpus seed (Phase 6/7 carry-over): `scripts/eval-corpus/run.ts`
  has executed against the seed corpus end-to-end at least once
  through `codex_compat`, with results JSON committed.

## 12. Out of Scope

- Phase 8 ToolGateway / approval / HITL gates. Step 9 stays a mock
  no-op in Phase 7; tool calls keep the Phase 5 inline R2/D1 layout.
- Phase 9 Cloudflare-native tracker (`tracker.kind: cloudflare`).
- Phase 10 native CodingAgent path (Worker + DO + Agents SDK
  replacement of the codex subprocess). ADR-0002 §4 covers the
  evaluation corpus that Phase 10 must beat.
- Linear / tracker write-back (Phase 8). Step 14
  (`transitionIssueState`) stays a mock no-op.
- Real `CODEX_HOME` secret rotation orchestration (Phase 11
  hardening). PR-E ships a manual rotation runbook only.
- Cloudflare Container substrate certification for `codex_compat`.
  Phase 7 certifies on VPS Docker only; Container is a Phase 6.B/7.B
  follow-up sub-phase.
- Removing `MockCodingAgent` from the codebase. It stays as a
  contract implementation and the default kind for tests.
- AI Gateway routing for model traffic (Phase 8 or later).

## 13. Estimated Effort

- PR-A — Contract + Mock + factory.pickCodingAgent + invariants
  rename: ~0.5 day.
- PR-B — CodexCompatAdapter + bridge spawners + fakes + unit tests:
  ~1.5 days.
- PR-C — execution.ts step 8 swap + adapter_kind dispatch + per-turn
  loop + tests: ~0.5 day.
- PR-D — dashboard token-per-turn surface + e2e against fake Codex:
  ~1 day.
- PR-E (optional) — `CODEX_HOME` materialization helper + operator
  runbook: ~0.5 day.
- **Total: 3–4 days** end-to-end across Phase 7, including review
  iterations and one fake-Codex e2e validation run. Add ~0.5 day
  if PR-E is required.

Live e2e against a real Codex on the dev VPS bridge is queued for a
separate validation pass after PR-D merges; budget ~0.5 day for
that pass and capture the 16-step grid + manifest as evidence.
