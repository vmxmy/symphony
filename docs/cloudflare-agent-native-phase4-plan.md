# Phase 4 Implementation Plan: IssueAgent retry_wait + failed states + alarm-driven backoff

Author: planner pass, 2026-05-02
Companion to: `docs/cloudflare-agent-native-phase1-plan.md`,
`docs/cloudflare-agent-native-target.md` §1115–1131.
Scope: Phase 4 sub-cut 3 (the final sub-cut of Phase 4). Sub-cuts 1 and 2 are
already merged on `main` (`6932964`, `f529208`). Sub-cut 3 closes Phase 4 by
adding the retry/backoff state machine and the alarm-driven re-dispatch loop
required by `target.md` §1115–1131.

---

## 1. Context

Phase 4 is *durable per-issue ownership without coding workloads*. Sub-cuts 1
and 2 landed:

- **sub-cut 1** (`6932964`): `IssueAgent` DO class, identity scheme, state
  machine `discovered → queued ⇄ paused → cancelled`, operator routes for
  dispatch/pause/resume/cancel, `write:issue.transition` capability,
  v2 wrangler migration that registers `IssueAgent` as a sqlite class.
- **sub-cut 2** (`f529208`): `symphony-dispatch` queue + DLQ,
  `IssueDispatchMessage` discriminated-union member, `handleTrackerRefresh`
  enqueues one dispatch per `kind === "dispatch"` decision from the reconcile
  harness, `handleIssueDispatch` routes to `IssueAgent.dispatch()`.

What is **missing** from Phase 4 exit criteria (`target.md` §1127–1131):

1. `Retry/backoff state` — there is no `retry_wait` or `failed` status today;
   `ALLOWED_TRANSITIONS` in `cf-control-plane/src/agents/issue.ts:50-55`
   has no edges into a retry state and no terminal-but-resumable failure state.
2. `Retry/backoff behavior matches current State.scheduleRetry semantics` —
   the ts-engine baseline (`ts-engine/src/state.ts:123-159`,
   `ts-engine/src/orchestrator.ts:124-147`) does the work today; the CF path
   has no equivalent.
3. `Dashboard can show queued/running/retrying/paused/terminal issue state` —
   the `retrying` half of that is unimplemented.

Phase 5 (ExecutionWorkflow) does NOT enter scope here. There is no real run
lifecycle, no `running` state, no `agent_state` column on `D1.issues`, no
`workflow_instance_id` lease. Phase 4 sub-cut 3 keeps the same invariant as
sub-cuts 1 and 2: **no execution starts**.

The intended outcome: when a dispatched issue fails (synthetically injected
in Phase 4; for-real once Phase 5 lands), the IssueAgent moves to
`retry_wait`, an alarm is set per `nextBackoffMs(attempt)`, the alarm fires,
the dispatch is re-enqueued, and the agent transitions back to `queued`. After
a configurable max attempts, the agent moves to `failed` instead of
`retry_wait`; `failed` is terminal-but-operator-resumable.

## 2. Current Evidence

| What | File / line | What it gives Phase 4 sub-cut 3 |
|---|---|---|
| Backoff math (verbatim port target) | `ts-engine/src/state.ts:152-159` | `nextBackoffMs(attempt, max, base=1000) = min(max, base * 2^(attempt-1))` per SPEC §11. |
| Retry state shape | `ts-engine/src/state.ts:13-18, 123-149` | `RetryEntry { issueId, issueIdentifier, attempt, dueAt, error, ... }`; `scheduleRetry` increments attempt; `clearRetry` on dispatch. |
| Retry decision callsite | `ts-engine/src/orchestrator.ts:124-147` | `max_turns_exceeded` → 1s short retry; generic `error` → exponential backoff via `nextBackoffMs`. |
| Reconcile decision shape | `cf-control-plane/src/reconcile/types.ts:32-37, 80-85` | Already carries `RetryEntry` input + emits `dispatch` decisions with `attempt`. The harness output is the contract — a Phase 4 dispatch decision MUST only fire when `RetryEntry.dueAt` is in the past. Currently true (see `tick.ts:110-113`). |
| Queue retry policy | `cf-control-plane/wrangler.toml:75-95` | `max_retries=3`, DLQ `symphony-dispatch-dlq`. This is the **infra layer** retry; IssueAgent attempts are the **business layer** retry — these stay separate. |
| Existing IssueAgent | `cf-control-plane/src/agents/issue.ts` | State machine + storage; needs new statuses, alarm handler, attempt persistence. |
| Existing dispatch handler | `cf-control-plane/src/queues/handlers.ts:80-115` | `handleIssueDispatch` already calls `IssueAgent.dispatch` — extension point for failure routing once Phase 5 reports outcomes. |

## 3. Requirements Summary

R1. `IssueAgent` MUST support two new statuses: `retry_wait` and `failed`.

R2. State transitions:
- `queued → retry_wait` (failure with attempts < max)
- `queued → failed` (failure with attempts >= max)
- `retry_wait → queued` (alarm fires AND status still retry_wait)
- `retry_wait → cancelled` (operator cancel)
- `retry_wait → paused` (operator pause)
- `failed → queued` (operator-driven resume; attempt counter NOT reset)
- `failed → cancelled` (operator cancel of a terminal-but-resumable failure)

R3. Backoff math: a verbatim port of `ts-engine/src/state.ts:nextBackoffMs`
shall live in `cf-control-plane/src/agents/backoff.ts` so it can be unit-tested
independently. The math, base, and cap MUST match SPEC §11 byte-for-byte.

R4. Alarm: when entering `retry_wait`, IssueAgent calls
`this.ctx.storage.setAlarm(nextRetryAt)`. The `alarm()` handler:
- Reads current state from storage.
- If status is not `retry_wait`, no-ops (cancellation race).
- Else enqueues an `IssueDispatchMessage` on `env.DISPATCH` with the next
  `attempt`, then transitions `retry_wait → queued` exactly like
  `IssueAgent.dispatch` does today.

R5. Reconcile harness MUST NOT emit a `dispatch` decision for issues whose
retry due_at is still in the future, or whose due_at is empty/null because
the row represents failed-state visibility. Sub-cut 3 must therefore mirror
retry state to a queryable surface that `reconcileTick` can read; doing it
via per-issue DO subrequest fan-out is too expensive — mirror to D1 instead.

R6. `D1` migration v3 MUST add the retry mirror without breaking sub-cut 2's
schema. New table `issue_retries` (one row per issue when retrying or failed;
failed rows use `due_at = ""`; rows are DELETEd when an operator/scheduler
transitions the issue back to queued). NO `ALTER TABLE issues` — preserve
the "defer agent_state on D1.issues until Phase 5" boundary.

R7. Operator routes:
- `POST /api/v1/issues/:t/:s/:e/actions/retry-now` — force a `retry_wait` to
  re-dispatch immediately (clears alarm, transitions to queued, enqueues).
- `POST /api/v1/issues/:t/:s/:e/actions/resume` — already exists; behavior
  extended to allow `failed → queued`.
- `POST /api/v1/admin/inject-failure` — Phase 4 test surface (gated by
  `write:issue.transition` capability). Phase 5 removes this when
  ExecutionWorkflow reports real failure outcomes.

R8. Dashboard MUST render a read-only retry/failed section showing `attempt`,
`last_error`, and a relative `next_retry_at` countdown for `retry_wait` rows.
It MUST NOT add dashboard mutation buttons in PR-D.

R9. Phase 4 invariant preserved:
- No ExecutionWorkflow.
- No agent_state column on `D1.issues`.
- No real run lifecycle (no `runs` row inserts driven by sub-cut 3).
- The dual retry layers — Cloudflare Queues `max_retries=3` (infra) and
  IssueAgent attempts (business) — stay distinct and are documented.

R10. Tests:
- Unit: backoff math parity table vs ts-engine for attempts 1-10 with
  matching `maxBackoffMs`.
- Unit: state machine — every R2 transition, every illegal transition.
- Integration (in-memory, bun:test): inject failure → retry_wait → simulated
  alarm → re-dispatched IssueDispatchMessage observed.
- Integration: reconcile harness skips dispatch when D1 retry due_at > now.
- E2E (live deploy, optional): admin/inject-failure on a known issue, observe
  next dispatch event after backoff window.

## 4. Implementation Steps

### Step 1 — Backoff helper

New file: `cf-control-plane/src/agents/backoff.ts`. Pure function; no DO
imports. Unit-tested in `cf-control-plane/tests/backoff.test.ts` with a
parity table copied from ts-engine output.

### Step 2 — Extend IssueAgent state shape and transitions

`cf-control-plane/src/agents/issue.ts`:
- `IssueAgentStatus` adds `"retry_wait" | "failed"`.
- `IssueAgentState` adds `attempt: number`, `lastError?: string`,
  `nextRetryAt?: string` (ISO).
- `ALLOWED_TRANSITIONS` updated per R2.
- New methods:
  - `markFailed(tenantId, slug, externalId, error, opts?: { maxAttempts?: number })`:
    decides retry_wait vs failed based on attempt + max; sets alarm; persists.
  - `retryNow(...)`: cancels alarm, immediately enqueues + transitions to queued.
- New override: `async alarm()` per R4.
- `transition()` is reused for everything except the alarm-internal
  enqueue (so all paths funnel through one validator).
- `assertControlPlaneId` calls already in place — keep them on every entry.

### Step 3 — Capability + auth surface

`cf-control-plane/src/auth/operator.ts`:
- No new capability needed; `write:issue.transition` covers all new admin
  routes, and `read:state` covers GET status. Keep the surface tight.

### Step 4 — D1 migration v3 + retry mirror

New file: `cf-control-plane/migrations/0003_issue_retries.sql`.

```sql
CREATE TABLE issue_retries (
  issue_id     TEXT PRIMARY KEY,        -- D1.issues.id (== `${profile_id}:${external_id}`)
  tenant_id    TEXT NOT NULL,
  profile_id   TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  attempt      INTEGER NOT NULL,
  due_at       TEXT NOT NULL,           -- ISO
  last_error   TEXT,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_issue_retries_due ON issue_retries (due_at);
CREATE INDEX idx_issue_retries_profile ON issue_retries (profile_id);
```

`IssueAgent.markFailed` writes the row via `env.DB`; retry_wait rows carry a
real `due_at`, while failed rows are retained with `due_at = ""` for dashboard
visibility. `IssueAgent.dispatch`, `retryNow`, `resume`, `pause`, `cancel`,
and the alarm re-dispatch path DELETE by `issue_id` when leaving the visible
retry/failed state.

### Step 5 — Reconcile harness retry-due gate

`cf-control-plane/src/reconcile/tick.ts`:
- Already accepts `RetryEntry[]` via `ReconcileInput.retries`.
- Caller (project agent's `poll`) currently constructs that array empty;
  update to `SELECT issue_id, attempt, due_at FROM issue_retries WHERE
  profile_id = ?` and pass.
- Existing `tick.ts:110-113` math (`prev + 1`) stays correct; PR-D adds the
  guard that empty/null `due_at` rows are not due.

### Step 6 — Failure routing in queue handler (test seam)

`cf-control-plane/src/queues/handlers.ts`:
- `handleIssueDispatch` keeps its current happy path (transition to queued).
- New optional `inject_failure` flag in `IssueDispatchMessage` (version 2)
  triggers `IssueAgent.markFailed` instead. **Justification**: until Phase 5
  there is no real failure source; the test surface lives on the message
  shape rather than on the handler internals. Versioning the message is
  cheaper than introducing a parallel queue.
- `IssueDispatchMessage` becomes `version: 1 | 2`; the handler treats
  v1 as never-failing.

### Step 7 — Operator routes

`cf-control-plane/src/worker.ts`:
- `POST /api/v1/issues/:t/:s/:e/actions/retry-now`
- `POST /api/v1/admin/inject-failure` — Phase 4 test seam.
- Existing `actions/resume` route: extend to allow `failed → queued`.
- All gated by `write:issue.transition`.

### Step 8 — Dashboard surface

`cf-control-plane/src/dashboard/render.ts`:
- New read-only Retries section for `retry_wait` (countdown to
  `next_retry_at`) and `failed` (showing `last_error` with no buttons).
- Dashboard fetches retry mirror rows via the same D1 table; no per-DO fan-out.

### Step 9 — Tests

`cf-control-plane/tests/`:
- `backoff.test.ts` — parity table.
- `issue_agent.test.ts` — state machine table.
- `retry_loop.test.ts` — full inject-failure → retry_wait → simulated
  `alarm()` → re-enqueue → queued → eventual `failed` after max attempts.
- `reconcile_retry_gate.test.ts` — harness skips dispatch when `due_at`
  is in the future.
- Existing `scheduled_poll.test.ts` and tracker.refresh tests keep
  passing — no behavioral regression on the happy path.

## 5. Suggested PR Breakdown

PRs are deliberately small to honor the codex-advisor judgment from
2026-05-01 (don't accumulate review debt; integration hygiene before
Phase 5 enters).

**PR-A — backoff helper + state machine**
- Step 1, Step 2, Step 9 (backoff + state machine tests).
- ~6 files, ~250 lines, no migration.

**PR-B — D1 retry mirror + reconcile gate**
- Step 4, Step 5, `reconcile_retry_gate.test.ts`.
- 1 migration + 2 tweaked files. Independent of PR-A.

**PR-C — Failure routing + operator routes + alarm**
- Step 6, Step 7, `retry_loop.test.ts`.
- Wires the loop end-to-end. Depends on PR-A and PR-B.

**PR-D — Dashboard surface + docs sync**
- Step 8 + sync README/target/phase4-plan checkboxes.
- Read-only retry/failed row visibility; depends on PR-A for state union
  and PR-B/PR-C for the D1 retry mirror.

Optional: each PR ships with `make all` green and a small **manual probe
script** (`scripts/probe-retry.ts`) that operators can run against the
deployed Worker. Probe scripts go in PR-D.

## 6. File-Level Checklist

- [x] `cf-control-plane/src/agents/backoff.ts` — new
- [x] `cf-control-plane/src/agents/issue.ts` — extended (R2, R4); PR-D retains failed rows with empty `due_at`
- [x] `cf-control-plane/src/queues/types.ts` — `IssueDispatchMessage` v2
- [x] `cf-control-plane/src/queues/handlers.ts` — failure injection branch
- [x] `cf-control-plane/src/reconcile/tick.ts` — skips empty/null `due_at` failed rows
- [x] `cf-control-plane/src/agents/project.ts` — load retries from D1 before tick
- [x] `cf-control-plane/src/worker.ts` — operator routes plus dashboard retry-row query
- [x] `cf-control-plane/src/dashboard/render.ts` — read-only Retries section
- [x] `cf-control-plane/migrations/0003_issue_retries.sql` — new
- [x] `cf-control-plane/wrangler.toml` — register migration tag v3 if needed
      (only if a new sqlite class is added — for sub-cut 3 it isn't)
- [x] `cf-control-plane/tests/backoff.test.ts` — new
- [x] `cf-control-plane/tests/issue_agent.test.ts` — new
- [x] `cf-control-plane/tests/retry_loop.test.ts` — new
- [x] `cf-control-plane/tests/reconcile_retry_gate.test.ts` — new
- [x] `cf-control-plane/README.md` — Phase 4 sub-cut 3 status row
- [x] `docs/cloudflare-agent-native-target.md` §1115–1131 status sync
- [x] `docs/cloudflare-agent-native-phase4-plan.md` — this file

## 7. Acceptance Criteria

A1. State machine: every transition in R2 is covered by a passing test;
every illegal transition (e.g. `cancelled → queued`) throws with a
deterministic message.

A2. Backoff parity: `nextBackoffMs(attempt=k, max=M)` for `k ∈ [1,10]` and
`M ∈ {30000, 300000}` matches the ts-engine implementation byte-for-byte.

A3. Retry loop e2e: `admin/inject-failure` on a queued issue causes:
- IssueAgent transitions queued → retry_wait,
- `issue_retries` row inserted with attempt=1, due_at = now + 1000ms,
- alarm fires within ~1.2s,
- IssueDispatchMessage observed on DISPATCH queue,
- IssueAgent ends in queued, attempt=1 preserved on the next failure.

A4. Max-attempt termination: after 5 consecutive failures
(default `maxAttempts=5`, configurable), state lands in `failed`,
no alarm is set, `issue_retries` is retained with `due_at = ""`, and the
dashboard shows the row with last_error and no mutation button.

A5. Operator force-retry: `POST /actions/retry-now` on a `retry_wait` row
clears alarm, transitions to queued, enqueues IssueDispatchMessage with
attempt unchanged.

A6. Operator resume of failed: `POST /actions/resume` on a `failed` row
transitions to queued, attempt counter NOT reset (so a flaky issue that
fails again immediately doesn't get N more attempts at the cheapest backoff),
and clears the informational retry mirror row.

A7. Reconcile harness: when D1 `issue_retries.due_at > now` for an issue,
the `dispatch` decision is **not** emitted; when due_at <= now, decision
fires with `attempt = prev + 1`. Empty/null `due_at` values represent
failed informational rows and also suppress dispatch.

A8. Cancellation race: operator cancel clears the `issue_retries` row; if a
previously scheduled alarm still fires while issue is `cancelled`, it no-ops
with no enqueue and no transition.

A9. Phase 4 invariant audit: sub-cut 3 does not add ExecutionWorkflow,
`workflow_instance_id`, or an `agent_state` column on `D1.issues`; existing
mock-run/dashboard run views remain unchanged until Phase 5.

A10. `bun test` green; `bunx tsc --noEmit` clean; `bun run db:migrate:local` applies.

## 8. Verification Matrix

| Behavior | How verified | Pass signal |
|---|---|---|
| Backoff math parity | `tests/backoff.test.ts` parity table | All 20 entries match |
| State machine transitions | `tests/issue_agent.test.ts` | Every R2 edge tested |
| Alarm-driven re-dispatch | `tests/retry_loop.test.ts` (in-memory ctx mock) | Mock alarm fires, queue records send |
| Retry due gate | `tests/reconcile_retry_gate.test.ts` | Decision absent when due_at is future or empty |
| Operator routes | bun test + manual CLI/curl | Status response shows expected state |
| Dashboard render | manual screenshot of `/dashboard` | retry_wait countdown and failed informational rows visible |
| Phase 4 invariant | code review / targeted `rg` | No ExecutionWorkflow, `workflow_instance_id`, or `D1.issues.agent_state` added |
| Live e2e (optional) | Deploy + admin/inject-failure | DispatchMessage observed within backoff window |

## 9. Risks and Mitigations

R-1 — **Dual retry layers (Cloudflare Queues + IssueAgent attempts)**.
Queue retry handles "DO call failed" (transient infra); IssueAgent attempt
handles "dispatched work failed" (business). Risk: silent compounding (a
queue retry that succeeds on the second hop bumps IssueAgent attempt).
*Mitigation*: `handleIssueDispatch` is idempotent on input — calling
`IssueAgent.dispatch` twice with the same message produces one effective
transition (queued is idempotent). Document the invariant in
`queues/handlers.ts`. Add a test that double-delivers a message and asserts
attempt counter unchanged.

R-2 — **Alarm fires after cancellation**. *Mitigation*: explicit early-
return in `alarm()` when status !== retry_wait; unit test covers.

R-3 — **Migration v3 schema drift**. The new table joins by
`profile_id + external_id`. *Mitigation*: a reconcile test seeds rows
in both tables and asserts the harness reads the join correctly.

R-4 — **Synthetic failure surface persists into prod**. The
`admin/inject-failure` route is operationally a footgun. *Mitigation*:
gate behind `write:issue.transition` (already operator-only); document
removal in Phase 5; consider compile-time elision via env flag if Phase 5
ships within 4 weeks.

R-5 — **Backoff math drift from ts-engine**. *Mitigation*: parity table
test (A2). If math intentionally diverges later, the parity test is the
forcing function to write a new SPEC clause.

R-6 — **Reconcile fan-out cost**. Reading retry state from N IssueAgent DOs
each tick is expensive. *Mitigation*: read from D1 `issue_retries` instead
(one indexed query per profile). Already in plan as Step 5.

R-7 — **Wrangler migration ordering**. v3 migration must run before any
Worker version that references it. *Mitigation*: deploy via
`bun run db:migrate:remote` before `wrangler deploy`. Document in
README.md migration loop section.

R-8 — **DO storage corruption on partial transition**. If we write retry
state to DO storage AND D1 in two separate steps, a crash between can
desync them. *Mitigation*: write DO storage first (it is the source of
truth), then D1 mirror is best-effort. On reconcile, if D1 says retrying
but DO says queued, prefer DO. Document this rule in `agents/issue.ts`.

## 10. Stop Conditions

S-1. If integrating retry_wait requires changing the reconcile harness
output enum (e.g. adding a `retry_due` decision distinct from `dispatch`),
**stop** — that means the harness contract is leaking and the change
deserves its own "reconcile contract v2" plan first.

S-2. If `DurableObject.alarm()` semantics turn out to differ between
local `wrangler dev` and the live edge in a way that breaks the test
strategy, **stop** and add a `spikes/cf-do-alarm/` reproduction before
continuing.

S-3. If Cloudflare Queues `max_retries=3` interacts badly with the
business-layer attempt counter (e.g. queue exhausts retries before
IssueAgent records the failure), **stop** and reconsider. The fallback
is to set the queue retry to `max_retries=0` and rely entirely on the
IssueAgent layer for retries.

S-4. If the failure-injection admin route cannot be safely shipped to
production (operator might fire it accidentally), **stop**, ship Phase 4
sub-cut 3 with unit-test-only verification, and leave the e2e admin
surface for Phase 5.

S-5. If migration v3 cannot be applied to the live D1 without downtime
(it shouldn't — it's a CREATE TABLE only), **stop** and re-evaluate.

## 11. Follow-ups

Phase 8 auth-model gap: PR-D keeps the dashboard read path on the existing
session-cookie flow but does not expand that cookie into mutation authority.
The decision is rows-only visibility: dashboard renders retry_wait/failed
rows informationally, while retry-now and failed-resume actions remain
Bearer-only CLI/curl calls until Phase 8 ToolGatewayAgent and proper
Cloudflare Access JWT validation extend the operator auth surface.

### Phase 5 Readiness Gates

Phase 5 (`ExecutionWorkflow without real coding`, target.md §1133) can
start when:

- All A1–A10 acceptance criteria pass on `main`.
- `admin/inject-failure` is the only synthetic failure source — no
  IssueAgent code path produces failure on its own.
- D1 `issue_retries` is queryable from the dashboard and from the
  reconcile harness; no per-DO fan-out.
- The dual retry layers (Queues + IssueAgent) are documented in
  `target.md` §12 and `cf-control-plane/README.md`.
- ADR-0001 (CodingAgentAdapter / WorkerHost boundaries) is unchanged —
  Phase 4 sub-cut 3 should NOT introduce a new boundary.

## 12. Out of Scope

- ExecutionWorkflow (Phase 5).
- `runs`, `run_steps`, `run_events` table writes (Phase 5).
- Run lease / `workflow_instance_id` on IssueAgent (Phase 5).
- `agent_state` column on `D1.issues` (Phase 5 schema bump).
- Real CodingAgent execution (Phase 6/7).
- Cloudflare Container TLS work (already closed in `cde7007`).

## 13. Estimated Effort

- PR-A: ~0.5 day (helper + state machine + parity tests).
- PR-B: ~0.5 day (migration + reconcile glue + 1 test).
- PR-C: ~0.5 day (alarm wiring + admin surface + retry loop test).
- PR-D: ~0.5 day (dashboard cells + docs sync).
- Total: 1.5–2 days end-to-end including review iterations.
