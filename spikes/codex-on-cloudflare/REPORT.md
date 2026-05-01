# Spike Report: Codex on Cloudflare Containers

Run date: __TODO__
Operator: __TODO__
Account: `d1da4742bef1158b96eb2a2660a49301`
Region: __TODO (Cloudflare assigns)__
Container instance type: `standard-1`
Codex version: `@openai/codex@0.128.0`
Image base: `node:20-slim`

## 1. Boot

| Step | Wall ms | Notes |
|---|---|---|
| `wrangler deploy` total | __ | Image build + push + Worker deploy |
| First `/healthz` 200 (cold) | __ | Time from first POST to ready |
| Second `/healthz` 200 (warm) | __ | DO instance reuse |

## 2. Smoke result

```jsonc
// Paste the JSON output of `bun run scripts/smoke.ts` here
```

Outcome: __completed | failed | timeout | spawn_error | exit_before_completion__

## 3. Frame method histogram

| method | count |
|---|---|
| __ | __ |

## 4. Observed JSON-RPC streaming behavior

- Frame ordering matches local engine: __yes/no__
- `item/agentMessage/delta` deltas observed: __yes/no__
- `thread/tokenUsage/updated` observed: __yes/no__
- Any non-JSON stderr noise: __notes__

## 5. File I/O check

Prompt that touches a file: __TODO write a file path__
Resulting artifact under `/data/workspace/...`: __observed/missing__

## 6. Long-process behavior

- 5+ minute idle then second turn: __reused instance / new instance / failed__
- Multiple concurrent turns to same DO: __serialized / parallel / corrupted__

## 7. Limits hit

- Worker subrequest limit reached? __no/yes (count)__
- Container OOM? __no/yes__
- Disk usage at end of run: __MB__

## 8. Sandbox SDK comparison (if account access)

__skipped (no Sandbox beta) | results below__

## 9. Decision

Recommended Phase 6/7 substrate default:

- [ ] Containers (standard-1 sufficient)
- [ ] Containers (need standard-2 or larger)
- [ ] Sandbox SDK (after beta access + parity proven)
- [ ] Dual-path required (document criteria)

Rationale:

> __Operator fills in__

## 10. Follow-ups for target doc / phase 1 plan

Update §6.1 Platform Limits Baseline if any pinned limit was wrong:

- __

Update §12 Sandbox vs Container policy table if assumptions changed:

- __

Add to `docs/cloudflare-platform-limits.md` (Phase 0 deliverable):

- __
