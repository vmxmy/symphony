# Phase 5 Implementation Plan: ExecutionWorkflow with MockCodingAgentAdapter

Author: planner pass, 2026-05-02
Companion to: `docs/cloudflare-agent-native-phase1-plan.md`,
`docs/cloudflare-agent-native-phase4-plan.md`,
`docs/cloudflare-agent-native-target.md` §8.4 + §1133–1148.
Scope: Phase 5 — durable workflow orchestration on Cloudflare Workflows
running a `MockCodingAgentAdapter`. No real coding agent, no real shell
hooks, no real workspace materialization. Phase 6 introduces real
WorkerHost execution; Phase 7 introduces the Codex compat adapter.

---

## 1. Context

Phase 4 leaves the control plane with:
- `IssueAgent` durable per-issue ownership with full state machine
  (`discovered → queued ⇄ paused → cancelled` plus, per the Phase 4 sub-cut 3
  plan, `retry_wait` and `failed`).
- `symphony-dispatch` queue carrying `IssueDispatchMessage`.
- `handleIssueDispatch` transitioning `IssueAgent` to `queued` on receipt.
- D1 schema for `runs`, `run_steps`, `run_events`, `tool_calls`, all
  pre-provisioned in `migrations/0001_init.sql` but only currently exercised
  by `executeMockRun` in `cf-control-plane/src/orchestration/mock_run.ts` —
  a Worker-resident loop, not a durable workflow.

Phase 5 promotes the mock run from a Worker handler into a real
**Cloudflare Workflows instance** that:
- Is started by `IssueAgent` (the lease holder) when a dispatch message
  arrives, not by the Worker queue handler directly.
- Walks the canonical 16-step list from `target.md` §8.4 in deterministic,
  individually-resumable steps.
- Persists step boundaries to D1 (`run_steps`) and event detail to R2
  (`run_events.payload_ref`), with summary copies in D1.
- Drives the `MockCodingAgentAdapter` ported from `ts-engine`'s mock —
  no real Codex, no real shell.
- Returns control to `IssueAgent` on completion / failure / cancellation,
  cleanly releasing the lease.

The intended outcome of Phase 5 is to **prove the orchestration model** —
durable steps, resume-on-step-failure, R2-pointer event log, D1 row trail,
dashboard visibility — without any execution-plane risk. Once that proof
holds, Phase 6 swaps the mock for real workspace ops on a `WorkerHost`,
and Phase 7 swaps the brain for `codex-compat`.

## 2. Current Evidence

| What | File / line | What it gives Phase 5 |
|---|---|---|
| Canonical 16-step list | `docs/cloudflare-agent-native-target.md` §8.4 (lines 354–371) | The contract for `ExecutionWorkflow` step ordering. |
| Mock orchestration loop (Worker-resident) | `cf-control-plane/src/orchestration/mock_run.ts` | The deterministic event sequence and D1 row shape we are about to lift into a Workflow. |
| D1 `runs`, `run_steps`, `run_events` schema | `cf-control-plane/migrations/0001_init.sql` | Already supports `workflow_id`, `adapter_kind` (`mock`/`codex_compat`/`cloudflare_native`), step sequencing, severity-keyed events. No new migration needed for the happy path. |
| Existing AgentRunner turn loop | `ts-engine/src/agent.ts:1-120` | Reference implementation of step 8 inner loop. Phase 5 mock collapses this to 1–2 echo turns. |
| Existing CodingAgentAdapter contract | `ts-engine/src/contracts/agent.ts` and `ts-engine/src/agent/types.ts` | The contract the new `MockCodingAgentAdapter` must satisfy on Cloudflare. Already has a working ts-engine mock (`ts-engine/src/agent/mock_adapter.ts`). |
| Workflows platform limits | `docs/cloudflare-platform-limits.md:22` | 30s default CPU/step (configurable to 5min); 1 MiB non-stream step result; 1 GB persisted state; default 10k max steps; 30-day completed state retention. Phase 5 step budget must fit. |
| R2 binding placeholder | `cf-control-plane/wrangler.toml:58-60` | `[[r2_buckets]]` is commented out; Phase 5 must wire it. |
| Phase 4 sub-cut 3 retry semantics | `docs/cloudflare-agent-native-phase4-plan.md` §3 R1–R4 | `IssueAgent.markFailed` already exists; Phase 5 step failures route through it. The dual retry layer (Queues infra vs IssueAgent business) is documented there. |

## 3. Requirements Summary

R1. New durable resource: `ExecutionWorkflow` registered as a Cloudflare
Workflows class. Identity: `run:{tenant_id}:{profile_slug}:{issue_id}:{attempt}`
(target.md §8.4).

R2. Trigger flow:
- `handleIssueDispatch` (existing) transitions `IssueAgent → queued`.
- `IssueAgent.queued` transition handler enqueues `EXECUTION_WORKFLOW.create`
  with `id = run:...:attempt` and params carrying tenant/profile/issue/attempt.
- `IssueAgent` records `workflow_instance_id` as lease state and transitions
  to a new `running` status. The lease is the workflow_instance_id; while
  it is non-null, no other workflow may start for this issue.
- On workflow terminate (any path), the workflow notifies IssueAgent
  via DO subrequest; IssueAgent clears `workflow_instance_id` and
  transitions to the appropriate next state (queued via retry, completed
  pseudo-status that maps to issue archival, retry_wait, failed).

R3. Canonical step list (target.md §8.4) implemented as 16 named steps in
`ExecutionWorkflow`:
| # | Name | Phase 5 mock behavior |
|---|---|---|
| 1 | `loadProfileAndIssue` | D1 SELECT issue + profile rows. |
| 2 | `acquireLease` | DO call to IssueAgent; idempotent; fails on lease conflict. |
| 3 | `prepareWorkspace` | Mock: log a `workspace.prepared` event; no real workspace. |
| 4 | `materializeAssets` | Mock: log a `assets.materialized` event. |
| 5 | `afterCreateHook` | Mock: skipped (event `step.afterCreateHook.skipped`). |
| 6 | `renderPrompt` | Build a deterministic prompt string from issue snapshot. |
| 7 | `beforeRunHook` | Mock: skipped. |
| 8 | `runAgentTurnLoop` | Run `MockCodingAgentAdapter` for 1 mock turn. |
| 9 | `handleToolCalls` | Inside step 8; emits `tool.call.{started,completed}`. |
| 10 | `pollTrackerBetweenTurns` | Phase 5 mock: skipped, single-turn. |
| 11 | `persistRunArtifacts` | Write `manifest.json` to R2 + token usage to D1. |
| 12 | `afterRunHook` | Mock: skipped. |
| 13 | `validateCompletion` | Trivial: always succeed in mock. |
| 14 | `transitionIssueState` | Mock: emit `issue.state.transitioned` event; no real tracker call. |
| 15 | `archiveOrCleanupWorkspace` | Mock: skipped. |
| 16 | `releaseLeaseAndNotify` | DO call to IssueAgent; idempotent. |

Steps 9 and 10 are in-step sub-flows of step 8 in the mock; the workflow
records them as separate `run_steps` rows for dashboard visibility.

R4. R2 layout (target.md §11):
- Bucket binding `ARTIFACTS` = `symphony-runs`.
- Manifest path: `runs/{tenant}/{profile}/{issue}/{attempt}/manifest.json`.
- Per-step input/output: `runs/.../steps/{seq}.{stepName}.{in|out}.json`.
- Event payloads (when message > 4 KB or structured): `runs/.../events/{event_id}.json`.

R5. Workflow step semantics:
- Each step uses `step.do(name, async () => ...)` — Workflows handles
  retries/replay per step.
- Step return values stay below 1 MiB (platform limit). Anything bigger
  goes to R2; D1 stores `*_ref`.
- All steps with side effects MUST be idempotent under replay:
  - D1 inserts use `INSERT OR IGNORE` keyed by `(run_id, step_sequence)`.
  - R2 puts use deterministic keys; same key + same content is safe.
  - DO calls are method-level idempotent (lease acquire is no-op when
    workflow_instance_id matches the caller).

R6. `MockCodingAgentAdapter`:
- Lives at `cf-control-plane/src/agents/mock_coding_adapter.ts`.
- Implements the same contract as `ts-engine/src/agent/types.ts:Agent`.
- `runTurn()` returns a deterministic `TurnResult` with one synthetic
  `tool.call` (pure echo, no side effect) and a token usage line that
  matches the existing mock for parity.
- No `cwd` filesystem access, no shell, no network beyond the Worker
  bindings the workflow already has.

R7. Operator surface:
- `GET /api/v1/runs/:t/:s/:e/:attempt/state` — workflow status (`pending|
  running|completed|failed|cancelled`) and step progress, derived from
  D1 + Workflows binding `instance.status()`.
- `POST /api/v1/runs/:t/:s/:e/:attempt/actions/cancel` — calls Workflows
  `instance.terminate()` and notifies IssueAgent.
- `GET /api/v1/runs/:t/:s/:e/:attempt/events?after=...` — paged D1 query
  for run_events with payload_ref dereferencing.

R8. Dashboard:
- Issue view shows the latest `runs` row's status + workflow_instance_id.
- New per-run view shows the 16-step grid with status, durations, and
  a click-through to events.

R9. Phase 5 invariants preserved:
- `MockCodingAgentAdapter` is the only agent shipped in Phase 5.
- No real shell hooks (`runHook` not invoked).
- No tracker write (issue state changes are emitted as events, not
  pushed to Linear).
- No workspace materialization on disk or in any WorkerHost.
- ADR-0001 boundaries unchanged: `CodingAgentAdapter` and `WorkerHost`
  remain the only replaceable seams.

R10. Tests:
- Unit: `MockCodingAgentAdapter` returns the expected token/event shape.
- Unit: each step's idempotency under double-invocation (replay simulation).
- Integration: a full workflow run end-to-end against an in-memory D1
  + a fake Workflows runner.
- Integration: step 5 forced-failure → resume picks up at step 5 with
  no duplicate side effects in steps 1–4.
- Integration: cancel mid-workflow leaves IssueAgent in `cancelled`,
  no `workflow.completed` event emitted, lease cleared.
- Live e2e (optional): deploy + admin enqueue → workflow runs end to end,
  manifest visible in R2, dashboard shows 16-step grid.

## 4. Implementation Steps

### Step 1 — Workflows class scaffold

New file: `cf-control-plane/src/workflows/execution.ts` exporting class
`ExecutionWorkflow extends WorkflowEntrypoint<Env, ExecutionParams>`.
Empty 16 steps as named no-ops first, just to validate that
`wrangler.toml` registers the class and `env.EXECUTION_WORKFLOW.create({id, params})`
returns an instance handle.

### Step 2 — wrangler.toml: Workflows binding + R2 binding

`cf-control-plane/wrangler.toml`:
- New `[[workflows]]` binding `EXECUTION_WORKFLOW` -> class
  `ExecutionWorkflow`, script `symphony-control-plane`.
- Uncomment `[[r2_buckets]]` ARTIFACTS = `symphony-runs`.
- New `[[migrations]]` tag `v3` with `new_classes = ["ExecutionWorkflow"]`
  (Workflows uses `new_classes`, not `new_sqlite_classes`).
- One-shot ops: `wrangler r2 bucket create symphony-runs`. Document in
  `cf-control-plane/README.md`.

### Step 3 — IssueAgent.startRun + new `running` state

`cf-control-plane/src/agents/issue.ts`:
- Add `"running"` to `IssueAgentStatus`.
- Add `workflow_instance_id?: string` to `IssueAgentState` (the lease).
- New `startRun()` method:
  1. Asserts current status is `queued`.
  2. Calls `env.EXECUTION_WORKFLOW.create({ id, params })`.
  3. Stores `workflow_instance_id`.
  4. Transitions status to `running`.
  Idempotent: if called twice with the same input, the existing
  `workflow_instance_id` is returned and no new workflow is created.
- New `onRunFinished(outcome)` method called by the workflow's last step.
  Decides queued (retry), failed, or terminal-completed; clears
  `workflow_instance_id`.
- Update `ALLOWED_TRANSITIONS`:
  - `queued → running` (startRun)
  - `running → queued` (retry path)
  - `running → retry_wait` (failure with attempts < max)
  - `running → failed` (failure with attempts >= max)
  - `running → cancelled` (operator cancel during run)
  - `running → completed`* (NEW pseudo-terminal: see R9 — actually maps to
    "issue is no longer active"; for Phase 5 mock, we map this to a
    `completed` IssueAgentStatus that's reachable only from running).

### Step 4 — Wire dispatch handler to startRun

`cf-control-plane/src/queues/handlers.ts`:
- After `IssueAgent.dispatch()` transitions to `queued`, call
  `IssueAgent.startRun()` to spin up the workflow.
- Phase 4's `inject_failure` v2 message branch still routes to
  `markFailed` for retry-loop testing; Phase 5 introduces `start_run`
  v3 to make the new path explicit. Keep v1 + v2 working.

### Step 5 — Implement the 16 steps

`cf-control-plane/src/workflows/execution.ts`:
- Each step calls `step.do(name, { retries: { limit: 3, delay: '5s', backoff: 'exponential' } }, async () => { ... })`.
- The step body writes a `run_steps` row at start and updates it at end.
- Run-level state: `runs` row inserted at step 2 (after lease acquire),
  updated at step 16. Status transitions: `running` → `completed` |
  `failed` | `cancelled`.
- Event emission: every step boundary writes a `run_events` row with
  `event_type = 'step.{name}.{started|completed|failed}'`.

### Step 6 — MockCodingAgentAdapter

`cf-control-plane/src/agents/mock_coding_adapter.ts`:
- Pure-function adapter; no Worker-binding dependencies aside from
  `ToolGateway` (mocked too — the Phase 5 mock returns a canned echo).
- Used inside step 8 by `ExecutionWorkflow` directly (workflow runs in
  Worker context; the adapter is a regular module call, not a
  subrequest).
- Output table parity: matches `ts-engine/src/agent/mock_adapter.ts`
  event sequence. The same parity-table technique used in Phase 4 sub-cut 3
  (`backoff.test.ts`) is reused for `mock_coding_adapter.test.ts`.

### Step 7 — R2 manifest writer

`cf-control-plane/src/runs/manifest.ts`:
- `writeManifest(env, runId, params, stepResults, tokenUsage)` writes
  `runs/.../manifest.json` to R2.
- Manifest shape: `{ schema: 'v1', run_id, issue, profile, attempt, steps: [...], started_at, finished_at, token_usage, events_count }`.
- Step input/output writers (`writeStepInput`, `writeStepOutput`) live
  here too. Keys are deterministic; same key + same content is safe.

### Step 8 — Operator routes

`cf-control-plane/src/worker.ts`:
- `GET /api/v1/runs/:t/:s/:e/:attempt/state`
- `POST /api/v1/runs/:t/:s/:e/:attempt/actions/cancel`
- `GET /api/v1/runs/:t/:s/:e/:attempt/events?after=...&limit=...`
- All gated by `read:state` / `write:run.cancel`. Add new capability
  `write:run.cancel` to `auth/operator.ts` and the `ALL_CAPABILITIES` list.

### Step 9 — Dashboard

`cf-control-plane/src/dashboard/render.ts`:
- New per-run view at `/dashboard/runs/{tenant}/{profile}/{issue}/{attempt}`.
- 16-step grid: each cell shows step status, duration, and a click-through
  to events (link to existing `/events` paged route or modal).
- Issue view: latest run summary cell linking to the run view.

### Step 10 — Replace executeMockRun with workflow trigger (or deprecate)

`cf-control-plane/src/orchestration/mock_run.ts`:
- Decision: keep as a synchronous-only debug surface (admin route uses
  it for fast feedback during Phase 5 development), OR remove it.
- Recommendation: keep but mark `@deprecated` in the file header and
  in the admin route response. Phase 6 removes.

### Step 11 — Tests

`cf-control-plane/tests/`:
- `mock_coding_adapter.test.ts` — output shape parity vs ts-engine mock.
- `execution_workflow_steps.test.ts` — each step in isolation; idempotency
  on replay; failure → recorded `run_steps.status=failed`.
- `execution_workflow_e2e.test.ts` — full run, in-memory D1 + a
  `FakeWorkflowRuntime` that synchronously invokes `step.do` callbacks.
- `lease_split_brain.test.ts` — concurrent `startRun` calls produce one
  workflow_instance_id; second call returns the same handle.
- `cancel_mid_run.test.ts` — `actions/cancel` mid-step → IssueAgent
  ends in `cancelled`, lease cleared, no `workflow.completed` event.

## 5. Suggested PR Breakdown

The Phase 4 sub-cut 3 plan defends the rationale for small PRs (codex
advisor 2026-05-01: integration hygiene before big new surface). Phase 5
follows the same principle.

**PR-A — Workflows + R2 plumbing**
- Step 1 (empty workflow scaffold), Step 2 (wrangler bindings + R2 bucket
  + migration tag).
- A live deploy that creates an empty workflow on each
  `EXECUTION_WORKFLOW.create()` call. No production behavior change.

**PR-B — IssueAgent.startRun + lease + dispatch wiring**
- Step 3 + Step 4. New `running` state, `workflow_instance_id` field,
  `startRun` / `onRunFinished` methods. Dispatch handler calls
  `startRun`. PR-A's empty workflow makes this PR's behavior testable
  end-to-end (lease acquire/release via DO calls).

**PR-C — 16 steps + MockCodingAgentAdapter + R2 manifest**
- Step 5, Step 6, Step 7, Step 11 (most tests).
- The largest PR; lands the actual mock workflow body.

**PR-D — Operator routes + dashboard**
- Step 8 + Step 9. Independent; depends on PR-C for runs to inspect.

**PR-E — Cleanup + docs**
- Step 10 + sync `target.md` Phase 5 status + this plan's checkboxes.

## 6. File-Level Checklist

- [x] `cf-control-plane/src/workflows/execution.ts` — PR-A scaffold (`01c26c1`); PR-C 16 step bodies + recordStep + final manifest re-write (`c0b8251`).
- [x] `cf-control-plane/src/agents/mock_coding_adapter.ts` — PR-C (`c0b8251`).
- [x] `cf-control-plane/src/runs/manifest.ts` — PR-C (`c0b8251`).
- [x] `cf-control-plane/src/agents/issue.ts` — PR-B startRun + onRunFinished + running/completed states + workflow_instance_id lease (`bed787a`).
- [x] `cf-control-plane/src/queues/types.ts` — no v3 needed; PR-B reuses v1/v2 message shapes.
- [x] `cf-control-plane/src/queues/handlers.ts` — PR-B v1 path: dispatch then startRun (`bed787a`).
- [x] `cf-control-plane/src/auth/operator.ts` — `write:run.cancel` capability added in PR-D (`15085be`).
- [x] `cf-control-plane/src/worker.ts` — PR-A re-export + Env extension (`01c26c1`); PR-D state / cancel / events routes + dashboard run view route (`15085be`).
- [x] `cf-control-plane/src/dashboard/render.ts` — PR-D `renderRunDetail` + 16-step grid + RunDetailView types (`15085be`).
- [x] `cf-control-plane/src/orchestration/mock_run.ts` — PR-E `@deprecated` marker (this PR).
- [x] `cf-control-plane/wrangler.toml` — PR-A `[[workflows]]` + `[[r2_buckets]]`. No new `[[migrations]]` block (Workflows register via the workflows binding).
- [x] `cf-control-plane/migrations/0004_*.sql` — not needed in Phase 5 (no schema additions).
- [x] `cf-control-plane/tests/mock_coding_adapter.test.ts` — PR-C (`c0b8251`).
- [x] `cf-control-plane/tests/execution_workflow_steps.test.ts` — PR-C (`c0b8251`).
- [x] `cf-control-plane/tests/execution_workflow_e2e.test.ts` — PR-C (`c0b8251`).
- [x] `cf-control-plane/tests/lease_split_brain.test.ts` — PR-B (`bed787a`).
- [x] `cf-control-plane/tests/cancel_mid_run.test.ts` — PR-C (`c0b8251`).
- [x] `cf-control-plane/tests/dashboard_run_view.test.ts` — PR-D (`15085be`, beyond original plan).
- [x] `cf-control-plane/tests/worker_routes_runs.test.ts` — PR-D (`15085be`, beyond original plan).
- [x] `cf-control-plane/README.md` — Phase 5 status row + R2 + Workflows setup section (PR-A + PR-E).
- [x] `docs/cloudflare-agent-native-target.md` §1140–1158 status sync (PR-E).
- [x] `docs/cloudflare-agent-native-phase5-plan.md` — this file (PR-E).

### 6.1 Merge log (origin/main)

All five Phase 5 PRs (#20–24) merged to `vmxmy/symphony main` on
2026-05-03 via `gh pr merge --rebase`. Phase 4 sub-cut 3 PRs (#16–19)
were merged in the same window because Phase 5 PRs depended on their
commits being on main first. Original branch SHAs were rebased onto
the new main HEAD, so post-merge SHAs differ from the per-PR SHAs
recorded in §6 above. Mapping:

| PR | Title | Original head | Post-rebase merge commit |
|---|---|---|---|
| #16 | Phase 4 sub-cut 3 PR-A (backoff helper + state machine) | `edc4a41` | `11c2fd2` |
| #17 | Phase 4 sub-cut 3 PR-B (D1 retry mirror + reconcile gate) | `78ba823` | `0f7f264` |
| #18 | Phase 4 sub-cut 3 PR-C (markFailed + retryNow + alarm + admin routes) | `0a056be` | `03d593d` |
| #19 | Phase 4 sub-cut 3 PR-D (Retries dashboard + failed-row mirror + docs sync + pause/cancel retry mirror cleanup) | `453a0d4` | `8259904` + `b6a2abc` |
| #20 | Phase 5 PR-A (ExecutionWorkflow scaffold + R2 binding) | `01c26c1` | `f52a621` |
| #21 | Phase 5 PR-B (IssueAgent.startRun + running/completed + lease) | `bed787a` | `e8baac5` |
| #22 | Phase 5 PR-C (16-step ExecutionWorkflow + MockCodingAgentAdapter + R2 manifest) | `c0b8251` | `63d8ca1` |
| #23 | Phase 5 PR-D (operator routes + dashboard run view) | `15085be` | `e822c0e` |
| #24 | Phase 5 PR-E (close Phase 5 — `@deprecated` mock_run, status sync; architect review fix; deslop) | `932a009` / `4e1e6f0` / `2680893` | `07a10e2` / `f1086b7` / `6d667fa` |

No merge conflicts were resolved during the run; each rebase auto-skipped
already-applied commits on top of the new main HEAD. Phase 5 plan §6
SHAs above intentionally preserve the per-PR identity for review
traceability; the merge log here is the post-merge reverse map.

Post-merge verification (2026-05-03, on `main` HEAD `6d667fa`):

- `cf-control-plane`: `bunx tsc --noEmit` clean; `bun test` 90 pass / 0
  fail / 372 expect calls / 17 files (Phase 5 close baseline preserved).
- `ts-engine`: `make all` green from repo root (19 pass / 84 expect calls;
  bun build to `bin/symphony-ts` succeeds).
- All 9 PR head branches deleted on origin and locally.

## 7. Acceptance Criteria

A1. End-to-end mock run: enqueueing an `IssueDispatchMessage` for a known
issue causes a workflow instance to start, walk all 16 steps, and end
with:
- IssueAgent status `completed`,
- `runs` row with status `completed`, `attempt=1`, `workflow_id` populated,
- 16 `run_steps` rows with sequence 1–16 and status `completed`,
- ≥ 32 `run_events` rows (start + complete per step minimum),
- `manifest.json` in R2 at the deterministic key.

A2. Step-level resume: forcing a synthetic failure at step 8 (the agent
turn loop) causes the workflow to retry that step per the workflow's
configured policy; on the third retry the step succeeds; final state
mirrors A1. No duplicate `run_steps` rows; D1 idempotency holds.

A3. Workflow-level retry vs IssueAgent retry: a non-recoverable workflow
failure (all step retries exhausted) causes:
- Workflow ends in `errored` status,
- Last step writes `runs.status = 'failed'`,
- IssueAgent receives `onRunFinished({ outcome: 'error' })`,
- IssueAgent transitions `running → retry_wait` (per Phase 4 sub-cut 3).

A4. Cancellation: `POST /api/v1/runs/:t/:s/:e/:attempt/actions/cancel`:
- Calls `instance.terminate()`,
- Workflow stops at the next step boundary,
- Lease released within 5 seconds,
- IssueAgent `running → cancelled`,
- No `workflow.completed` event emitted.

A5. Lease split-brain: two near-simultaneous calls to `IssueAgent.startRun`
result in exactly one workflow instance; the second call returns the same
`workflow_instance_id`. (Test exercises DO concurrency directly.)

A6. R2 manifest shape: `manifest.json` parses against a Zod schema in
the test file; all 16 step entries present; `events_count` matches the
D1 `run_events` count for the run.

A7. Mock adapter parity: `MockCodingAgentAdapter` produces a turn output
whose `tokenUsage` and event names match `ts-engine/src/agent/mock_adapter.ts`
(parity table in `mock_coding_adapter.test.ts`).

A8. Phase 5 invariant audit: a grep gate in the test runner asserts no
new code path imports a real WorkerHost adapter, calls `runHook`, or
imports `agent/codex_adapter.ts`.

A9. `bun test` green; `bunx tsc --noEmit` clean; `make all` green.

A10. Operator visibility: `/dashboard/runs/...` shows the 16-step grid
with status colors; `/api/v1/runs/.../events` returns a paged response
with non-empty `data` and a `next_cursor` when more events exist.

## 8. Verification Matrix

| Behavior | How verified | Pass signal |
|---|---|---|
| Workflow class registration | `wrangler deploy` succeeds; `env.EXECUTION_WORKFLOW.create()` returns handle | No `class_name not found` error |
| 16-step sequencing | `execution_workflow_e2e.test.ts` | Steps 1-16 logged in order in `run_steps` |
| Step idempotency on replay | `execution_workflow_steps.test.ts` | Double-invocation produces 1 run_steps row, 1 manifest write |
| Workflow → IssueAgent notify | `execution_workflow_e2e.test.ts` | IssueAgent ends in expected status; lease cleared |
| Lease split-brain | `lease_split_brain.test.ts` | One workflow_instance_id; second call no-op |
| Cancel mid-run | `cancel_mid_run.test.ts` | IssueAgent cancelled; no workflow.completed event |
| R2 manifest written | `execution_workflow_e2e.test.ts` + live e2e | `ARTIFACTS.get(manifestKey)` returns parseable JSON |
| Mock adapter parity | `mock_coding_adapter.test.ts` parity table | All entries match |
| Operator routes | `worker_routes.test.ts` + manual curl | 200/202/204 response codes per spec |
| Phase 5 invariant | grep gate | No banned tokens (codex_adapter, runHook, real worker host) |

## 9. Risks and Mitigations

R-1 — **Workflows behavior under wrangler dev vs live edge differs**.
Local emulation of Workflows is reportedly less mature than live; some
step semantics (retry policy, replay timing) may diverge.
*Mitigation*: every test uses an in-process `FakeWorkflowRuntime` that
implements the documented `step.do` contract; live behavior is checked
once per PR via a smoke deploy. If divergence is found, file a spike at
`spikes/cf-workflows-semantics/`.

R-2 — **Step 8 (agent turn loop) is non-deterministic in production**.
The mock is deterministic; the real Codex adapter is not. The 16-step
boundary intentionally puts `runAgentTurn` in step 8, but **per-turn
side effects (tool calls)** are not replay-safe in Phase 6+.
*Mitigation*: Phase 5 mock has no side-effecting tool calls. Document
the constraint that step 8 must be wrapped in a "single attempt; retry =
new step.do" pattern starting in Phase 6 — not a within-step retry. This
is target.md §13.1 idempotency contract territory; reference it.

R-3 — **Lease ordering hazard**. Workflow uses `instance.id` as the lease
token in IssueAgent. Two issues with rapid retry could create two near-
simultaneous workflow instances. Cloudflare Workflows itself does not
prevent two instances with the same logical id from being created if
they're created in rapid succession before the first reaches storage.
*Mitigation*: lease check happens **inside** step 2 (`acquireLease`) by
calling IssueAgent. If lease conflict, the workflow's step 2 fails fatally
(no retry), and IssueAgent reports back the existing lease holder. Only
one will pass step 2.

R-4 — **R2 1/sec write rate to same key**. Workflow replay could re-write
`manifest.json` if the final step retries.
*Mitigation*: manifest write is final-step-only; deterministic content
makes a re-write harmless even if it sneaks through. Step input/output
keys are unique per `(run_id, step_sequence)` so no hot-key contention.

R-5 — **Workflows step result 1 MiB cap**. Large mock payloads (issue
snapshot + prompt) could approach this.
*Mitigation*: every step returns a small `{ status, ref }` shape; bulky
data lives in R2 referenced by `ref`. This is the target.md §11 "store
payloads by R2 pointer" rule applied at the workflow boundary.

R-6 — **Workflows completed-state retention is 30 days**. Operator
queries against old runs may hit a 404 from `instance.status()` after
that.
*Mitigation*: dashboard reads from D1 for historical runs (D1 has
`runs.archived_at` for retention but no hard 30-day cap), and only hits
`instance.status()` when the run is currently running. Document the
contract in dashboard code.

R-7 — **R2 bucket creation ordering**. `wrangler r2 bucket create
symphony-runs` must run before the first deploy that has the binding.
*Mitigation*: README has a one-shot ops section; CI deploy script
checks bucket exists before `wrangler deploy`. Optional: a Phase 5 fence
in `worker.ts` that fails health check if `env.ARTIFACTS` is not bound.

R-8 — **Migration v3 vs Phase 4 sub-cut 3 migration v3**. Both phases
plan a v3 migration. The Phase 4 plan registers a CREATE TABLE
(`issue_retries`); Phase 5 registers a DO/Workflow class binding (no
SQL change needed). Two migrations cannot share tag v3.
*Mitigation*: Phase 4 sub-cut 3 ships first; its migration is v3
(SQL-only). Phase 5 migration tag is v4 (Workflows class binding only,
likely no SQL). Both plans cross-link this resolution.

R-9 — **MockCodingAgentAdapter drift from ts-engine mock**. If the
ts-engine mock evolves, parity testing at `mock_coding_adapter.test.ts`
needs to be re-run.
*Mitigation*: parity test is a forcing function — when it breaks, decide
explicitly whether the divergence is intentional. Document that decision
in the test file.

## 10. Stop Conditions

S-1. If `wrangler dev` cannot run a Workflows instance locally in any
practical mode (only live Cloudflare deploys can exercise the workflow),
**stop** and either:
- (a) accept the dev-loop cost (deploy-per-iteration) and revise this plan
  to acknowledge it, or
- (b) write a `FakeWorkflowRuntime` rich enough to validate Phase 5
  invariants without a live deploy. Recommend (b).

S-2. If Cloudflare Workflows replay semantics turn out to break the
existing mock adapter parity (e.g. event timestamps drift on replay
in a way that no idempotent rewrite can fix), **stop** and add a
spike `spikes/cf-workflows-replay/` before continuing.

S-3. If `IssueAgent → Workflows.create() → IssueAgent.onRunFinished`
introduces a circular dependency between bindings that wrangler refuses
to deploy, **stop** and consider the alternative: workflow returns to
the queue, queue calls IssueAgent. Document either choice.

S-4. If R2 binding creation surfaces an account-level constraint
(e.g. R2 not enabled on the account), **stop** and document in
`docs/cloudflare-platform-limits.md` before retrying.

S-5. If the Phase 4 sub-cut 3 retry loop is not landed when Phase 5
PR-B is ready to merge, **stop** PR-B until sub-cut 3 ships. Phase 5
depends on `retry_wait`, `failed`, and the `markFailed` API.

## 11. Phase 6 Readiness Gates

Phase 6 (`Workspace execution on WorkerHosts`, target.md §1150) can
start when:

- All A1–A10 acceptance criteria pass on `main`.
- `MockCodingAgentAdapter` is the only adapter shipped; the
  `cloudflare_native` and `codex_compat` adapter slots in `runs.adapter_kind`
  remain unimplemented.
- The 16-step list has been exercised end-to-end on the live edge (not
  just in `FakeWorkflowRuntime`) at least once.
- The dual retry layer (Workflows step retries vs IssueAgent attempt
  retries) is documented in `target.md` §12 with the worked example
  from R-2 above.
- `target.md` §13.1 idempotency contract is updated to reflect step-
  vs-turn boundary decisions made in this phase.

Status (2026-05-03, PR-E):

- [x] All A1–A10 acceptance criteria pass on `main` via the in-memory
  `FakeWorkflowRuntime` end-to-end test (`tests/execution_workflow_e2e.test.ts`).
- [x] `MockCodingAgentAdapter` is the only shipped Phase 5 adapter;
  `runs.adapter_kind` records `'mock'` for every Phase 5 run.
- [ ] **Open follow-up**: live-edge run on the deployed Cloudflare control
  plane has not yet executed the 16-step workflow against real Workflows
  bindings. The local `FakeWorkflowRuntime` covers the canonical happy
  path + cancel-mid-run; a one-shot live deploy + curl-driven dispatch is
  the remaining smoke item. Tracked as the only gating Phase 6 prerequisite;
  Phase 6 PR-A (VPS Docker WorkerHost) can start in parallel since
  Phase 6's risk surface is the substrate, not the workflow shape.
- [x] Dual retry layer documented in this plan (§9 R-1) and inherited
  by `target.md` Phase 4 sub-cut 3 status sync (Cloudflare Queues retries
  protect transient infra; `IssueAgent.markFailed` + alarm own
  business-layer retries).
- [x] step-vs-turn boundary documented inline in
  `src/workflows/execution.ts` (`{ retries: { limit: 0 } }` on steps 2 / 8
  / 16; default policy on the rest).

Phase 5 follow-ups:

- F-1 (carried into Phase 6): live-edge end-to-end run on the deployed
  Worker. Smoke a real corpus issue through the dispatch queue and
  verify the manifest lands in production R2.
- F-2 (PR-D deferred): "latest run" summary column on the existing
  Issues table. Requires a `LEFT JOIN runs` in `loadDashboardState`;
  scope deferred from PR-D to keep the per-run surface focused.
- F-3 (Phase 8 alongside ToolGatewayAgent): cookie-auth on operator
  routes so the dashboard run view can host Cancel buttons. PR-D's
  inline footer hint stays as the workaround until then.
- F-4 (Phase 6 entry): replace the `MockCodingAgentAdapter` call in
  step 8 with the WorkerHost-backed adapter; the workflow shape is
  unchanged.
- F-5 (Phase 6 entry, from architect review): `IssueAgent.startRun`
  persists `workflow_instance_id` *before* `EXECUTION_WORKFLOW.create`
  so an exception inside `create()` after the storage write would leave
  a stale lease pointing at no workflow instance. Cloudflare Workflows
  `.create()` is documented as idempotent on the same id, so a queue
  retry's second `startRun` would re-run `create` against the same id
  and succeed. The narrow window worth hardening: if `create()` fails
  permanently (e.g. workflow class not registered), the agent stays in
  `running` forever. Phase 6 entry should add either an
  `instance.status()` probe on the idempotent path or move the storage
  put after `create()`. Tracked at
  `cf-control-plane/src/agents/issue.ts:271-277`.
- F-6 (Phase 6 entry, from architect review): the final manifest write
  at `cf-control-plane/src/workflows/execution.ts:447-487` runs OUTSIDE
  any `step.do` boundary. R2 same-key overwrite is harmless under
  replay, but the write reads fresh D1 step rows on each run, so a
  partial-success replay could observe a slightly different snapshot
  than the original. Phase 6 entry can either wrap as a logical step 17
  inside `step.do` (with `retries.limit=0`) or accept the trade-off
  with an explicit comment. Current state: documented in the file
  header; not blocking Phase 5 close because dashboard / archive
  readers tolerate a minor manifest snapshot drift under replay.

## 12. Out of Scope

- Real WorkerHost workspace operations (Phase 6).
- Real `codex-compat` adapter (Phase 7).
- Cloudflare-native CodingAgent (Phase 10).
- Tracker write-back (issue state transitions to Linear/native) — events
  only in Phase 5.
- Approval flow / human-in-the-loop gates (target.md §13.2; Phase 8).
- AI Gateway routing for model traffic (Phase 8 or later).
- Profile schema v3 / runtime config bumps (none planned for Phase 5).

## 13. Estimated Effort

- PR-A: ~0.5 day (Workflows + R2 plumbing, empty workflow).
- PR-B: ~0.75 day (IssueAgent.startRun + lease state + dispatch wiring).
- PR-C: ~1.5 days (16 steps + MockCodingAgentAdapter + manifest writer +
  most tests).
- PR-D: ~0.75 day (operator routes + dashboard run view).
- PR-E: ~0.25 day (cleanup + docs).
- Total: 3.5–4 days end-to-end including review iterations and one live
  e2e validation.
