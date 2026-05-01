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
