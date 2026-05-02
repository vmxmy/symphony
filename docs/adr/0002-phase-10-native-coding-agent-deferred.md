# ADR-0002: Phase 10 native CodingAgent is deferred until Phase 5 + 6/7 ship; parallel-evaluation harness is the conversion gate

Status: Accepted (as deferred-decision stub)
Date: 2026-05-02
Supersedes: none
Builds on: ADR-0001 (CodingAgentAdapter and WorkerHost are the replaceable boundaries)
Deciders: project owner; second opinion via `omc ask codex` artifact
`2026-05-01T19-19-16-648Z` (Phase 0/1 next-step ranking)

---

## 1. Why this ADR exists now

ADR-0001 pinned `CodingAgentAdapter` and `WorkerHost` as the two replaceable
seams and listed five triggers (`§3`) under which the deferred Phase 10
"native CodingAgent on Worker + DO" path becomes a real roadmap item. That
ADR was written at the end of Phase 1, before any Phase 2–4 control-plane
code shipped.

Three things have happened since:

1. The Phase 0 CF Container TLS issue was closed at the WorkerHost layer
   (`cde7007`, `SSL_CERT_FILE` env var). ADR-0001 §3 trigger #1 (Codex
   hosted-execution unreliability) is **not** firing.
2. Phase 2–4 sub-cuts 1+2 shipped with `MockCodingAgentAdapter` as the only
   coding-agent path. The control plane was implementable without Codex,
   confirming ADR-0001 §2.3.
3. The codex-advisor session of 2026-05-01 explicitly recommended writing
   a Phase-10-specific ADR stub to prevent "Codex idolization" — the
   pattern where every operational hiccup gets reframed as "we should go
   native now." ADR-0001 covers the boundary reasoning, but not the
   evaluation-harness requirement that turns a hypothetical native path
   into a comparable artifact.

This ADR is the explicit Phase 10 placeholder. It does **not** approve
Phase 10 design work, and it does **not** restate ADR-0001's boundary
arguments. Read ADR-0001 first; this document is the narrower sequel.

## 2. Decision

D1. **Phase 10 ("native CodingAgent on Cloudflare Worker + Durable
Object") remains deferred** with the trigger framework in ADR-0001 §3 as
the conversion gate. No Phase 10 design or implementation work is
authorized by this ADR.

D2. **`codex_compat` is the path of record for shipping real coding-agent
execution** through Phases 5–9. Native Phase 10 stays out of the
roadmap until at least Phase 8 ships.

D3. **A parallel-evaluation harness is a precondition for promoting
Phase 10 from deferred to scoped.** The evaluation harness must exist
before the first Phase 10 design document; it is not part of the
Phase 10 design work itself. See §4.

D4. **The Phase 10 ADR conversion bar is set higher than the ADR-0001
trigger bar.** ADR-0001 trigger firing is necessary but not sufficient.
Promotion also requires evidence from the parallel-evaluation harness
showing native path advantage on a concrete metric. See §5.

## 3. What Phase 10 would and would not do (sketch only)

This is a sketch of scope, not a design. Recorded so future readers
understand what was deferred without re-deriving it.

### What Phase 10 would do

- Replace the **brain** behind `CodingAgentAdapter`: a Worker + Durable
  Object loop that owns thread state, calls models directly via
  Cloudflare AI Gateway (or another provider abstraction), and drives
  the turn loop with the same `runTurn` contract as `CodexAdapter`.
- Continue to use `WorkerHost` for **tool execution** — shell, file
  patches, repo operations stay in the existing substrate (VPS Docker
  or Container). Phase 10 does NOT remove `WorkerHost`.
- Implement a **provider abstraction** so the native brain can route
  among multiple model vendors without the caller noticing. This is the
  canonical place where AI Gateway integration would live.
- Keep `ToolGateway` semantics unchanged; the native brain hits the
  same tool-call envelope and the same idempotency / approval surface.

### What Phase 10 would NOT do

- Replace `WorkerHost`. Tool execution stays substrate-isolated.
- Replace `IssueAgent`, `ProjectAgent`, `TenantAgent`, or the
  `ExecutionWorkflow`. Those are control-plane shapes that survive any
  brain swap.
- Mandate a single model provider. Provider routing is part of the
  design, not preordained here.
- Delete the `codex_compat` adapter. The two adapters coexist for at
  least one full milestone of comparison data.

### Anti-pattern call-out

Do **not** in this ADR or any preparatory note:

- Specify the provider-abstraction interface.
- Enumerate model vendors or routing rules.
- Design the AI Gateway header / auth / cost-attribution contract.
- Sketch the tool-runner taxonomy (which tools live where).
- Pre-pick whether the native loop is per-DO or per-Workflow.

Those are the actual Phase 10 design work. Doing them here is the
mistake this ADR exists to prevent.

## 4. Parallel-evaluation harness (precondition)

Before any Phase 10 design document is written, the project must have a
working `codex_compat` adapter (Phase 7 deliverable) that successfully
completes a non-trivial issue corpus end-to-end. The corpus is the
**measurement vehicle** that turns Phase 10 promotion from a hunch into
a comparable artifact.

Concrete shape:

- **Issue corpus**: at least 30 mirrored issues across at least 2
  profiles, exercising the full 16-step ExecutionWorkflow with real
  tool calls (Linear GraphQL, GitHub PR creation, file edits).
- **Reference run**: each issue is run once through `codex_compat`
  (Phase 7 path) and the run artifacts (manifest, transcripts, token
  usage, wall time, success/failure) are persisted to R2.
- **Metrics**:
  - Success rate (issue reaches `completed` workflow status).
  - Time-to-PR (workflow start → tracker state transition).
  - Token cost (input + output across all turns).
  - Tool-call count.
  - Operator intervention count (cancels, retries, escalations).
- **Native run constraint**: any future Phase 10 candidate must run the
  same corpus through the native adapter and be compared on the same
  metric set. No metric may be excluded after the fact.

The harness lives at `cf-control-plane/scripts/eval-corpus/` (deferred
implementation). This ADR documents the requirement; the actual harness
ships as part of Phase 7 wrap-up or early Phase 8.

## 5. Promotion criteria (deferred → scoped)

Phase 10 promotes from deferred to scoped only if **all** of the
following hold:

| # | Criterion | Evidence required |
|---|---|---|
| C1 | At least one ADR-0001 §3 trigger has fired with documented evidence | Trigger entry appended to ADR-0001 §7 |
| C2 | `codex_compat` adapter has run the evaluation corpus end-to-end at least once | Corpus run report under R2 / `docs/eval/` |
| C3 | A specific operational pain point or capability gap that Phase 10 would meaningfully address | Written failure mode + evidence trail |
| C4 | A one-page design sketch identifying which boundaries change and which stay | Document at `docs/cloudflare-agent-native-phase10-sketch.md` |
| C5 | Reviewer confirmation that the native path is non-redundant given Phase 9 (tracker abstraction) and Phase 11 (multi-tenant hardening) | `omc ask codex --critic` artifact |

**C1 alone is not enough.** A trigger firing tells us Codex has a problem;
it does not tell us a native path solves the problem better than fixing
Codex inside the existing seams.

**C2 is the highest-leverage gate.** Without the corpus baseline, any
promotion argument reduces to "the code we have not written yet would
be better than the code we have." That's the failure mode this ADR is
designed to prevent.

## 6. What converts when this ADR is superseded

When (if) Phase 10 promotes, this ADR is superseded by:

- A new ADR (likely 0010 or higher) that records the promotion
  decision, the trigger that fired, the corpus evidence, and the design
  sketch.
- A `docs/cloudflare-agent-native-phase10-plan.md` predictive plan
  following the 13-section template used by `phase4-plan.md`,
  `phase5-plan.md`, and `phase6-7-plan.md`.

This ADR's `Status` line changes from `Accepted (as deferred-decision
stub)` to `Superseded by ADR-NNNN` at that point.

## 7. Consequences

Positive:

- Every "Codex hit a snag, let's go native" suggestion is redirected to
  one of three places: ADR-0001 §3 (does this match a trigger?), the
  evaluation harness (do we have data?), or the WorkerHost layer (can we
  fix it at the substrate?). The argument no longer escapes those
  bounds.
- Phase 5–9 work can ship without periodic re-litigation of the brain
  decision.
- When Phase 10 finally is promoted, the artifact will land on top of
  evidence rather than enthusiasm.

Negative:

- A genuinely needed native path is delayed by however long it takes
  Phase 5–7 to ship. *Mitigation*: the criteria in §5 are explicit, so
  the promotion path is unblocked the moment evidence accumulates.
- The evaluation harness (§4) is itself deferred work that must be
  remembered and budgeted. *Mitigation*: this ADR's promotion criterion
  C2 is the forcing function — Phase 10 cannot promote without it,
  which forces the harness to be built when promotion becomes
  attractive.
- Operators frustrated by hosted-Codex issues during sustained outages
  may demand earlier promotion. *Mitigation*: substrate switching via
  `WorkerHost` (VPS Docker fallback) is the documented short-term
  remedy in ADR-0001 §6.

## 8. Non-goals

- This ADR does not approve building Phase 10.
- This ADR does not approve building the evaluation harness ahead of
  Phase 7. The harness is a precondition for promotion, not a Phase 5
  deliverable.
- This ADR does not preclude smaller "native experiments" inside
  spikes (e.g. a native loop running against a single issue in a
  spikes/ subdirectory). Such experiments must not produce a
  promotion claim without satisfying §5.

## 9. References

- `docs/adr/0001-coding-agent-and-workerhost-boundaries.md` — boundary
  decisions and trigger framework.
- `docs/cloudflare-agent-native-target.md` §8.5 (CodingAgent Adapter),
  §16 (phase plan), §22 (critic review).
- `docs/cloudflare-agent-native-phase4-plan.md` — Phase 4 sub-cut 3
  (no Phase 10 surface).
- `docs/cloudflare-agent-native-phase5-plan.md` — `MockCodingAgentAdapter`
  ships as the single Phase 5 adapter; reaffirms ADR-0001 §2.3.
- `docs/cloudflare-agent-native-phase6-7-plan.md` — Phase 7 ships
  `codex_compat`; this ADR's evaluation corpus piggybacks on that.
- `docs/integration-plan.md` §3 (Track 2 retroactive review) and §11
  (Out of Scope) — process discipline that complements this ADR.
- `omc ask codex` artifact 2026-05-01T19:19:16Z — Phase 10 framing
  recommendation.
- `spikes/codex-on-cloudflare/REPORT.md` §15 — persistent bridge
  results that informed ADR-0001 trigger calibration.
