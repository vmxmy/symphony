# Cloudflare Platform Limits Register

Status: Phase 0 limits register / planning artifact  
Date verified: 2026-05-01  
Scope: Cloudflare Agent-native control plane for Symphony, with pluggable WorkerHost execution.

## 1. Account And Execution Defaults

| Item | Value |
|---|---|
| Cloudflare account | `d1da4742bef1158b96eb2a2660a49301` (`blueyang@gmail.com`) |
| Current dev WorkerHost | `VpsDockerWorkspace` on `dev@74.48.189.45` |
| Hosted Cloudflare WorkerHost | `CloudflareContainerWorkspace` by default; Sandbox SDK remains opt-in until parity is proven |
| Spike image | `node:20-slim` + `@openai/codex@0.128.0` + HTTP-to-stdio bridge |
| Local provider config | Same local third-party Codex provider config via `CODEX_CONFIG_TOML_B64`, `CRS_OAI_KEY`, and `KIMI_API_KEY` |

## 2. Current Limits To Design Against

| Product | Relevant limits | Symphony implication | Source |
|---|---|---|---|
| Workers | Paid plan CPU can be configured up to 5 minutes; memory is 128 MB per isolate; paid subrequests default to 10,000/request and can be raised by config | Keep the control API light; stream or externalize logs/artifacts; do not run shell/Codex in Workers | Cloudflare Workers limits |
| Workflows | Paid step CPU defaults to 30 seconds and can be configured to 5 minutes; step wall time is unlimited; non-stream step result is 1 MiB; persisted state is 1 GB; paid max steps default to 10,000 and can be configured to 25,000; completed state retention is 30 days | Keep step outputs small, persist bulky outputs to R2, and budget the turn loop by step count | Cloudflare Workflows limits |
| Durable Objects / Agents | SQLite-backed DOs have unlimited objects per namespace, 10 GB storage per object on paid plans, and per-invocation CPU defaults to 30 seconds/configurable to 5 minutes; WebSocket message size is 32 MiB | IssueAgent can be per issue, but hot Agent state must stay compact and logs must live in R2/D1 | Cloudflare Durable Objects limits and DO changelog |
| D1 | Paid accounts allow 50,000 databases, 10 GB/database, 1 TB/account storage, 30 second SQL query duration, 100 columns/table, 100 KB SQL statement length, and 100 bound parameters/query | Keep rows narrow; index hot dashboard/reconciliation queries; store payloads by R2 pointer | Cloudflare D1 limits |
| R2 | Object keys are limited to 1,024 bytes; objects are up to 5 TiB; single upload is up to 5 GiB; multipart upload supports up to 4.995 TiB and 10,000 parts; writes to the same key are limited to 1/second | Use immutable run/artifact keys, segmented JSONL, and manifests instead of hot append keys | Cloudflare R2 limits |
| Queues | Message size is 128 KB; max consumer batch is 100; `sendBatch` is max 100 messages or 256 KB; per-queue throughput is 5,000 messages/second; consumer wall time is 15 minutes; retention is configurable up to 14 days | Queue messages carry IDs and R2/D1 pointers, not payloads; consumers should invoke Agents/Workflows | Cloudflare Queues limits |
| Containers | Predefined instance types range from `lite` to `standard-4`; `standard-1` is 0.5 vCPU, 4 GiB memory, 8 GB disk; custom instances can use up to 4 vCPU, 12 GiB memory, and 20 GB disk; paid account live limits include 6 TiB memory, 1,500 vCPU, and 30 TB disk | Cloudflare-hosted Codex should start with `standard-1`/`standard-2` and stream snapshots/logs out to R2 | Cloudflare Containers limits |
| Sandbox SDK | Built on Containers; default HTTP transport counts each SDK operation as a subrequest; paid Sandbox SDK subrequest guidance is 1,000/request; WebSocket transport multiplexes many SDK operations through one upgraded connection | Only use Sandbox for command-heavy loops with WebSocket transport enabled and a parity spike | Cloudflare Sandbox limits and transport docs |

## 3. WorkerHost Runtime Findings

| Substrate | Status | Evidence | Decision |
|---|---|---|---|
| `VpsDockerWorkspace` | Pass | Container on `dev@74.48.189.45` returned `/healthz 200`, completed a READY Codex turn in 7.0s bridge time, emitted `item/agentMessage/delta` and `thread/tokenUsage/updated`, and wrote `vps-smoke.txt` with content `READY` | Current dev default |
| `CloudflareContainerWorkspace` | Partial pass | Worker -> Container -> Codex JSON-RPC path reached turn execution. Initial run failed because the image lacked native CA certs and used default OpenAI endpoint; image now installs `ca-certificates`/`bubblewrap` and supports local provider config | Hosted Cloudflare default after one clean redeploy/smoke |
| `CloudflareSandboxWorkspace` | Not run | Requires Sandbox account access and parity testing with persistent sessions, file I/O, and Codex turn loops | Opt-in only |
| `LocalDockerWorkspace` | Not run in this spike | Same image should support local debug; not the production target | Compatibility/debug adapter |

## 4. Phase 2 Gates

Phase 2 may start only after these are true:

1. Control-plane D1 migrations include hot indexes, retention/archive fields, tenant policy records, and idempotency records.
2. WorkerHost selection is explicit in profile/runtime config: current dev default `vps_docker`, hosted Cloudflare default `cloudflare_container`.
3. Cloudflare Container path has one clean smoke using the same local third-party provider config, or Phase 6/7 explicitly remains VPS-only until hosted parity is proven.
4. Reconciliation diff harness exists for current TS behavior vs ProjectAgent behavior.
5. Developer loop can import/reset a profile without manual D1/R2 edits.

## 5. Source URLs

- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Workflows limits: https://developers.cloudflare.com/workflows/reference/limits/
- Durable Objects limits: https://developers.cloudflare.com/durable-objects/platform/limits/
- Durable Objects WebSocket message size changelog: https://developers.cloudflare.com/changelog/product/durable-objects/
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- R2 limits: https://developers.cloudflare.com/r2/platform/limits/
- Queues limits: https://developers.cloudflare.com/queues/platform/limits/
- Containers limits: https://developers.cloudflare.com/containers/platform-details/limits/
- Sandbox limits: https://developers.cloudflare.com/sandbox/platform/limits/
- Sandbox transport: https://developers.cloudflare.com/sandbox/configuration/transport/
