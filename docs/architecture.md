# Architecture: Three Entities

Symphony is organized around three separated entities. Each has a defined contract and avoids knowing the others' internals.

## Dependency Direction

```text
PROFILE (workflow bundle) -> LAUNCHER (bridge) -> SYMPHONY TS ENGINE -> CODEX
```

Profiles define what to do. The launcher validates and starts profile-specific engine processes. The TypeScript engine runs tracker polling, workspace lifecycle, Codex JSON-RPC sessions, retry/reconciliation, logging, and the dashboard API.

## 1. Symphony TS Engine

Long-running orchestration daemon.

**Input**: one `<WORKFLOW.md>` path plus CLI args.

**Output**: HTTP/dashboard observability, logs, and per-issue workspaces/artifacts.

**Lives in**: `ts-engine/`.

**Entry points**:

- `bin/symphony` — source wrapper, default launcher target
- `ts-engine/src/main.ts` — Bun runtime entry
- `ts-engine/package.json` — `typecheck`, `test`, and `build` scripts

**It does not know**: profile registry details, where the launcher found the profile, or how credentials are provisioned beyond process env and `WORKFLOW.md`.

## 2. Profile · the Workflow Bundle

A self-contained pipeline. It defines state machine, prompt body, tracker project, credentials, skills, and Codex environment.

**Lives in**: `profiles/<name>/`.

**Required files**:

- `profile.yaml` — metadata + tracker/Symphony/preflight config
- `WORKFLOW.md` — engine config front matter + prompt body
- `env` (gitignored) / `env.example` (committed) — credentials
- `skills/` — profile-specific Codex skills
- `codex-home/` — CODEX_HOME isolation
- `runtime/` (gitignored) — PID, logs, sessions

**It does not know**: launcher implementation or engine binary path.

## 3. Launcher · the Bridge

Profile-aware process manager.

**Lives in**: `bin/symphony-launch`.

**Auto-detects**:

- `SYMPHONY_BIN` from `$(dirname "$0")/symphony`
- `PROFILES_ROOT` from `$(dirname "$0")/../profiles`

Both can be overridden via env vars.

**It does**:

- validates profile files, env vars, skills, and `codex-home`
- exports profile-specific `CODEX_HOME`
- starts/stops/checks engine processes
- writes PID and launcher logs under the profile runtime directory

**It does not know**: `WORKFLOW.md` prompt semantics or agent behavior.

## Boundaries

| Entity | Forbidden |
|---|---|
| Symphony engine | Hardcoding profile names or profile-specific credentials |
| Profile | Hardcoding an engine binary path |
| Launcher | Interpreting prompt body or changing agent behavior |

## Invariants

1. Profiles are portable: copy a profile directory, fill `env`, and run it.
2. Launcher is profile-agnostic: adding a profile requires no launcher code change.
3. Engine is launcher-agnostic: any process manager can run `bin/symphony` or a compiled binary.
4. `CODEX_HOME` isolates profile sessions, skills, and generated assets.
5. Credentials stay in profile env files or external secret managers; they are not committed.
