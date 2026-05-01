# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Repository Identity

This is a TypeScript-first Symphony fork. The former Elixir implementation has been removed; `ts-engine/` is the active engine.

Three entities live here:

1. **Symphony TS engine** — `ts-engine/`. Long-running daemon that polls Linear, creates per-issue workspaces, drives Codex via app-server JSON-RPC, and exposes a dashboard/API.
2. **Profiles** — `profiles/<name>/`. Self-contained workflow bundles with one `WORKFLOW.md`, `profile.yaml`, skills, `codex-home/`, env, and runtime state.
3. **Launcher** — `bin/symphony-launch`. Bash bridge that runs preflight, sets `CODEX_HOME`, and starts the engine for a profile.

Dependency direction is strict: **Profile -> Launcher -> Symphony -> Codex**. See `docs/architecture.md`.

## Common Commands

### Engine

```bash
make setup                       # bun install --frozen-lockfile in ts-engine/
make typecheck                   # tsc --noEmit
make test                        # bun test
make build                       # compile to bin/symphony-ts (ignored artifact)
make all                         # setup + typecheck + test + build
```

Direct engine run:

```bash
./bin/symphony profiles/content-wechat/WORKFLOW.md --port 4001 \
  --logs-root profiles/content-wechat/runtime/log \
  --i-understand-that-this-will-be-running-without-the-usual-guardrails
```

Inside `ts-engine/`:

```bash
bun test
bun test tests/server.test.ts
bun run typecheck
bun run src/main.ts ../profiles/content-wechat/WORKFLOW.md --port 4002 \
  --i-understand-that-this-will-be-running-without-the-usual-guardrails
bun run build
```

### Launcher

```bash
./bin/symphony-launch list
./bin/symphony-launch check <profile>
./bin/symphony-launch start <profile>
./bin/symphony-launch stop <profile>
./bin/symphony-launch restart <profile>
./bin/symphony-launch status [profile]
```

Override engine binary or profile root with `SYMPHONY_BIN` and `SYMPHONY_PROFILES_ROOT`.

## Engine Architecture

`ts-engine/src/` implements the Symphony contract:

- `main.ts` — CLI entry, config wiring, graceful shutdown
- `workflow.ts` — `WORKFLOW.md` YAML front matter + prompt body loader
- `linear.ts` — Linear GraphQL tracker client
- `orchestrator.ts` — poll loop, dispatch, retry queue, reconciliation
- `state.ts` — in-memory runtime snapshot used by dashboard/API
- `agent.ts` — issue-level runner and continuation logic
- `agent/codex_adapter.ts` — Codex app-server JSON-RPC adapter over stdio
- `dynamic_tool.ts` — injected `linear_graphql` tool handler
- `workspace.ts` — per-issue workspace creation/removal and hooks
- `prompt.ts` — Liquid prompt rendering with UTF-8 preservation
- `server.ts` + `dashboard/` — Bun HTTP API and HTML dashboard

## Profile System

Each `profiles/<name>/` is a self-contained pipeline. Required structure:

```text
profiles/<name>/
├── profile.yaml
├── WORKFLOW.md
├── env.example          # committed; env is gitignored
├── skills/<name>/
├── codex-home/
└── runtime/             # gitignored
```

Critical invariants:

- `profile.yaml` must not include a `binary:` field; launcher auto-detects `bin/symphony`.
- `symphony.port` must be unique across profiles.
- `_template/` and other `_*` profiles are hidden from `symphony-launch list`.
- `codex-home/auth.json`, sessions, generated images, sqlite state, and logs are machine-local and gitignored.
- UTF-8 prompt bodies are supported; still quote tracker/user fields carefully when using them in shell snippets.

## WORKFLOW.md Contract

Front matter is YAML, body is the Codex session prompt rendered by Liquid. Key fields:

- `tracker.kind`, `tracker.project_slug`, `tracker.api_key` (defaults to `$LINEAR_API_KEY`)
- `workspace.root`
- `hooks.after_create`, `hooks.before_run`, `hooks.after_run`, `hooks.before_remove`
- `agent.max_concurrent_agents`, `agent.max_turns`, `agent.max_concurrent_agents_by_state`
- `codex.command`, `codex.approval_policy`, `codex.thread_sandbox`, `codex.turn_sandbox_policy`
- `polling.interval_ms`

Defaults should stay conservative. Raising guardrails should be explicit in `WORKFLOW.md` and paired with `symphony.bypass_guardrails: true` in `profile.yaml`.

## Tooling Conventions

- TypeScript is strict: `noUncheckedIndexedAccess`, `noUnusedLocals`, and `noUnusedParameters` are enabled.
- Run `make all` before handoff when feasible.
- PR body must follow `.github/pull_request_template.md`; CI checks the required headings.
- Keep engine behavior aligned with `SPEC.md`; update the spec when behavior changes meaningfully.
- Prefer `rg` over `grep` for searches.

## Documentation

- `README.md` — repo overview and quick start
- `PRODUCT.md` — product shape and roadmap
- `SPEC.md` — behavior contract
- `docs/architecture.md` — entity boundaries
- `docs/profile-spec.md` — profile schema
- `docs/launcher-cli.md` — launcher reference
- `docs/deployment.md` — deployment notes
- `docs/creating-a-profile.md` — profile authoring guide
- `ts-engine/README.md` — engine-specific commands and API routes
