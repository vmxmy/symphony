# symphony-ts (engine port)

TypeScript port of [OpenAI Symphony](https://github.com/openai/symphony)
orchestrator engine, per [SPEC.md](../SPEC.md). Drop-in replacement for the
upstream Elixir engine at `elixir/bin/symphony`.

## Why a TypeScript port

- **No Elixir runtime dependency** — single Bun binary, easy VPS deploy
- **Stack alignment** — most of our skills (baoyu-*, mptext, firecrawl) are
  TypeScript; one language end-to-end
- **Side-step the Solid 0x85 mystery** — different stdlib means different
  byte-handling code paths, almost certainly bypassing whatever causes our
  Chinese encoding issue
- **Easier to extend** — add custom features (multi-profile native support,
  fancy dashboards, structured logs) without learning OTP

## CLI contract (compatible with Elixir engine)

```
symphony-ts <WORKFLOW.md path> [--port N] [--logs-root DIR]
            [--i-understand-that-this-will-be-running-without-the-usual-guardrails]
```

The launcher (`bin/symphony-launch`) treats `SYMPHONY_BIN` as opaque — point it
at this binary instead of the Elixir one and the rest works unchanged.

## Status

**v0 MVP** in progress. See [docs/PORTING-PLAN.md](docs/PORTING-PLAN.md) for the
module-by-module roadmap.

| Module | Status |
|---|---|
| WorkflowLoader | partial (parses YAML+body, no Liquid yet) |
| Linear client | TODO |
| Orchestrator | TODO |
| Workspace manager | TODO |
| Codex App-Server JSON-RPC client | TODO |
| HTTP API + dashboard | partial (Bun server, JSON API, modular server-rendered dashboard) |
| Hot reload | TODO (post-MVP) |
| LiveView dashboard | won't port; serve modular plain HTML+JSON |

## Run

```bash
cd ts-engine
bun install
bun run src/main.ts ../profiles/content-wechat/WORKFLOW.md --port 4002
```

## Dashboard Architecture

The TS engine dashboard stays lightweight and server-rendered. `src/server.ts`
owns Bun route wiring and delegates the dashboard page to `src/dashboard/`:

- `view_model.ts` adapts `State.snapshot()` into display-ready dashboard data
- `render.ts` renders HTML and owns escaping/layout composition
- `styles.ts` keeps dashboard CSS out of route handlers

Existing routes remain compatibility contracts: `/`, `/api/v1/state`,
`/api/v1/<issue-id-or-identifier>`, and `POST /api/v1/refresh`. The first
modular implementation is dependency-free and keeps CSS inline through a
dedicated style module rather than adding a static asset endpoint.

## Test workflow loader

```bash
bun run src/workflow.ts ../profiles/content-wechat/WORKFLOW.md
```
