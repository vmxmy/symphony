# Generic Ticket Workflow PR Gates

Status: Active for G-series work
Date: 2026-05-03
Companion:
- `docs/generic-ticket-workflow-spec.md`
- `docs/adr/0003-generic-ticket-workflow-core.md`

This document defines the automation and review gates for implementing the
generic ticket workflow target.

## Standard Workflow

```text
RALPLAN-DR
  -> omx team within one PR
  -> PR gate
  -> verifier / code-review
  -> next PR
```

Rules:

- G0 must land before G1-G8 implementation work.
- `omx team` is allowed for parallel work inside one PR boundary.
- G1-G8 must not be implemented as one cross-stage parallel swarm.
- `ralph` is reserved for narrow slices: one failing test, one route, one
  migration assertion, one typecheck fix, or one focused documentation patch.
- Review-only backfill runs in parallel only as a review lane. It must not
  merge and must not become a second architecture decision source.

## Required PR Template

Every G-series PR must include:

```text
## Scope
- What this PR changes
- Which G-stage it implements

## Forbidden Changes
- What this PR intentionally does not change

## Architecture Boundary Check
- Ticket canonical identity:
- Connector boundary:
- Coding adapter boundary:
- Approval/audit boundary:

## Verification Evidence
- Targeted tests:
- Full test gate:
- Typecheck:

## Regression Risk
- Existing coding path:
- Existing Linear compatibility:
- Existing dashboard/API:

## Rollback / Follow-ups
- Rollback:
- Follow-ups:
```

## Common Verification

Run before handoff:

```bash
cd cf-control-plane
bun test
bun run typecheck
```

The current reference baseline when this gate was adopted is 150 passing tests
and `tsc --noEmit` clean. Future work may increase the test count; the required
signal is 0 failures and clean typecheck.

## G0 Gate: Generic Ticket + Connector ADR

Purpose:

- Establish the product architecture source of truth.
- Link `docs/generic-ticket-workflow-spec.md` into the documentation chain.
- Record Linear as connector and Codex/workspace as adapter.

Required evidence:

- New ADR under `docs/adr/`.
- Product docs updated to distinguish current compatibility runtime from vNext
  target.
- Target architecture docs point to the generic ticket workflow spec.

Forbidden:

- Implementing G1-G8 code before G0 review passes.
- Reclassifying Linear or Codex as mandatory product core.

## G1 Gate: Generic Schema

Purpose:

- Add canonical generic ticket workflow D1 tables.

Required evidence:

- Additive migration.
- Schema contract tests for new tables and indexes.
- Existing compatibility tables remain intact.

Forbidden:

- Dropping, renaming, or destructively rewriting `issues`, `runs`,
  `run_steps`, `run_events`, `tool_calls`, `approvals`, or
  `idempotency_records`.

## G2 Gate: Linear-to-Ticket Bridge

Purpose:

- Create or link canonical tickets from Linear issue mirror data.

Required evidence:

- Idempotency on `(tenant_id, source_kind, external_id)`.
- Tests for renamed Linear identifiers and pre-existing mirror rows.
- Linear API failure does not corrupt internal ticket state.

Forbidden:

- Using Linear issue id or identifier as canonical `Ticket.id`.

## G3 Gate: Ticket API v2

Purpose:

- Provide Linear-free ticket creation and read APIs.

Required evidence:

- `POST /api/v2/tickets` works without `LINEAR_API_KEY`.
- List/detail/comment/event route tests.
- Audit event writes for create/comment/event.

Forbidden:

- Routing manual/API ticket creation through Linear-only profile state.

## G4 Gate: Agent Control Center MVP

Purpose:

- Provide the first internal UI replacement for Linear as workflow carrier.

Required evidence:

- `/tickets`
- `/tickets/:ticketId`
- `/approvals`
- Render tests or route tests for each page.

Forbidden:

- Building a full Linear clone: cycles, advanced search, complex inbox,
  mobile parity, or broad issue-tracker automation.
- Displaying private model reasoning.

## G5 Gate: GenericTicketWorkflow MVP

Purpose:

- Run a non-coding workflow with persisted steps.

Required evidence:

- Mock workflow can start, run, and complete without Codex, Linear, or
  workspace.
- `workflow_steps` timeline is queryable.
- Replay does not duplicate side effects.

Forbidden:

- Making WorkerHost or Codex the default generic workflow runtime.

## G6 Gate: Approval Resume

Purpose:

- Make approval a first-class workflow pause/resume mechanism.

Required evidence:

- Approval row created with immutable decision.
- Approve resumes workflow.
- Reject/cancel stops or branches workflow.
- Audit events are written.

Forbidden:

- Encoding approval decisions only as comments.

## G7 Gate: ToolGateway MVP

Purpose:

- Add governed tools, risk policy, idempotency, audit, and artifacts.

Required evidence:

- Tool allowlist and schema validation.
- Risk level assignment.
- Mutating tool idempotency record.
- L3/L4 approval path.
- `artifact.create` metadata and R2/mock-R2 reference.

Forbidden:

- Direct external side effects outside ToolGateway.

## G8 Gate: Coding Workflow Adapter

Purpose:

- Reframe existing coding execution as `coding_agent_run`.

Required evidence:

- Existing coding execution tests remain green.
- Generic workflow can invoke or reference the coding adapter without making it
  mandatory.
- Codex/workspace-specific state stays out of generic core tables except via
  references.

Forbidden:

- Making Codex compatibility the default generic workflow runtime.

## Review-Only Backfill Lane

Backfill PRs for already shipped Phase 6/7 commits must use this banner:

```text
Review-only backfill. Already shipped on vmxmy/symphony main.
Do not merge; use for review findings and follow-up issues.
Verified final head: 150 pass / 0 fail + tsc --noEmit.
```

Backfill findings may create:

- G0 ADR follow-ups
- G8 coding adapter backlog items
- focused bugfix issues

Backfill findings must not:

- rewrite `main`
- become mergeable PRs
- block G0/G1 unless they expose a high-risk boundary violation
