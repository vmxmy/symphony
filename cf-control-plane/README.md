# symphony-control-plane

Cloudflare Agent-native control plane for Symphony, per
`docs/cloudflare-agent-native-target.md`. This package owns the Worker
entrypoint, Durable-Object-backed Agents (Tenant/Project/Issue), Workflows,
D1 index database, and R2 artifact bucket bindings.

This is **Phase 2 of the migration**. The active engine is still
`ts-engine/` and runs locally; this package is built incrementally next to
it, with no traffic crossover until a profile explicitly opts in.

## Status

- [x] D1 schema (`migrations/0001_init.sql`) — first cut covering tenants,
      profiles, issues, runs, run_steps, run_events, tool_calls, approvals,
      and idempotency_records (per target §11 + §13.1).
- [ ] Worker entrypoint with Access protection.
- [ ] TenantAgent / ProjectAgent skeleton state.
- [ ] Profile import (v1 → v2 auto-upgrade per target §10.1).
- [ ] Read-only dashboard.
- [ ] Mock orchestration run that emits `runs` + `run_events`.

## Layout

```
cf-control-plane/
├── migrations/         # D1 schema migrations (wrangler d1 migrations apply)
│   └── 0001_init.sql
├── src/                # Worker / Agents / Workflows code (added in later commits)
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

Migrations are idempotent (`CREATE TABLE IF NOT EXISTS` everywhere) so
re-applying is safe; wrangler also tracks applied migrations in its own
bookkeeping table.

## Adding a migration

```bash
wrangler d1 migrations create symphony-control-plane <short-description>
# This generates migrations/000N_<short_description>.sql; edit it, then run
# `bun run db:migrate:local` to validate.
```

Each migration must be replay-safe:
- `CREATE TABLE IF NOT EXISTS`, not `CREATE TABLE`.
- `CREATE INDEX IF NOT EXISTS`, not `CREATE INDEX`.
- For column adds: `ALTER TABLE … ADD COLUMN` is idempotent only via the
  manual check pattern (SQLite has no `IF NOT EXISTS` for columns); wrap in
  a guarded block or split into a per-database one-shot script.

## Schema design notes

- Bulky payloads (event bodies, tool inputs/outputs, workspace snapshots)
  live in R2; D1 stores `*_ref` pointers only. This keeps row sizes small
  and respects D1's 100 KB statement limit.
- Foreign keys are documented but not enforced. D1 ships with
  `PRAGMA foreign_keys = OFF`. Relations are validated in app logic.
- All timestamps are ISO-8601 UTC TEXT for portability and human-readable
  diagnostics.
- Each table that can grow without bound has an `archived_at` column and a
  partial index `WHERE archived_at IS NULL` so dashboard queries stay
  selective even after retention sweeps run.

## Phase 2 readiness mapping

| Gate (per docs/cloudflare-agent-native-phase1-plan.md §14) | Status |
|---|---|
| Platform limits + entitlements pinned | ✅ `docs/cloudflare-platform-limits.md` |
| Codex-in-WorkerHost spike (substrate decision) | ✅ `spikes/codex-on-cloudflare/REPORT.md` §15 |
| ToolGateway idempotency contract | ✅ doc-level (`target.md §13.1`); table here (`idempotency_records`) |
| v1→v2 profile import policy | ✅ doc-level (`target.md §10.1`); columns here (`source_schema_version`, `defaults_applied`, `warnings`) |
| Developer loop pick | ✅ doc-level (`target.md §14.1`) |
| Reconciliation diff harness | ⏸ Phase 3 |
