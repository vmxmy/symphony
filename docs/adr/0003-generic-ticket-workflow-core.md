# ADR-0003: Generic Ticket Workflow Core

Status: Accepted
Date: 2026-05-03
Deciders: project owner; RALPLAN-DR Planner/Architect/Critic consensus
Related:
- `docs/generic-ticket-workflow-spec.md`
- `docs/generic-ticket-workflow-pr-gates.md`
- `docs/cloudflare-agent-native-target.md`
- `SPEC.md`
- ADR-0001 `docs/adr/0001-coding-agent-and-workerhost-boundaries.md`
- ADR-0002 `docs/adr/0002-phase-10-native-coding-agent-deferred.md`

## Context

Symphony started as a long-running automation service that reads tracker issues,
creates isolated workspaces, and runs coding agents. The current TypeScript and
Cloudflare control-plane work successfully established useful infrastructure:
durable entity ownership, Workflows, D1/R2 records, Queues, WorkerHost
substrates, and a CodingAgentAdapter seam.

The product target has now broadened. Symphony vNext is a generic agent ticket
workflow platform, not only a coding-agent runner. The platform must process
business tickets such as vendor review, contract review, content review,
research, approvals, and other long-running workflows.

This creates a vocabulary risk. If new work continues to treat `Issue`, `Run`,
`Workspace`, `Linear`, and `Codex` as core product primitives, the
implementation will harden around coding-only assumptions and make the generic
ticket workflow platform harder to build.

## Decision

Symphony vNext adopts this canonical product model:

```text
Ticket
  -> WorkflowInstance
  -> WorkflowStep
  -> AgentRole / ToolInvocation / Approval / Artifact / AuditEvent
```

The platform owns canonical tickets, workflow state, approvals, artifacts, and
audit records.

Three boundaries are mandatory:

1. **Ticket canonical identity**
   - `Ticket.id` is the internal source of truth.
   - External ids from Linear, Jira, Slack, email, APIs, or webhooks are stored
     in `TicketSource`.
   - New code MUST NOT use a Linear issue id or identifier as the canonical
     ticket id.

2. **Connector boundary**
   - Linear, Jira, Slack, email, Notion, Zendesk, and webhooks are connectors.
   - A connector may be a source, notification channel, sync target, or tool
     provider.
   - Linear is not the canonical workflow state store.
   - Linear comments MUST NOT be the only place approvals, artifacts, or audit
     evidence live.

3. **Coding adapter boundary**
   - Codex, workspaces, WorkerHost, and coding issue execution are compatibility
     capabilities.
   - Coding execution is represented by a `coding_agent_run` workflow step.
   - Codex is a `CodingAgentAdapter` implementation, not the product core.
   - New generic ticket workflow code MUST NOT add a mandatory dependency on
     Codex or workspace-backed execution.

## Development Process Decision

The generic ticket workflow implementation must use this automation standard:

```text
RALPLAN-DR
  -> omx team within one PR
  -> PR gate
  -> verifier / code-review
  -> next PR
```

`ralph` is reserved for narrow slices such as a failing test, a single endpoint,
or a typecheck fix. It must not be used to implement the entire G0-G8 migration
as one unbounded loop.

The required PR sequence is:

| PR | Scope |
|---|---|
| G0 | Generic Ticket + Connector ADR and documentation chain |
| G1 | Additive generic ticket workflow schema |
| G2 | Linear-to-Ticket bridge |
| G3 | Ticket API v2 |
| G4 | Agent Control Center MVP |
| G5 | GenericTicketWorkflow MVP |
| G6 | Approval resume |
| G7 | ToolGateway MVP |
| G8 | Coding workflow adapter |

G0 is mandatory before G1-G8 implementation. Before G0 passes review, later
work may only be read-only research, draft branches, or review-only backfill.

## Alternatives Considered

### A. Keep the Linear/Codex issue runner as the product core

Rejected. It preserves current behavior but conflicts with the generic ticket
workflow target and keeps Linear/Codex as permanent product gravity.

### B. Replace Linear immediately and build only a native ticket system

Rejected for the near term. It is clean, but it creates unnecessary cutover risk
and discards useful compatibility. Linear should first become a connector.

### C. Continue Phase 7 Codex compatibility before generic ticket work

Rejected as the next primary path. Phase 7 PR-A/A.5 foundation remains useful,
but deeper Codex compatibility should wait until it can be framed as the
`coding_agent_run` adapter.

### D. Use one long `ralph` run to implement G0-G8

Rejected. The migration spans schema, API, dashboard, workflow runtime,
approval, ToolGateway, and compatibility adapters. It needs PR-by-PR gates and
separate verification surfaces.

### E. Complete all Phase 6/7 review-only backfill before G0

Rejected as a blocker. Backfill should run in parallel as a review lane. It
must not rewrite history or block the generic product pivot unless it finds a
high-risk WorkerHost/CodingAgentAdapter boundary issue.

## Consequences

Positive:

- The next product core is explicit and reviewable.
- Linear becomes a connector without forcing an immediate cutover.
- Codex compatibility remains useful without controlling the platform model.
- New schema, API, dashboard, workflow, approval, and ToolGateway work can be
  evaluated against one architecture source of truth.
- Review-only backfill can restore review hygiene without rewriting `main`.

Negative:

- Some Phase 7 Codex work is deliberately deprioritized.
- G0 adds documentation and gate work before more visible product features.
- Every PR now needs an architecture-boundary check, which adds review cost.

## Required Gates

Every G-series implementation PR must include:

- scope summary
- forbidden changes
- architecture boundary check
- targeted tests
- full verification evidence
- regression risk
- rollback or follow-up notes

Common verification baseline:

```bash
cd cf-control-plane
bun test
bun run typecheck
```

The test count may increase, but the suite must remain 0-fail and typecheck
must remain clean.

## Stop Conditions

Stop and re-plan if any PR:

- treats a Linear id as canonical `Ticket.id`
- stores approval decisions only as comments
- executes mutating side effects outside ToolGateway and idempotency controls
- makes Codex or WorkerHost mandatory for generic ticket workflows
- requires destructive D1 migration of existing compatibility tables
- exposes private model reasoning instead of action summaries/evidence
- breaks the existing coding compatibility path without a contained fix

## Follow-ups

1. Implement G1 as an additive D1 migration plus schema contract tests.
2. Implement G2 by linking the existing Linear issue mirror to canonical
   tickets through `ticket_sources`.
3. Keep review-only backfill PRs marked as already shipped and do-not-merge.
4. Defer deeper Codex compatibility until G8, where it is framed as
   `coding_agent_run`.
