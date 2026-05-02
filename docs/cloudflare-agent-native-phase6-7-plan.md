# Phase 6/7 Implementation Plan: real WorkerHost workspace + codex_compat CodingAgent

> **Superseded** by `docs/cloudflare-agent-native-phase6-plan.md` (Phase 6 implementation plan)
> and a future `docs/cloudflare-agent-native-phase7-plan.md` (Phase 7 implementation plan).
> This document is preserved for historical reference of the original Phase 6+7 combined draft.

Author: planner pass, 2026-05-02
Companion to: `docs/cloudflare-agent-native-phase1-plan.md`,
`docs/cloudflare-agent-native-phase4-plan.md`,
`docs/cloudflare-agent-native-phase5-plan.md`,
`docs/cloudflare-agent-native-target.md` §1150–1196,
ADR-0001, ADR-0002.
Scope: Phases 6 and 7 combined into one plan because Phase 7 is a thin
adapter on top of Phase 6's substrate work and the two are tightly
coupled: Phase 6 ships a real `WorkerHost`, Phase 7 ships the first
real `CodingAgentAdapter` running inside it. Phase 5 is the
prerequisite — the `ExecutionWorkflow` shell, `MockCodingAgentAdapter`,
and the run lease must be in place before this plan starts.

---

## 1. Context

Phase 5 leaves the system with:
- `ExecutionWorkflow` running 16 canonical steps under Cloudflare Workflows.
- `IssueAgent` lease (`workflow_instance_id`) acquired and released by the
  workflow.
- `MockCodingAgentAdapter` providing deterministic mock turns inside step 8.
- D1 + R2 row trail for runs, run_steps, run_events.
- No real workspace operations; no real coding-agent execution; no shell
  side effects.

What is **missing** for the system to be operationally useful (target.md
§1150–1170 + §1175–1196):

1. **Phase 6 — Real workspace operations on a `WorkerHost`.** Steps 3
   (`prepareWorkspace`) and 4 (`materializeAssets`) must do real work:
   git checkout, profile asset materialization, `WORKFLOW.md`/skills
   layout, `codex-home/` provisioning, hook execution. Phase 6 also
   introduces R2 snapshot/archive of workspace state and a redaction
   pass before snapshot persistence.

2. **Phase 7 — Real coding-agent execution.** Step 8
   (`runAgentTurnLoop`) calls `codex_compat` instead of the mock.
   `codex_compat` is the `CodingAgentAdapter` that runs `codex
   app-server` inside the Phase 6 WorkerHost via JSON-RPC, replicating
   the existing `ts-engine/src/agent/codex_adapter.ts` behavior.

ADR-0001 §2 names `WorkerHost` and `CodingAgentAdapter` as the two
replaceable seams; this plan is the first time both seams ship a
real implementation in the Cloudflare control plane. ADR-0002 reaffirms
that `codex_compat` is the path of record (D2) and that any future
Phase 10 native path must compete on the same evaluation corpus that
Phase 7 produces (ADR-0002 §4).

Sub-phasing inside this plan:

- **Phase 6.A** — VPS Docker WorkerHost as primary. The Phase 0 spike
  (`bf3a072`, `2576f72`, `bbef3c0`, `e17fb82`) already proved this
  end-to-end with the persistent bridge; Phase 6.A productionizes it.
- **Phase 6.B** — Cloudflare Container WorkerHost as opt-in. The TLS
  blocker is closed (`cde7007` + `SSL_CERT_FILE`), so the substrate is
  usable; Phase 6.B wires it into the workflow.
- **Phase 6.C (optional)** — Cloudflare Sandbox WorkerHost if and only
  if the WebSocket-multiplexed transport delivers a clear
  cost/latency improvement over Container, per
  `docs/cloudflare-platform-limits.md` §28. Defer until Container
  e2e ships.
- **Phase 7.A** — `codex_compat` adapter on Phase 6.A (VPS Docker).
- **Phase 7.B** — `codex_compat` validated on Phase 6.B (Container)
  using the same per-issue corpus from 7.A.

Phase 6.C and any further substrate work is explicit Phase 8+ scope.

## 2. Current Evidence

| What | File / line | What it gives Phase 6/7 |
|---|---|---|
| WorkerHost contract sketch | `docs/cloudflare-agent-native-target.md` §6 (WorkerHost Abstraction) | Substrate identity values: `vps_docker`, `cloudflare_container`, `cloudflare_sandbox`, `local_docker`. Phase 6 implements the first two, leaves last two (Sandbox optional, local_docker dev-only). |
| WorkspaceAdapter contract | `ts-engine/src/contracts/workspace.ts` | Existing interface; Phase 6 ships the first non-local implementation. |
| CodexAdapter reference | `ts-engine/src/agent/codex_adapter.ts` | Working JSON-RPC client. Phase 7 ports the protocol layer; the substrate hookup is the only delta. |
| Persistent bridge spike | `spikes/codex-on-cloudflare/bridge/`, REPORT.md §13 | spawn-once + persistent thread + `/reset` endpoint pattern; warm avg 5s vs spawn-per-request 7s; multi-turn smoke pass. Phase 7.A's reference for codex lifecycle. |
| Container TLS resolution | `cde7007`, `cde7007^..cde7007 -- spikes/`, `docs/cloudflare-platform-limits.md` §3 | `ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt` + `SSL_CERT_DIR=/etc/ssl/certs` in image; clean Container application reset required after env change. |
| BRIDGE_REVISION cache-bust + CONTAINER_INSTANCE_NAME | `e17fb82` | Mandatory deploy mechanics; Phase 6.B documents this in operator runbook. |
| Phase 5 16-step workflow | `docs/cloudflare-agent-native-phase5-plan.md` §3 R3 | The shape Phase 6/7 plug into without changing it. |
| Phase 5 idempotency boundary | `docs/cloudflare-agent-native-phase5-plan.md` §9 R-2 | Step 8 (turn loop) is non-replay-safe in Phase 6+; this plan's risk section R-1 details the resolution. |
| Existing R2 binding | Phase 5 PR-A | `ARTIFACTS = symphony-runs`. Phase 6 adds workspace-snapshot keys. |
| Container instance image | `spikes/codex-on-cloudflare/bridge/Dockerfile` | Image baseline for Container substrate. Phase 6.B references this; production image likely needs slimming. |

## 3. Requirements Summary

R1. New runtime contract: `WorkerHost`. The `WorkspaceAdapter`
implementation for Phase 6 takes a `WorkerHost` instance as a
constructor dependency; the workflow does not branch on substrate
identity.

R2. WorkerHost interface (small):
- `prepareWorkspace(ref: WorkspaceRef): Promise<WorkspaceHandle>`
- `runHook(handle, hookName, env): Promise<HookResult>`
- `runShell(handle, cmd, opts): Promise<ShellResult>` (optional in
  Phase 6.A — VPS Docker may expose only specific verbs)
- `snapshotWorkspace(handle, redaction?): Promise<R2Ref>`
- `releaseWorkspace(handle): Promise<void>`

R3. WorkspaceAdapter for VPS Docker (Phase 6.A):
- Workspace path: `/symphony/workspaces/{tenant}/{profile}/{issue}`.
- Materialization: `git clone --depth 1` of the profile-configured repo;
  `WORKFLOW.md`, `skills/`, `codex-home/`, `env` mounted from R2 +
  Worker secrets.
- Hooks: `after_create`, `before_run`, `after_run`, `before_remove`
  invoked via SSH-or-API into the VPS bridge process.
- Hook output is captured and returned as `HookResult { stdout, stderr,
  exitCode, durationMs }`.
- Snapshot: a tar.zst archive of the workspace minus a redaction list
  is uploaded to `runs/{tenant}/{profile}/{issue}/{attempt}/snapshot.tar.zst`.

R4. Workflow step 3 (`prepareWorkspace`) and step 4
(`materializeAssets`) are rewritten to call the WorkerHost-backed
`WorkspaceAdapter`. Both steps remain idempotent on replay:
- Step 3 returns the same `WorkspaceRef` for the same `(run_id)`;
  re-invocation is a no-op if the workspace already exists.
- Step 4 uses content-addressed materialization (hash of profile
  bundle); re-invocation is a no-op if the hashes match.

R5. WorkspaceAdapter for Cloudflare Container (Phase 6.B):
- Reuses Phase 0 spike artifact: bridge process inside a Container
  instance; `BRIDGE_REVISION` env cache-buster + per-deploy
  `CONTAINER_INSTANCE_NAME` increment.
- Same WorkerHost interface as Phase 6.A.
- Substrate selection is profile-level: `profile.yaml` adds
  `runtime.host: 'vps_docker' | 'cloudflare_container'`. Default
  `vps_docker`.
- `wrangler.toml` adds the Container binding only when the binding is
  actually used; Phase 6.A code paths must work with the binding
  absent.

R6. Hook semantics:
- Hooks execute inside the WorkerHost. The control plane never runs
  shell.
- Hook timeouts: `after_create` 60s, `before_run` 30s, `after_run` 60s,
  `before_remove` 30s. These match the existing ts-engine defaults
  unless a profile overrides.
- Hook output is logged to `run_events` with `event_type =
  'hook.{name}.{started|completed|failed}'`. Large output goes to R2.
- A failed hook is a step failure, not a workflow failure: step retry
  policy applies (Phase 5 default 3 retries). A failed hook after
  retries marks the step `failed` and the workflow follows the
  Phase 4 sub-cut 3 `markFailed` path.

R7. Snapshot + redaction:
- Redaction list lives in `profile.yaml` under `runtime.snapshot.redact`.
- Default redaction list: `.env`, `**/.git/`, any path matching
  `**/secret*`, `**/*.key`, `**/auth*.json`, `runtime/log/`.
- Snapshot is written before workspace release; failure to snapshot is
  a soft error that emits a `run_events.warning` but does not fail the
  workflow.
- Snapshot key is deterministic per `(run_id)`, so step retry on
  step 15 (`archiveOrCleanupWorkspace`) is idempotent.

R8. CodingAgentAdapter for codex_compat (Phase 7):
- File: `cf-control-plane/src/agents/codex_compat_adapter.ts`.
- Implements the same contract as `ts-engine/src/agent/codex_adapter.ts`
  and `MockCodingAgentAdapter` from Phase 5.
- Lifecycle: spawns `codex app-server` inside the Phase 6 WorkerHost
  using the persistent-bridge pattern from spikes §13.
- JSON-RPC envelope: identical to Codex 0.128.0 wire format
  (`initialize`, `thread/start`, `turn/start`, `thread/status/changed`,
  `item/started`, `item/agentMessage/delta`, `item/completed`,
  `turn/completed`, `thread/tokenUsage/updated`).
- Tool call routing: `item/started` with a tool-call envelope is
  forwarded to `ToolGateway.handle()`; the result is sent back as the
  Codex tool reply.
- Token usage: parses `thread/tokenUsage/updated` deltas; same shape
  as ts-engine's `agent/codex_adapter.ts`.

R9. Step 8 turn loop on Phase 7:
- Each `step.do('runAgentTurn.{n}', ...)` is **one** Codex turn. Within
  a step, retries are NOT permitted because turn side effects (tool
  calls) are not replay-safe.
- A step failure escalates to a NEW `step.do` for the next attempt,
  with attempt number bumped. Phase 4 sub-cut 3's `IssueAgent.markFailed`
  + alarm is the retry path; the workflow re-enters via a new
  ExecutionWorkflow instance for the new attempt.
- Inside one step (one turn): `codex_compat` either completes the turn
  or the workflow step fails. No within-step retry.

R10. Operator surface additions:
- `GET /api/v1/profiles/:t/:s/runtime` returns the resolved
  `runtime.host` and substrate-identity field for the active version.
- `POST /api/v1/projects/:t/:s/actions/snapshot-now` (admin) forces a
  workspace snapshot for the latest run; useful for Phase 6/7 debug.
- `POST /api/v1/runs/:t/:s/:e/:attempt/actions/peek-workspace` returns
  a presigned R2 URL for the snapshot, gated by `read:state`.

R11. Evaluation corpus seed (forward link to ADR-0002 §4):
- Phase 7.A wrap-up writes `cf-control-plane/scripts/eval-corpus/`
  with a seed runner that exercises 5 issues end-to-end through
  `codex_compat`. The full 30-issue corpus from ADR-0002 §4 is built
  incrementally over Phase 7 + Phase 8.

R12. Phase 6/7 invariants:
- ADR-0001 boundaries unchanged. WorkerHost stays a substrate; the
  control plane never branches on substrate id.
- ADR-0002 reaffirmation: `codex_compat` is the only real coding agent;
  Phase 10 stays deferred.
- The Phase 5 16-step list does NOT grow. Step 8 is the only step that
  changes shape (from mock call to real codex_compat call); steps 3
  and 4 swap their mock bodies for WorkerHost calls; everything else
  is unchanged.
- No new `D1.runs.adapter_kind` value; the existing union
  (`mock`/`codex_compat`/`cloudflare_native`) is sufficient. Phase 6/7
  lights up the `codex_compat` value.

R13. Tests:
- Unit: `WorkerHost` mock + `WorkspaceAdapter` against a fake
  filesystem; idempotency on replay; redaction filter.
- Unit: `codex_compat` JSON-RPC frame parser; tool-call routing;
  token-usage deltas.
- Integration: full Phase 6.A workflow run on dev VPS Docker
  WorkerHost — **at least one mirrored issue completes step 1–step 16
  end-to-end with real codex_compat output and a non-empty manifest**.
- Integration: Phase 6.B same as above on Container, behind a feature
  flag.
- Integration: forced step-3 failure (workspace prep fails) → Phase 4
  retry_wait → re-attempt picks up cleanly with a fresh workspace.
- Integration: redaction list is honored — assertion that the snapshot
  archive does not contain any path on the default redaction list.
- E2E live: deploy Phase 7.A and run 1 real corpus issue end-to-end on
  the live Cloudflare control plane; capture the manifest and the
  16-step grid screenshot.

## 4. Implementation Steps

### Step 1 — Define WorkerHost and WorkspaceHandle types

`cf-control-plane/src/runtime/worker_host.ts` (new):
- `WorkerHost` interface (R2).
- `WorkspaceHandle` value type (substrate id, ref, opaque cookie).
- Discriminated-union return types for hook/shell results.

### Step 2 — VPS Docker WorkerHost adapter (Phase 6.A)

`cf-control-plane/src/runtime/vps_docker_host.ts` (new):
- Calls the existing dev VPS bridge over an authenticated HTTPS
  endpoint; the bridge already supports `prepareWorkspace`,
  `runHook`, `snapshotWorkspace`. Authentication via Worker secret
  `VPS_BRIDGE_TOKEN`.
- Idempotency: workspace creation is keyed by `(tenant, profile, issue)`;
  re-invocation returns the same handle.
- Snapshot: streams the tar.zst from VPS over R2 multipart upload;
  R2 1/sec rate limit is irrelevant because the key is unique per run.

### Step 3 — Workflow step 3 + step 4 swap mock for WorkerHost

`cf-control-plane/src/workflows/execution.ts` (modify):
- Step 3 + step 4 call `WorkspaceAdapter.prepare(...)` and
  `WorkspaceAdapter.materialize(...)`.
- `WorkspaceAdapter` is constructed from a `WorkerHost` chosen by
  profile config (`runtime.host`).
- A `MockWorkerHost` keeps the Phase 5 path alive when
  `runtime.host === 'mock'` (used by tests + the deprecated
  `executeMockRun`).

### Step 4 — Hook execution + R2 snapshot

`cf-control-plane/src/runtime/hooks.ts` (new):
- Maps `after_create | before_run | after_run | before_remove` to
  `WorkerHost.runHook` calls with timeouts from R6.
- Records `run_events` rows with severity-keyed event types.
- Step 5 (`afterCreateHook`), 7 (`beforeRunHook`), 12 (`afterRunHook`)
  in the workflow swap their `skipped` mock bodies for real calls.

`cf-control-plane/src/runtime/snapshot.ts` (new):
- Redaction list resolution from `profile.yaml`.
- R2 multipart upload (5 GiB per object cap is far above any real
  workspace; multipart kept for retention friendliness).
- Step 15 (`archiveOrCleanupWorkspace`) calls `snapshot.run()` then
  `WorkerHost.releaseWorkspace`.

### Step 5 — Cloudflare Container WorkerHost (Phase 6.B)

`cf-control-plane/src/runtime/cloudflare_container_host.ts` (new):
- Reuses the spike's bridge protocol and the persistent-thread
  pattern.
- `wrangler.toml` adds a `[[containers]]` binding only when the
  account has Containers GA enabled.
- A profile that opts into `runtime.host: 'cloudflare_container'`
  uses this host; other profiles continue on VPS Docker.
- Operator runbook in `cf-control-plane/README.md` documents the
  `BRIDGE_REVISION` cache-bust + per-deploy
  `CONTAINER_INSTANCE_NAME` increment from spikes §13.4.

### Step 6 — codex_compat CodingAgentAdapter (Phase 7)

`cf-control-plane/src/agents/codex_compat_adapter.ts` (new):
- Wire-compatible port of `ts-engine/src/agent/codex_adapter.ts`.
- Lifecycle inside WorkerHost: spawn-once → persistent thread →
  `/reset` between issues. The lifecycle is a substrate detail; the
  adapter contract does not leak it.
- JSON-RPC stream parser: handles partial frames, out-of-order
  notifications, and the `bubblewrap` warning + websocket retry
  noise on stderr (per spike REPORT.md §4).
- Tool-call envelope is forwarded to `ToolGateway.handle()`. The
  reply path keeps the JSON-RPC `id` ordering Codex expects.

### Step 7 — Step 8 turn loop wiring to codex_compat

`cf-control-plane/src/workflows/execution.ts` (modify):
- The `runAgentTurnLoop` step body becomes a per-turn `step.do`:
  ```
  for (let n = 1; n <= cfg.agent.maxTurns; n++) {
    await step.do(`runAgentTurn.${n}`, { retries: { limit: 0 } }, async () => {
      const turnResult = await adapter.runTurn(...);
      // record run_events; bail on terminal status
    });
    if (turnResult.terminal) break;
  }
  ```
- `retries.limit: 0` enforces the R9 invariant: tool-call side
  effects must not be replayed.
- Per-turn `run_steps` rows record the granularity for the dashboard.

### Step 8 — Profile schema bump

`cf-control-plane/src/profiles/schema.ts` (modify):
- Add `runtime.host: 'vps_docker' | 'cloudflare_container' | 'mock'`
  with default `vps_docker` for v2 profiles.
- Add `runtime.snapshot.redact: string[]` with default list from R7.
- Importer auto-upgrades v1 → v2 with `runtime.host = 'vps_docker'`.

### Step 9 — Operator routes (R10)

`cf-control-plane/src/worker.ts` (modify):
- Three new routes per R10. All gated by capabilities already in
  Phase 4/5.

### Step 10 — Dashboard surface

`cf-control-plane/src/dashboard/render.ts` (modify):
- Per-run view shows substrate identity (`runtime.host`) for the run.
- Snapshot link (presigned R2 URL) on completed runs.
- Hook output excerpt (first 1 KB) on hook-failed runs.

### Step 11 — Evaluation corpus seed

`cf-control-plane/scripts/eval-corpus/run.ts` (new):
- Reads a corpus manifest at `cf-control-plane/scripts/eval-corpus/corpus.json`.
- Triggers each issue via `POST /api/v1/projects/:t/:s/actions/refresh`
  and waits for the run to terminate.
- Captures the manifest, transcript ref, and key metrics into
  `cf-control-plane/scripts/eval-corpus/results/{date}.json`.
- Phase 7.A ships the runner with a 5-issue seed corpus; full 30
  issues land progressively.

### Step 12 — Tests (R13)

`cf-control-plane/tests/`:
- `worker_host_idempotency.test.ts`
- `worker_host_redaction.test.ts`
- `codex_compat_jsonrpc.test.ts`
- `codex_compat_tool_routing.test.ts`
- `phase6a_e2e.test.ts` (in-memory + fake VPS bridge)
- `phase7a_e2e.test.ts` (in-memory + fake codex bridge with canned
  responses)
- live e2e: tracked by a manual operator runbook in PR-G.

## 5. Suggested PR Breakdown

7 PRs across the two phases, sequenced by dependency. None should
exceed ~600 net lines.

**PR-A — WorkerHost contract + types**
- Step 1. Pure types + a `MockWorkerHost` reference. No production
  behavior change. Stays mergeable independent of substrate work.

**PR-B — VPS Docker WorkerHost (Phase 6.A part 1)**
- Step 2. Real adapter against the dev VPS bridge. Hidden behind a
  feature flag (`runtime.host: 'vps_docker'` opt-in) until PR-C lands.

**PR-C — Workflow steps 3 + 4 swap to WorkerHost**
- Step 3. The workflow now calls real workspace adapters instead of
  emitting mock events. PR-B becomes the live path.

**PR-D — Hooks + snapshot + redaction**
- Step 4. Workflow steps 5/7/12/15 become real. Snapshot writes to R2.

**PR-E — Cloudflare Container WorkerHost (Phase 6.B)**
- Step 5 + Container substrate runbook. Behind feature flag; default
  remains `vps_docker`.

**PR-F — codex_compat adapter (Phase 7.A)**
- Step 6. Adapter ships; not yet wired to step 8.

**PR-G — Step 8 wiring + evaluation corpus seed**
- Step 7 + Step 11. Step 8 stops calling MockCodingAgentAdapter and
  starts calling codex_compat. Eval corpus runner ships with a 5-issue
  seed. End-to-end Phase 7.A live deploy is part of this PR's
  acceptance evidence.

**PR-H (optional, Phase 6.B + 7.B validation)**
- Run the eval corpus through Cloudflare Container substrate as well.
  Document any per-substrate metric divergence.

## 6. File-Level Checklist

- [ ] `cf-control-plane/src/runtime/worker_host.ts` — interface + types
- [ ] `cf-control-plane/src/runtime/mock_worker_host.ts` — replaces ad-hoc
      mock paths
- [ ] `cf-control-plane/src/runtime/vps_docker_host.ts` — Phase 6.A
- [ ] `cf-control-plane/src/runtime/cloudflare_container_host.ts` —
      Phase 6.B
- [ ] `cf-control-plane/src/runtime/hooks.ts` — hook driver
- [ ] `cf-control-plane/src/runtime/snapshot.ts` — R2 snapshot writer
- [ ] `cf-control-plane/src/agents/codex_compat_adapter.ts` — Phase 7
- [ ] `cf-control-plane/src/workflows/execution.ts` — steps 3, 4, 5, 7,
      8, 12, 15 modifications
- [ ] `cf-control-plane/src/profiles/schema.ts` — `runtime.host` +
      redaction
- [ ] `cf-control-plane/src/worker.ts` — 3 new routes
- [ ] `cf-control-plane/src/dashboard/render.ts` — substrate id +
      snapshot link
- [ ] `cf-control-plane/scripts/eval-corpus/run.ts` — corpus runner
- [ ] `cf-control-plane/scripts/eval-corpus/corpus.json` — 5-issue seed
- [ ] `cf-control-plane/wrangler.toml` — `[[containers]]` binding
      (Phase 6.B)
- [ ] `cf-control-plane/README.md` — Phase 6/7 status + Container
      runbook
- [ ] `cf-control-plane/tests/worker_host_idempotency.test.ts`
- [ ] `cf-control-plane/tests/worker_host_redaction.test.ts`
- [ ] `cf-control-plane/tests/codex_compat_jsonrpc.test.ts`
- [ ] `cf-control-plane/tests/codex_compat_tool_routing.test.ts`
- [ ] `cf-control-plane/tests/phase6a_e2e.test.ts`
- [ ] `cf-control-plane/tests/phase7a_e2e.test.ts`
- [ ] `docs/cloudflare-agent-native-target.md` §1150–1196 status sync
- [ ] `docs/cloudflare-agent-native-phase6-7-plan.md` — this file

## 7. Acceptance Criteria

A1. **Phase 6.A end-to-end**: a mirrored issue completes the full
16-step ExecutionWorkflow with real workspace operations on VPS
Docker. The `runs` row has `adapter_kind = 'mock'` (Phase 6 alone
does not change adapter; Phase 7 does), `runtime.host = 'vps_docker'`
on the joined profile, and the snapshot key resolves in R2.

A2. **Hook execution**: `after_create`, `before_run`, `after_run`
hooks for a profile that defines them all run inside the WorkerHost
and emit `hook.{name}.completed` events; `before_remove` runs on
workspace release.

A3. **Workspace idempotency**: re-running step 3 + step 4 via a
forced workflow replay yields the same `WorkspaceRef`; no duplicate
git checkout, no duplicate asset materialization.

A4. **Snapshot redaction**: a snapshot of a workspace containing a
`.env` file, a `.git/` directory, and a path matching `**/secret*`
does **not** contain those entries; manifest references no redacted
paths.

A5. **Phase 6.B feature flag**: a profile with
`runtime.host: 'cloudflare_container'` runs end-to-end on Container
substrate; a profile without that field defaults to `vps_docker` and
behavior matches A1 verbatim.

A6. **Phase 7.A end-to-end**: a single eval-corpus issue completes
through `codex_compat` with at least one real Codex turn that emits
`thread/tokenUsage/updated` and at least one tool call routed
through `ToolGateway`. `runs.adapter_kind = 'codex_compat'`. Manifest
includes a non-empty `token_usage` object.

A7. **Step 8 retry boundary**: forcing a turn-level failure inside
step 8 produces a step failure (not a within-step retry) and routes
through `IssueAgent.markFailed` per Phase 4 sub-cut 3. The next
attempt runs as a new `ExecutionWorkflow` instance with a new
`workflow_instance_id`.

A8. **Tool-call routing parity**: a `linear_graphql` tool call
emitted by `codex_compat` lands in `ToolGateway.handle()` and the
reply round-trips back to Codex with the correct JSON-RPC `id`. A
`tool_calls` D1 row is written with the call envelope refs.

A9. **Eval corpus seed**: `scripts/eval-corpus/run.ts` runs against
a 5-issue seed corpus; results JSON is written to
`scripts/eval-corpus/results/{date}.json`; success rate ≥ 60% on the
seed (acknowledging Phase 7.A bring-up tolerance).

A10. **Phase 6/7 invariants**: no new code path imports
`ts-engine/src/agent/codex_adapter.ts` directly (the port is at
`cf-control-plane/src/agents/codex_compat_adapter.ts`); no workflow
step branches on substrate identity outside the adapter layer; the
16-step list is unchanged in count and order. Grep gate enforces.

A11. `bun test` green; `bunx tsc --noEmit` clean; `make all` green.

A12. Live e2e: PR-G includes a captured manifest + 16-step grid
screenshot from a real corpus issue running on the live Cloudflare
control plane.

## 8. Verification Matrix

| Behavior | How verified | Pass signal |
|---|---|---|
| WorkerHost contract | `worker_host_*` unit tests | Mock + VPS adapter both satisfy interface |
| Workspace idempotency | `phase6a_e2e.test.ts` replay | Single workspace, single git fetch |
| Hook execution | `phase6a_e2e.test.ts` | `hook.*.completed` events present |
| Redaction | `worker_host_redaction.test.ts` | Snapshot tar contains no banned paths |
| Container substrate | `phase6b_e2e.test.ts` (deferred) + manual deploy | Container run completes |
| Codex JSON-RPC parity | `codex_compat_jsonrpc.test.ts` | Frame-by-frame match against canned 0.128.0 fixture |
| Tool routing | `codex_compat_tool_routing.test.ts` | Reply lands with correct id; D1 row written |
| Step 8 retry boundary | `phase7a_retry.test.ts` | New workflow instance on attempt 2 |
| Eval corpus | `scripts/eval-corpus/run.ts` + manual review | Results JSON contains all 5 issues |
| Live e2e | Manual deploy + screenshot | Manifest in R2; dashboard renders 16 steps green |

## 9. Risks and Mitigations

R-1 — **Step 8 within-step retry would compound side effects**.
Cloudflare Workflows retries any failing `step.do` automatically; a
turn that completes a tool call and then fails on a later notification
would be retried, re-invoking the tool.
*Mitigation*: `step.do('runAgentTurn.{n}', { retries: { limit: 0 } }, ...)`.
The Phase 4 sub-cut 3 retry layer (alarm + new ExecutionWorkflow)
owns retry semantics; Workflows step retries are disabled inside
step 8 only. This is enforced by a grep gate in CI.

R-2 — **VPS Docker bridge SSO/auth**. The bridge is an HTTPS endpoint
on dev@74.48.189.45; production must rotate `VPS_BRIDGE_TOKEN`,
support multiple tenant scopes, and survive a host reboot.
*Mitigation*: token + per-tenant principal in the bridge auth
header; bridge process supervised by systemd with a documented
restart procedure. Phase 6.A operator runbook in PR-B.

R-3 — **Container instance lifecycle racing with workflow replay**.
A workflow may resume after a Container instance has been
recreated, invalidating the persistent codex bridge process inside
it.
*Mitigation*: bridge `/reset` endpoint is idempotent; `codex_compat`
re-issues `initialize` + `thread/start` if it sees no active thread.
The lifecycle layer detects "fresh container" via a `bridge_instance_id`
sentinel and re-bootstraps cleanly.

R-4 — **Codex 0.128.0 wire format drift in newer Codex versions**.
Pinning to 0.128.0 is brittle.
*Mitigation*: the JSON-RPC parser is version-tagged; a future Codex
version bump triggers a new parser variant rather than mutating the
existing one. The eval corpus pins a Codex version explicitly.

R-5 — **R2 snapshot key collision on concurrent attempts**. Two
attempts of the same issue could in theory clash on snapshot keys.
*Mitigation*: snapshot key includes attempt number; R2 1/sec same-key
write rate is irrelevant.

R-6 — **Workflow step result 1 MiB cap on large hook output**.
A noisy hook (e.g. `npm install` log) can exceed it.
*Mitigation*: hook output > 4 KB is written to R2 and the step
result carries only the R2 ref. Same pattern as Phase 5 R-5.

R-7 — **`ToolGateway` idempotency contract not yet defined**. Phase 7
calls into `ToolGateway.handle()` for tool calls, but the
idempotency-key contract (target.md §13.1) is a Phase 8 deliverable.
*Mitigation*: Phase 7 lands without idempotency keys; tool calls in
the seed corpus are restricted to **read-only** Linear queries +
filesystem patches. Mutating tool calls (Linear comment write, GitHub
PR create) are deferred to Phase 8 alongside the idempotency contract.

R-8 — **Profile schema v2 → v3 migration**. Adding `runtime.host` is
a non-breaking add (default `vps_docker`); but if `runtime.snapshot.redact`
syntax is wrong (glob vs regex confusion) profiles can subtly break.
*Mitigation*: schema validator enforces glob shape; importer fails
loud on unknown patterns; integration test seeds a profile with the
default redact list.

R-9 — **Cloudflare Container startup latency masks bring-up bugs**.
Cold-start a Container can take 10–30s, hiding race conditions in the
workflow → bridge handshake.
*Mitigation*: Phase 6.B integration test uses warm-cache fixtures;
live e2e adds a 60s grace timeout per step before declaring failure.

R-10 — **VPS substrate is single-host**. Phase 6.A's VPS Docker
WorkerHost runs on one VPS; outage = total bring-down for any
profile pinned to it.
*Mitigation*: out of scope for Phase 6/7. Multi-host VPS Docker is a
Phase 8/Phase 11 hardening concern. Document the single-host risk in
the operator runbook.

R-11 — **Eval corpus drift from real-world issues**. A corpus that
becomes unrepresentative is worse than no corpus.
*Mitigation*: corpus issues are tagged with a `corpus_id` field in
their R2 manifest; quarterly review removes stale issues and adds
new ones drawn from real run history.

## 10. Stop Conditions

S-1. If the VPS bridge cannot be authenticated from a Worker (e.g.
mTLS / IP-allowlist issues that the Worker cannot satisfy), **stop**
PR-B and add a spike `spikes/vps-bridge-auth/`. Phase 6.A blocks until
the auth path is real.

S-2. If `wrangler dev` cannot exercise a `[[containers]]` binding
(local emulation gap), **stop** Phase 6.B's local dev path and accept
a deploy-per-iteration cycle for Container substrate work, OR add a
`FakeContainerHost` to the test harness. Document either choice.

S-3. If `codex_compat` cannot complete a single eval-corpus issue
end-to-end on Phase 6.A within the first PR-G iteration, **stop** and
add a spike `spikes/codex-compat-bringup/`. Do not push past the
acceptance criteria via partial completion.

S-4. If Phase 7 hits the ToolGateway idempotency gap (R-7) sooner
than expected — i.e. the seed corpus turns out to require mutating
tool calls — **stop** Phase 7 wiring (Step 7) and prioritize Phase 8
ToolGateway work first.

S-5. If Phase 4 sub-cut 3 has not landed when PR-G is ready to merge,
**stop** PR-G until sub-cut 3 ships. R9 and A7 both depend on
`IssueAgent.markFailed` and the alarm-driven re-attempt loop.

S-6. If the live Cloudflare Container instance fails to start a
codex bridge after 3 attempts (Phase 6.B integration), **stop** and
re-run the spike `spikes/codex-on-cloudflare/` to verify the bridge
contract is unchanged.

## 11. Phase 8 Readiness Gates

Phase 8 (`Tool registry, policy model, approval flow`, target.md
§1175) can start when:

- All A1–A12 acceptance criteria pass on `main`.
- The `codex_compat` adapter has run the 5-issue seed corpus
  end-to-end at least twice on different days (smoke stability).
- `target.md` §13.1 idempotency contract has been updated to reflect
  the actual ToolGateway boundary that Phase 7 hit (the
  read-only-only constraint in R-7 is documented).
- The eval corpus runner is operationally usable: an operator can
  trigger a corpus run, read the results JSON, and compare two runs.
- Substrate identity (`runtime.host`) is exposed in operator routes
  and dashboard for at least one full operator runbook cycle.
- `D1.runs.adapter_kind = 'codex_compat'` rows are present in
  production data, enabling Phase 8 routing decisions per substrate.

## 12. Out of Scope

- Native Cloudflare CodingAgent (Phase 10; ADR-0002 deferral).
- Multi-host VPS Docker WorkerHost (Phase 8/11 hardening).
- Cloudflare Sandbox WorkerHost (Phase 6.C, deferred).
- ToolGateway idempotency contract / approval flow (Phase 8).
- AI Gateway routing for model traffic (Phase 8 or later).
- Profile schema v3 / additional runtime knobs beyond `runtime.host`
  + `runtime.snapshot.redact`.
- Multi-tenant isolation hardening (Phase 11).
- Production ingestion of the full 30-issue eval corpus (Phase 7
  ships seed; full corpus is incremental).
- Removing the `MockCodingAgentAdapter` from the codebase (it stays
  as a test fixture).

## 13. Estimated Effort

- PR-A: ~0.5 day (types + mock host).
- PR-B: ~1 day (VPS Docker host + bridge auth integration).
- PR-C: ~0.5 day (workflow steps 3/4 swap).
- PR-D: ~1 day (hooks + snapshot + redaction).
- PR-E: ~1 day (Container substrate; spike artifacts ease the work).
- PR-F: ~1.5 days (codex_compat port + JSON-RPC parser + tool routing).
- PR-G: ~1.5 days (step 8 wiring + eval corpus seed + live e2e).
- PR-H: ~0.5 day (Container e2e validation).
- Total: 7.5–8 days end-to-end across two phases including review
  and one live e2e validation run.
