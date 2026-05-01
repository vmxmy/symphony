# Symphony Fork (multi-profile edition)

A productized fork of [openai/symphony](https://github.com/openai/symphony) that
turns the upstream Codex orchestrator into a **multi-pipeline platform**: many
self-contained workflow bundles ("profiles") on one Symphony engine, managed by
a single launcher.

## What's different from upstream

| Aspect | upstream openai/symphony | this fork |
|---|---|---|
| WORKFLOW.md | one file at `elixir/WORKFLOW.md` | one per profile, under `profiles/<name>/` |
| Profile concept | none (one workflow per Symphony instance) | first-class — bundle + isolation + ensure |
| Launcher | manual `./bin/symphony WORKFLOW.md` | `bin/symphony-launch start <profile>` |
| Skills | `~/.codex/skills/` (global) | per-profile, isolated via `CODEX_HOME` |
| Linear setup | manual UI clicks | `profile.yaml.linear.ensure_*` automated |
| Multi-pipeline | run extra Symphony instances by hand | `symphony-launch list/start/stop/status` |

The upstream **engine** (`elixir/lib/`) is **untouched** so we can pull future
upstream releases via `git merge upstream/main`.

## Three entities

```
   PROFILE (workflow bundle)  ──loads──▶  LAUNCHER (bridge)  ──spawn──▶  SYMPHONY (engine)
```

See [docs/architecture.md](docs/architecture.md) for full definitions.

## Quick start

```bash
git clone <this-repo>
cd symphony
mise install                                       # provision Erlang/Elixir
mise exec -- mix setup && mise exec -- mix build   # build engine binary

# Pick or create a profile
cd profiles/content-wechat
cp env.example env
$EDITOR env                                        # fill credentials
cd ../..

# Launch
./bin/symphony-launch start content-wechat
open http://127.0.0.1:4001/
```

## Repo layout

```
.                                       # fork root (= product root)
├── elixir/                             # upstream engine (lib/ untouched)
├── bin/symphony-launch                 # our launcher
├── profiles/                           # all pipelines + a _template
│   ├── content-wechat/                 # WeChat 公众号 pipeline (Tier 2 editorial)
│   └── _template/                      # skeleton for new profiles
├── docs/                               # product docs
│   ├── architecture.md                 # three-entity definition
│   ├── profile-spec.md                 # profile.yaml schema
│   ├── launcher-cli.md                 # CLI reference
│   ├── deployment.md                   # SSH-worker / VPS setup
│   └── upstream-sync.md                # how to merge upstream updates
└── README.md                           # upstream README (preserved)
```

## Versioning

- **Product version**: git tags `vX.Y.Z` on this fork
- **Upstream commit**: tracked in `docs/upstream-sync.md`
- **Profile schema**: `schema_version` field in each `profile.yaml`

## Roadmap

- v1.0 — single-machine multi-profile (current)
- v1.x — `symphony-launch new` from `_template/`, `package` to tarball
- v2.0 — distributed worker pools, profile registry, CI for profiles

## Status

Personal-use fork. Not affiliated with OpenAI. Engine licensed under upstream Apache 2.0.
