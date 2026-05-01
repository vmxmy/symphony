# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository identity

This is a **fork of `openai/symphony`** that adds a multi-profile architecture on top of the upstream Codex orchestrator. Three distinct things live here:

1. **Symphony engine** — `elixir/` (upstream reference) and `ts-engine/` (in-progress TypeScript port). Long-running daemon that polls Linear, creates per-issue workspaces, and drives Codex via App Server JSON-RPC.
2. **Profiles** — `profiles/<name>/`. Self-contained workflow bundles (one `WORKFLOW.md`, `profile.yaml`, skills, `codex-home/`, env). Each profile is one pipeline.
3. **Launcher** — `bin/symphony-launch`. Bash bridge that runs preflight, sets `CODEX_HOME`, and spawns the engine with the profile's `WORKFLOW.md`.

Dependency direction is strict and one-way: **Profile → Launcher → Symphony → Codex**. See `docs/architecture.md` for the contract each must not break.

The upstream relationship is preserved via `git remote add upstream` and merges into `main` (see `docs/upstream-sync.md`). The aspiration is to keep `elixir/lib/` close to upstream so engine updates merge cleanly — when changing engine code, prefer adding behind config rather than rewriting upstream paths.

## Common commands

### Elixir engine (`elixir/`)

```bash
cd elixir
mise install                     # install Erlang 28 / Elixir 1.19 per mise.toml
mise exec -- mix setup           # mix deps.get
mise exec -- mix build           # builds escript at elixir/bin/symphony
make all                         # full quality gate: fmt-check + lint + coverage + dialyzer
mix test                         # run all tests
mix test test/symphony_elixir/orchestrator_status_test.exs       # single file
mix test test/symphony_elixir/orchestrator_status_test.exs:42    # single test by line
mix test --cover                 # coverage (must reach 100% threshold for non-ignored modules)
mix lint                         # alias: specs.check + credo --strict
mix specs.check                  # validates @spec coverage rule (see below)
mix pr_body.check --file pr.md   # validates PR body against template
make e2e                         # live Linear + Codex E2E (requires LINEAR_API_KEY)
```

CI runs `make all` from `elixir/` (`.github/workflows/make-all.yml`).

### TypeScript engine (`ts-engine/`)

```bash
cd ts-engine
bun install
bun test                         # all tests
bun test tests/server.test.ts    # single file
bun run typecheck                # tsc --noEmit (strict, noUnchecked, noUnused all on)
bun run src/main.ts <WORKFLOW.md path> --port 4002 \
  --i-understand-that-this-will-be-running-without-the-usual-guardrails
bun run build                    # bun build --compile → bin/symphony-ts
```

### Launcher (running profiles)

```bash
./bin/symphony-launch list                       # all profiles + status
./bin/symphony-launch check <profile>            # preflight only (env, skills, codex-home)
./bin/symphony-launch start <profile>            # preflight + spawn detached, write runtime/symphony.pid
./bin/symphony-launch stop <profile>
./bin/symphony-launch restart <profile>
./bin/symphony-launch status [profile]
```

Override engine binary or profile root with `SYMPHONY_BIN` and `SYMPHONY_PROFILES_ROOT` env vars. The launcher auto-wraps the engine with `mise exec --` if `escript` is not on PATH.

### Upstream sync

```bash
git remote add upstream https://github.com/openai/symphony.git    # one time
git fetch upstream
git log HEAD..upstream/main --oneline
git merge upstream/main
```

## Engine architecture (Elixir)

`elixir/lib/symphony_elixir/` is an OTP application supervised one-for-one by `SymphonyElixir.Application`. Reading these together explains the runtime:

- `orchestrator.ex` (the heart, ~52K) — stateful GenServer. Polls `Tracker`, claims issues, dispatches `AgentRunner` workers, handles retries, reconciliation, and cleanup when Linear issues hit terminal states.
- `agent_runner.ex` — per-issue Task; renders the prompt and drives one Codex session.
- `codex/app_server.ex` + `codex/dynamic_tool.ex` — JSON-RPC client to `codex app-server`. Exposes the client-side `linear_graphql` tool that lets skills make raw Linear GraphQL calls during a session.
- `linear/{client,adapter,issue}.ex` and `tracker.ex` / `tracker/memory.ex` — pluggable tracker behind a `Tracker` behaviour; Linear is the production impl, in-memory tracker is used in tests.
- `workflow.ex` + `workflow_store.ex` — parse YAML frontmatter from `WORKFLOW.md` and hot-reload it. If the initial parse fails, Symphony refuses to boot; if a later reload fails, it keeps the last good config and logs the error.
- `config.ex` + `config/schema.ex` — Ecto schema-backed config access. **Do all config reads through `SymphonyElixir.Config`**, not via ad-hoc `System.get_env/Application.get_env`.
- `workspace.ex` + `path_safety.ex` — per-issue workspace creation, `hooks.after_create` / `before_remove` execution. Workspace safety is critical: never let a Codex turn run with `cwd` inside the source repo, and keep all workspaces under the configured `workspace.root`.
- `prompt_builder.ex` — Solid (Liquid) template renderer. **Known bug**: corrupts UTF-8 byte `0x85` to `0x0A`, which mangles Chinese text in prompts. Profiles work around this by keeping `WORKFLOW.md` ASCII-only and injecting non-ASCII content through `linear_graphql` tool calls at runtime.
- `ssh.ex` — SSH worker support for running agents on remote hosts.
- `status_dashboard.ex` + `lib/symphony_elixir_web/` — Phoenix LiveView dashboard at `/` and JSON API under `/api/v1/*`. Bandit serves it; only enabled when `--port` (or `server.port` in workflow) is set.
- `cli.ex` — escript entry, builds to `elixir/bin/symphony` (configured via `escript:` in `mix.exs`).

The boot sequence: `Application.start/2` → `LogFile.configure` → supervises `Phoenix.PubSub`, `TaskSupervisor`, `WorkflowStore`, `Orchestrator`, `HttpServer`, `StatusDashboard`.

## Engine architecture (TypeScript port)

`ts-engine/src/` mirrors the Elixir engine module-for-module: `workflow.ts`, `linear.ts`, `orchestrator.ts`, `state.ts`, `agent.ts`, `codex.ts`, `dynamic_tool.ts`, `workspace.ts`, `prompt.ts`, `server.ts`, `dashboard/`. CLI parity is the design contract — `bin/symphony-launch` should treat `SYMPHONY_BIN` as opaque whether it points at the Elixir escript or the Bun binary. Status is **v0 MVP**; see `ts-engine/docs/PORTING-PLAN.md` for what's stubbed. Hot reload, LiveView dashboard, and several modules are not yet ported.

## Profile system (the fork's main addition)

Each `profiles/<name>/` is a self-contained pipeline that the launcher loads. Required structure (full schema in `docs/profile-spec.md`):

```
profiles/<name>/
├── profile.yaml         # metadata + symphony.{port,workspace_root,bypass_guardrails} + linear + preflight
├── WORKFLOW.md          # the engine's workflow contract (frontmatter + prompt body)
├── env.example          # committed; env is gitignored, sourced by launcher with `set -a; source env`
├── skills/<name>/       # Codex skills bundled with this profile
├── codex-home/          # CODEX_HOME for this profile (config.toml symlink, auth.json symlink, skills/)
└── runtime/             # gitignored: symphony.pid, log/, sessions/
```

Critical invariants when editing profiles:

- `profile.yaml` must **not** include a `binary:` field — the launcher auto-detects `SYMPHONY_BIN` from `<repo>/elixir/bin/symphony`.
- `symphony.port` must be unique across profiles (one engine instance per port).
- `WORKFLOW.md` body should stay **ASCII-only** because of the Solid `0x85` corruption bug (see Engine architecture). Use `linear_graphql` calls in skills for non-ASCII content.
- `_template/` and other `_*` profiles are hidden from `symphony-launch list`.
- `codex-home/auth.json` is a per-machine symlink to `~/.codex/auth.json` (gitignored target). `codex-home/sessions/`, `generated_images/`, `history.jsonl`, `*.sqlite*`, etc. are all gitignored — see the long block in `.gitignore`.

## WORKFLOW.md contract (engine input)

Front matter is YAML, body is the Codex session prompt (Liquid-templated, with `issue` available). Key fields the engine consumes via `Workflow`/`Config`:

- `tracker.kind`, `tracker.project_slug`, `tracker.api_key` (defaults to `$LINEAR_API_KEY`).
- `workspace.root` (per-issue workspace parent; `~` and `$VAR` expansion supported).
- `hooks.after_create` / `hooks.before_remove` (shell snippets).
- `agent.max_concurrent_agents`, `agent.max_turns` (default 20), `agent.max_concurrent_agents_by_state`.
- `codex.command` (shell command, `$VAR` expanded by the launched shell — not by Symphony).
- `codex.approval_policy` (default rejects sandbox/rules/elicitations), `codex.thread_sandbox` (default `workspace-write`), `codex.turn_sandbox_policy` (default `workspaceWrite` rooted at the workspace).
- `server.port` enables the dashboard and JSON API.

Defaults err on the safe side. When raising guardrails (like `danger-full-access` in `content-wechat`), this should be paired with the launcher `--i-understand-...` flag and `bypass_guardrails: true` in `profile.yaml`.

## Conventions enforced by tooling

- **`@spec` rule** (Elixir): every public `def` in `elixir/lib/` must have an adjacent `@spec`. `defp` and `@impl` callbacks are exempt. Validated by `mix specs.check` (custom Mix task at `lib/mix/tasks/specs.check.ex`); also wired into `mix lint`.
- **Coverage threshold**: 100% (modules listed in `test_coverage.ignore_modules` of `mix.exs` are exempted — those are mostly thin IO/Phoenix layers). When adding new pure-logic modules, expect them to be covered.
- **Style**: `mix format --check-formatted` + `credo --strict`. Run `mix format` (or `make fmt`) before committing.
- **PR body**: must follow `.github/pull_request_template.md` — Context / TL;DR / Summary / Alternatives / Test Plan. Validated by `mix pr_body.check`. Test Plan should list `make -C elixir all` plus targeted checks.
- **TypeScript**: `tsconfig.json` enables `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`. Run `bun run typecheck`.
- **Logging** (Elixir): when logging issue work, include `issue_id` (Linear UUID) AND `issue_identifier` (e.g. `MT-620`); for Codex events include `session_id`. Use `key=value` pairs and stable wording. See `elixir/docs/logging.md`.

## Where things live

- Spec of record: `SPEC.md` at repo root. The Elixir implementation may be a superset but must not conflict; update the spec in the same change when behavior changes meaningfully.
- Product docs (this fork): `docs/architecture.md`, `docs/profile-spec.md`, `docs/launcher-cli.md`, `docs/deployment.md`, `docs/creating-a-profile.md`, `docs/upstream-sync.md`.
- Engine docs: `elixir/README.md`, `elixir/AGENTS.md`, `elixir/docs/logging.md`, `elixir/docs/token_accounting.md`, `elixir/WORKFLOW.upstream.md` (preserved upstream sample).
- TS porting plan: `ts-engine/docs/PORTING-PLAN.md`.
- Repo-local Codex skills (used when running Codex in this repo for self-modification): `.codex/skills/{commit,push,pull,land,linear,debug}`.
