# Architecture: Three Entities

This fork organizes itself around three clearly-separated entities. Each has a
defined contract and is forbidden from knowing about the others' internals.

## Dependency direction

```
┌───────────┐         ┌───────────┐         ┌───────────┐
│  PROFILE  │ ◀──── │ LAUNCHER  │ spawn  │ SYMPHONY  │
│ (workflow │ loads │  (bridge) │ ─────▶ │  (engine) │
│  bundle)  │        │           │        │           │
└───────────┘         └───────────┘         └─────┬─────┘
     ▲                                             │ JSON-RPC stdio
     │ define what to do                           ▼
     └─ Linear states + skills + env         ┌──────────┐
                                              │  CODEX   │ ──▶ skills, $CODEX_HOME
                                              └──────────┘
```

Single-direction: `Profile → Launcher → Symphony → Codex`.
Profile does not know which launcher loads it. Symphony does not know about profiles.

---

## 1. Symphony · the engine

Long-running orchestration daemon. Polls a tracker (Linear), runs a state
machine, dispatches Codex agents, owns the JSON-RPC protocol with Codex.

**Input**: one `<WORKFLOW.md>` path + CLI args.
**Output**: HTTP/dashboard observability + per-issue artifacts.

**Lives in**: `elixir/` (upstream untouched at `elixir/lib/`).

**It does not know**: profile concept, credentials, where skills live.

## 2. Profile · the workflow bundle

A self-contained pipeline. Defines what work this Symphony instance does:
state machine, prompt body, Linear project, credentials, skills, Codex env.

**Lives in**: `profiles/<name>/`.

**Required files**:
- `profile.yaml` — metadata + Linear/Symphony/preflight config
- `WORKFLOW.md` — Symphony pipeline definition (frontmatter + prompt body)
- `env` (gitignored) / `env.example` (committed) — credentials
- `skills/` — profile-specific Codex skills
- `codex-home/` — CODEX_HOME isolation (config.toml + auth.json + skills symlinks)
- `runtime/` (gitignored) — PID + log + sessions

**It does not know**: launcher implementation, Symphony binary path,
existence of other profiles.

## 3. Launcher · the bridge

Tightly coupled to Symphony's CLI. Reads `profile.yaml`, runs preflight,
sets `CODEX_HOME`, sources `env`, spawns the engine, manages PID lifecycle.

**Lives in**: `bin/symphony-launch`.

**Auto-detects**:
- `SYMPHONY_BIN` from `$(dirname "$0")/../elixir/bin/symphony`
- `PROFILES_ROOT` from `$(dirname "$0")/../profiles`

Both can be overridden via env vars.

**It does not know**: WORKFLOW.md prompt content, agent behavior, domain logic.

---

## Boundaries (what each must NOT do)

| Entity | Forbidden |
|---|---|
| **Symphony** | Knowing about profiles, multi-tenancy, credentials |
| **Profile** | Hardcoding Symphony binary path, assuming a specific launcher |
| **Launcher** | Interpreting WORKFLOW.md prompt, modifying agent behavior |

---

## Key product invariants

1. **Profile is portable**: `tar` + ship to another machine; `git clone` + `cp env.example env` + run.
2. **Launcher is profile-agnostic**: adding a new profile requires no launcher code change.
3. **Symphony is launcher-agnostic**: replacing bash launcher with Go/Rust requires no engine change.
4. **CODEX_HOME isolates**: different profiles have separate skills / sessions / image cache.
5. **Credentials stay in profile**: Symphony and launcher never persist secrets.

---

## Why all three live in one repo

The fork's product identity is the union of (engine + launcher + profiles).
Splitting them across repos would mean:
- launcher version drifts from Symphony CLI changes
- profile templates separated from the launcher that loads them
- collaborators receiving fragments instead of a complete product
- no atomic git tag describing "the whole platform at version X"

By co-locating in one fork repo, `git clone` gives you a working multi-profile
platform with one cohesive history.

The upstream relationship is preserved via `git remote add upstream` —
see [upstream-sync.md](upstream-sync.md).
