# Phase 2 Plan (Retrospective): Control-Plane Skeleton on Cloudflare

**Status: Retrospective.** This document captures decisions actually made
during Phase 2 implementation, not a forward-looking plan. Use it as a
review trail and as input to retroactive code review per
`docs/integration-plan.md` §4 milestone M-05 + §5 Step 5.

Author: planner pass, 2026-05-02 (recovered from 8 commits, 2026-04-30 → 2026-05-01)
Companion to: `docs/cloudflare-agent-native-phase1-plan.md`,
`docs/cloudflare-agent-native-target.md` §1093–1114,
`docs/integration-plan.md` §4 (M-05).

---

## 1. Context

Phase 2's outcome was to land a Cloudflare-resident control plane that
mirrors the local ts-engine state model into managed primitives without
introducing a real coding-agent execution path. The phase was scoped by
target.md §1093–1114 and the Phase 1 plan §14 readiness gates.

By the start of Phase 2, the engine had two replaceable seams from
Phase 1 (`CodingAgentAdapter`, `WorkerHost`) and a frozen Cloudflare
substrate decision (Containers-default-with-Sandbox-deferred from
target.md §6.1). Phase 0 spike artifacts existed but were not on the
critical path: the spike-validated VPS Docker WorkerHost was the
intended dev loop, not a Phase 2 deliverable.

The intended outcome (achieved): mirrored issues / runs / tool calls
visible in a read-only dashboard served from a Worker, with all reads
hitting D1 and DO storage being the source of truth for live agent
state. No real coding agent, no real shell, no tracker write-back.

## 2. Shipped Artifacts (commit-pinned)

| What | Commit | Date |
|---|---|---|
| `cf-control-plane` package + D1 schema (`migrations/0001_init.sql`) | `f4e36e5` | 2026-04-30 |
| Worker entrypoint + bearer-token auth gate | `1847666` | 2026-04-30 |
| TenantAgent + ProjectAgent skeletons with D1-mirror identity checks | `d11933c` | 2026-04-30 |
| v1 profile importer with v2 default tracking + dry-run default | `3f049f1` | 2026-04-30 |
| Read-only dashboard at `/dashboard` | `ca5941d` | 2026-04-30 |
| Mock orchestration writes full run trail to D1 | `c7a3f5b` | 2026-04-30 |
| Phase 2 hardening (architect-review pass) | `2192470` | 2026-05-01 |
| Migration `0002` for already-deployed databases | `842830d` | 2026-05-01 |

## 3. Decisions Made (with evidence)

D1. **D1 holds the queryable mirror; DO storage holds live agent state.**
The split is intentional: dashboards, profile lookup, and idempotency
records hit D1; per-tenant / per-project / per-issue mutable state lives
in Durable Object storage. D1 reads never block on DO subrequests.
*Evidence*: `f4e36e5` schema; `d11933c` agent skeletons reading from D1
on identity validation, writing to DO storage for state; `2192470`
"Make TenantAgent and ProjectAgent use D1 as the identity registry,
reject missing or archived rows, and persist D1 before DO state."

D2. **Migration files fail loud on incompatible existing tables.**
`0001_init.sql` deliberately creates tables without `IF NOT EXISTS`.
Wrangler still tracks applied migrations in its bookkeeping table, so
schema drift surfaces as a migration failure rather than silent
acceptance. *Evidence*: `cf-control-plane/README.md` "Adding a migration"
section; `f4e36e5` migration body.

D3. **Schema-additions to a deployed database go in a separate migration
file.** When the hardening pass (`2192470`) added columns
(`tenants.policy_json`, `issues.tracker_kind`, idempotency lease/retry
fields), the deployed remote D1 had already recorded `0001` as applied.
A new `0002_*.sql` file landed the additions; `0001` stayed
fail-loud-on-existing-tables for fresh databases.
*Evidence*: `842830d` commit message: "Move additive hardening columns
and partial operational indexes into a new 0002 D1 migration for
databases that already applied 0001."

D4. **Profile importer is dry-run by default.** `import:profile` prints
SQL + warnings without mutating D1; explicit `--apply` is required.
Re-imports use UPSERT keyed by `(tenant_id, slug)` and preserve
historical join columns (`issues.profile_id`, `runs.issue_id`).
*Evidence*: `3f049f1` + `2192470` ("Replace profile import replacement
writes with stable-id UPSERTs").

D5. **R2 artifact persistence is deferred.** `source_bundle_ref` and
`normalized_config_ref` columns exist but are populated with `NULL`
during Phase 2; the importer prints an explicit warning. R2 lifecycle
work lands in Phase 5 alongside the manifest writer.
*Evidence*: `cf-control-plane/README.md` "Profile import" section,
explicit `R2 persistence ... is still deferred` warning in importer
output. `2192470` "Preserve explicit deferrals for R2 artifact
uploads."

D6. **Bearer-token auth is a placeholder; capability principal is the
durable model.** `1847666` shipped a single-shared-token model
(`OPERATOR_TOKEN`); `2192470` introduced a capability-aware operator
principal so route authorization call sites do not change when
Cloudflare Access JWTs replace the bearer provider in Phase 8.
Capabilities currently shipped: `read:state`, `write:tenant`,
`write:profile.import`, `write:profile.transition`, `write:run.cancel`.
*Evidence*: `cf-control-plane/src/auth/operator.ts`; `2192470`
"shared operator principals, route capabilities, and signed dashboard
session cookies."

D7. **Dashboard sessions use HMAC-signed cookies, not raw tokens.**
The dashboard `/dashboard` and the API auth share the same operator
principal; the dashboard cookie is a signed envelope rather than the
operator token in plaintext. *Evidence*: `2192470` "signed dashboard
session cookies" — closing the architect-review gap on raw token
cookies.

D8. **Mock orchestration emits the full D1 row trail to validate the
target schema.** `executeMockRun` writes a deterministic event sequence
across `runs`, `run_steps`, `run_events`, `tool_calls`. Phase 5 lifts
the same sequence into a Cloudflare Workflow. *Evidence*: `c7a3f5b`;
matches the canonical step list in target.md §8.4. Hardening pass
added "atomic attempt allocation" to avoid `(issue_id, attempt) UNIQUE`
races (`2192470`).

D9. **Identity strings are validated before any D1 / DO call.** A new
`assertControlPlaneId` + `durableObjectName` helper rejects raw user
input that contains characters incompatible with DO names or D1 row
ids. *Evidence*: `2192470` "Introduce validated control-plane
identities."

D10. **Phase 2 explicitly does not start runs.** `mock_run.ts` is the
only run-creation path; even the hardened version calls "gated
execution" rather than autonomy. *Evidence*: `2192470` "atomic attempt
allocation, run steps, and detail refs" inside the mock-run scope only.

## 4. Acceptance — Shipped

A1. ✅ D1 schema covers tenants, profiles, issues, runs, run_steps,
run_events, tool_calls, approvals, idempotency_records (target.md §11).
*Evidence*: `migrations/0001_init.sql` + `migrations/0002_*.sql`.

A2. ✅ Worker entrypoint with operator-token gate + capability principal.
Public routes: `GET /`, `GET /api/v1/healthz`, `GET /api/v1/readyz`.
Gated routes: `/api/v1/state`, `/api/v1/tenants`, `/api/v1/profiles`,
`/dashboard`. *Evidence*: `cf-control-plane/src/worker.ts` and
`src/auth/operator.ts`.

A3. ✅ TenantAgent + ProjectAgent skeletons with D1-backed identity
checks; archived/missing tenants reject the request. *Evidence*:
`src/agents/tenant.ts`, `src/agents/project.ts`.

A4. ✅ v1 → v2 profile importer with dry-run default and warnings.
*Evidence*: `cf-control-plane/scripts/import-profile.ts`.

A5. ✅ Read-only dashboard rendered from D1 read models. *Evidence*:
`src/dashboard/render.ts` and `src/dashboard/`.

A6. ✅ Mock orchestration emits `runs`, `run_steps`, `run_events`,
`tool_calls`. *Evidence*: `src/orchestration/mock_run.ts`.

A7. ✅ Phase 1 readiness gates closed (per `phase1-plan.md` §14):
platform limits + entitlements pinned, Codex-on-Cloudflare spike
substrate decision, ToolGateway idempotency contract (doc-level),
profile import policy (doc + columns), developer-loop pick. The
reconciliation diff harness gate landed in Phase 3 (`21c297b`).

## 5. Risks That Materialized (and how they were handled)

R-1 — **`(issue_id, attempt) UNIQUE` race in mock-run**. Two near-
simultaneous calls to `executeMockRun` could both compute attempt=1
and collide on insert. *Resolution*: atomic attempt allocation in the
hardening pass — a small SELECT-MAX-then-INSERT in a transaction-
substitute pattern, since D1 does not support multi-statement
transactions. *Evidence*: `2192470`.

R-2 — **Migration drift between local and remote D1**. After `2192470`
added columns to `0001_init.sql`, the deployed database had `0001`
applied but did not have the new columns. Hardened Worker routes
referenced columns that did not exist on the live DB. *Resolution*:
move additive changes to `0002_*.sql`, restore `0001` to its original
shape, run `bun run db:migrate:remote`. *Evidence*: `842830d`.

R-3 — **Re-import orphaning historical joins**. Replacing a profile
row would orphan `issues.profile_id` references when the new row got a
new id. *Resolution*: stable id `(tenant_id, slug)` UPSERT keeps the
primary key sticky across re-imports. *Evidence*: `2192470` "stable-id
UPSERTs."

R-4 — **DO/D1 split-brain**. A successful DO storage write followed
by a failed D1 mirror would diverge. *Resolution*: write D1 first,
then DO. The DO is the source of truth for active state, but identity
and archive flags live in D1 — a successful DO write with a failed D1
write is a worse failure than the inverse, because dashboards would
list a non-existent row. *Evidence*: `2192470` "persist D1 before DO
state."

R-5 — **Raw token cookies in browser**. The first dashboard cut
echoed the operator token into a cookie. *Resolution*: HMAC-signed
session cookie wrapping a principal id, with a separate signing
secret. *Evidence*: `2192470`.

R-6 — **Namespace-bound DO injection**. Identity strings reaching
`idFromName(...)` could carry hostile bytes. *Resolution*:
`assertControlPlaneId` validator + `durableObjectName` URL-encoder
applied at every entry point. *Evidence*: `2192470`.

## 6. Stop Conditions That Held

S-1 (followed). Phase 2 explicitly did not introduce a real coding
agent path; `executeMockRun` is the only write to `runs`. Held.

S-2 (followed). Phase 2 did not introduce real workspace operations;
no `WorkerHost` was wired into the control plane. Held — Phase 6
covers that.

S-3 (followed). Phase 2 did not write back to the tracker. Held — even
mock runs do not modify Linear.

## 7. Verification — Shipped

| Behavior | How verified | Pass signal at the time |
|---|---|---|
| `0001_init.sql` applies cleanly to a fresh D1 | `bun run db:migrate:local` | Schema test green (`tests/schema.test.ts`) |
| `0001 + 0002` apply cleanly to deployed remote D1 | `bun run db:migrate:remote` | `wrangler d1 migrations list` shows both applied |
| Worker auth gate rejects missing / wrong bearer | `scripts/worker-smoke.ts` | 401 on no-bearer; 200 on valid |
| Dashboard renders from D1 | manual GET `/dashboard` | Mocked tenants + profiles visible |
| Mock orchestration writes the full row trail | `executeMockRun` integration test | All 4 tables get rows |
| Profile import dry-run does not mutate D1 | `bun run import:profile -- --dry-run` | row counts unchanged |

## 8. Phase 3 Readiness Gates That Were Closed

The Phase 3 readiness gates (per `phase1-plan.md` §14 item 6) closed
**after** Phase 2 with a single commit (`21c297b` — reconciliation
diff harness). The gate did not block Phase 2 from starting; it
gated Phase 3 entry.

## 9. Out of Scope (and stayed out)

- Real coding agent execution (Phase 5 + Phase 7).
- Real workspace operations (Phase 6).
- Tracker write-back (Phase 8 / Phase 9).
- ToolGateway idempotency runtime (Phase 8).
- Cloudflare Access JWT validation (Phase 8 — bearer remains the
  Phase 2 placeholder).
- AI Gateway routing (Phase 8 or later).
- Multi-tenant production hardening (Phase 11).

## 10. Cross-References

- `docs/integration-plan.md` §4 M-05: Phase 2 milestone scope and
  retroactive review track.
- `docs/cloudflare-agent-native-target.md` §11 (D1 schema), §13.1
  (idempotency contract — doc-level Phase 2 gate), §15
  (compatibility strategy).
- `docs/cloudflare-agent-native-phase1-plan.md` §14 (Phase 2 readiness
  gates).
- ADR-0001 §2.3: Phase 2 control plane does not depend on Codex
  specifics — held.
- `cf-control-plane/README.md`: D1 setup, migration loop, profile
  import, auth and readiness, Phase 2 readiness mapping.

## 11. Follow-ups Carried into Later Phases

- F-1 (Phase 3, closed). Reconciliation diff harness (`21c297b`).
- F-2 (Phase 5, scoped). R2 binding + manifest writer + workspace
  snapshot — `phase5-plan.md` covers it.
- F-3 (Phase 8, deferred). Cloudflare Access JWT validation replacing
  bearer-token gate.
- F-4 (Phase 8, deferred). ToolGateway idempotency runtime
  implementation. Phase 2 only landed the column shapes
  (`idempotency_records`).

## 12. Estimated Effort (recovered)

Approximate from commit dates and net diff size:
- D1 schema + Worker entrypoint + agent skeletons + dashboard +
  importer + mock-run (`f4e36e5..c7a3f5b`): ~1.5 days.
- Hardening pass + migration v2 (`2192470` + `842830d`): ~0.75 day.
- Total: ~2.25 days. (No reviewer wall-clock; single-author work.)
