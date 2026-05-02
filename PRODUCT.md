# Symphony Product Notes

Symphony is evolving into a generic agent ticket workflow platform. The
canonical vNext product model is:

```text
Ticket -> WorkflowInstance -> WorkflowStep -> AgentRole / ToolInvocation / Approval / Artifact / AuditEvent
```

The current TypeScript/Codex issue runner remains the active compatibility
runtime. It should be treated as a coding workflow adapter, not as the long-term
product core. The former Elixir implementation has been retired; `ts-engine/`
is the only active local engine.

Canonical vNext references:

- `docs/generic-ticket-workflow-spec.md` — product/runtime target for the generic ticket workflow platform.
- `docs/adr/0003-generic-ticket-workflow-core.md` — accepted architecture
  decision for ticket identity, connector, and coding adapter boundaries.
- `docs/generic-ticket-workflow-pr-gates.md` — required G0-G8 implementation gates.
- `SPEC.md` — v1 coding issue-runner compatibility contract.

## Product Shape

Current compatibility shape:

| Surface | Purpose |
|---|---|
| `ts-engine/` | TypeScript/Bun orchestration engine and dashboard API |
| `bin/symphony` | Source-tree engine wrapper used by humans and the launcher |
| `bin/symphony-launch` | Profile lifecycle manager: list/check/start/stop/status |
| `profiles/<name>/` | Self-contained workflow bundle with `WORKFLOW.md`, skills, env, and `CODEX_HOME` |
| `docs/` | Operator and profile author documentation |

## Current Compatibility Entities

```text
PROFILE (workflow bundle) -> LAUNCHER (bridge) -> SYMPHONY TS ENGINE -> CODEX
```

- **Profile** defines the work: tracker config, state machine, prompt body, credentials, and skills.
- **Launcher** validates and starts profile-specific engine processes.
- **Symphony TS engine** owns polling, workspace lifecycle, Codex app-server
  sessions, retry/reconciliation, logging, and the dashboard API.

## vNext Product Entities

```text
CONNECTOR SOURCE -> TICKET -> WORKFLOW INSTANCE -> STEPS -> ARTIFACTS / AUDIT
```

- **Connector source** brings work from Linear, Jira, Slack, email, web forms,
  API calls, or other systems.
- **Ticket** is the internal canonical work item. External issue ids are source
  metadata, not primary identity.
- **Workflow instance** owns durable execution state, retries, waits, approvals,
  and SLA/escalation semantics.
- **Steps** may run agents, call tools, wait for humans, wait for external
  events, validate outputs, or deliver artifacts.
- **Artifacts and audit events** are first-class platform records, not comments
  hidden in an external tracker.

## Quick Start

```bash
git clone <this-repo>
cd symphony
make setup
make build

cp profiles/content-wechat/env.example profiles/content-wechat/env
$EDITOR profiles/content-wechat/env
./bin/symphony-launch start content-wechat
```

## Repo Layout

```text
.
├── ts-engine/              # active TypeScript engine
├── bin/
│   ├── symphony            # Bun source wrapper
│   └── symphony-launch     # profile manager
├── profiles/               # workflow bundles and templates
├── docs/                   # product docs
├── SPEC.md                 # behavior contract
└── Makefile                # TS quality/build commands
```

## Versioning

- Product versions are git tags on this repo.
- Profile schema compatibility is declared with `schema_version` in each `profile.yaml`.
- Current coding issue-runner behavior should stay aligned with `SPEC.md`;
  update that spec when compatibility behavior changes.
- Generic ticket workflow behavior should stay aligned with
  `docs/generic-ticket-workflow-spec.md`; update the ADR/gates when architecture
  boundaries or stage order change.

## Roadmap

- v1.x — maintain the TypeScript/Codex profile runtime as compatibility mode.
- v2.x — implement the generic ticket workflow platform through G0-G8 gates.
- v3.x — make the Agent Control Center and connector hub the primary product surfaces.

## Status

Personal-use fork. Not affiliated with OpenAI. Licensed under Apache 2.0.
