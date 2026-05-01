# symphony-ts

Active TypeScript/Bun implementation of the Symphony orchestrator engine, aligned with [SPEC.md](../SPEC.md).

## CLI Contract

```bash
symphony-ts <WORKFLOW.md path> [--port N] [--logs-root DIR]
            [--i-understand-that-this-will-be-running-without-the-usual-guardrails]
```

The repository-level wrapper exposes the same contract:

```bash
../bin/symphony <WORKFLOW.md path> --port 4001 --logs-root ./log \
  --i-understand-that-this-will-be-running-without-the-usual-guardrails
```

`bin/symphony-launch` treats `SYMPHONY_BIN` as opaque and defaults it to `bin/symphony`.

## Capabilities

- WORKFLOW.md YAML front matter + Liquid prompt rendering
- Linear tracker polling and raw `linear_graphql` dynamic tool
- Per-issue workspace lifecycle and hooks
- Codex app-server JSON-RPC adapter
- Polling, dispatch, retry, reconciliation, and bounded concurrency
- Bun HTTP API and lightweight server-rendered dashboard

## Run

```bash
cd ts-engine
bun install
bun run src/main.ts ../profiles/content-wechat/WORKFLOW.md --port 4001 \
  --i-understand-that-this-will-be-running-without-the-usual-guardrails
```

## Build

```bash
bun run build
# Produces ../bin/symphony-ts via the package script when run from ts-engine/
```

The compiled binary is a local build artifact. The tracked `../bin/symphony` wrapper runs the engine from source and is the default launcher target.

## Test

```bash
bun run typecheck
bun test
```

## Dashboard Architecture

`src/server.ts` owns Bun route wiring and delegates dashboard rendering to `src/dashboard/`:

- `view_model.ts` adapts `State.snapshot()` into display-ready dashboard data
- `render.ts` renders HTML and owns escaping/layout composition
- `styles.ts` keeps dashboard CSS out of route handlers

Compatibility routes:

- `GET /`
- `GET /api/v1/state`
- `GET /api/v1/<issue-id-or-identifier>`
- `POST /api/v1/refresh`
