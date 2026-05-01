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

## Adapter Boundaries

Phase 1 of the Cloudflare Agent native migration (see `../docs/cloudflare-agent-native-phase1-plan.md`) extracted five adapter contracts so orchestration logic depends on interfaces rather than concrete classes. The composition root in `src/main.ts` is the only normal-path file that wires concrete local implementations together.

| Contract | File | Local implementation | Future Cloudflare implementation |
|---|---|---|---|
| `TrackerAdapter` | `src/contracts/tracker.ts` | `LinearClient` in `src/linear.ts` | `TrackerAdapter` for `tracker.kind: cloudflare` (Phase 9) |
| `WorkspaceAdapter` | `src/contracts/workspace.ts` | `WorkspaceManager` in `src/workspace.ts` | Sandbox/Container workspace adapter (Phase 6) |
| `ToolGateway` | `src/contracts/tools.ts` | `LinearToolGateway` in `src/dynamic_tool.ts` | `ToolGatewayAgent` / `McpAgent` with policy + audit (Phase 8) |
| `EventSink` | `src/contracts/events.ts` | `Logger` in `src/log.ts` | D1/R2/Analytics Engine sinks (Phase 2-5) |
| `CodingAgentAdapter` | `src/contracts/agent.ts` (alias of `Agent`) | `CodexAdapter` in `src/agent/codex_adapter.ts` | Native Cloudflare coding-agent adapter (Phase 10) |

Phase 1 makes the seams; the engine still runs locally with Linear and Codex exactly as before. There is no Cloudflare deployment yet — see `docs/cloudflare-agent-native-target.md` §16 for the migration phases and `docs/cloudflare-agent-native-phase1-plan.md` §14 for the Phase 2 readiness gates that must pass before any Cloudflare-runtime code lands.
