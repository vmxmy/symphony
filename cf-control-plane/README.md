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
