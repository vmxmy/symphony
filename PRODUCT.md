# Symphony Product Notes

Symphony is now a TypeScript-first multi-profile automation platform. The former Elixir implementation has been retired; `ts-engine/` is the only active engine.

## Product Shape

| Surface | Purpose |
|---|---|
| `ts-engine/` | TypeScript/Bun orchestration engine and dashboard API |
| `bin/symphony` | Source-tree engine wrapper used by humans and the launcher |
| `bin/symphony-launch` | Profile lifecycle manager: list/check/start/stop/status |
| `profiles/<name>/` | Self-contained workflow bundle with `WORKFLOW.md`, skills, env, and `CODEX_HOME` |
| `docs/` | Operator and profile author documentation |

## Three Entities

```text
PROFILE (workflow bundle) -> LAUNCHER (bridge) -> SYMPHONY TS ENGINE -> CODEX
```

- **Profile** defines the work: tracker config, state machine, prompt body, credentials, and skills.
- **Launcher** validates and starts profile-specific engine processes.
- **Symphony TS engine** owns polling, workspace lifecycle, Codex app-server sessions, retry/reconciliation, logging, and the dashboard API.

## Quick Start

```bash
git clone <this-repo>
cd symphony
make setup
make build

cp profiles/content-wechat/env.example profiles/content-wechat/env
$EDITOR profiles/content-wechat/env
./bin/symphony-launch start content-wechat
```

## Repo Layout

```text
.
├── ts-engine/              # active TypeScript engine
├── bin/
│   ├── symphony            # Bun source wrapper
│   └── symphony-launch     # profile manager
├── profiles/               # workflow bundles and templates
├── docs/                   # product docs
├── SPEC.md                 # behavior contract
└── Makefile                # TS quality/build commands
```

## Versioning

- Product versions are git tags on this repo.
- Profile schema compatibility is declared with `schema_version` in each `profile.yaml`.
- Engine behavior should stay aligned with `SPEC.md`; update the spec when behavior changes.

## Roadmap

- v1.x — richer profile creation/package commands and profile CI
- v2.x — distributed worker pools, profile registry, Cloudflare-native deployment path

## Status

Personal-use fork. Not affiliated with OpenAI. Licensed under Apache 2.0.
