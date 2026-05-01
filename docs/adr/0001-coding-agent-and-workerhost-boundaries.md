# ADR-0001: CodingAgentAdapter and WorkerHost are the replaceable boundaries; Codex-native vs Cloudflare-native is a deferred decision

Status: Accepted
Date: 2026-05-01
Supersedes: none
Deciders: project owner; second opinion via `omc ask codex` (artifact `2026-05-01T15-08-02-758Z`)

## 1. Context

By the end of Phase 1 the engine has two stable seams:

- **`CodingAgentAdapter`** (`ts-engine/src/contracts/agent.ts`) — replaces the
  in-process Codex JSON-RPC dependency with a contract that any coding-agent
  brain can implement.
- **`WorkerHost`** / `WorkspaceAdapter`
  (`ts-engine/src/contracts/workspace.ts` and the Phase 6 `WorkerHost`
  contract documented in `docs/cloudflare-agent-native-target.md` §6) —
  replaces the local-shell execution dependency with a substrate-level
  contract: `vps_docker`, `cloudflare_container`, `cloudflare_sandbox`,
  `local_docker`.

The Phase 0 spike (`spikes/codex-on-cloudflare/`) showed Codex compatibility
running cleanly on `vps_docker` and single-turn model execution passing on
`cloudflare_container` after a clean Container application reset. It
also surfaced a recurring temptation: every time the Codex execution path
hits a runtime quirk, a voice in the room argues for "Phase 10 native
CodingAgent now" — i.e. swap the Codex brain for a Worker+DO orchestration
loop, and reduce the Container to a thin shell-tool runner.

Without explicit triggers, that argument will keep recurring on every
operational hiccup, hijacking control-plane work that should not be tied to
a specific coding-agent brand. This ADR pins the boundaries down so the
discussion stops happening at the wrong layer.

## 2. Decision

1. **`CodingAgentAdapter` is the brain boundary.** Anything that produces
   model tokens, drives a turn loop, manages thread state, or accumulates
   token usage runs behind this interface. Both the existing `CodexAdapter`
   and any future native implementation satisfy the same contract.
2. **`WorkerHost` is the tool-execution boundary.** Anything that runs
   shell, opens files, applies patches, or persists workspace state runs
   inside a `WorkerHost` substrate. Substrate choice is a profile-level
   knob; control-plane code never branches on substrate identity.
3. **Phase 2 control plane (Tenant/Project/IssueAgent + D1 + R2 + Queues +
   Workflows) does not depend on Codex specifics.** Phase 2 must be
   implementable end-to-end with a `MockCodingAgentAdapter` and any
   `WorkerHost`. Codex-only behavior (`linear_graphql`, app-server JSON-RPC
   shape, ChatGPT auth) belongs in adapters, not in the Agents.
4. **Phase 10 ("native CodingAgent on Worker + DO") is not a current
   roadmap item.** It is deferred until the trigger conditions in §3 are
   met, AND only after Phase 2 is operational with a Mock adapter.

## 3. Triggers for promoting Phase 10

A native `CodingAgentAdapter` (Worker + Durable Object orchestrator that
calls models via AI Gateway, with Container reduced to a shell tool runner)
becomes a candidate work item only when at least one of these is true:

| # | Trigger | How we measure it |
|---|---|---|
| 1 | Codex hosted-execution unreliability | More than 2 distinct Codex runtime issues block Cloudflare-managed deployment for >2 weeks each (e.g. CF Container TLS, app-server protocol regression, vendored dependency breakage) |
| 2 | `CodingAgentAdapter` capability gap | A near-term product requirement cannot be expressed through the existing adapter contract (e.g. multi-provider routing, in-flight model fallback, native Cloudflare AI Gateway audit hooks) |
| 3 | Cost runaway | Codex token / sandbox / process overhead exceeds the modeled budget by >2x and the gap cannot be closed inside the adapter |
| 4 | Tool protocol divergence | The Codex tool-call surface stops matching what `ToolGatewayAgent` needs to enforce (idempotency, approvals, MCP fan-out) and the adapter cannot bridge the gap without invasive workarounds |
| 5 | Provider lock-in cost | Need to support a model provider whose contract Codex CLI does not expose, AND the workaround through Codex config becomes a maintenance burden |

**None of these are true today.** The Phase 0 spike's CF Container TLS issue
was resolved at the WorkerHost layer by a clean Container application reset
plus explicit `SSL_CERT_FILE` / `SSL_CERT_DIR` env vars; it does not satisfy
trigger #1.

## 4. Trigger evaluation cadence

- Re-read this ADR at the end of every milestone (Phase 2, Phase 3, ...).
- If any trigger fires during a phase, log a short note in this ADR
  (under "Trigger events") and decide whether to promote Phase 10 from
  "deferred" to "scoped".
- Promotion to scoped requires: the trigger description, the failure
  evidence (logs, smoke runs, cost numbers), and a one-page design sketch
  that lists what the native path takes on (orchestration loop, provider
  abstraction, tool runner contract, evaluation harness vs `codex_compat`).

## 5. Non-goals

- This ADR does not approve building a native CodingAgent.
- It does not constrain the `CodingAgentAdapter` interface beyond what is
  already in `ts-engine/src/contracts/agent.ts`.
- It does not pre-judge model providers, AI Gateway routing, or MCP
  topology. Those are downstream design questions.

## 6. Consequences

Positive:

- Every "Codex is broken on substrate X, let's go native" argument is
  redirected to the `WorkerHost` layer (where it belongs) or to a
  trigger-and-evidence record (rather than a roadmap pivot).
- Phase 2 control-plane work can proceed without coupling to the Codex
  process model.
- The `CodingAgentAdapter` contract gets time to harden against the
  existing `CodexAdapter` and a `MockCodingAgentAdapter` before a third
  implementation needs to fit the same shape.

Negative:

- A genuinely-needed native path could be delayed by one milestone if
  triggers are missed. Mitigation: the trigger list is enumerated and the
  cadence is documented; missing a trigger is a process failure, not a
  policy failure.
- Operators may find the policy frustrating during a sustained Codex
  outage. Mitigation: substrate isolation via `WorkerHost` keeps the blast
  radius small (e.g. switch the dev profile from `cloudflare_container`
  back to `vps_docker` while a substrate finding is investigated).

## 7. Trigger events

(none yet — append entries below as they fire)

## 8. References

- `docs/cloudflare-agent-native-target.md` §6 (control plane / WorkerHost
  abstraction), §8.5 (CodingAgentAdapter), §16 (phase plan), §22 (critic
  review record).
- `docs/cloudflare-agent-native-phase1-plan.md` §14 (Phase 2 readiness
  gates).
- `docs/cloudflare-platform-limits.md` §3 (WorkerHost runtime findings).
- `spikes/codex-on-cloudflare/REPORT.md` §13-§15 (persistent bridge spike;
  CF TLS reset/fix finding).
- `ts-engine/src/contracts/{agent,workspace,tracker,tools,events}.ts`
  (Phase 1 contracts).
- `omc ask codex` artifact, 2026-05-01T15:08:02Z (decision rationale and
  trigger framing).
