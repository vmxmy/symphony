# Integration Plan: PR Discipline + Retroactive Review

Author: planner pass, 2026-05-02
Companion to: `docs/cloudflare-agent-native-phase1-plan.md`,
`docs/cloudflare-agent-native-phase4-plan.md`,
`docs/cloudflare-agent-native-phase5-plan.md`.

This is **not** a phase plan. It is a process plan that addresses the
codex-advisor feedback (2026-05-01): "30 commits not PR'd will let review
debt compound." As of 2026-05-02 the count is 50 commits, and the original
framing — "push these to upstream as N PRs" — turns out to be wrong on
inspection. This plan corrects the framing and proposes a workable PR
discipline going forward, plus an optional retroactive cleanup track.

---

## 1. Context

### What we thought
The Phase 4 sub-cut 3 plan (and codex's 2026-05-01 ranking of options)
both treated "PR split for upstream review" as the highest-priority next
move — under the assumption that upstream/main is the integration target.

### What is actually true
- `git remote -v`: `origin = vmxmy/symphony` (active fork);
  `upstream = openai/symphony` (Elixir-based original).
- `git log upstream/main -3`: top commit is
  `58cf97d fix(elixir): configure Codex app-server model via config` —
  upstream is still the **Elixir** project, never absorbed the
  TypeScript rewrite.
- `git log upstream/main..HEAD`: 50 commits, but those 50 include the
  entire TypeScript rewrite (`76fc66c refactor: drop Elixir engine, go
  TypeScript-only`), the original ts-engine MVP, profile architecture,
  Phase 0–4 cf-control-plane work, and the spike directory.
- `git status`: working tree clean; `main` tracks `origin/main` and is
  in sync (`0 0` divergence).

### Implication
Upstream openai/symphony is **not** a realistic merge target for this
fork. The fork is a deliberate strategic divergence (Elixir → TypeScript
+ Cloudflare-native). Asking openai to absorb that is not a small PR
ask; it's a project-direction conversation that this plan does not
attempt to plan.

The actual review target — **if review discipline matters at all** — is
some combination of:
- (a) Future contributors to the fork (pair / hire / open-source
  contributor) who would benefit from a clean commit history and a
  reviewable backlog.
- (b) The author themselves (you), reviewing past work systematically
  to catch defects, capture ADRs, and surface invariants.
- (c) Eventual upstream re-engagement, if openai/symphony decides to
  refresh its baseline. This is speculative.

The codex advisor's actual concern — "review difficulty grows
non-linearly with unreviewed commit count" — applies regardless of
whether the reviewer is upstream, a future contributor, or future-you.
The remediation does not require upstream cooperation.

## 2. Goals

G1. Stop accumulating new unreviewed work going forward. Every Phase 4
sub-cut 3 PR onward (per the per-phase plans) is itself the review
unit; PRs land on `origin/main` via `gh pr create`, even when the
sole reviewer is the author.

G2. Make the existing 50-commit backlog auditable. Group it into named
milestones with explicit acceptance criteria, evidence trails, and ADR
links. Do **not** retroactively rewrite history; layer a review
artifact over it.

G3. Decide explicitly whether to attempt any subset of the 50 commits as
upstream PRs. The default decision is **no** for the rewrite-shaped
work; a possible **yes** for narrow targeted contributions (e.g. a
single self-contained docs PR if upstream wants the platform-limits
register).

G4. Reduce the per-phase review surface so that no future PR exceeds
~600 lines of net change, with very few exceptions.

## 3. Two Tracks

### Track 1 — Going-forward PR discipline (REQUIRED)

Starting with Phase 4 sub-cut 3 and applying to every subsequent phase:

- Each per-phase plan's "Suggested PR Breakdown" section is binding.
- Open a `gh pr create` against `origin/main` for each PR, even if the
  reviewer queue contains only the author.
- PR template (new file, see Step 4): title, summary, acceptance
  criteria, test evidence, link to phase plan, risk/rollback notes.
- Self-review pass before merge: read the diff cover-to-cover one
  business day after the PR opens. The 24-hour delay is the cheap
  forcing function — it surfaces issues the writer-context missed.
- Optional second pass: `omc ask codex` with the PR diff as input,
  using the existing artifact-capture pattern from `.omc/artifacts/ask/`.
- Merge with `Squash and merge` when small + atomic; `Rebase and merge`
  when the commit history is already well-structured (rare).

### Track 2 — Retroactive review of the 50-commit backlog (OPTIONAL)

This track is optional in the sense that the work is already on
`origin/main`. Skipping it is fine if the cost outweighs the value
for your situation.

If pursued, the 50 commits are organized into **review milestones**,
not PRs. A milestone is a labeled GitHub release on `origin` with:
- Commit range (`v0.1.0..v0.2.0`).
- A milestone summary doc in `docs/milestones/MNN-<name>.md`.
- Open ADRs called out (target.md links, phase plan links).
- Known follow-ups already filed as issues.

Milestones do **not** rewrite git history. They are layered metadata.

## 4. Milestone Inventory (Track 2 grouping)

The 50 commits naturally cluster into 6 milestones. Counts are
approximate (some commits span groupings; assigned by primary intent).

### M-01: TypeScript Rewrite (~9 commits)
- `76fc66c` drop Elixir engine
- `d787cec` ts-engine foundation: workflow loader + prompt renderer
- `efa01a5` ts-engine v0 MVP (full engine in TS/Bun)
- `4a0a44e` real-time dashboard + agent state polling + tests
- `d456929` populate token usage from Codex notification shape
- `c14df46` dashboard CSS refinement
- `1f7c5a0` add CLAUDE.md
- `6ce1e45` extract Agent interface, validate with mock adapter
- `13daa18` test: bump dashboard expectation

Review focus: the strategic rewrite. ADR coverage: target.md §1, §2,
§15 (compatibility strategy). Open question for the milestone doc:
which Elixir behavior, if any, is intentionally not preserved.

### M-02: Profile Architecture + Launcher (~3 commits)
- `ca37d84` multi-profile architecture with launcher
- `349b317` content-wechat: drop {{ issue.url }} from prompt body
- `b31aa4a` docs: detailed guide for creating new profiles

Review focus: profile schema v1 (`docs/profile-spec.md`), launcher
contract (`docs/launcher-cli.md`), workflow contract preserved across
the rewrite.

### M-03: Cloudflare Target Architecture + Phase 0 spike (~13 commits)
- `c3c35fd` target architecture for Cloudflare Agent native migration
- `53a49a5` scaffold codex-on-cloudflare phase 0 spike
- `f1a8b74` introduce engine contracts package
- `5ba015c` route dynamic tool calls through ToolGateway
- `d8c6ccb` invert tracker, workspace, and event-sink dependencies
- `945209b` document adapter boundaries from Phase 1
- `4c557fb` target: introduce WorkerHost execution plane abstraction
- `45912ff` cloudflare platform limits register
- `2d33034` VPS Docker hardening
- `bf3a072` VPS Docker WorkerHost results + operator checklists
- `2576f72` persistent codex bridge for multi-turn validation
- `bbef3c0` multi-turn smoke test
- `e17fb82` cache-bust ENV + DO instance bump

Review focus: the contract package + adapter seams (Phase 1) and the
Phase 0 spike outcomes. ADR coverage: ADR-0001
(`docs/adr/0001-coding-agent-and-workerhost-boundaries.md`).
This is the largest milestone by commit count and the most important
to review carefully — it locks the substrate for everything after.

### M-04: Phase 0 Spike Wrap-up (~3 commits)
- `3ffce70` persistent bridge results + CF TLS finding
- `a831486` TLS env-var attempt + REPORT §14 timebox finding
- `cde7007` CF Container SSL_CERT_FILE validated; §14.4 closed
- `34a9a5f` ADR-0001: CodingAgent + WorkerHost boundaries

Review focus: the §14 TLS timebox outcome (closed) and the ADR
that emerged from the spike. Effectively M-03's coda.

### M-05: Phase 2 Control Plane Skeleton (~7 commits)
- `f4e36e5` D1 schema for Cloudflare-native control plane
- `3f049f1` v1 profile importer with v2 default tracking
- `1847666` Worker entrypoint with bearer-token auth gate
- `d11933c` TenantAgent + ProjectAgent skeletons with D1 mirror
- `ca5941d` server-rendered read-only dashboard
- `c7a3f5b` mock orchestration writes full run trail to D1
- `2192470` harden Phase 2 control plane (architect-review pass)

Review focus: D1 schema decisions, capability/HMAC auth model,
Phase 2 hardening pass. ADR coverage gap — Phase 2 has no
`docs/cloudflare-agent-native-phase2-plan.md`. That gap is itself a
follow-up: write a retroactive Phase 2 plan as part of this milestone.

### M-06: Phase 3 Tracker Bridge + Phase 4 sub-cuts 1–2 (~9 commits)
- `21c297b` reconciliation diff harness for Phase 3 parity
- `4b1c0aa` Linear tracker adapter + ProjectAgent.poll + refresh route + dashboard issues
- `842830d` migration for deployed Phase 2 schema
- `fb85d38` refresh idempotency + UNIQUE collision fix
- `48d085e` scheduled cron poll + admin trigger route
- `f185bf7` queue-based tracker event ingestion
- `322094f` sync Phase 3 status across README + target + phase1-plan
- `91b9662` fill in queue-ingestion commit hash
- `6932964` IssueAgent state machine + operator routes (Phase 4 sub-cut 1)
- `f529208` enqueue dispatch decisions (Phase 4 sub-cut 2)

Review focus: the reconcile harness contract (Phase 3 readiness
gate), the Linear adapter port, and the IssueAgent state machine
+ dispatch queue. ADR coverage gap — no Phase 3 or Phase 4 plan
documents exist; the Phase 4 plan in `docs/cloudflare-agent-native-phase4-plan.md`
covers sub-cut 3 only.

## 5. Implementation Steps

### Step 1 — Lock Track 1 (going-forward PRs)

`docs/`:
- New file `docs/pr-discipline.md` codifying:
  - PR template required
  - 24-hour cool-down before merge
  - PR size soft cap (~600 net lines)
  - Self-review checklist
  - When to delegate review to `omc ask codex`

`.github/PULL_REQUEST_TEMPLATE.md` (new file):
- Sections: Summary, Linked Phase Plan, Acceptance Criteria,
  Verification Evidence, Risk + Rollback, Migration Notes.
- Mandatory checkboxes: `make all` green, `bunx tsc --noEmit` clean,
  invariant grep gates pass.

CI gate (optional, deferred):
- Add `.github/workflows/pr-checks.yml` running typecheck + bun test
  per PR. Defer to Phase 5 PR-A or later — the per-PR self-review
  process works without it.

### Step 2 — Open Phase 4 sub-cut 3 PR-A as the proof of new discipline

This is the first PR under the new discipline. It also validates the
PR template and the 24-hour cool-down on a real change. Failure mode:
the template + cool-down add too much friction to a 0.5-day PR; if so,
adjust before applying to Phase 5.

### Step 3 — Decide on Track 2 (retroactive review)

Two-question decision:
- Q1: Is there a future reviewer who needs to ramp on this codebase
  within the next 6 months? (Hire / collaborator / open-source
  community.) If **yes**, Track 2 returns its investment. If **no**,
  the artifact value is mostly for future-you, and the cost may not
  be worth it.
- Q2: Are there known defects you suspect but haven't audited? If
  **yes**, Track 2's milestone-by-milestone audit is the cheapest
  way to find them. If **no**, defer Track 2.

If both answers are no, **stop here** and run only Track 1.

### Step 4 — Track 2 milestone documents

Only if Step 3 decides yes:

For each of M-01 through M-06, create `docs/milestones/MNN-<slug>.md`
with:
- Commit range (oldest..newest).
- Milestone goal (1 sentence).
- Acceptance criteria recovered from contemporary evidence.
- Files modified (high-level, not line-by-line — point at directories).
- Open follow-ups (file as GitHub issues, link).
- ADR links (existing or proposed).
- Tag the range as `git tag v0.M.0` and push to origin.

Suggested order: M-01 first (largest, oldest, foundation; if review
finds issues it changes the cost calculus on the rest), then M-03
(also large, also foundational), then M-05 (most schema-laden), then
the smaller ones.

### Step 5 — Track 2 retroactive plan documents

For phases that have no plan document — Phase 2 (M-05), Phase 3 (part of M-06),
Phase 4 sub-cut 1+2 (part of M-06):

- Write `docs/cloudflare-agent-native-phase2-plan.md` retroactively,
  capturing decisions actually made (D1 schema, auth model, hardening
  outcomes from `2192470`). This is for review trail, not re-implementation.
- Write `docs/cloudflare-agent-native-phase3-plan.md` retroactively
  covering reconcile harness + Linear adapter + queue ingestion.
- Extend `docs/cloudflare-agent-native-phase4-plan.md` with a
  "Sub-cuts 1-2 retrospective" section linking to the actual commits
  and the design decisions they encode.

These retroactive plans are scoped tighter than the predictive plans
in Phase 4 sub-cut 3 and Phase 5 — they capture *what was decided*,
not *what to do next*.

### Step 6 — Track 2 selective upstream PRs (OPTIONAL)

Only if you want to engage with openai/symphony specifically. Realistic
candidates:
- `docs/cloudflare-platform-limits.md` (`45912ff`) — self-contained,
  factual, useful to anyone exploring Cloudflare on top of Elixir
  Symphony.
- ADR-0001 (`34a9a5f`) — same shape; standalone document.

NOT realistic candidates: anything in `cf-control-plane/`, `ts-engine/`,
or the Elixir-removal commit. These are the divergence and would not
land cleanly.

If pursued: file each as a separate, narrow PR against
`upstream/main`, with a clear "this is a docs / strategy contribution
from a fork; merging implies no commitment to absorb the rewrite."

## 6. PR Boundaries (Track 1 going-forward summary)

| Phase | PRs (per phase plan) |
|---|---|
| Phase 4 sub-cut 3 | A: backoff + state; B: D1 retry mirror + reconcile gate; C: failure routing + alarm + admin routes; D: dashboard + docs |
| Phase 5 | A: Workflows + R2 plumbing; B: IssueAgent.startRun + lease; C: 16 steps + MockCodingAgentAdapter + manifest; D: operator routes + dashboard run view; E: cleanup + docs |
| Phase 6 (future) | TBD — workspace adapter on VPS Docker, then Container/Sandbox |
| Phase 7 (future) | TBD — codex-compat adapter |

Total expected new PR cadence: ~9 PRs across Phases 4–5, then 4–6 more
through Phases 6–7. None should exceed ~600 net lines except where the
phase plan justifies it.

## 7. Acceptance Criteria

A1. `docs/pr-discipline.md` exists and is referenced from `CLAUDE.md`
or `AGENTS.md`.

A2. `.github/PULL_REQUEST_TEMPLATE.md` exists; opening any new PR
populates the template by default.

A3. Phase 4 sub-cut 3 PR-A is opened against `origin/main` using the
template, and merged after a ≥24-hour cool-down (or earlier if the PR
fix is itself revertible / urgent and the discipline doc allows).

A4. The decision in Step 3 (Track 2 yes/no) is recorded in this plan's
companion file or in a one-line note at the top of `docs/milestones/`
README.

A5. (If Track 2 yes) M-01 milestone document is written and an
`origin` tag is pushed before any other milestone is touched.

A6. (If Track 2 yes) Retroactive Phase 2 plan exists.

A7. No new commit lands on `origin/main` outside a PR after Phase 4
sub-cut 3 PR-A merges. Direct push to `main` is reserved for hotfix +
template/docs land which obey the same template.

## 8. Risks and Mitigations

R-1 — **The PR template + cool-down adds friction that the author
abandons**. *Mitigation*: keep the template short (one screen).
24-hour cool-down can be waived with an explicit "fast-track" reason
in the PR body; track the waiver count to detect drift.

R-2 — **`omc ask codex` review is treated as approval**. The codex
review is a second opinion, not approval. *Mitigation*: discipline
doc is explicit — the author is the approver; codex is advisory.

R-3 — **Track 2 milestone work is open-ended and never finishes**.
*Mitigation*: M-01 is the canary. If it takes longer than 1.5 days
of focused work, **stop** the rest of Track 2 and revisit the
cost/value calculation.

R-4 — **Retroactive plan documents drift from reality**. Writing a
"plan" after the work is done is partly fiction — decisions made
under different constraints get rationalized. *Mitigation*: cite
commit hashes and dates rigorously; do not fabricate "alternatives
considered" if there is no contemporary evidence.

R-5 — **Upstream re-engagement attempts (Step 6) get bogged down**.
openai/symphony may not respond, may reject, or may demand
significant rework. *Mitigation*: Step 6 is optional and timeboxed
to a week per attempted PR.

R-6 — **Codex's "PR split" advice was tied to upstream review;
applying it to a same-author fork has a much lower payoff**. The
author may correctly conclude that Track 2 is not worth doing. This
plan supports that conclusion explicitly via Step 3.

## 9. Stop Conditions

S-1. If Step 3 returns "no" on both questions, **stop** at the end of
Track 1. The 50-commit retroactive review is not free; if no future
reviewer needs it and no defects are suspected, the cost is unjustified.

S-2. If the PR template is itself a discipline drag (R-1), **stop**
the template after PR-A and switch to plain commits + post-merge
review notes.

S-3. If retroactive review of M-01 surfaces a serious correctness
issue, **stop** Track 2 and switch to a focused fix-pass before
continuing Phase 4 sub-cut 3 or Phase 5.

S-4. If `gh pr create` rate limits or auth issues block the new
discipline, **stop** and use plain branches with post-merge
self-review until the auth issue is resolved.

## 10. Decision Required (Track 2)

Before this plan can drive any work, the author must answer:

- [ ] Track 1 (PR discipline going forward): **commit / defer**
- [ ] Track 2 (retroactive review): **yes / no / partial (only Phase 2 retro plan)**
- [ ] Step 6 (upstream PRs for narrow docs): **yes / no / later**

Recommendation:
- Track 1: **commit**. Cost is small; benefit is real.
- Track 2: **partial** — write only the retroactive Phase 2 + Phase 3
  plans. Skip the milestone tagging exercise unless a collaborator
  joins.
- Step 6: **later** — defer until Phase 6/7 ships and the architecture
  story stabilizes.

## 11. Out of Scope

- Rewriting git history (rebase/squash/cherry-pick of past commits).
- Forcing upstream openai/symphony to accept the rewrite.
- CI infrastructure beyond a single optional `pr-checks.yml`.
- Branch protection rules (`origin/main` direct push is disabled by
  this plan but enforcement is a GitHub setting, not a code change).
- Phase 4 sub-cut 3 / Phase 5 implementation work — those have their
  own plans.

## 12. Estimated Effort

- Step 1 (Track 1 lock-in): ~0.5 day.
- Step 2 (Phase 4 sub-cut 3 PR-A as proof): inside that PR's effort
  budget; ~0.1 day overhead.
- Step 3 (decision): ~30 minutes.
- Step 4 (M-01 milestone, if pursued): ~1.5 days. Defer if uncertain.
- Step 5 (retroactive Phase 2 + Phase 3 plans): ~1 day total.
- Step 6 (upstream docs PR, if pursued): ~0.5 day per PR + waiting
  time.

If Tracks 1 + partial 2 (Steps 1, 2, 3, 5): **~2 days of net work**.
If full Track 2 + selective Step 6: **~5 days plus indeterminate
upstream wait**.
