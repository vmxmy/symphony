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
| HTTP API | TODO |
| Hot reload | TODO (post-MVP) |
| LiveView dashboard | won't port; serve plain HTML+JSON |

## Run

```bash
cd ts-engine
bun install
bun run src/main.ts ../profiles/content-wechat/WORKFLOW.md --port 4002
```

## Test workflow loader

```bash
bun run src/workflow.ts ../profiles/content-wechat/WORKFLOW.md
```
