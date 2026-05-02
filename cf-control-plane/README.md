# symphony-control-plane

Cloudflare Agent-native control plane for Symphony, per
`docs/cloudflare-agent-native-target.md`. This package owns the Worker
entrypoint, Durable-Object-backed Agents (Tenant/Project/Issue), Workflows,
D1 index database, and R2 artifact bucket bindings.

This is **Phase 2 of the migration**. The active engine is still
`ts-engine/` and runs locally; this package is built incrementally next to
it, with no traffic crossover until a profile explicitly opts in.

## Status

Phase 2 control-plane skeleton is complete; Phase 3 (tracker adapter bridge)
has landed. The Cloudflare Worker now runs the LinearTrackerAdapter, scheduled
ProjectAgent polling, D1 issue mirror, queue-based tracker event ingestion, and
the project-scoped refresh route. Phase 3 hardening also added refresh
idempotency, schema additions for the issue mirror, the scheduled cron handler,
and an admin `run-scheduled` route to trigger polling on demand.

Phase 2 (skeleton):

- [x] D1 schema (`migrations/0001_init.sql`) — first cut covering tenants,
      profiles, issues, runs, run_steps, run_events, tool_calls, approvals,
      and idempotency_records (per target §11 + §13.1).
- [x] Worker entrypoint with temporary operator-token gate; Cloudflare Access
      JWT validation remains a later OperatorAgent/Access integration.
- [x] TenantAgent / ProjectAgent skeleton state with D1-backed identity checks.
- [x] Profile import (v1 → v2 auto-upgrade per target §10.1) with dry-run by
      default and explicit `--apply` for D1 writes.
- [x] Read-only dashboard rendered from D1 read models.
- [x] Mock orchestration run that emits `runs`, `run_steps`, `run_events`, and
      `tool_calls`.

Phase 3 (tracker adapter bridge):

- [x] LinearTrackerAdapter running on Cloudflare Workers (commit 4b1c0aa).
- [x] Scheduled ProjectAgent polling via cron (commit 48d085e).
- [x] D1 issue mirror with idempotent upserts (commit 4b1c0aa).
- [x] Queue-based tracker event ingestion (commit f185bf7).
- [x] `POST /api/v1/projects/:tenant/:slug/actions/refresh` compatibility route (commit 4b1c0aa).

Phase 4 (IssueAgent dispatch and retry/backoff):

- [x] IssueAgent durable per-issue state machine with queued, paused, cancelled, retry_wait, and failed states.
- [x] Dispatch queue consumer routes tracker decisions into IssueAgent without starting coding workloads.
- [x] D1 `issue_retries` mirror gates reconcile dispatches until retry due time.
- [x] Failed issues stay visible as `issue_retries` rows with empty `due_at`; reconcile treats empty due dates as not due.
- [x] Dashboard renders a read-only Retries section; operator retry/resume actions remain Bearer-only API calls for CLI/curl.

Phase 6 (8 commits, 2026-05-03 Ralph session):

| Commit | Slice | Tests delta |
|--------|-------|-------------|
| `289f255` | PR-A — WorkerHost contract + MockWorkerHost + F-5/F-6 fixes + grep gates | 90 → 102 |
| `ecbba33` | PR-B — VpsDockerHost HTTP adapter | 102 → 110 |
| `2bcdfe6` | PR-C-1 — Factory + parseRuntimeConfig | 110 → 122 |
| `277d09d` | PR-C-2 — execution.ts steps 3+4 swap to WorkerHost | 122 (no regression) |
| `5628f41` | PR-D-1 — runHookWithTimeout helper + 3 unit tests | 122 → 125 |
| `f27fb59` | PR-D-2 — execution.ts steps 5/7/12 hook wiring | 125 (no regression) |
| `0ea41b2` | PR-D-3 — execution.ts step 15 archive sequence | 125 (no regression) |
| `777cfad` | PR-E-1 — GET /api/v1/profiles/:t/:s/runtime operator route | 125 → 132 |

Final state: 132 pass / 0 fail / 478 expect() calls / 24 test files.
Next slice (deferred): PR-E-2 — CloudflareContainerHost + admin write routes + dashboard surface.

Phase 5 (ExecutionWorkflow on Cloudflare Workflows with MockCodingAgentAdapter):

- [x] ExecutionWorkflow class registered via `[[workflows]] EXECUTION_WORKFLOW`; R2 binding `ARTIFACTS = symphony-runs`.
- [x] IssueAgent gains `running` + `completed` states + `workflow_instance_id` lease; `startRun` is idempotent against Promise.all races via in-flight Promise dedup.
- [x] Queue dispatch chain: `IssueDispatchMessage` → `IssueAgent.dispatch` → `IssueAgent.startRun` → `EXECUTION_WORKFLOW.create`.
- [x] 16 canonical steps from target.md §8.4 implemented. Step 2 / 8 / 16 use `retries.limit=0` (lease check / mutating tool calls / lease release are not replay-safe).
- [x] `MockCodingAgentAdapter` ships as the only Phase 5 adapter; ts-engine mock parity preserved.
- [x] R2 manifest written at the canonical step-11 boundary and re-emitted with the final 16-step terminal snapshot before `runs.status=completed`.
- [x] Per-run operator surface: `/api/v1/runs/:t/:s/:e/:attempt/{state,events}` (read), `actions/cancel` (write:run.cancel).
- [x] Dashboard `/dashboard/runs/:t/:s/:e/:attempt` renders the 16-step grid + run metadata + events.
- [x] `executeMockRun` marked `@deprecated`; the synchronous admin route stays for fast-feedback bring-up; Phase 6 removes both.

## Layout

```
cf-control-plane/
├── migrations/         # D1 schema migrations (wrangler d1 migrations apply)
│   └── 0001_init.sql
├── scripts/            # Operator CLIs and smoke probes
├── src/                # Worker / Agents / dashboard / mock orchestration code
├── wrangler.toml       # D1/R2/Queues bindings; database_id is filled in by db:create
├── package.json
├── tsconfig.json       # @cloudflare/workers-types only; strict
└── .gitignore
```

## D1 setup

One-time, per developer machine:

```bash
cd cf-control-plane
bun install
bun run db:create
# Take the database_id from the output and paste it into wrangler.toml,
# replacing PLACEHOLDER_REPLACE_AFTER_WRANGLER_D1_CREATE.
```

After that, the migration loop is:

```bash
# Apply locally (fast iteration; uses .wrangler/state/v3/d1)
bun run db:migrate:local

# Apply to the live D1
bun run db:migrate:remote

# List unapplied migrations
bun run db:list:local
bun run db:list:remote

# Show current tables
bun run db:tables
```

The initial schema migration intentionally creates tables without
`IF NOT EXISTS`: if a remote database already has an incompatible table shape,
the migration should fail loudly instead of silently accepting schema drift.
Wrangler still tracks applied migration files in its bookkeeping table.

## R2 + Workflows setup (Phase 5 one-shot)

Phase 5 introduces the `EXECUTION_WORKFLOW` Cloudflare Workflow and the
`ARTIFACTS` R2 bucket binding. First-time setup per environment:

```bash
# Create the R2 bucket (idempotent on rerun)
wrangler r2 bucket create symphony-runs

# wrangler deploy will register the ExecutionWorkflow class automatically
# from the [[workflows]] binding in wrangler.toml.
wrangler deploy
```

The bucket name `symphony-runs` matches the binding in wrangler.toml.
Re-running `wrangler r2 bucket create` against an existing bucket is a
no-op; safe to put in a setup script.

## Adding a migration

```bash
wrangler d1 migrations create symphony-control-plane <short-description>
# This generates migrations/000N_<short_description>.sql; edit it, then run
# `bun run db:migrate:local` to validate.
```

Each new migration should be exactly-once and auditable:
- Prefer failing loudly on incompatible existing objects over masking drift.
- Keep `CREATE INDEX IF NOT EXISTS` for additive indexes.
- For column adds: `ALTER TABLE … ADD COLUMN` is not replay-safe in SQLite;
  ship it as a new Wrangler migration and validate the resulting schema.

## Schema design notes

- Bulky payloads (event bodies, tool inputs/outputs, workspace snapshots)
  live in R2; D1 stores `*_ref` pointers only. This keeps row sizes small
  and respects D1's 100 KB statement limit.
- Foreign keys are documented but not enforced. D1 ships with
  `PRAGMA foreign_keys = OFF`. Relations are validated in app logic.
- All timestamps are ISO-8601 UTC TEXT for portability and human-readable
  diagnostics.
- Each table that can grow without bound has an `archived_at` column or a
  time-window retention index so dashboard queries stay selective after
  retention sweeps run.

## Profile import

`import:profile` is safe by default:

```bash
# Prints generated SQL and import warnings; does not mutate D1.
bun run import:profile -- --profile ../profiles/content-wechat --dry-run

# Applies to the local D1 database.
bun run import:profile -- --profile ../profiles/content-wechat --apply --local
```

Profiles use a stable registry id (`<tenant>/<slug>`) and `active_version`
tracks the currently imported bundle version. Re-imports use an explicit
UPSERT on `(tenant_id, slug)` and preserve historical `issues.profile_id` /
`runs.issue_id` joins. R2 persistence for `source_bundle_ref` and
`normalized_config_ref` is still deferred; the importer prints a warning and
writes `NULL` refs until the R2 bucket lands.

## Auth and readiness

- `GET /` is the public liveness banner.
- `GET /api/v1/healthz` and `GET /api/v1/readyz` are public readiness checks.
  They report sanitized DB/operator-token status and return `503` until
  protected routes are actually usable.
- API routes and `/dashboard` share the same operator-principal auth shim. The
  temporary bearer token maps to an all-capabilities operator principal today;
  Cloudflare Access JWTs can replace the provider later without changing route
  authorization call sites.

## Phase 2 readiness mapping

| Gate (per docs/cloudflare-agent-native-phase1-plan.md §14) | Status |
|---|---|
| Platform limits + entitlements pinned | ✅ `docs/cloudflare-platform-limits.md` |
| Codex-in-WorkerHost spike (substrate decision) | ✅ `spikes/codex-on-cloudflare/REPORT.md` §15 |
| ToolGateway idempotency contract | ✅ doc-level (`target.md §13.1`); table here (`idempotency_records`) |
| v1→v2 profile import policy | ✅ doc-level (`target.md §10.1`); columns here (`source_schema_version`, `defaults_applied`, `warnings`) |
| Developer loop pick | ✅ doc-level (`target.md §14.1`) |
| Reconciliation diff harness | ✅ Phase 3 readiness gate (commit 21c297b) |
