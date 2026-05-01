# Profile Specification

A profile is a self-contained pipeline definition. It lives at
`profiles/<name>/` with the following structure:

```
profiles/<name>/
├── profile.yaml              # metadata + Linear + preflight (this doc)
├── WORKFLOW.md               # Symphony pipeline (state machine + prompt body)
├── env                       # API credentials (gitignored)
├── env.example               # credentials template (committed)
├── README.md                 # human-facing docs for this pipeline
├── skills/                   # Codex skills bundled with this profile
│   └── <skill-name>/         # one dir per skill; copy of ~/.claude/skills format
├── codex-home/               # per-profile CODEX_HOME
│   ├── config.toml           # symlink → ~/.codex/config.toml (shared)
│   ├── auth.json             # symlink → ~/.codex/auth.json (shared, gitignored)
│   └── skills/               # symlink farm: profile skills + system skills
└── runtime/                  # PID, log, sessions (gitignored)
    ├── symphony.pid
    ├── log/
    └── sessions/
```

## profile.yaml schema

### Top-level required fields

```yaml
name: <unique-id>                # ASCII, dash-separated; matches dir name
schema_version: 1                # bump when this schema changes
version: <semver>                # this profile's version
description: <one-line>          # appears in `symphony-launch list`
maintainer: <email-or-handle>    # who owns this pipeline
```

### `symphony:` block

Engine instance parameters.

```yaml
symphony:
  port: 4001                     # HTTP/dashboard port; must be unique across profiles
  bypass_guardrails: true        # adds --i-understand-... CLI flag
  workspace_root: ~/x            # per-issue workspace parent dir
  archive_root:   ~/x-archive    # before_remove hook target
```

The launcher auto-detects the Symphony binary from `$(dirname "$0")/symphony`.
Profiles **must not** include a `binary:` field — it would couple the profile
to a specific install path.

### `linear:` block

Linear project + state machine declaration. The launcher uses this for preflight
to ensure required states/labels exist before dispatching agents.

```yaml
linear:
  team_id: <uuid>                # Linear team UUID
  project_slug: <slug>           # from project URL
  states:                        # used for human-readable docs
    active:    [Todo, ...]       # mirrors WORKFLOW.md tracker.active_states
    pause:     [Backlog, ...]    # not in active or terminal
    terminal:  [Done, Cancelled]
  ensure_states:                 # launcher creates these via Linear API on start
    - {name: Researching, type: started, color: "#94a3b8"}
  ensure_labels:
    - {name: 科普, color: "#26b5ce"}
```

### `preflight:` block

Checks the launcher runs before starting Symphony.

```yaml
preflight:
  env_required:                  # missing env var → start aborts
    - LINEAR_API_KEY
    - WECHAT_APP_ID
  skills_required:               # missing skill dir → start aborts
    - baoyu-post-to-wechat
    - linear
  ssh_workers:                   # optional: validate remote workers
    - host: dev@74.48.189.45
      purpose: WeChat fixed-IP
      check_cmd: 'test -x ~/.bun/bin/bun'
      sync_paths:
        - {local: skills/baoyu-post-to-wechat/, remote: ~/.codex/skills/baoyu-post-to-wechat/}
```

### `notes:` (optional)

Free-form notes for maintainers. Not parsed by the launcher.

---

## WORKFLOW.md (managed by the engine, not the launcher)

This file's frontmatter is consumed by Symphony itself, not by the launcher.
Schema: see `SPEC.md`. Highlights specific to this fork:

```yaml
---
tracker:
  kind: linear
  project_slug: ...
  active_states: [...]
  terminal_states: [...]
polling:
  interval_ms: 8000
workspace:
  root: ~/symphony-content-workspaces
hooks:
  after_create: |
    mkdir -p research draft imgs output
  before_remove: |
    rsync ...
agent:
  max_concurrent_agents: 2
  max_turns: 25
  max_concurrent_agents_by_state:
    publishing: 1
codex:
  command: codex --dangerously-bypass-approvals-and-sandbox ... app-server
  approval_policy: never
  thread_sandbox: danger-full-access
  turn_sandbox_policy:
    type: dangerFullAccess
---

(prompt body, UTF-8 supported)
```

### UTF-8 rendering

The TypeScript engine uses `yaml` and `liquidjs`; UTF-8 prompt bodies and `{{ issue.* }}` substitutions are supported. Keep YAML keys and operational state names simple/ASCII where possible because shell hooks, tracker filters, and external tools are easier to debug that way.

---

## env / env.example

Plain shell `KEY=VALUE` files, sourced by the launcher with `set -a; source env`.

`env` is gitignored. `env.example` is committed and lists every variable the
profile needs (with placeholder values).

---

## codex-home/

The launcher exports `CODEX_HOME=$PROFILE_DIR/codex-home` before spawning
Symphony, so all Codex children read configuration from this directory.

Standard contents:

| Path | Origin | Committed? |
|---|---|---|
| `config.toml` | symlink → `~/.codex/config.toml` | symlink yes, target no |
| `auth.json` | symlink → `~/.codex/auth.json` | symlink no (gitignored, dev-machine specific) |
| `skills/.system/` | symlink → `~/.codex/skills/.system/` | symlink yes |
| `skills/<name>/` | symlink → `../../skills/<name>/` | symlink yes |
| `sessions/` | runtime artifacts | gitignored |
| `generated_images/` | image_gen output | gitignored |

---

## Skill bundling

Skills live in `profiles/<name>/skills/<skill>/`. Each skill is a directory
matching the format used by `~/.claude/skills/` and `~/.codex/skills/`:

```
skills/<skill-name>/
├── SKILL.md            # frontmatter (name, description) + body
├── scripts/            # optional executables (TypeScript / shell / etc.)
├── references/         # optional reference docs
└── prompts/            # optional prompt templates
```

The launcher symlinks these into `codex-home/skills/<skill>/` so Codex can
find them. Profile-specific skills override `~/.codex/skills/` of the same name.

---

## Compatibility

A profile declares its expected fork version via `schema_version`. The launcher
validates this on `start`:

```yaml
schema_version: 1   # current launcher accepts schema 1 only
```

Future schema bumps will keep launcher backward-compatible where possible.
