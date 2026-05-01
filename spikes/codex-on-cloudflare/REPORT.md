# Spike Report: Codex on Cloudflare Containers

Run date: 2026-05-01
Operator: Codex CLI / xumingyang
Account: `d1da4742bef1158b96eb2a2660a49301`
Region: Cloudflare-assigned; observed client edge `LAX` in response headers during manual `/healthz` checks
Container instance type: `standard-1`
Codex version: `@openai/codex@0.128.0`
Image base: `node:20-slim`
Worker URL: `https://symphony-codex-spike.blueyang.workers.dev`

## 1. Boot

| Step | Wall ms | Notes |
|---|---:|---|
| `bun install` | ~8,880 | Installed Wrangler 4.87.0 and Worker deps |
| `wrangler secret put CODEX_AUTH_JSON` | ~2,000 | Secret uploaded successfully; value was not printed |
| First `wrangler deploy` | 6,000 | Failed because Docker Desktop daemon was not running |
| Docker Desktop startup | ~60,000 | `docker desktop start`, then manual `open -a Docker`; daemon became available |
| First successful image build + push + deploy | 129,000 | Built `@openai/codex@0.128.0`, pushed Container image, deployed Worker |
| Iterative redeploy after cached image layers | 20,000-37,000 | Used for bridge fixes and new Container DO instance names |
| Latest deploy | 37,000 | Version ID `fdff8d96-2bce-4b71-ab25-2918733faca4` |
| First `/healthz` 200 after env fix | ~3,000 | `GET /healthz` returned `200 ok` after switching to Container `envVars` property and a fresh DO instance name |
| Second `/healthz` 200 warm | <1,000 | Existing Container returned `200 ok` |

## 2. Smoke result

```json
{
  "worker_url": "https://symphony-codex-spike.blueyang.workers.dev",
  "model": "gpt-5.5",
  "prompt": "Reply with the single word READY and nothing else.",
  "total_ms": 34480,
  "bridge_ms": 31419,
  "outcome": {
    "status": "completed",
    "reason": {
      "threadId": "019de3d1-d427-7630-9b8f-c122bbb19011",
      "turn": {
        "id": "019de3d1-d472-71d1-941f-f249093cf505",
        "items": [],
        "status": "failed",
        "error": {
          "message": "stream disconnected before completion: error sending request for url (https://api.openai.com/v1/responses)",
          "codexErrorInfo": "other",
          "additionalDetails": null
        },
        "startedAt": 1777643672,
        "completedAt": 1777643703,
        "durationMs": 30995
      }
    }
  },
  "frame_count": 23,
  "frame_method_histogram": {
    "<response>": 3,
    "configWarning": 1,
    "remoteControl/status/changed": 1,
    "thread/started": 1,
    "thread/status/changed": 2,
    "turn/started": 1,
    "item/started": 1,
    "item/completed": 1,
    "error": 10,
    "warning": 1,
    "turn/completed": 1
  },
  "stderr_tail": "\u001b[2m2026-05-01T13:54:32.531600Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_app_server\u001b[0m\u001b[2m:\u001b[0m Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the vendored bubblewrap in the meantime.\n\u001b[2m2026-05-01T13:54:32.698119Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_api::endpoint::responses_websocket\u001b[0m\u001b[2m:\u001b[0m failed to connect to websocket: IO error: no native root CA certificates found (errors: []), url: wss://api.openai.com/v1/responses\n\u001b[2m2026-05-01T13:54:32.724193Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_api::endpoint::responses_websocket\u001b[0m\u001b[2m:\u001b[0m failed to connect to websocket: IO error: no native root CA certificates found (errors: []), url: wss://api.openai.com/v1/responses\n\u001b[2m2026-05-01T13:54:32.914770Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_api::endpoint::responses_websocket\u001b[0m\u001b[2m:\u001b[0m failed to connect to websocket: IO error: no native root CA certificates found (errors: []), url: wss://api.openai.com/v1/responses\n\u001b[2m2026-05-01T13:54:33.312908Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_api::endpoint::responses_websocket\u001b[0m\u001b[2m:\u001b[0m failed to connect to websocket: IO error: no native root CA certificates found (errors: []), url: wss://api.openai.com/v1/responses\n\u001b[2m2026-05-01T13:54:34.105720Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_api::endpoint::responses_websocket\u001b[0m\u001b[2m:\u001b[0m failed to connect to websocket: IO error: no native root CA certificates found (errors: []), url: wss://api.openai.com/v1/responses\n\u001b[2m2026-05-01T13:54:35.662687Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_api::endpoint::responses_websocket\u001b[0m\u001b[2m:\u001b[0m failed to connect to websocket: IO error: no native root CA certificates found (errors: []), url: wss://api.openai.com/v1/responses\n\u001b[2m2026-05-01T13:54:38.780776Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_api::endpoint::responses_websocket\u001b[0m\u001b[2m:\u001b[0m failed to connect to websocket: IO error: no native root CA certificates found (errors: []), url: wss://api.openai.com/v1/responses\n"
}
```

Outcome: partial pass / infrastructure pass / model-call fail

Important nuance: the bridge currently marks `turn/completed` as `outcome.status = completed`, but Codex's inner turn payload has `turn.status = failed`. The smoke script therefore returned exit code 0 even though the model call failed. The pass/fail check should be tightened to require `outcome.reason.turn.status === "completed"`.

## 3. Frame method histogram

| method | count |
|---|---:|
| `<response>` | 3 |
| `configWarning` | 1 |
| `remoteControl/status/changed` | 1 |
| `thread/started` | 1 |
| `thread/status/changed` | 2 |
| `turn/started` | 1 |
| `item/started` | 1 |
| `item/completed` | 1 |
| `error` | 10 |
| `warning` | 1 |
| `turn/completed` | 1 |


## 4. Observed JSON-RPC streaming behavior

- Frame ordering matches local engine: partial. `initialize`, `thread/start`, `turn/start`, `thread/status/changed`, `item/started`, `item/completed`, and `turn/completed` frames were observed.
- `item/agentMessage/delta` deltas observed: no, because the upstream model request failed before response text streamed.
- `thread/tokenUsage/updated` observed: no, for the same reason.
- Any non-JSON stderr noise: yes. Codex logs a bubblewrap warning and repeated OpenAI websocket CA failures.

Observed stderr class:

```text
Codex could not find bubblewrap on PATH. Codex will use the vendored bubblewrap in the meantime.
failed to connect to websocket: IO error: no native root CA certificates found, url: wss://api.openai.com/v1/responses
```

Interpretation:

- Container can boot the bridge and Codex app-server.
- Worker -> Container -> Codex app-server JSON-RPC path works through `initialize`, `thread/start`, and `turn/start`.
- `CODEX_AUTH_JSON` reaches the Container after setting `this.envVars` as a property, not an `envVars()` method.
- The remaining blocker is image/runtime trust store, not Cloudflare Container routing.

## 5. File I/O check

Prompt that touches a file: not run yet.
Resulting artifact under `/data/workspace/...`: not observed.

Reason: first successful JSON-RPC path reached model execution but failed on native root CA certificates before useful agent output. File I/O should be tested after adding CA certificates to the image.

## 6. Long-process behavior

- 5+ minute idle then second turn: not tested.
- Multiple concurrent turns to same DO: not tested.
- Container reuse: warm `/healthz` worked after the Container was started.

## 7. Limits hit

- Worker subrequest limit reached? no evidence.
- Container OOM? no evidence.
- Disk usage at end of run: not measured.
- Image build/push: succeeded after Docker Desktop was running and Docker config exposed the buildx plugin.

## 8. Sandbox SDK comparison (if account access)

Skipped. This run tested Cloudflare Containers only.

## 9. Decision

Recommended Phase 6/7 substrate default:

- [x] Containers, but image needs CA/bubblewrap hardening before declaring full Codex compatibility
- [ ] Containers (need standard-2 or larger)
- [ ] Sandbox SDK (after beta access + parity proven)
- [ ] Dual-path required (document criteria)

Rationale:

> Containers are viable for the control path: image build/push/deploy works, Container starts, `/healthz` works, env secret materialization works, and Codex app-server JSON-RPC reaches turn execution. The remaining failure is a Linux image dependency issue (`ca-certificates`, and possibly explicit `bubblewrap`) rather than an architectural blocker.

## 10. Follow-ups for target doc / phase 1 plan

Update §6.1 Platform Limits Baseline if any pinned limit was wrong:

- No platform-limit mismatch found in this run.

Update §12 Sandbox vs Container policy table if assumptions changed:

- Keep Containers as the Phase 6/7 default for Codex compatibility.
- Add image hardening requirement: install native root CA certificates and consider installing `bubblewrap` instead of relying on Codex vendored fallback.
- Add bridge correctness requirement: app-server bridge must use Codex 0.128.0 JSON-RPC field shapes:
  - `thread/start.sandbox = "danger-full-access"`
  - `turn/start.sandbox_policy = "dangerFullAccess"`
- Tighten smoke pass criterion to inspect the inner turn status, not only bridge outcome.

Add to `docs/cloudflare-platform-limits.md` (Phase 0 deliverable):

- Containers deploy requires local Docker daemon and buildx-compatible Docker config for `wrangler deploy` image build.
- For local macOS Docker Desktop, a minimal `DOCKER_CONFIG` without the `cli-plugins` symlink made Wrangler fall back to legacy `docker build` and fail on `--load`; include the buildx plugin in the Docker config or use default Docker Desktop config.
- `@cloudflare/containers` env configuration uses the `envVars` property; an `envVars()` method did not pass secrets into the Container.

## 11. Local scaffold changes made during spike

- `src/worker.ts`: switched Container secret passing to `this.envVars = ...` in the constructor and used versioned Container instance names to avoid stale DO/container env during smoke runs.
- `container/server.mjs`: fixed Codex 0.128.0 JSON-RPC sandbox field shapes for thread and turn startup.

These are spike fixes, not production implementation.

## 12. VPS Docker WorkerHost run

Run date: 2026-05-01
Host: `dev@74.48.189.45`
Remote workspace: `~/symphony-codex-worker`
Docker image: `symphony-codex-worker:dev`
Container name: `symphony-codex-worker`
Published endpoint: `127.0.0.1:8788 -> container :8080`
Access path from local dev: SSH tunnel `127.0.0.1:8788 -> dev@74.48.189.45:127.0.0.1:8788`

Environment findings:

| Item | Result |
|---|---|
| Remote OS | Ubuntu Linux, kernel `6.8.0-90-generic`, x86_64 |
| Docker | Present, server `29.0.4` |
| Node | Present |
| Bun | Not present; not required for the running container |
| Disk | `/dev/vda2`, 96G total, 32G available before build |
| Memory | 5.8 GiB total, about 2.4 GiB available before build |

Deployment notes:

- Synced the spike scaffold to the VPS with `node_modules`, `.wrangler`, and `secrets` excluded from normal source sync.
- Materialized secrets under `~/symphony-codex-worker/secrets` with `0700` directory and `0600` files.
- Used `CODEX_AUTH_JSON_B64` and `CODEX_CONFIG_TOML_B64` to avoid multiline JSON/TOML shell quoting issues.
- Passed the same local third-party model provider environment used by the local Codex setup: `CRS_OAI_KEY` and `KIMI_API_KEY`.
- Mounted `~/symphony-codex-worker/data/workspace` to `/data/workspace` so file I/O can be inspected after smoke tests.
- Added `.dockerignore` so remote `secrets/`, `data/`, `node_modules/`, and report files are not sent in the Docker build context. Rebuilt after this change; final build context was 71 bytes.

Container boot result:

```text
symphony-codex-worker Up 2 minutes 127.0.0.1:8788->8080/tcp
[bridge] codex auth materialized
[bridge] codex config materialized
[bridge] listening on :8080
```

### 12.1 READY smoke through local SSH tunnel

```json
{
  "worker_url": "http://127.0.0.1:8788",
  "model": "gpt-5.5",
  "prompt": "Reply with the single word READY and nothing else.",
  "total_ms": 7669,
  "bridge_ms": 7016,
  "outcome": {
    "status": "completed",
    "reason": {
      "threadId": "019de3ea-5856-7712-8a13-13d8223ee850",
      "turn": {
        "id": "019de3ea-588c-79b3-87c3-446e8061defc",
        "items": [],
        "status": "completed",
        "error": null,
        "startedAt": 1777645279,
        "completedAt": 1777645285,
        "durationMs": 6401
      }
    }
  },
  "frame_count": 18,
  "frame_method_histogram": {
    "<response>": 3,
    "remoteControl/status/changed": 1,
    "thread/started": 1,
    "thread/status/changed": 2,
    "turn/started": 1,
    "item/started": 2,
    "item/completed": 2,
    "account/rateLimits/updated": 2,
    "model/verification": 1,
    "item/agentMessage/delta": 1,
    "thread/tokenUsage/updated": 1,
    "turn/completed": 1
  },
  "stderr_tail": ""
}
```

Outcome: pass. The bridge outcome and the inner Codex turn status are both `completed`; `item/agentMessage/delta` and `thread/tokenUsage/updated` were observed; no stderr tail was emitted.

After adding `.dockerignore` and restarting the container, the same READY smoke passed again with `total_ms=13144`, `bridge_ms=12425`, `frame_count=18`, and empty stderr.

### 12.2 File I/O smoke

Prompt:

```text
Create a file named vps-smoke.txt in the current working directory containing exactly READY, then reply with the single word READY.
```

Result summary:

```json
{
  "worker_url": "http://127.0.0.1:8788",
  "model": "gpt-5.5",
  "total_ms": 17158,
  "bridge_ms": 15518,
  "outcome": {
    "status": "completed",
    "reason": {
      "turn": {
        "status": "completed",
        "error": null,
        "durationMs": 14969
      }
    }
  },
  "frame_count": 24,
  "stderr_tail": ""
}
```

Remote artifact verification:

```text
~/symphony-codex-worker/data/workspace/vps-smoke.txt
size=5
content=READY
```

After adding `.dockerignore` and restarting the container, the file I/O smoke passed again with `total_ms=20433`, `bridge_ms=19819`, `frame_count=24`, empty stderr, and the same remote artifact content.

Outcome: pass. The VPS Docker WorkerHost can run Codex app-server, call the local third-party provider configuration, stream JSON-RPC events, and write to the mounted workspace.

### 12.3 Execution-substrate recommendation update

For the current development loop, use `VpsDockerWorkspace` on `dev@74.48.189.45` as the default WorkerHost. This is cheaper and easier to debug than Cloudflare Containers while keeping the Cloudflare Agent-native control plane design intact.

For the target architecture, keep the execution plane pluggable:

```text
WorkerHost / WorkspaceAdapter
├── VpsDockerWorkspace              # current dev default
├── CloudflareContainerWorkspace    # managed Cloudflare option
├── CloudflareSandboxWorkspace      # opt-in after parity spike
└── LocalDockerWorkspace            # local compatibility/debug adapter
```

Cloudflare Containers remain viable as a managed execution substrate, but they are no longer required for the current dev environment or for cost-sensitive deployments.

## 13. Persistent bridge spike (spike v1)

Run date: 2026-05-01
Bridge change: spawn-once + persistent thread + serialized turn lock + `/reset` endpoint (commit `2576f72`).
Multi-turn smoke: `scripts/smoke-multi.ts` (commit `bbef3c0`).

### 13.1 Goals

Replace the spawn-per-request bridge so the WorkerHost mirrors the production
shape (one IssueAgent → one long-lived codex session per issue, many turns
share a thread). Validate:

- `initialize` + `thread/start` happen exactly once across many `/run-turn`
  calls.
- `threadId` persists across turns (the only way to share conversation context
  in codex).
- `/reset` kills codex and starts a fresh thread on the next call.
- Cold-start cost is paid once per container life, not per turn.

### 13.2 VPS Docker WorkerHost result (new bridge)

Single-turn smoke (`scripts/smoke.ts`):

- `total_ms=6810`, `bridge_ms=6133`
- Inner turn `completed`, threadId `019de40d-b113-7c80-b04d-c056bac227c4`
- Frames included `item/agentMessage/delta` and `thread/tokenUsage/updated`
- Empty `stderr_tail`

Multi-turn smoke (`scripts/smoke-multi.ts`, 3 turns + `/reset` + 1 turn):

```json
{
  "thread_persistence": "ok",
  "reset_creates_new_thread": "ok",
  "cold_vs_warm_ms": {
    "cold_init": 3858,
    "warm_avg": 5134,
    "post_reset": 8140
  },
  "turns": [
    { "label": "turn-1", "bridge_ms": 3858, "inner_status": "completed",
      "thread_id": "019de40d-b113-7c80-b04d-c056bac227c4" },
    { "label": "turn-2", "bridge_ms": 2894, "inner_status": "completed",
      "thread_id": "019de40d-b113-7c80-b04d-c056bac227c4" },
    { "label": "turn-3", "bridge_ms": 7373, "inner_status": "completed",
      "thread_id": "019de40d-b113-7c80-b04d-c056bac227c4" },
    { "label": "turn-4", "bridge_ms": 8140, "inner_status": "completed",
      "thread_id": "019de40e-266d-7b52-81a0-f487bfcaa27b" }
  ]
}
```

Outcome: full pass. All four inner turns `completed`, turns 1–3 share the same
`threadId` (proves spawn-once + persistent thread), turn 4 has a different
`threadId` (proves `/reset` creates a fresh thread). Warm reuse averages
~5s vs. ~8s post-reset cold start. The previous spawn-per-request bridge
paid ~7s cold start every turn.

### 13.3 Cloudflare Container WorkerHost result (new bridge)

Infrastructure:

- `/healthz` 200 ✅
- `/reset` 200 with body `{"reset": true}` ✅ (proves new bridge image is
  live in the running Container instance)

Model call: **fail**. Multi-turn smoke shows all four inner turns `failed`
with the same error class as the original `§1` partial pass:

```text
"stream disconnected before completion: error sending request for url
 (https://api.openai.com/v1/responses)"
```

Stderr shows the original codex CA-cert error class:

```text
codex_api::endpoint::responses_websocket: failed to connect to websocket:
  IO error: no native root CA certificates found (errors: []),
  url: wss://api.openai.com/v1/responses
```

Each turn produces a different `threadId`, because codex exits after the
model call fails, the bridge `clearCodexState` drops the cached thread, and
the next `/run-turn` lazy-inits a fresh codex.

This **is not** a bridge-shape regression: the bridge is observably
correct on VPS with the same image. It is a Cloudflare Container TLS
resolution finding.

### 13.4 Deploy mechanics: how to actually update CF

Repeating the same `wrangler deploy` after a bridge file change is **not**
sufficient. Wrangler container deploy will:

1. Build the local Docker image with a content-addressed tag.
2. Compute a manifest hash and check whether the registry already has it.
3. If yes, **skip the push** and **leave the Worker config pointing at the
   old image tag**, even though the Worker version ID is still bumped.
4. If a new container instance is started after `sleepAfter` expires, it
   pulls the (still old) image.

Two structural changes finally pushed the new bridge to a fresh Container:

- `Dockerfile`: added `ENV BRIDGE_REVISION=v1-persistent-2026-05-01` so the
  manifest hash is forced to differ (cache-bust). Without this, deploys 1–3
  this session reused the prior image hash.
- `src/worker.ts`: bumped `CONTAINER_INSTANCE_NAME` from
  `local-provider-config-v1` to `persistent-bridge-v1`. Even after the new
  image was uploaded (deploy 4), the existing warm Container kept serving
  the old code until `sleepAfter` (5m) expired. Bumping the DO instance
  name created a fresh DO + Container immediately and `/reset` started
  returning 200.

Operator rule for future bridge-shape changes on Cloudflare Containers:
bump `BRIDGE_REVISION` and `CONTAINER_INSTANCE_NAME` together, or accept a
5-minute warm-instance delay before the new code is reachable.

### 13.5 Open: CF Container TLS resolution

Superseded by §15: after deleting and recreating the Container application,
the image with `SSL_CERT_FILE` / `SSL_CERT_DIR` completed real Codex turns.

The same Docker image works on VPS but fails on Cloudflare Container.

Confirmed by inspecting the deployed image
`registry.cloudflare.com/.../symphony-codex-spike-codexcontainer:37c09245`
on the local Docker host:

- `/etc/ssl/certs/ca-certificates.crt` is present (216 KB).
- `/usr/bin/bwrap` (bubblewrap) is present.
- Base is Debian GNU/Linux 12.

Therefore the CF runtime is somehow not exposing the same trust store to
codex. Hypotheses to test next:

1. **`SSL_CERT_FILE` env var.** Try `ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`
   and `SSL_CERT_DIR=/etc/ssl/certs` in the Dockerfile, then redeploy.
2. **codex Rust HTTP stack.** codex 0.128.0 may use rustls with a vendored
   trust store that ignores OS CA paths in some configurations. Verify by
   running codex inside the deployed image locally with `docker run` and
   the same env vars CF would set; if it works locally but fails on CF,
   the difference is in CF's runtime, not the image.
3. **CF Container egress.** Check whether CF Containers go through an HTTPS
   inspection middlebox or a proxy that requires a Cloudflare-issued
   intermediate cert in the trust store.
4. **Use AI Gateway instead of api.openai.com directly.** Routes outbound
   model traffic through `https://gateway.ai.cloudflare.com/...` which is
   already trusted by CF runtime; this also wins us caching/limits/audit
   for Phase 2+ control plane.

Until this is resolved, **CF Container is not a usable model-execution
substrate** for Codex-as-runtime. VPS Docker remains the dev default and
the only proven model-execution path. CF Container is validated only at the
infrastructure layer (image build, deploy, secret materialization, /healthz,
/reset, JSON-RPC stream up to model call).

### 13.6 Updated execution-substrate recommendation

| WorkerHost | Bridge | /healthz | /reset | Single turn | Multi-turn | Status |
|---|---|---|---|---|---|---|
| VPS Docker | persistent | ✅ | ✅ | ✅ inner completed | ✅ thread persists, reset OK | **Production-grade for spike** |
| Cloudflare Container | persistent | ✅ | ✅ | ❌ TLS / CA error | ❌ codex re-inits each turn | **Infra OK; model path blocked on §13.5** |
| Cloudflare Sandbox | n/a | not run | not run | not run | not run | Opt-in only |
| Local Docker | n/a | n/a | n/a | n/a | n/a | Debug only |

Decision: keep `VpsDockerWorkspace` as the dev default and as the Phase 7
Codex compatibility substrate. `CloudflareContainerWorkspace` waits on the
§13.5 CA/TLS resolution before it can be promoted from "infra-only" to
"production-capable" on the WorkerHost matrix.

## 14. §13.5 TLS timebox attempt (followup)

Run date: 2026-05-01 later same session
Timebox budget: 30–60 min per `omc ask codex` advice.
Outcome: **inconclusive — blocked on CF deploy state, not on the TLS hypothesis**.

### 14.1 Changes attempted

- `Dockerfile`: added `ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`
  and `ENV SSL_CERT_DIR=/etc/ssl/certs`. The Codex Rust HTTP stack should
  consult these if it falls back through the rustls-native-certs path.
- `Dockerfile`: bumped `BRIDGE_REVISION` from `v1-persistent-2026-05-01`
  to `v2-tls-cert-env-2026-05-01` so wrangler computes a new manifest
  hash and pushes a new image (per §13.4).
- `src/worker.ts`: bumped `CONTAINER_INSTANCE_NAME` from
  `persistent-bridge-v1` to `persistent-bridge-v2-tls` so a fresh
  Durable Object instance materializes a fresh Container with the new
  image (also per §13.4).

### 14.2 Deploy outcome

Wrangler deploy succeeded:

```text
image switched: :fdff8d96 -> :659ed7a1
Current Version ID: 659ed7a1-8243-45c1-af22-155ea1952ec3
```

Probe results:

```text
GET  /healthz  -> 200 ok
POST /reset    -> 404 not found     (expected 200 with new bridge)
POST /reset    -> 404 not found     (retry after 3s warm-up)
```

`/reset` 404 means the running Container is still serving the OLD
spawn-per-request bridge despite a fresh DO instance name and a confirmed
new image tag in the worker config. This is the same deploy-state inversion
class observed in §13.4 deploys 1–3, except this time §13.4's reliable
work-around (bump `BRIDGE_REVISION` + bump `CONTAINER_INSTANCE_NAME`
together) did not produce a fresh Container in time to validate the SSL
hypothesis.

Either the Container product retains some routing state across DO instance
name changes, or wrangler's deploy diff is reporting an image change while
serving a prior container version. The result is that we could not
reach a "model call passes / model call still fails" answer on the SSL
fix within the timebox.

### 14.3 What this rules out and rules in

Rules in (still possible):

- `SSL_CERT_FILE` / `SSL_CERT_DIR` env vars MAY fix `no native root CA
  certificates found`. Untested; image is built and ready, just not
  reachable through the current CF Container routing.

Rules out:

- Nothing about codex's TLS resolution behavior is concluded.

### 14.4 Operator next-attempt checklist

1. `wrangler container delete` (or remove the application stanza, deploy,
   re-add, deploy) to reset CF-side container state. The current
   incremental deploy path appears to retain stale routing.
2. After a clean container application redeploy, verify
   `POST /reset -> 200` before running any model smoke. `/reset` is the
   load-bearing canary that proves the new bridge image is actually
   being served.
3. If `/reset` returns 200 and `bun run scripts/smoke.ts` still fails on
   the same `no native root CA certificates found` stderr line, the SSL
   env-var fix is wrong and the next theory to test is AI Gateway
   routing (`https://gateway.ai.cloudflare.com/...` as the codex provider
   `base_url`), per `docs/cloudflare-platform-limits.md` future hardening
   options.
4. If `/reset` returns 200 and the smoke passes, update §13.5 / §13.6
   with the new substrate matrix entry.

### 14.5 Decision

Superseded by §15: the deploy reset checklist was executed and unblocked the
CF Container model path for single-turn Codex execution.

Historical decision before §15: `VpsDockerWorkspace` was the only Codex
execution substrate validated end-to-end, and `CloudflareContainerWorkspace`
was gated on the §13.5 CF TLS finding. Per ADR-0001, that never triggered
Phase 10 native CodingAgent work; it remained a WorkerHost-substrate concern.

## 15. CF Container deploy reset and SSL_CERT_FILE validation

Run date: 2026-05-01 later same session  
Task: execute §14.4 as an independent reset/deploy attempt.  
Worker URL: `https://symphony-codex-spike.blueyang.workers.dev`

### 15.1 Reset and deploy actions

- Verified Wrangler: `4.87.0`.
- Listed current Container application:
  - old application ID: `a0323068-1f44-4feb-a8d6-99f1adcb2d72`
  - name: `symphony-codex-spike-codexcontainer`
  - live instances before reset: `3`
- Deleted the old Container application with `wrangler containers delete a0323068-1f44-4feb-a8d6-99f1adcb2d72`.
- Verified `wrangler containers list` returned `No containers found`.
- Redeployed with `wrangler deploy`.

Deploy result:

```text
Created application symphony-codex-spike-codexcontainer
Application ID: a03b3af1-3907-4451-a35e-dd67f8fc2782
Current Version ID: 59d9d260-5644-423c-9efa-993326660353
Image digest: sha256:8545a552a281c7e22376668b249c44537818c68010b1a8fce51e72218b664a74
```

The image already existed remotely, so Wrangler skipped the push, but the Container application itself was newly created. This is the missing reset step from §14.4.

### 15.2 `/reset` canary

After redeploy, `/reset` returned 200 immediately and repeatedly:

```text
GET  /healthz -> 200 ok
POST /reset   -> 200 {"reset":true}
```

This confirms the new persistent bridge image is being served. The prior §14 deploy-state blocker is resolved.

Runtime instance check:

```text
Application ID: a03b3af1-3907-4451-a35e-dd67f8fc2782
Instance name: persistent-bridge-v2-tls
State: running
Location: dfw13
Created: 2026-05-01T15:36:14.748999936Z
```

### 15.3 SSL smoke result

Command shape:

```bash
WORKER_URL="https://symphony-codex-spike.blueyang.workers.dev" \
TIMEOUT_MS=120000 \
bun run scripts/smoke.ts
```

Result:

```json
{
  "worker_url": "https://symphony-codex-spike.blueyang.workers.dev",
  "model": "gpt-5.5",
  "prompt": "Reply with the single word READY and nothing else.",
  "total_ms": 9446,
  "bridge_ms": 8265,
  "outcome": {
    "status": "completed",
    "reason": {
      "threadId": "019de430-7819-7811-8993-38add3c555ad",
      "turn": {
        "id": "019de430-78da-7630-9f5e-ba299cf70122",
        "items": [],
        "status": "completed",
        "error": null,
        "startedAt": 1777649875,
        "completedAt": 1777649882,
        "durationMs": 6871
      }
    }
  },
  "frame_count": 14,
  "frame_method_histogram": {
    "thread/started": 1,
    "<response>": 1,
    "thread/status/changed": 2,
    "turn/started": 1,
    "item/started": 2,
    "item/completed": 2,
    "account/rateLimits/updated": 2,
    "item/agentMessage/delta": 1,
    "thread/tokenUsage/updated": 1,
    "turn/completed": 1
  },
  "stderr_tail": ""
}
```

Direct reply validation:

```json
{
  "durationMs": 10322,
  "outcomeStatus": "completed",
  "innerTurnStatus": "completed",
  "innerError": null,
  "frameCount": 15,
  "replyFromDeltas": "CF_CONTAINER_SSL_OK",
  "stderrTail": "",
  "threadId": "019de431-2ba5-7323-a5e3-421dd3f2b6dc"
}
```

### 15.4 Conclusion

The `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt` and `SSL_CERT_DIR=/etc/ssl/certs` hypothesis is validated after a clean CF Container application reset. The previous `no native root CA certificates found` failure did not reproduce. CF Container now completes real Codex model turns with local third-party provider config.

Updated WorkerHost matrix:

| WorkerHost | Bridge | /healthz | /reset | Single turn | Multi-turn | Status |
|---|---|---|---|---|---|---|
| VPS Docker | persistent | ✅ | ✅ | ✅ inner completed | ✅ thread persists, reset OK | Production-grade for spike |
| Cloudflare Container | persistent | ✅ | ✅ | ✅ inner completed | Not re-tested after reset | **Hosted model path unblocked; needs multi-turn/file I/O follow-up** |
| Cloudflare Sandbox | n/a | not run | not run | not run | not run | Opt-in only |
| Local Docker | n/a | n/a | n/a | n/a | n/a | Debug only |

Follow-up: run Cloudflare Container multi-turn reuse and file I/O smoke before declaring full parity with `VpsDockerWorkspace`.
