# Symphony

Symphony is a TypeScript/Bun automation service that turns tracker issues into isolated Codex implementation runs. It polls a project workflow, creates a per-issue workspace, runs an agent session, records observability data, and exposes a lightweight dashboard/API for operators.

This fork is organized around reusable **profiles**: each profile packages a `WORKFLOW.md`, credentials template, skills, and isolated `CODEX_HOME` so multiple pipelines can run from the same engine without sharing runtime state.

## What is in this repo

- `ts-engine/` — the active TypeScript Symphony engine
- `bin/symphony` — source-tree wrapper for running the TS engine with Bun
- `bin/symphony-launch` — profile-aware process manager
- `profiles/` — workflow bundles and the profile template
- `docs/` — architecture, profile, launcher, and deployment docs
- `SPEC.md` — language-agnostic Symphony behavior contract

## Quick Start

Install Bun, then run the engine directly:

```bash
cd ts-engine
bun install
bun run src/main.ts ../profiles/content-wechat/WORKFLOW.md \
  --port 4001 \
  --logs-root ../profiles/content-wechat/runtime/log \
  --i-understand-that-this-will-be-running-without-the-usual-guardrails
```

Or use the profile launcher:

```bash
cp profiles/content-wechat/env.example profiles/content-wechat/env
$EDITOR profiles/content-wechat/env
./bin/symphony-launch check content-wechat
./bin/symphony-launch start content-wechat
open http://127.0.0.1:4001/
```

## Development

```bash
make setup
make typecheck
make test
make build
make all
```

`make build` compiles `ts-engine/src/main.ts` to `bin/symphony-ts`, which is ignored as a local build artifact. The tracked `bin/symphony` wrapper runs the same engine from source.

## Documentation

- [Architecture](docs/architecture.md)
- [Profile specification](docs/profile-spec.md)
- [Launcher CLI](docs/launcher-cli.md)
- [Creating a profile](docs/creating-a-profile.md)
- [Deployment](docs/deployment.md)

## License

This project is licensed under the [Apache License 2.0](LICENSE).
