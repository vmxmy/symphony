# Phase 6 Implementation Plan: real WorkerHost workspace operations

> **Destination on approval**: `docs/cloudflare-agent-native-phase6-plan.md`
> (alongside `phase4-plan.md` and `phase5-plan.md`).
> Drafted in plan mode immediately after Phase 5 close.

Author: planner pass, 2026-05-03 (post-Phase-5 close, A→C→B Ralph US-001).
Companion to: `docs/cloudflare-agent-native-phase4-plan.md`,
`docs/cloudflare-agent-native-phase5-plan.md`,
`docs/cloudflare-agent-native-phase6-7-plan.md` (predecessor combined draft —
this file is the canonical Phase 6 plan; the combined draft remains as
historical reference for the substrate-and-adapter co-design and is
superseded by this file + a future `phase7-plan.md`),
`docs/cloudflare-agent-native-target.md` §1168–1184,
ADR-0001, ADR-0002.

Scope: Phase 6 only — real workspace operations on a `WorkerHost`. Phase 7
(`codex_compat` CodingAgentAdapter on top of the Phase 6 substrate) gets
its own plan. The existing `phase6-7-plan.md` documents the joint
sub-phasing rationale; this plan reuses that rationale and narrows
delivery scope to Phase 6.

---

## 1. Context

Phase 5 closed 2026-05-03 with PRs #20–24 (`01c26c1` PR-A → `2680893`
PR-E). The `ExecutionWorkflow` shell is in place: 16 canonical steps,
`MockCodingAgentAdapter` driving step 8, `IssueAgent` lease via
`workflow_instance_id`, R2 manifest at
`runs/{tenant}/{slug}/{external_id}/{attempt}/manifest.json`, dashboard
run view, operator cancel route. `executeMockRun` is `@deprecated`. 90/90
tests green; tsc clean.

What is **missing** for Phase 6 (`target.md` §1168–1184):

1. **Real workspace operations.** Steps 3 (`prepareWorkspace`) and 4
   (`materializeAssets`) must do real work: git checkout of the
   profile-configured repo, `WORKFLOW.md` + skills + `codex-home/` +
   `env` materialization, hook execution, snapshot persistence.
   Phase 5's bodies for these steps are deterministic events with no
   side effects.
2. **A `WorkerHost` substrate.** ADR-0001 §2 names `WorkerHost` and
   `CodingAgentAdapter` as the two replaceable seams. Phase 5 left both
   seams as mocks; Phase 6 ships the first non-mock `WorkerHost`. The
   primary substrate is **VPS Docker** (Phase 0 spike already
   end-to-end at `dev@74.48.189.45`); **Cloudflare Container** is opt-in
   per-profile and lights up after the VPS path is real (the Phase 0
   §13.5 TLS resolution at `cde7007` cleared the substrate-level
   blocker).
3. **Hook execution outside the Worker.** `target.md` §17.1 forbids
   shell in the control plane. Phase 6 runs `after_create`,
   `before_run`, `after_run`, `before_remove` inside the WorkerHost.
4. **R2 snapshot + redaction.** `target.md` §1178 requires a redaction
   pass before snapshot persistence. Phase 6 ships the redaction list
   resolution from `profile.yaml` and the snapshot uploader.
5. **Phase 5 architect follow-ups F-1, F-4, F-5, F-6.** Each of these
   was carried into Phase 6 entry from the Phase 5 architect review.
   This plan absorbs them explicitly (see §3 R12–R15 below) so they
   are tracked, not orphaned.

Phase 6 keeps two invariants from Phase 5:

- The 16 canonical step names from `target.md` §8.4 do **not** change.
  Only step bodies (3, 4, 5, 7, 12, 15) get real implementations; the
  list and ordering are frozen.
- `MockCodingAgentAdapter` stays the only shipped adapter through
  Phase 6 — step 8 still calls the mock. Phase 7 swaps step 8 to
  `codex_compat`. This separation is what keeps Phase 6 PRs small and
  reviewable.

Phase 6 expressly does NOT ship:

- Real coding-agent execution (Phase 7).
- Native Cloudflare CodingAgent (Phase 10; ADR-0002 deferral).
- Multi-host VPS substrate or Cloudflare Sandbox WorkerHost (Phase 8+).
- ToolGateway idempotency contract (Phase 8).

## 2. Current Evidence

| What | File / line | What it gives Phase 6 |
|---|---|---|
| Phase 0 spike (VPS Docker bridge) | `spikes/codex-on-cloudflare/bridge/`, `REPORT.md` §13 | spawn-once + persistent thread + `/reset`; warm avg 5s vs spawn-per-request 7s; multi-turn smoke pass on `dev@74.48.189.45`. Phase 6.A's reference for substrate semantics, even though Phase 6 is workspace-only (codex bring-up is Phase 7). |
| Container TLS resolution | `cde7007`, `docs/cloudflare-platform-limits.md` §3 | `ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt` + `SSL_CERT_DIR=/etc/ssl/certs`. Substrate-level blocker cleared; Phase 6.B can wire Container substrate without re-litigating TLS. |
| BRIDGE_REVISION + CONTAINER_INSTANCE_NAME deploy mechanics | `e17fb82` | Mandatory cache-bust + per-deploy instance increment for Container substrate. Phase 6.B operator runbook documents this. |
| WorkspaceAdapter contract | `ts-engine/src/contracts/workspace.ts` | The interface Phase 6 ships its first non-local implementation against. |
| Existing local workspace driver | `ts-engine/src/workspace.ts` | Reference behavior for git checkout, `WORKFLOW.md` mount, hook invocation, redaction list. Phase 6 ports the semantics; substrate changes from local FS to WorkerHost RPC. |
| ts-engine hook semantics | `ts-engine/src/workspace.ts` (`runHook` + timeouts), `ts-engine/src/orchestrator.ts` (hook lifecycle) | Default timeouts: `after_create` 60s, `before_run` 30s, `after_run` 60s, `before_remove` 30s. Phase 6 preserves these. |
| Phase 5 16-step workflow | `cf-control-plane/src/workflows/execution.ts`, `phase5-plan.md` §3 R3 | The shape Phase 6 plugs into without changing it. Steps 3, 4, 5, 7, 12, 15 are the only bodies that change. |
| Phase 5 idempotency boundary | `phase5-plan.md` §9 R-1 | Steps 2 / 8 / 16 use `retries.limit=0`; Phase 6's new step bodies (3, 4, 5, 7, 12, 15) inherit the default retry policy because their side effects are content-addressed and idempotent on replay. |
| Phase 5 architect follow-ups | `phase5-plan.md` §11 (F-1, F-4, F-5, F-6) | Phase 6 entry items absorbed in §3 R12–R15 below. F-2/F-3 are not Phase 6 (F-2 is dashboard polish; F-3 is cookie-auth, deferred to Phase 8 with ToolGateway). |
| Existing R2 binding | Phase 5 PR-A `01c26c1` | `ARTIFACTS = symphony-runs`. Phase 6 adds new key prefix `runs/{...}/snapshot.tar.zst` alongside the existing manifest key. |
| Profile schema | `cf-control-plane/src/profiles/schema.ts` (Phase 2) | Phase 6 adds `runtime.host` + `runtime.snapshot.redact` as additive fields with defaults. |
| Phase 4 sub-cut 3 retry layer | `cf-control-plane/src/agents/issue.ts` (`markFailed`, alarm) | Phase 6 hook failures escalate to Phase 4 retry semantics. |

## 3. Requirements Summary

R1. **`WorkerHost` runtime contract** at
`cf-control-plane/src/runtime/worker_host.ts` (new):

```ts
export interface WorkerHost {
  id: WorkerHostKind; // "vps_docker" | "cloudflare_container" | "mock"
  prepareWorkspace(ref: WorkspaceRef): Promise<WorkspaceHandle>;
  materializeAssets(handle: WorkspaceHandle, bundle: AssetBundleRef): Promise<void>;
  runHook(handle: WorkspaceHandle, name: HookName, env: Record<string, string>): Promise<HookResult>;
  snapshotWorkspace(handle: WorkspaceHandle, opts: SnapshotOptions): Promise<R2ObjectRef>;
  releaseWorkspace(handle: WorkspaceHandle): Promise<void>;
}
```

The workflow does **not** branch on substrate identity; the
`WorkerHost` chosen at run time is determined by profile config.

R2. **`WorkspaceAdapter` for VPS Docker** (Phase 6 primary path) at
`cf-control-plane/src/runtime/vps_docker_host.ts` (new):

- Talks to the existing dev VPS bridge over an authenticated HTTPS
  endpoint. Auth via Worker secret `VPS_BRIDGE_TOKEN`.
- Workspace path on the host: `/symphony/workspaces/{tenant}/{profile}/{issue}`.
- Materialization: `git clone --depth 1 -b <branch>` of the profile-configured
  repo; `WORKFLOW.md` + `skills/` + `codex-home/` + `env` mounted from
  R2 + Worker secrets.
- Idempotency: workspace creation is keyed by `(tenant, profile, issue)`;
  re-invocation of `prepareWorkspace` returns the same handle (no
  duplicate `git clone`).
- Materialization is content-addressed: hash of the asset bundle is the
  cache key; re-invocation with the same hash is a no-op.

R3. **`WorkspaceAdapter` for Cloudflare Container** (Phase 6.B opt-in)
at `cf-control-plane/src/runtime/cloudflare_container_host.ts` (new):

- Reuses the Phase 0 spike artifact: bridge process inside a Container
  instance.
- Same `WorkerHost` interface as Phase 6.A.
- `wrangler.toml` adds the `[[containers]]` binding only when the
  binding is actually used; Phase 6.A code paths must continue to work
  with the binding absent.
- Operator runbook in `cf-control-plane/README.md` documents
  `BRIDGE_REVISION` cache-bust + per-deploy `CONTAINER_INSTANCE_NAME`
  increment from spikes §13.4.

R4. **Workflow steps 3 and 4 swap mock for `WorkerHost`** in
`cf-control-plane/src/workflows/execution.ts`:

- Step 3 (`prepareWorkspace`) calls `WorkspaceAdapter.prepare(ref)`.
- Step 4 (`materializeAssets`) calls
  `WorkspaceAdapter.materialize(handle, bundle)`.
- Both steps remain idempotent on replay (R2 above + R8 below).
- A `MockWorkerHost` keeps the Phase 5 path alive for tests + the
  existing `executeMockRun` deprecated route until Phase 6 closes it.

R5. **Hook execution** at `cf-control-plane/src/runtime/hooks.ts` (new):

- Maps `after_create | before_run | after_run | before_remove` to
  `WorkerHost.runHook`.
- Default timeouts: `after_create=60s`, `before_run=30s`,
  `after_run=60s`, `before_remove=30s` (matching ts-engine).
- Hook stdout/stderr is recorded in `run_events` with
  `event_type='hook.{name}.{started|completed|failed}'`. Output > 4 KB
  is written to R2 and the event payload carries only the R2 ref
  (Phase 5 R-5 same pattern).
- A failed hook is a step failure, not a workflow failure: Cloudflare
  Workflows step retry policy applies (default 3 retries from Phase 5);
  a hook that exhausts retries marks the step `failed` and the workflow
  enters the Phase 4 sub-cut 3 `markFailed` path.
- Workflow steps 5 (`afterCreateHook`), 7 (`beforeRunHook`), 12
  (`afterRunHook`) swap their Phase 5 deterministic-event bodies for
  real `runHook` calls.

R6. **R2 snapshot + redaction** at
`cf-control-plane/src/runtime/snapshot.ts` (new):

- Redaction list resolution from `profile.yaml`
  `runtime.snapshot.redact`. Default list (applied if no override):
  `.env`, `**/.git/`, `**/secret*`, `**/*.key`, `**/auth*.json`,
  `runtime/log/`.
- Snapshot is a tar.zst archive uploaded to R2 at
  `runs/{tenant}/{slug}/{external_id}/{attempt}/snapshot.tar.zst`.
  Same key prefix as the manifest, so the artifact set is contiguous.
- Snapshot is written **before** workspace release (step 15 ordering);
  failure to snapshot is a soft error that emits a
  `run_events.warning` and does not fail the workflow.
- Snapshot key is deterministic per `(tenant, slug, issue, attempt)`;
  R2 same-key write under replay is harmless.
- Step 15 (`archiveOrCleanupWorkspace`) calls `snapshot.run()` then
  `WorkerHost.releaseWorkspace`.

R7. **`runs.adapter_kind` semantics**:

- Phase 6 keeps step 8 calling `MockCodingAgentAdapter`. The
  `runs.adapter_kind` value stays `'mock'` for every Phase 6 run.
- Phase 6 introduces NO new `adapter_kind` value; the existing union
  (`mock` | `codex_compat` | `cloudflare_native`) is sufficient.
- Phase 7 lights up the `codex_compat` value when step 8 swaps.

R8. **Replay-safety for steps 3, 4, 5, 7, 12, 15**:

- Step 3 + 4: idempotent via content-addressed materialization (R2).
- Step 5, 7, 12 (hooks): idempotent because each invocation is logged
  as a `run_events` row with `INSERT OR IGNORE` keyed by
  `(run_id, step_sequence, event_type, sequence)`. Re-running a hook
  on replay is acceptable (hooks are advertised as side-effecting in
  the workspace, not in tracker/external state).
- Step 15 (snapshot + release): idempotent via deterministic R2 key +
  `releaseWorkspace`'s no-op-on-already-released contract.

R9. **Profile schema bump** at
`cf-control-plane/src/profiles/schema.ts`:

- Add `runtime.host: 'vps_docker' | 'cloudflare_container' | 'mock'`.
  Default `'vps_docker'` for v2 profiles. Importer auto-upgrades v1 →
  v2 with the default.
- Add `runtime.snapshot.redact: string[]` with the default list from
  R6.
- Schema validator enforces glob shape; importer fails loud on
  unknown patterns.
- Profile schema bump is a non-breaking ADD; no D1 migration is
  required (the JSON column `config_json` carries the new fields).

R10. **Operator surface additions**:

- `GET /api/v1/profiles/:t/:s/runtime` returns the resolved
  `runtime.host` and substrate identity for the active version.
- `POST /api/v1/projects/:t/:s/actions/snapshot-now` (admin) forces a
  workspace snapshot for the latest run; useful for Phase 6 debug.
- `POST /api/v1/runs/:t/:s/:e/:attempt/actions/peek-workspace` returns
  a presigned R2 URL for the snapshot, gated by `read:state`.

R11. **Dashboard surface additions**:

- Per-run view shows substrate identity (`runtime.host`) for the run.
- Snapshot link (presigned R2 URL) on completed runs.
- Hook output excerpt (first 1 KB) on hook-failed runs.

R12. **F-1 absorption (live-edge smoke)**:

- Phase 6 PR-A entry gate: a one-shot live deploy + curl-driven
  dispatch of one mock run on the live Cloudflare control plane,
  verifying the manifest lands in production R2.
- This is the F-1 follow-up from `phase5-plan.md` §11. It is
  **execution-substrate-independent** (still runs the mock adapter)
  and validates Workflows + D1 + R2 bindings, not the WorkerHost.
- Outcome is recorded in `cf-control-plane/README.md` Phase 6 status
  row and in this plan's §12 verification matrix.
- F-1 runs once before PR-A merges. If it fails, PR-A blocks until the
  gate passes.

R13. **F-4 absorption (WorkerHost adapter swap)**:

- This is the meat of Phase 6: steps 3 + 4 swap from the mock body to
  the WorkerHost-backed `WorkspaceAdapter`. PR-C is exactly this swap.
- F-4 closes when PR-C merges and an integration test demonstrates a
  mirrored issue completes the full 16-step workflow with real
  workspace operations on VPS Docker (Phase 6.A).

R14. **F-5 absorption (lease ordering)**:

- `cf-control-plane/src/agents/issue.ts:271-277`: `IssueAgent.startRun`
  currently writes `workflow_instance_id` to DO storage **before**
  `EXECUTION_WORKFLOW.create`. The architect-flagged risk: if
  `create()` fails permanently, the agent stays in `running` forever.
- Phase 6 entry hardening (PR-A scope): add a path-level guard. Two
  acceptable shapes:
  1. Move the storage put **after** `create()` succeeds, and rely on
     Cloudflare Workflows `.create()` idempotency on the same id for
     queue-redelivery safety.
  2. Keep the current ordering and add an `instance.status()` probe on
     a follow-up dispatch that detects "stale lease, no instance" and
     re-runs `create()` for the same id.
- The plan recommends option (1) as smaller and easier to reason
  about; the implementation PR makes the final call after reading the
  Workflows binding's exact create semantics. Both options preserve
  the `Promise.all` dedup map (`startRunInFlight`) untouched.
- Acceptance: an integration test seeds an `EXECUTION_WORKFLOW.create`
  failure (mock binding throws) and asserts the agent does NOT stay
  in `running`. Specifically: it transitions back to `queued` (or stays
  in `queued`, depending on chosen option), and a follow-up dispatch
  succeeds.

R15. **F-6 absorption (manifest re-write inside step.do)**:

- `cf-control-plane/src/workflows/execution.ts:447-487`: the final
  manifest re-write runs OUTSIDE any `step.do`, so a partial-success
  replay can observe a slightly different snapshot than the original.
- Phase 6 entry hardening (PR-A scope): wrap the final manifest write
  as a logical step inside `step.do(name, { retries: { limit: 0 } }, ...)`.
  The step is logically "step 17" in execution flow but is NOT added
  to the canonical 16-step list (R8 above forbids that). Two
  acceptable shapes:
  1. Add a private `step.do('finalizeManifest', ...)` boundary that is
     **not** counted in run_steps (the 16-row invariant for
     `tests/execution_workflow_e2e.test.ts` stays intact).
  2. Re-use step 16's `releaseLeaseAndNotify` body to also write the
     manifest, since both are terminal.
- The plan recommends option (1) because step 16 already has
  `retries.limit=0` and shouldn't grow new responsibilities. Final
  call is in the PR.
- Acceptance: replay of the full workflow on the in-memory runtime
  shows the manifest written exactly once (no double R2 write, no
  observed snapshot drift).

R16. **Phase 6 invariants**:

- ADR-0001 boundaries unchanged. `WorkerHost` stays a substrate; the
  control plane never branches on substrate id outside the adapter
  layer. Grep gate enforces.
- ADR-0002 reaffirmation: Phase 10 native CodingAgent stays deferred.
- The Phase 5 16-step list does NOT grow. Steps 3, 4, 5, 7, 12, 15
  are the only bodies that change. Grep gate enforces step name list.
- `MockCodingAgentAdapter` stays the only shipped adapter through
  Phase 6 close.
- No new D1 migration. Profile schema additions go into the existing
  `profiles.config_json` column.

R17. **Tests**:

- Unit: `WorkerHost` mock + `WorkspaceAdapter` against a fake
  filesystem; idempotency on replay; redaction filter (default + custom
  list).
- Unit: hook timeout enforcement; large-output → R2 spill.
- Integration (in-memory `FakeWorkflowRuntime`): full 16-step workflow
  with real `WorkspaceAdapter` + fake VPS bridge — at least one
  mirrored issue completes step 1–16 end-to-end with snapshot in R2.
- Integration: forced step-3 failure (workspace prep fails) → Phase 4
  retry_wait → re-attempt picks up cleanly with a fresh workspace.
- Integration: redaction list is honored — assertion that the snapshot
  archive does not contain any path on the default redaction list
  when the workspace seeded one of each.
- Integration: F-5 — `EXECUTION_WORKFLOW.create` failure does not leave
  the agent in `running`.
- Integration: F-6 — replay shows manifest written exactly once.
- Live e2e: F-1 — one-shot live deploy + curl smoke; manifest in
  production R2.

## 4. Implementation Steps

### Step 1 — `WorkerHost` types + `MockWorkerHost`

`cf-control-plane/src/runtime/worker_host.ts` (new):
- `WorkerHost` interface (R1).
- `WorkspaceHandle`, `WorkspaceRef`, `AssetBundleRef`, `HookResult`,
  `R2ObjectRef`, `SnapshotOptions` value types.
- `WorkerHostKind` discriminated union.

`cf-control-plane/src/runtime/mock_worker_host.ts` (new):
- Replaces ad-hoc mock paths in Phase 5 tests; in-memory FS with
  deterministic hook output.

### Step 2 — VPS Docker `WorkerHost` adapter (Phase 6.A)

`cf-control-plane/src/runtime/vps_docker_host.ts` (new):
- Talks to the existing dev VPS bridge over HTTPS with
  `Authorization: Bearer ${VPS_BRIDGE_TOKEN}`.
- Implements all `WorkerHost` methods (R2).
- Streams the snapshot tar.zst from VPS over R2 multipart upload.

### Step 3 — Workflow steps 3 + 4 swap (F-4)

`cf-control-plane/src/workflows/execution.ts` (modify):
- Step 3 + 4 call `WorkspaceAdapter.prepare(...)` and
  `WorkspaceAdapter.materialize(...)`.
- The adapter is constructed from a `WorkerHost` chosen by profile
  config (`runtime.host`).
- Mock path (`runtime.host === 'mock'`) keeps Phase 5 behavior intact
  for the deprecated `executeMockRun` route and tests.

### Step 4 — Hook execution + R2 snapshot

`cf-control-plane/src/runtime/hooks.ts` (new):
- Maps hook names to `WorkerHost.runHook` calls with R5 timeouts.
- Records `run_events` rows with severity-keyed event types.
- Workflow steps 5, 7, 12 call this driver.

`cf-control-plane/src/runtime/snapshot.ts` (new):
- Redaction list resolution + glob match.
- R2 multipart upload to the deterministic key.
- Workflow step 15 calls `snapshot.run()` then
  `WorkerHost.releaseWorkspace`.

### Step 5 — Cloudflare Container `WorkerHost` (Phase 6.B)

`cf-control-plane/src/runtime/cloudflare_container_host.ts` (new):
- Reuses the spike's bridge protocol.
- Profile-level opt-in via `runtime.host: 'cloudflare_container'`.
- `wrangler.toml` adds `[[containers]]` binding only if a profile
  uses it.
- README operator runbook documents the `BRIDGE_REVISION` +
  `CONTAINER_INSTANCE_NAME` mechanics.

### Step 6 — Profile schema bump

`cf-control-plane/src/profiles/schema.ts` (modify):
- `runtime.host` + `runtime.snapshot.redact` per R9.
- Importer v1→v2 auto-upgrade.

### Step 7 — F-5 lease-ordering hardening

`cf-control-plane/src/agents/issue.ts` (modify lines ~271-277):
- Apply chosen option (default: move DO storage put after
  `EXECUTION_WORKFLOW.create` succeeds).
- Keep `startRunInFlight` Promise dedup map untouched.
- Add integration test seeding a forced `create()` failure.

### Step 8 — F-6 manifest re-write boundary

`cf-control-plane/src/workflows/execution.ts` (modify lines ~447-487):
- Wrap final manifest write inside a `step.do('finalizeManifest',
  { retries: { limit: 0 } }, ...)`. Boundary is **not** added to the
  canonical 16-row run_steps list; the workflow assertion that
  `run_steps.length === 16` stays intact.

### Step 9 — Operator routes (R10) + dashboard surface (R11)

`cf-control-plane/src/worker.ts` + `cf-control-plane/src/dashboard/render.ts`:
- 3 new routes (R10).
- Run-view substrate identity row + snapshot link + hook excerpt
  rendering (R11).

### Step 10 — Tests (R17)

`cf-control-plane/tests/`:
- `worker_host_idempotency.test.ts`
- `worker_host_redaction.test.ts`
- `hook_timeout.test.ts`
- `phase6a_e2e.test.ts` (in-memory + fake VPS bridge)
- `lease_create_failure.test.ts` (F-5)
- `manifest_finalize_replay.test.ts` (F-6)
- Live e2e (F-1) tracked by an operator runbook in PR-A acceptance
  evidence (not a unit test).

### Step 11 — Phase 5 invariant grep gates

`cf-control-plane/scripts/check-phase6-invariants.ts` (new, called from
`bun test`):
- Grep that the canonical 16 step names from `target.md` §8.4 appear
  exactly once in `src/workflows/execution.ts`.
- Grep that no workflow step body imports a substrate-specific module
  (no direct import of `vps_docker_host.ts` or
  `cloudflare_container_host.ts` from `execution.ts`).
- Grep that no new `adapter_kind` value appears outside the existing
  union.

## 5. Suggested PR Breakdown

5 PRs. None should exceed ~600 net lines. PR-A absorbs the three Phase 5
follow-ups (F-1, F-5, F-6) so the rest of Phase 6 starts from a
hardened workflow shell.

**PR-A — Phase 5 follow-up hardening + WorkerHost contract**
- Step 1 (`WorkerHost` interface + `MockWorkerHost`).
- Step 7 (F-5 lease ordering).
- Step 8 (F-6 manifest re-write boundary).
- Live-edge smoke (F-1) as PR-A acceptance evidence (operator runbook
  + manifest screenshot).
- Grep gates (Step 11).
- ~5 files, ~350 lines, no migration.

**PR-B — VPS Docker `WorkerHost` (Phase 6.A part 1)**
- Step 2 (real adapter against dev VPS bridge).
- Hidden behind a feature flag: `runtime.host: 'vps_docker'` requires
  PR-C to wire steps 3 + 4. PR-B alone ships the adapter; nothing
  calls it yet.
- ~3 files, ~400 lines.

**PR-C — Workflow steps 3 + 4 swap to `WorkerHost` (F-4)**
- Step 3 (workflow modification).
- Step 6 (profile schema bump for `runtime.host`).
- The workflow now calls real workspace adapters instead of emitting
  mock events. PR-B becomes the live path for any profile defaulting
  to `vps_docker`.
- ~4 files, ~250 lines.

**PR-D — Hooks + snapshot + redaction**
- Step 4 (`hooks.ts` + `snapshot.ts`).
- Workflow steps 5, 7, 12, 15 swap their Phase 5 deterministic-event
  bodies for real driver calls.
- Profile schema bump for `runtime.snapshot.redact` (Step 6 part 2 if
  not landed in PR-C).
- ~5 files, ~500 lines.

**PR-E — Cloudflare Container `WorkerHost` (Phase 6.B) + dashboard surface**
- Step 5 (Container substrate adapter + runbook).
- Step 9 (operator routes + dashboard surface).
- Behind feature flag; default remains `vps_docker`.
- ~4 files, ~450 lines.

Optional **PR-F (deferred)** — full Phase 6.A 30-issue regression run.
This is operations / corpus work, not code; it can ship as a script +
a runbook entry rather than a PR.

## 6. File-Level Checklist

- [ ] `cf-control-plane/src/runtime/worker_host.ts` — new (PR-A)
- [ ] `cf-control-plane/src/runtime/mock_worker_host.ts` — new (PR-A)
- [ ] `cf-control-plane/src/runtime/vps_docker_host.ts` — new (PR-B)
- [ ] `cf-control-plane/src/runtime/cloudflare_container_host.ts` — new (PR-E)
- [ ] `cf-control-plane/src/runtime/hooks.ts` — new (PR-D)
- [ ] `cf-control-plane/src/runtime/snapshot.ts` — new (PR-D)
- [ ] `cf-control-plane/src/workflows/execution.ts` — modify steps 3, 4, 5, 7, 12, 15 + F-6 finalizeManifest boundary (PR-A, PR-C, PR-D)
- [ ] `cf-control-plane/src/agents/issue.ts` — F-5 lease-ordering fix (PR-A, lines ~271-277)
- [ ] `cf-control-plane/src/profiles/schema.ts` — `runtime.host` + `runtime.snapshot.redact` (PR-C)
- [ ] `cf-control-plane/src/worker.ts` — 3 new routes (PR-E)
- [ ] `cf-control-plane/src/dashboard/render.ts` — substrate id + snapshot link + hook excerpt (PR-E)
- [ ] `cf-control-plane/scripts/check-phase6-invariants.ts` — new grep gate (PR-A)
- [ ] `cf-control-plane/wrangler.toml` — `[[containers]]` binding for Phase 6.B (PR-E)
- [ ] `cf-control-plane/README.md` — Phase 6 status rows (PR-A through PR-E) + Container runbook (PR-E)
- [ ] `cf-control-plane/tests/worker_host_idempotency.test.ts` — new (PR-A)
- [ ] `cf-control-plane/tests/worker_host_redaction.test.ts` — new (PR-D)
- [ ] `cf-control-plane/tests/hook_timeout.test.ts` — new (PR-D)
- [ ] `cf-control-plane/tests/phase6a_e2e.test.ts` — new (PR-C)
- [ ] `cf-control-plane/tests/lease_create_failure.test.ts` — new (PR-A, F-5)
- [ ] `cf-control-plane/tests/manifest_finalize_replay.test.ts` — new (PR-A, F-6)
- [ ] `docs/cloudflare-agent-native-target.md` §1168–1184 status sync (PR-A through PR-E)
- [ ] `docs/cloudflare-agent-native-phase6-plan.md` — this file (PR-A)
- [ ] `docs/cloudflare-agent-native-phase6-7-plan.md` — mark superseded by `phase6-plan.md` + future `phase7-plan.md` (PR-A)

## 7. Acceptance Criteria

A1. **`WorkerHost` contract**: every Phase 6 substrate adapter
(`MockWorkerHost`, `VpsDockerHost`, `CloudflareContainerHost`)
implements the interface verbatim. A type test asserts assignability.

A2. **Phase 6.A end-to-end**: a mirrored issue completes the full
16-step `ExecutionWorkflow` with real workspace operations on VPS
Docker. The `runs` row has `adapter_kind = 'mock'` (Phase 6 alone
does not change adapter; Phase 7 does), `runtime.host = 'vps_docker'`
on the joined profile, and the snapshot key resolves in R2.

A3. **Hook execution**: `after_create`, `before_run`, `after_run`
hooks for a profile that defines them all run inside the WorkerHost
and emit `hook.{name}.completed` events. `before_remove` runs on
workspace release.

A4. **Hook timeout enforcement**: a hook that exceeds its R5
timeout is killed by the host driver, emits `hook.{name}.failed`
with reason `timeout`, and the step is marked `failed`.

A5. **Workspace idempotency**: re-running step 3 + step 4 via a
forced workflow replay yields the same `WorkspaceRef`; no duplicate
git checkout, no duplicate asset materialization.

A6. **Snapshot redaction**: a snapshot of a workspace containing a
`.env` file, a `.git/` directory, and a path matching `**/secret*`
does **not** contain those entries; manifest references no redacted
paths.

A7. **Phase 6.B feature flag**: a profile with
`runtime.host: 'cloudflare_container'` runs end-to-end on Container
substrate; a profile without that field defaults to `'vps_docker'`
and behavior matches A2 verbatim.

A8. **F-1 closed**: a one-shot live deploy + curl smoke completes
one mock run end-to-end on the deployed Cloudflare control plane;
the manifest lands in production R2; PR-A merge waits on this gate.

A9. **F-4 closed**: A2 above implies F-4 because steps 3 + 4 swapped
their bodies.

A10. **F-5 closed**: a forced `EXECUTION_WORKFLOW.create` failure
does not leave the agent in `running`; an integration test asserts
the agent transitions out of `running` and a follow-up dispatch
succeeds.

A11. **F-6 closed**: an in-memory replay of the full workflow shows
the manifest written exactly once at the `finalizeManifest`
boundary; `run_steps.length === 16` (the new boundary is NOT counted
as a 17th step).

A12. **Phase 6 invariants** (R16): grep gates in CI fail any PR that
adds a 17th canonical step name, branches on substrate identity
inside `execution.ts`, or introduces a new `adapter_kind` value.

A13. `bun test` green; `bunx tsc --noEmit` clean; `make all` green
in `cf-control-plane`.

A14. **Live e2e (Phase 6.A)**: PR-C includes a captured manifest +
16-step grid screenshot from a real mirrored issue running on the
live Cloudflare control plane with the VPS Docker WorkerHost. This
is on top of A8's mock-only F-1 smoke.

## 8. Verification Matrix

| Behavior | How verified | Pass signal |
|---|---|---|
| `WorkerHost` contract | Type tests + `worker_host_idempotency.test.ts` | All adapters satisfy interface; mock + VPS pass idempotency assertions |
| Workspace idempotency | `phase6a_e2e.test.ts` replay | Single workspace, single git fetch |
| Hook execution | `phase6a_e2e.test.ts` | `hook.*.completed` events present in run_events |
| Hook timeout | `hook_timeout.test.ts` | `hook.*.failed` with reason=`timeout` |
| Redaction | `worker_host_redaction.test.ts` | Snapshot tar contains no banned paths |
| Container substrate | Manual deploy + smoke (PR-E) | Container run completes |
| F-1 live-edge mock smoke | Manual deploy + curl chain (PR-A) | Manifest in production R2 |
| F-5 lease ordering | `lease_create_failure.test.ts` | Agent does not stay in `running` after `create()` failure |
| F-6 manifest replay | `manifest_finalize_replay.test.ts` | Manifest written exactly once |
| Phase 6 invariants | Grep gate in `bun test` | No banned tokens; canonical 16 step names exact |
| Live e2e (VPS Docker) | Manual deploy + screenshot (PR-C) | Manifest in R2; dashboard renders 16 steps green |

## 9. Risks and Mitigations

R-1 — **VPS Docker bridge auth**. The bridge is an HTTPS endpoint on
`dev@74.48.189.45`; production must rotate `VPS_BRIDGE_TOKEN`,
support multiple tenant scopes, and survive a host reboot.
*Mitigation*: token + per-tenant principal in the bridge auth header;
bridge supervised by systemd with documented restart procedure.
Phase 6.A operator runbook in PR-B.

R-2 — **Container instance lifecycle racing with workflow replay**.
A workflow may resume after a Container instance has been recreated.
*Mitigation*: bridge `/reset` endpoint is idempotent;
`prepareWorkspace` re-bootstraps cleanly via a `bridge_instance_id`
sentinel. Workspace state is on the host filesystem, so a recreated
Container needs to either reuse the volume or trigger a fresh
materialization (R8 idempotency covers this).

R-3 — **Workflow step result 1 MiB cap on large hook output**. A
noisy hook (e.g. `npm install` log) can exceed it.
*Mitigation*: hook output > 4 KB is written to R2 and the step
result carries only the R2 ref. Same pattern as Phase 5 R-5.

R-4 — **R2 snapshot key collision on concurrent attempts**. Two
attempts of the same issue could in theory clash on snapshot keys.
*Mitigation*: snapshot key includes `attempt`; R2 1/sec same-key
write rate is irrelevant.

R-5 — **Profile schema v2 → v3 confusion**. Adding `runtime.host` is
non-breaking, but if `runtime.snapshot.redact` syntax is wrong
(glob vs regex confusion) profiles can subtly break.
*Mitigation*: schema validator enforces glob shape; importer fails
loud on unknown patterns; integration test seeds a profile with the
default redact list.

R-6 — **Cloudflare Container startup latency masks bring-up bugs**.
Cold-start a Container can take 10–30s, hiding race conditions in
the workflow → bridge handshake.
*Mitigation*: Phase 6.B integration test uses warm-cache fixtures;
live e2e adds a 60s grace timeout per step before declaring failure.

R-7 — **VPS substrate is single-host**. Phase 6.A's VPS Docker
WorkerHost runs on one VPS; outage = total bring-down for any
profile pinned to it.
*Mitigation*: out of scope for Phase 6. Multi-host VPS Docker is a
Phase 8/Phase 11 hardening concern. Document the single-host risk
in the operator runbook.

R-8 — **F-5 chosen option may interact with `startRunInFlight`
dedup**. Moving the DO put after `create()` means the in-flight
Promise resolves before the storage write — concurrent dispatch
bursts may see a brief window where the Promise is resolved but the
lease isn't yet persisted.
*Mitigation*: the Promise resolution payload carries the
`workflow_instance_id`; concurrent callers receive that id from the
in-flight Promise without reading storage. The window is closed at
the next storage put. Test coverage in
`lease_create_failure.test.ts` and an additional concurrency test
in PR-A.

R-9 — **F-6 boundary may break the `run_steps.length === 16`
invariant if implemented carelessly**. If the new
`finalizeManifest` step body is recorded in the `run_steps` table,
the existing E2E test in `tests/execution_workflow_e2e.test.ts` will
fail.
*Mitigation*: implement option (1) — the new `step.do` boundary
does NOT call `recordStep`. Only the canonical 16 step bodies call
`recordStep`. A unit test asserts this invariant.

R-10 — **Snapshot upload time on large workspaces**. A workspace
with a heavy `node_modules/` could push snapshot upload time over
the workflow step timeout.
*Mitigation*: default redaction list includes `node_modules/` (add
to R6 default list — `node_modules/`, `.next/`, `dist/`, `target/`);
Phase 6 ships with these excluded by default; a profile can override
to include them if it really wants.

## 10. Stop Conditions

S-1. If the VPS bridge cannot be authenticated from a Worker (e.g.
mTLS / IP-allowlist issues that the Worker cannot satisfy), **stop**
PR-B and add a spike `spikes/vps-bridge-auth/`. Phase 6.A blocks
until the auth path is real.

S-2. If `wrangler dev` cannot exercise a `[[containers]]` binding
(local emulation gap), **stop** Phase 6.B's local dev path and
accept a deploy-per-iteration cycle for Container substrate work, OR
add a `FakeContainerHost` to the test harness. Document either
choice.

S-3. If F-1 (live-edge mock smoke) cannot complete because the
deployed Worker is missing a binding (D1 / R2 / Workflows), **stop**
PR-A until the operator runbook is updated to include the missing
provisioning step.

S-4. If F-5 chosen option introduces a regression in the
`startRunInFlight` dedup behavior, **stop** PR-A and spike
`spikes/issue-agent-startrun-dedup/` to prove the chosen option
preserves the property.

S-5. If F-6 implementation pushes `run_steps.length === 16`
invariant out of true, **stop** PR-A — the invariant is the contract
the dashboard renders against.

S-6. If a Phase 6 PR exceeds ~600 net lines, **stop** and re-cut. PRs
that grow past that bound should be split into review-sized chunks.

## 11. Phase 7 Readiness Gates

Phase 7 (`Codex compatibility adapter on WorkerHosts`,
`target.md` §1186–1202) can start when:

- A1–A14 acceptance criteria pass on `main`.
- F-1, F-4, F-5, F-6 are all closed in this plan's tracking.
- `WorkerHost` interface is stable (no breaking changes since PR-A).
- Phase 6.A path has been exercised against at least one real
  mirrored issue end-to-end (A14).
- A `spikes/codex-on-cloudflare/` reference deploy is still
  reproducible from current main (the Phase 0 artifact still works).
- The future `phase7-plan.md` document is drafted and linked from
  `target.md` §1186 status row.

Phase 7's first PR (`codex_compat` adapter) wires step 8 to a real
adapter on the Phase 6 substrate; everything else stays unchanged.

## 12. Out of Scope

- Real coding-agent execution (Phase 7).
- Native Cloudflare CodingAgent (Phase 10; ADR-0002 deferral).
- Multi-host VPS Docker WorkerHost (Phase 8/11 hardening).
- Cloudflare Sandbox WorkerHost (Phase 6.C, deferred per
  `phase6-7-plan.md` §1).
- ToolGateway idempotency contract / approval flow (Phase 8).
- AI Gateway routing for model traffic (Phase 8 or later).
- Tracker write-back (Phase 8 alongside ToolGateway).
- F-2 (latest-run summary column on Issues table; dashboard polish,
  Phase 6 closer or Phase 7).
- F-3 (cookie-auth for operator routes; Phase 8 with ToolGateway).
- Removing `MockCodingAgentAdapter` from the codebase (it stays as a
  test fixture and feeds the deprecated `executeMockRun` until
  Phase 7 closes).
- D1 schema migration (Phase 6 is JSON-additive only).

## 13. Estimated Effort

- PR-A (F-1 + F-5 + F-6 + WorkerHost contract): ~1 day. F-1 is
  largely operations (one live deploy + verification); F-5 + F-6 are
  small targeted fixes with focused tests; the contract is types
  only.
- PR-B (VPS Docker WorkerHost): ~1 day, mostly wiring against an
  existing bridge.
- PR-C (workflow steps 3 + 4 swap + profile schema bump): ~0.75 day.
- PR-D (hooks + snapshot + redaction): ~1 day.
- PR-E (Container substrate + dashboard surface + operator routes):
  ~1 day.
- Total: 4.5–5 days end-to-end including review iterations and one
  live e2e validation.

## 14. CodingAgentAdapter contract (forward link to Phase 7)

Phase 6 does **not** ship a real `CodingAgentAdapter`. For Phase 7
readiness, this section pins the contract Phase 7 will implement so
Phase 6 reviewers can reject any drift.

The contract is the existing TS engine `Agent` interface from
`ts-engine/src/agent/types.ts`, re-exported as
`CodingAgentAdapter` via `ts-engine/src/contracts/agent.ts`:

```ts
export interface Agent {
  start(): Promise<void>;
  startSession(opts: SessionOptions): Promise<string>;
  runTurn(prompt: string, title: string, handlers: TurnHandlers): Promise<TurnResult>;
  stop(): Promise<void>;
}

export type TurnHandlers = {
  onActivity?: (info: AgentActivity) => void;
  onTokenUsage?: (usage: AgentTokenUsage) => void;
  onToolCall?: (call: ToolCall) => Promise<ToolResult>;
};

export type AgentTokenUsage = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
};

export type TurnResult = {
  status: "completed" | "failed" | "cancelled" | "timeout";
  reason?: unknown;
  sessionId?: string | null;
};
```

Phase 7's `codex_compat` adapter is a **verbatim port** of this shape:
identical method signatures, identical return-type unions, identical
`AgentTokenUsage` field set. The Cloudflare-side adapter file
(`cf-control-plane/src/agents/codex_compat_adapter.ts`) re-uses the
type definitions from `ts-engine/src/agent/types.ts` (or a copied
header that stays byte-identical) so the dashboard's
`token_usage_json` shape and the operator's tool-call envelope are
unchanged from Phase 5 mock to Phase 7 codex_compat.

**Phase 6 reviewer guard**: any PR that adds a Cloudflare-side adapter
file with a divergent shape (e.g. renames `runTurn` to `runOneTurn`,
adds a 4th token field, splits `TurnHandlers`) is rejected — the
contract bridge stays a verbatim port.
