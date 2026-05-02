# Phase 3 Plan (Retrospective): Tracker Adapter Bridge on the Worker

**Status: Retrospective.** This document captures decisions actually made
during Phase 3 implementation, not a forward-looking plan. Use it as a
review trail and as input to retroactive code review per
`docs/integration-plan.md` §4 milestone M-06 + §5 Step 5.

Author: planner pass, 2026-05-02 (recovered from 7 commits, 2026-05-01)
Companion to: `docs/cloudflare-agent-native-phase1-plan.md`,
`docs/cloudflare-agent-native-phase2-plan.md`,
`docs/cloudflare-agent-native-target.md` §1101–1114,
`docs/integration-plan.md` §4 (M-06).

---

## 1. Context

Phase 3's outcome was to bring real tracker traffic into the Cloudflare
control plane: port the Linear GraphQL client from ts-engine to a
Worker-runnable adapter, drive `ProjectAgent.poll()` end-to-end against
the live tracker, mirror tracker state into D1 with idempotent UPSERTs,
and expose both an operator-triggered refresh route and a scheduled
cron path. Phase 4 sub-cuts (IssueAgent state machine + dispatch queue)
build on top of this.

By the start of Phase 3, Phase 2 (skeleton) had landed and the Phase 3
readiness gate — the reconciliation diff harness — was the first item
shipped (`21c297b`). The harness contract pinned the decision shape
that any new tracker-adapter implementation must produce, ensuring
Phase 3's `ProjectAgent.poll()` is behaviorally equivalent to ts-engine's
`Orchestrator.tick()` for the same input.

Intended outcome (achieved): a deployed Worker that, on cron tick or on
operator-triggered refresh, fetches active + terminal issues from the
project's Linear workspace, runs them through the reconcile harness,
mirrors the resulting issue snapshots into D1, and emits a decision list
for downstream consumers (Phase 4 sub-cut 2 turns the dispatch decisions
into IssueAgent transitions). No execution starts yet; Phase 3
explicitly stops at the dispatch decision boundary.

## 2. Shipped Artifacts (commit-pinned)

| What | Commit | Date |
|---|---|---|
| Reconciliation diff harness (Phase 3 readiness gate) | `21c297b` | 2026-05-01 |
| Linear tracker adapter + `ProjectAgent.poll()` + refresh route + dashboard issues | `4b1c0aa` | 2026-05-01 |
| Refresh idempotency + UNIQUE collision fix on existing rows | `fb85d38` | 2026-05-01 |
| Scheduled cron poll + admin trigger route | `48d085e` | 2026-05-01 |
| Queue-based tracker event ingestion | `f185bf7` | 2026-05-01 |
| Phase 3 status sync docs | `322094f`, `91b9662` | 2026-05-01 |

## 3. Decisions Made (with evidence)

D1. **The reconcile harness is a pure function and the contract.**
`reconcileTick(input): Decision[]` takes a snapshot of tracker + state
and returns decisions; no I/O. Both ts-engine's local
`Orchestrator.tick()` and the cf-control-plane `ProjectAgent.poll()`
must produce the same decisions for the same input. The same five
decision branches as ts-engine: `reconcile_not_visible`,
`reconcile_terminal`, `reconcile_pause`, `dispatch`, `cleanup`.
*Evidence*: `21c297b` — `cf-control-plane/src/reconcile/types.ts` and
`tick.ts`; the commit message explicitly cites parity with
`ts-engine/src/orchestrator.ts:76-120`.

D2. **`workspaceExists` oracle is computed BEFORE mirror runs.** The
oracle reads `archived_at IS NULL` from D1; if it ran AFTER the mirror
upsert that updates `archived_at`, cleanup decisions would fire on
every poll instead of once per terminal transition.
*Evidence*: `4b1c0aa` commit message: "computes the workspaceExists
oracle from D1 (archived_at IS NULL) BEFORE mirror runs (so cleanup
decisions fire once per terminal transition, not on every poll)."

D3. **Queries are byte-equivalent to ts-engine.** `POLL_QUERY` and
`QUERY_BY_IDS` strings in `cf-control-plane/src/tracker/linear.ts`
match `ts-engine/src/linear.ts` character for character. Maintains
the parity invariant required by the reconcile harness.
*Evidence*: `4b1c0aa`; `cf-control-plane/src/tracker/linear.ts`.

D4. **Two-phase identity oracle in mirror.ts.** Issue identity in D1
is checked first by `(profile_id, external_id)` (the partial unique
index). When the tracker-fetched row has a non-null external_id but
the existing D1 row was inserted with NULL external_id (e.g. mock
runs from Phase 2), a fallback `WHERE profile_id = ? AND identifier = ?
AND external_id IS NULL` attaches the new external_id to the existing
row. Mixed id-format coexistence is handled at the application layer.
*Evidence*: `fb85d38` commit message + `cf-control-plane/src/tracker/mirror.ts`
header comment.

D5. **archived_at is cleared on tracker re-emergence and on state
change, NOT on every unchanged poll.** An earlier defense-in-depth
clear in the unchanged branch oscillated against the cleanup
decision loop (cleanup re-archived; mirror un-archived). Removed.
*Evidence*: `fb85d38` ("archived_at oscillation between mirror and
cleanup loop") + the explicit comment block in `mirror.ts:138-147`.

D6. **Refresh route is project-scoped, not global.** `POST
/api/v1/projects/:tenant/:slug/actions/refresh` runs `poll()` for one
project; target.md mentions a global `/api/v1/refresh` shape but
Phase 3 deferred that to keep blast radius small.
*Evidence*: `4b1c0aa`; `worker.ts` route table; PRD non-goal.

D7. **Sync routes bypass the queue.** The refresh route and
`/api/v1/admin/run-scheduled` route call `ProjectAgent.poll()`
directly for immediate operator feedback. Only the cron tick goes
through the queue; this preserves operator UX while making the
scheduled path retryable.
*Evidence*: `48d085e` (cron + admin route) + `f185bf7`
(queue ingestion); `cf-control-plane/wrangler.toml` queue + cron
binding comments.

D8. **Cron interval is 5 minutes, configurable via wrangler.toml.**
`crons = ["*/5 * * * *"]`. Manual operator trigger via
`POST /api/v1/admin/run-scheduled` for ad-hoc testing without waiting.
*Evidence*: `48d085e`; `wrangler.toml`.

D9. **Tracker events queue is `symphony-tracker-events` with DLQ.**
Cron tick fans out one `TrackerRefreshMessage` per active profile.
Queue consumer dispatches to `ProjectAgent.poll()`. `max_retries=3`,
DLQ `symphony-tracker-events-dlq`, batch size 10, batch timeout 5s.
*Evidence*: `f185bf7`; `wrangler.toml`.

D10. **Polling can be paused per-project without DLQ pressure.**
`profiles.status = 'paused'` skips the cron fan-out for that profile.
Active set is `status = 'active' AND archived_at IS NULL`.
*Evidence*: `48d085e`; `cf-control-plane/src/orchestration/scheduled_poll.ts`.

D11. **D1 issues table has a partial unique index on
`(profile_id, external_id) WHERE external_id IS NOT NULL`.**
This is what makes the fallback identity oracle in D4 safe — mock-run
rows with NULL external_id never collide.
*Evidence*: `0001_init.sql` schema + `fb85d38` discussion.

D12. **Queue messages are versioned discriminated unions.**
`TrackerRefreshMessage { kind, version, ... }` carries `version: 1`
to allow rolling shape changes during deploys.
*Evidence*: `f185bf7`; `cf-control-plane/src/queues/types.ts`.

## 4. Acceptance — Shipped

A1. ✅ `cf-control-plane/src/tracker/linear.ts` exports
`LinearGraphqlClient` with `fetchActiveIssues`, `fetchTerminalIssues`,
`fetchIssuesByIds`, `graphql<T>()` matching ts-engine query shapes.
*Evidence*: `4b1c0aa`.

A2. ✅ `cf-control-plane/src/tracker/types.ts` exports `TrackerAdapter`
interface; `LinearGraphqlClient` declares `implements TrackerAdapter`.
Source uses only Worker-compatible APIs (`fetch`, no `node:*`).
*Evidence*: `4b1c0aa`.

A3. ✅ Operator debug routes:
`GET /api/v1/profiles/:tenant/:slug/tracker/{active,terminal}` with
404 / 400 / 500 / 502 status mapping.
*Evidence*: `4b1c0aa`; live verification: 7 terminal issues fetched
from the configured Linear project including `ZII-12`.

A4. ✅ `ProjectAgent.poll(tenantId, slug)` loads profile, constructs
`LinearGraphqlClient` from the per-tenant `LINEAR_API_KEY` Worker
secret, fetches active + terminal in parallel, computes
`workspaceExists`, runs `reconcileTick`, mirrors via UPSERT, returns
`{ decisions, mirrored: { inserted, updated, unchanged } }`.
*Evidence*: `4b1c0aa`; `src/agents/project.ts`.

A5. ✅ `POST /api/v1/projects/:tenant/:slug/actions/refresh` returns
`{ generated_at, profile, decisions, mirrored }`. 405 on non-POST,
404 on missing profile, 502 on Linear network failure.
*Evidence*: `4b1c0aa`; `worker.ts`.

A6. ✅ Dashboard `/dashboard` adds an Issues section showing
identifier, state, last_seen_at for the most recent poll.
*Evidence*: `4b1c0aa`; `src/dashboard/render.ts`.

A7. ✅ Cron schedule `*/5 * * * *` enumerates active profiles and
fans out one queue message per profile; queue consumer drives
`ProjectAgent.poll()`. Admin route triggers the same fan-out
on-demand.
*Evidence*: `48d085e` + `f185bf7`.

A8. ✅ `scripts/worker-smoke.ts` includes a refresh probe asserting
HTTP 200 + decisions array shape (skipped when secret unset).
*Evidence*: `4b1c0aa`.

A9. ✅ `bunx tsc --noEmit` clean; `bun test` green at every commit
boundary; `wrangler deploy` succeeds; live deploy returns 200 on the
new routes.
*Evidence*: each commit's "Tests" section.

## 5. Risks That Materialized (and how they were handled)

R-1 — **`UNIQUE constraint failed: issues.profile_id, issues.external_id`
on first authenticated probe**. Phase 2 hardening (`2192470`) had
migrated `mirror.ts` row id from `${profileId}:${issue.identifier}` to
`${profileId}:${issue.id}` (Linear UUID). The deployed D1 had 7 rows
from earlier Phase 3 first-cut runs in the OLD format. New
`SELECT WHERE id = ?` missed them; INSERT path collided on the partial
unique index. *Resolution*: switch identity oracle from primary-key
lookup to `(profile_id, external_id)`, then a second-pass lookup by
`identifier` for rows with NULL external_id. *Evidence*: `fb85d38` (D4).

R-2 — **`archived_at` oscillation between mirror and cleanup loop**.
Mirror's "defense-in-depth" clear in the unchanged branch un-archived
rows that the cleanup decision had archived in the same poll, causing
a permanent flap on stable terminal state. *Resolution*: remove the
unchanged-branch clear; meaningful re-emergence (terminal → active)
carries a state change and lands in the `changed` branch which clears
archived_at. *Evidence*: `fb85d38` (D5).

R-3 — **Refresh route idempotency under retries**. The first
authenticated smoke run produced double-mirrored rows on retry.
*Resolution*: the two-phase identity oracle from R-1 also fixes
duplicate inserts under retry; subsequent probe verified zero
duplicates over consecutive runs (`decisions=[] cleaned_up=0`).
*Evidence*: `fb85d38`.

R-4 — **Cron at-least-once delivery**. Cloudflare Cron is
at-least-once; queue retries also at-least-once. `poll()` had to be
idempotent on stable input. *Resolution*: idempotent-by-construction:
mirror upserts are no-ops when state hasn't changed; cleanup
decisions only fire on archived-at transitions; reconcile harness is
pure. *Evidence*: `48d085e` + `f185bf7` commit messages reference
the at-least-once contract.

R-5 — **Mock-run rows with NULL external_id colliding with tracker-
fetched rows**. The partial unique index `WHERE external_id IS NOT NULL`
prevents NULL-external-id rows from colliding among themselves; the
two-phase identity oracle attaches the external_id to the existing
mock row instead of inserting a duplicate. Tested via the existing
mock-run fixtures. *Evidence*: `fb85d38` discussion + `mirror.ts`
header comment block.

R-6 — **Tracker fetch failures crashing the Worker**. A 5xx response
from Linear during a refresh route call must not propagate to the
Worker entrypoint as an unhandled rejection. *Resolution*: 502 status
code mapping with diagnostic body. *Evidence*: `4b1c0aa` route handler.

R-7 — **Queue retry storm masking real failures**. With `max_retries=3`
and DLQ, a permanently failing message would land in DLQ; an
intermittent failure would self-heal. *Mitigation in place*: DLQ is
documented but not actively monitored — flagged as a Phase 8
operability follow-up.

## 6. Stop Conditions That Held

S-1 (followed). Phase 3 explicitly did not start any run. The
dispatch decision is the boundary; Phase 4 sub-cut 2 turns dispatch
decisions into IssueAgent state transitions; nothing in Phase 3
allocates a `runs` row outside of the existing mock-run path.
Held.

S-2 (followed). Phase 3 did not write back to the tracker.
Decisions are emitted but not actioned beyond mirroring. Held —
Phase 8 covers tracker write-back.

S-3 (followed). Phase 3 did not introduce queue or cron triggers
that bypass the reconcile harness. All paths funnel through
`reconcileTick`. Held.

## 7. Verification — Shipped

| Behavior | How verified | Pass signal at the time |
|---|---|---|
| Reconcile harness parity | 10 fixture tests in `tests/reconcile.test.ts` | All branches + concurrency caps + retry due-time covered |
| Linear adapter live fetch | `worker-smoke.ts` against deployed Worker version `4a50979f-...` | 7 terminal issues; ZII-12 visible |
| Mirror upsert idempotency | Consecutive refresh probes against unchanged tracker | `decisions=[]`, `cleaned_up=0`, `inserted=0` |
| UNIQUE collision fix | First post-fix smoke run against deployed Worker | 200 OK; no DLQ entries |
| Cron fan-out | Manual `wrangler tail` during cron tick + admin route | One `TrackerRefreshMessage` per active profile observed |
| Queue consumer routing | `tail` during admin trigger | Each message dispatched to `ProjectAgent.poll()` |
| Sync route bypass | Admin run-scheduled route timing vs cron tick | Sync route returns full payload synchronously |

## 8. Phase 4 Readiness Gates That Were Closed

By end of Phase 3, the substrate for Phase 4 sub-cuts (IssueAgent
state machine + dispatch queue) was in place:

- A reconcile-harness-shaped decision list (`Decision[]`) per
  `ProjectAgent.poll()` call. Phase 4 sub-cut 2 consumes
  `kind === 'dispatch'` decisions.
- A queue plumbing precedent (`symphony-tracker-events` + DLQ +
  versioned discriminated-union message types). Phase 4 sub-cut 2
  reuses the pattern for `symphony-dispatch`.
- A capability principal model that already gates routes —
  Phase 4 only needs to add `write:issue.transition`.
- D1 schema with partial unique indexes and identity validation
  that survive the new IssueAgent identity scheme.

## 9. Out of Scope (and stayed out)

- IssueAgent state machine + dispatch queue (Phase 4 sub-cut 1, 2 —
  separate commits `6932964`, `f529208`).
- Real coding agent execution (Phase 5/7).
- Real workspace operations (Phase 6).
- Tracker write-back / Linear comment / state transition (Phase 8).
- Multi-project per-tick concurrency caps (handled at queue batch
  size and project count; revisit at Phase 11 if profiles >50).
- Webhook-driven tracker ingestion (Phase 8 or later — current path
  is poll-only per profile config).

## 10. Cross-References

- `docs/integration-plan.md` §4 M-06: Phase 3 milestone scope.
- `docs/cloudflare-agent-native-target.md` §11 (queue topics), §16
  Phase 3 (deliverables + exit criteria).
- `docs/cloudflare-agent-native-phase1-plan.md` §14 item 6
  (reconciliation diff harness as Phase 3 readiness gate).
- `docs/cloudflare-agent-native-phase2-plan.md` D8 (mock orchestration
  emits the row trail Phase 3 mirrors into).
- `cf-control-plane/README.md` Phase 3 status table and Auth /
  Readiness sections.

## 11. Follow-ups Carried into Later Phases

- F-1 (Phase 4 sub-cut 1, closed). IssueAgent state machine —
  `6932964`.
- F-2 (Phase 4 sub-cut 2, closed). `symphony-dispatch` queue +
  auto-dispatch from poll decisions — `f529208`.
- F-3 (Phase 4 sub-cut 3, scoped). Retry/backoff state machine +
  alarm-driven re-dispatch loop — `phase4-plan.md`.
- F-4 (Phase 8, deferred). Webhook-driven tracker ingestion as an
  alternative to polling, per `target.md` §8.2.
- F-5 (Phase 8, deferred). DLQ monitoring + alerting.
- F-6 (Phase 8, deferred). Tracker write-back (Linear comment posting,
  state transitions).

## 12. Estimated Effort (recovered)

Approximate from commit dates and net diff size:
- Reconcile harness (`21c297b`): ~0.5 day. Fixture tests dominated.
- Linear adapter + poll + refresh route + dashboard issues
  (`4b1c0aa`): ~1 day, including live verification.
- UNIQUE collision + archived_at oscillation fix (`fb85d38`):
  ~0.25 day; both bugs surfaced and fixed in one sitting after first
  authenticated smoke.
- Scheduled cron + admin route (`48d085e`): ~0.25 day.
- Queue ingestion (`f185bf7`): ~0.5 day; mostly plumbing.
- Status sync docs (`322094f` + `91b9662`): ~0.1 day.
- Total: ~2.5 days. (No reviewer wall-clock; single-author work.)
