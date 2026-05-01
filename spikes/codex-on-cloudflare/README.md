# Spike: Codex App-Server on Cloudflare Containers

Status: Phase 0 spike scaffolding (not deployed)
Question: can `codex app-server` run inside a Cloudflare Container with acceptable
JSON-RPC behavior, file I/O, long-process stability, and artifact export, so
that Phase 6/7 can default to Containers as the workspace substrate?

This directory is **scaffold only**. No `wrangler deploy` has been run. Resource
creation, secret upload, and image build all require explicit operator action.

## What this spike answers

| Question | Pass criterion |
|---|---|
| Can `codex app-server` boot inside a Cloudflare Container? | Container reaches `/healthz` 200 within 30s of cold-start |
| Does JSON-RPC streaming over stdio survive HTTP proxying? | `initialize` + `thread/start` + `turn/start` round-trip succeeds |
| Can a single turn complete end-to-end? | One `turn/completed` notification observed for a trivial prompt |
| What is end-to-end wall time? | Recorded in `REPORT.md` |
| Can codex read/write files inside the container workspace? | A turn that touches a file produces a visible artifact |
| Does process cleanup work? | Container stays under sleepAfter budget; no zombie processes |

The spike does **not** answer (deferred):

- `linear_graphql` dynamic tool routing through `ToolGatewayAgent` — Phase 8.
- Workflows-driven multi-turn resume — Phase 5.
- Long-running session reuse across turns — current scaffold spawns per request.
- R2 artifact export from container — added once Container side proves baseline.

## Files

| Path | Purpose |
|---|---|
| `Dockerfile` | Container image: node:20-slim + `@openai/codex@0.128.0` + bridge |
| `container/server.mjs` | HTTP-to-stdio bridge inside the container |
| `wrangler.toml` | Worker + Container DO binding + image build config |
| `src/worker.ts` | Worker entrypoint that proxies HTTP to the container DO |
| `package.json` | Wrangler dev deps for the Worker side |
| `scripts/smoke.ts` | Local client that drives one turn end-to-end |
| `REPORT.md` | Empty results template — fill after each spike run |

## Prerequisites (verified 2026-05-01 against this account)

- Workers Paid Plan ✅
- Containers product entitled (token has `containers (write)`, `cloudchamber (write)`) ✅
- Account: `d1da4742bef1158b96eb2a2660a49301` (`blueyang@gmail.com`)
- Local `wrangler` >= 4.56.0 with valid OAuth ✅

## Deploy checklist (operator runs these)

```bash
cd spikes/codex-on-cloudflare

# 1. Install Worker-side deps
bun install

# 2. Provide secrets — DO NOT commit any of these.
#    CODEX_AUTH_JSON should be the literal contents of ~/.codex/auth.json on a
#    machine that already authenticated codex. Keep the JSON one-line.
wrangler secret put CODEX_AUTH_JSON
wrangler secret put OPENAI_API_KEY      # only if your auth.json does not embed creds

# 3. Build + deploy. First deploy will build the Docker image and upload it.
wrangler deploy

# 4. Run the smoke from your laptop. Replace URL with the deployed worker route.
WORKER_URL="https://symphony-codex-spike.<your-subdomain>.workers.dev" \
  bun run scripts/smoke.ts

# 5. Tail container logs while the smoke runs (separate terminal)
wrangler tail
```

## Cost guardrail

- `instance_type = "standard-1"` and `max_instances = 3` keep the spike's vCPU
  budget within Workers Paid included allowance.
- `sleepAfter = "5m"` so idle instances are reclaimed; do not let it idle
  overnight without explicit re-run.
- `wrangler delete` removes the entire spike when done.

## Rollback / cleanup

```bash
wrangler delete       # removes Worker + Container instances + DO state
```

R2/D1/Queues are not provisioned by this spike, so nothing else to clean.

## Open uncertainties to resolve during spike execution

1. The exact `@cloudflare/containers` SDK API surface as of 2026-05-01 — the
   scaffold uses the documented `Container` base class + `getContainer()` helper;
   verify `wrangler deploy --dry-run` accepts the `wrangler.toml` shape.
2. Whether `codex` 0.128.0 needs additional CLI flags inside a no-TTY Linux
   container (e.g. `--no-color`, `--non-interactive`).
3. Whether codex will accept a workspace path like `/data/workspace` without
   explicit sandbox config; the scaffold passes `threadSandbox: "danger-full-access"`
   to maximize spike signal — this matches the current `content-wechat`
   profile and is **not** a recommendation for production.
