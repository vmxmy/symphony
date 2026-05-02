// ExecutionWorkflow — Phase 5 PR-C implementation.
//
// Plan: docs/cloudflare-agent-native-phase5-plan.md.
//
// Identity (target.md §8.4):
//   `run:{tenant_id}:{slug}:{external_id}:{attempt}`
//
// PR-A landed the empty 16-step scaffold + R2 binding + Workflows
// registration. PR-B added IssueAgent.startRun + workflow_instance_id
// lease + running state. PR-C fills the step bodies.
//
// Per-step semantics:
// - Each step is wrapped in recordStep() which writes a run_steps row at
//   start and updates it at end, plus run_events rows at boundaries.
// - All step writes use INSERT OR IGNORE keyed by (run_id, step_sequence)
//   for D1 idempotency under Workflows replay.
// - R2 manifest path is deterministic per run, so replay re-writes the
//   same key (R2 1/sec same-key cap is irrelevant for a final manifest).
// - Steps 2 (acquireLease), 8 (runAgentTurnLoop), and 16
//   (releaseLeaseAndNotify) use { retries: { limit: 0, delay: 0 } } because
//   their side effects are not replay-safe. All other steps use the default
//   { limit: 3, delay: "5 seconds", backoff: "exponential" }.
//
// Phase 5 invariant: only MockCodingAgentAdapter ships. Real workspace
// ops are Phase 6; codex_compat is Phase 7.

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import { MockCodingAgentAdapter } from "../agents/mock_coding_adapter.js";
import {
  type ManifestPayload,
  type ManifestStepEntry,
  writeManifest,
} from "../runs/manifest.js";
import { parseRuntimeConfig, pickWorkerHost } from "../runtime/factory.js";
import type {
  AssetBundleRef,
  WorkspaceHandle,
  WorkspaceRef,
} from "../runtime/worker_host.js";

export type ExecutionWorkflowParams = {
  tenant_id: string;
  slug: string;
  external_id: string;
  identifier: string;
  attempt: number;
  workflow_instance_id: string;
};

type Env = {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  ISSUE_AGENT: DurableObjectNamespace;
  VPS_BRIDGE_BASE_URL?: string;
  VPS_BRIDGE_TOKEN?: string;
};

type StepRetries = {
  limit: number;
  delay?: string | number;
  backoff?: "exponential" | "linear" | "constant";
};

const DEFAULT_RETRIES: StepRetries = {
  limit: 3,
  delay: "5 seconds",
  backoff: "exponential",
};

const NO_RETRY: StepRetries = { limit: 0, delay: 0 };

type StepBody<T> = () => Promise<{ result: T; eventDetail?: Record<string, unknown> }>;

// step.do() requires the body to return Cloudflare's Serializable<T>.
// Plain JSON-safe objects (records, arrays, primitives) satisfy that
// constraint at runtime; cast at the boundary to keep our callers
// returning ordinary TypeScript objects.
type StepDoBody<T> = (ctx: unknown) => Promise<T>;

// Exported for tests/execution_workflow_steps.test.ts. Internal callers
// stay inside ExecutionWorkflow.run() below.
export async function recordStep<T>(
  env: Env,
  runId: string,
  sequence: number,
  name: string,
  step: WorkflowStep,
  body: StepBody<T>,
  retries: StepRetries = DEFAULT_RETRIES,
): Promise<T> {
  const stepDoOptions = { retries } as Parameters<typeof step.do>[1];
  const wrapped: StepDoBody<T> = async () => {
    const startedAt = new Date().toISOString();
    const stepRowId = `${runId}:${sequence}`;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO run_steps (id, run_id, step_name, step_sequence, status, started_at)
       VALUES (?, ?, ?, ?, 'running', ?)`,
    )
      .bind(stepRowId, runId, name, sequence, startedAt)
      .run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO run_events (id, run_id, event_type, severity, message, created_at)
       VALUES (?, ?, ?, 'info', ?, ?)`,
    )
      .bind(
        `${stepRowId}:started`,
        runId,
        `step.${name}.started`,
        `Step ${sequence}/${name} started`,
        startedAt,
      )
      .run();
    try {
      const { result, eventDetail } = await body();
      const finishedAt = new Date().toISOString();
      await env.DB.prepare(
        `UPDATE run_steps SET status = 'completed', finished_at = ? WHERE id = ?`,
      )
        .bind(finishedAt, stepRowId)
        .run();
      await env.DB.prepare(
        `INSERT OR IGNORE INTO run_events (id, run_id, event_type, severity, message, created_at)
         VALUES (?, ?, ?, 'info', ?, ?)`,
      )
        .bind(
          `${stepRowId}:completed`,
          runId,
          `step.${name}.completed`,
          eventDetail ? JSON.stringify(eventDetail) : `Step ${sequence}/${name} completed`,
          finishedAt,
        )
        .run();
      return result;
    } catch (e) {
      const finishedAt = new Date().toISOString();
      const error = String((e as Error)?.message ?? e);
      await env.DB.prepare(
        `UPDATE run_steps SET status = 'failed', finished_at = ?, error = ? WHERE id = ?`,
      )
        .bind(finishedAt, error, stepRowId)
        .run();
      await env.DB.prepare(
        `INSERT OR IGNORE INTO run_events (id, run_id, event_type, severity, message, created_at)
         VALUES (?, ?, ?, 'error', ?, ?)`,
      )
        .bind(
          `${stepRowId}:failed`,
          runId,
          `step.${name}.failed`,
          error,
          finishedAt,
        )
        .run();
      throw e;
    }
  };
  // Cast: step.do's body must return Serializable<T>; our T is always a
  // plain JSON-safe object, so the runtime check passes and the cast is
  // safe at this boundary.
  const promise = step.do(
    name,
    stepDoOptions,
    wrapped as Parameters<typeof step.do>[2],
  );
  return promise as unknown as Promise<T>;
}

type IssueAgentLeaseStub = {
  getStatus(
    tenantId: string,
    slug: string,
    externalId: string,
  ): Promise<{ status: string; workflow_instance_id?: string }>;
  onRunFinished(
    tenantId: string,
    slug: string,
    externalId: string,
    outcome: "completed" | "failed" | "cancelled" | "retry",
  ): Promise<unknown>;
  // Used by the catch path so a workflow failure releases the lease
  // (running -> queued) and then bumps the attempt counter via markFailed.
  // Without this two-step the next dispatch would collide on
  // runs.UNIQUE(issue_id, attempt) with the same attempt number.
  transition(
    tenantId: string,
    slug: string,
    externalId: string,
    next: string,
    decidedBy?: string,
    reason?: string,
  ): Promise<unknown>;
  markFailed(
    tenantId: string,
    slug: string,
    externalId: string,
    error: string,
  ): Promise<unknown>;
};

function leaseStub(env: Env, params: ExecutionWorkflowParams): IssueAgentLeaseStub {
  const id = env.ISSUE_AGENT.idFromName(
    `issue:${params.tenant_id}:${params.slug}:${params.external_id}`,
  );
  return env.ISSUE_AGENT.get(id) as unknown as IssueAgentLeaseStub;
}

export class ExecutionWorkflow extends WorkflowEntrypoint<Env, ExecutionWorkflowParams> {
  async run(event: WorkflowEvent<ExecutionWorkflowParams>, step: WorkflowStep): Promise<void> {
    const params = event.payload;
    const runId = `run:${params.tenant_id}:${params.slug}:${params.external_id}:${params.attempt}`;
    const startedAt = new Date().toISOString();
    const issueId = `${params.tenant_id}/${params.slug}:${params.external_id}`;

    // Open the runs row idempotently. UNIQUE(issue_id, attempt) guarantees
    // re-runs of the same workflow instance share one row.
    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO runs (
         id, issue_id, attempt, status, workflow_id, adapter_kind, started_at
       ) VALUES (?, ?, ?, 'running', ?, 'mock', ?)`,
    )
      .bind(runId, issueId, params.attempt, params.workflow_instance_id, startedAt)
      .run();

    const tokenUsage = { totalTokens: 0, inputTokens: 0, outputTokens: 0 };

    try {
      // Step 1: loadProfileAndIssue
      const loaded = await recordStep(this.env, runId, 1, "loadProfileAndIssue", step, async () => {
        const issueRow = await this.env.DB.prepare(
          `SELECT id, identifier, title FROM issues WHERE id = ?`,
        )
          .bind(issueId)
          .first<{ id: string; identifier: string; title: string | null }>();
        const profileRow = await this.env.DB.prepare(
          `SELECT id, slug, config_json FROM profiles WHERE id = ?`,
        )
          .bind(`${params.tenant_id}/${params.slug}`)
          .first<{ id: string; slug: string; config_json: string | null }>();
        return {
          result: { issue: issueRow, profile: profileRow },
          eventDetail: {
            issue_id: issueRow?.id ?? null,
            profile_id: profileRow?.id ?? null,
          },
        };
      });

      // Resolve the profile slug + WorkerHost for steps 3-4. The factory is
      // the single dispatch point per ADR-0001; execution.ts must not branch
      // on WorkerHostKind. parseRuntimeConfig falls back to "mock" when the
      // profile is missing or config_json is empty / unparseable.
      const profileSlug = loaded.profile?.slug ?? params.slug;
      const runtimeConfig = parseRuntimeConfig(loaded.profile?.config_json ?? null);
      const workerHost = pickWorkerHost(this.env, runtimeConfig);
      let workspaceHandle: WorkspaceHandle;

      // Step 2: acquireLease — IssueAgent confirms our workflow_instance_id
      // owns the lease. Conflict here is fatal: the next attempt is a new
      // workflow instance, not an in-place retry.
      await recordStep(
        this.env,
        runId,
        2,
        "acquireLease",
        step,
        async () => {
          const stub = leaseStub(this.env, params);
          const agentState = await stub.getStatus(
            params.tenant_id,
            params.slug,
            params.external_id,
          );
          if (
            agentState.status !== "running" ||
            agentState.workflow_instance_id !== params.workflow_instance_id
          ) {
            throw new Error(
              `acquire_lease_conflict: agent_status=${agentState.status} agent_lease=${agentState.workflow_instance_id ?? "<none>"}`,
            );
          }
          return {
            result: { lease: agentState.workflow_instance_id },
            eventDetail: { lease: params.workflow_instance_id },
          };
        },
        NO_RETRY,
      );

      // Step 3: prepareWorkspace — delegate to the WorkerHost picked above.
      // The full handle is returned as the step result so Workflows replay
      // can restore workspaceHandle from the cached step.do() value without
      // re-executing prepareWorkspace's body.
      workspaceHandle = await recordStep(
        this.env,
        runId,
        3,
        "prepareWorkspace",
        step,
        async () => {
          const ref: WorkspaceRef = {
            tenant: params.tenant_id,
            profile: profileSlug,
            issue: params.external_id,
          };
          const handle = await workerHost.prepareWorkspace(ref);
          return {
            result: handle,
            eventDetail: { handle_id: handle.id, substrate: handle.substrate },
          };
        },
      );

      // Step 4: materializeAssets — content-addressed bundle hash derived
      // from (tenant, profile, issue, attempt) so replay produces the same
      // hash and adapters (MockWorkerHost cache, VpsDockerHost server-side)
      // treat the call as idempotent.
      const bundle: AssetBundleRef = {
        hash: `mock-${params.tenant_id}-${profileSlug}-${params.external_id}-${params.attempt}`,
      };
      await recordStep(this.env, runId, 4, "materializeAssets", step, async () => {
        await workerHost.materializeAssets(workspaceHandle, bundle);
        return {
          result: { handle_id: workspaceHandle.id, bundle_hash: bundle.hash },
          eventDetail: { handle_id: workspaceHandle.id, bundle_hash: bundle.hash },
        };
      });

      // Steps 5-7: Phase 5 mock no-ops. Each step records its boundary
      // event so dashboards see the canonical 16-step shape.
      await recordStep(this.env, runId, 5, "afterCreateHook", step, async () => ({
        result: { mock: true, skipped: true },
        eventDetail: { mock: true, skipped: "no after_create hook in mock profile" },
      }));
      await recordStep(this.env, runId, 6, "renderPrompt", step, async () => ({
        result: { prompt: `${params.identifier} attempt ${params.attempt}` },
        eventDetail: { mock: true, prompt_chars: params.identifier.length + 20 },
      }));
      await recordStep(this.env, runId, 7, "beforeRunHook", step, async () => ({
        result: { mock: true, skipped: true },
        eventDetail: { mock: true, skipped: "no before_run hook in mock profile" },
      }));

      // Step 8: runAgentTurnLoop — single mock turn.
      // CRITICAL: { retries: { limit: 0 } } per phase5-plan §9 R-1. Tool
      // call side effects are not replay-safe; a failed turn escalates to
      // a failed run, and the next attempt becomes a fresh workflow
      // instance via Phase 4 sub-cut 3 markFailed.
      await recordStep(
        this.env,
        runId,
        8,
        "runAgentTurnLoop",
        step,
        async () => {
          const adapter = new MockCodingAgentAdapter();
          const turnResult = await adapter.runTurn({
            prompt: `${params.identifier} attempt ${params.attempt}`,
            attempt: params.attempt,
          });
          tokenUsage.totalTokens += turnResult.tokenUsage.totalTokens;
          tokenUsage.inputTokens += turnResult.tokenUsage.inputTokens;
          tokenUsage.outputTokens += turnResult.tokenUsage.outputTokens;

          // Persist tool-call envelopes to R2 + tool_calls rows. Phase 5
          // mock writes a single linear_graphql echo per turn. R2 keys are
          // deterministic per (run_id, tool_call_id) so replay is safe.
          for (const tc of turnResult.toolCalls) {
            const toolCallId = `${runId}:tc:${tc.id}`;
            const inputKey = `runs/${params.tenant_id}/${params.slug}/${params.external_id}/${params.attempt}/tool-calls/${tc.id}.in.json`;
            const outputKey = `runs/${params.tenant_id}/${params.slug}/${params.external_id}/${params.attempt}/tool-calls/${tc.id}.out.json`;
            await this.env.ARTIFACTS.put(inputKey, JSON.stringify(tc.arguments), {
              httpMetadata: { contentType: "application/json" },
            });
            await this.env.ARTIFACTS.put(outputKey, JSON.stringify(tc.result), {
              httpMetadata: { contentType: "application/json" },
            });
            const now = new Date().toISOString();
            await this.env.DB.prepare(
              `INSERT OR IGNORE INTO tool_calls (
                 id, run_id, turn_number, tool_name, status, input_ref, output_ref, started_at, finished_at
               ) VALUES (?, ?, 1, ?, 'completed', ?, ?, ?, ?)`,
            )
              .bind(toolCallId, runId, tc.name, inputKey, outputKey, now, now)
              .run();
          }

          return {
            result: { tokens: turnResult.tokenUsage.totalTokens, toolCallCount: turnResult.toolCalls.length },
            eventDetail: {
              tokens: turnResult.tokenUsage.totalTokens,
              tool_calls: turnResult.toolCalls.length,
            },
          };
        },
        NO_RETRY,
      );

      // Steps 9-10: tool calls have already been recorded inside step 8;
      // single-turn mock skips between-turn polling.
      await recordStep(this.env, runId, 9, "handleToolCalls", step, async () => ({
        result: { mock: true, recordedInStep8: true },
        eventDetail: { mock: true, note: "tool_calls rows written by step 8" },
      }));
      await recordStep(this.env, runId, 10, "pollTrackerBetweenTurns", step, async () => ({
        result: { mock: true, skipped: true },
        eventDetail: { mock: true, skipped: "single-turn mock; no between-turn poll" },
      }));

      // Step 11: persistRunArtifacts — write the R2 manifest. The manifest
      // includes step durations from the run_steps rows we just wrote;
      // step 11 itself is in_flight at this moment so it shows up as
      // 'running' in the manifest snapshot until the recordStep wrapper
      // updates it to 'completed' after this body returns.
      await recordStep(this.env, runId, 11, "persistRunArtifacts", step, async () => {
        const stepRows = await this.env.DB.prepare(
          `SELECT step_sequence, step_name, status, started_at, finished_at
             FROM run_steps WHERE run_id = ? ORDER BY step_sequence`,
        )
          .bind(runId)
          .all<{
            step_sequence: number;
            step_name: string;
            status: string;
            started_at: string;
            finished_at: string | null;
          }>();
        const eventCountRow = await this.env.DB.prepare(
          `SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?`,
        )
          .bind(runId)
          .first<{ n: number }>();
        const finishedAt = new Date().toISOString();
        const steps: ManifestStepEntry[] = (stepRows.results ?? []).map((r) => ({
          step_sequence: r.step_sequence,
          step_name: r.step_name,
          status: r.status as ManifestStepEntry["status"],
          duration_ms: r.finished_at
            ? new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()
            : 0,
        }));
        const manifest: ManifestPayload = {
          schema: "v1",
          run_id: runId,
          tenant_id: params.tenant_id,
          slug: params.slug,
          issue_external_id: params.external_id,
          attempt: params.attempt,
          steps,
          started_at: startedAt,
          finished_at: finishedAt,
          token_usage: tokenUsage,
          events_count: eventCountRow?.n ?? 0,
        };
        const { key } = await writeManifest(this.env.ARTIFACTS, params, manifest);
        await this.env.DB.prepare(
          `UPDATE runs SET artifact_manifest_ref = ? WHERE id = ?`,
        )
          .bind(key, runId)
          .run();
        return {
          result: { manifest_ref: key },
          eventDetail: { manifest_ref: key, events_count: manifest.events_count },
        };
      });

      // Steps 12-15: mock no-ops emitting deterministic events.
      await recordStep(this.env, runId, 12, "afterRunHook", step, async () => ({
        result: { mock: true, skipped: true },
        eventDetail: { mock: true, skipped: "no after_run hook in mock profile" },
      }));
      await recordStep(this.env, runId, 13, "validateCompletion", step, async () => ({
        result: { mock: true, valid: true },
        eventDetail: { mock: true, validation: "trivial-pass" },
      }));
      await recordStep(this.env, runId, 14, "transitionIssueState", step, async () => ({
        result: { mock: true, transitioned: false },
        eventDetail: { mock: true, note: "phase 5 emits event only; tracker write-back is phase 8" },
      }));
      await recordStep(this.env, runId, 15, "archiveOrCleanupWorkspace", step, async () => ({
        result: { mock: true, skipped: true },
        eventDetail: { mock: true, skipped: "phase 5 mock has no workspace to archive" },
      }));

      // Step 16: releaseLeaseAndNotify — call IssueAgent.onRunFinished.
      // No within-step retry: a duplicate notify would clobber the agent
      // state. onRunFinished is itself idempotent on already-terminal,
      // so the worst case under replay is a no-op DO subrequest.
      await recordStep(
        this.env,
        runId,
        16,
        "releaseLeaseAndNotify",
        step,
        async () => {
          const stub = leaseStub(this.env, params);
          await stub.onRunFinished(
            params.tenant_id,
            params.slug,
            params.external_id,
            "completed",
          );
          return { result: { outcome: "completed" }, eventDetail: { outcome: "completed" } };
        },
        NO_RETRY,
      );

      // Final manifest re-write: step 11 captured a partial snapshot (it
      // runs before steps 12-16), so re-emit the manifest now that all 16
      // steps have terminal status. R2 same-key cap is irrelevant —
      // multi-second gap between step 11 and this write — and the key is
      // deterministic so a replay safely overwrites identical content.
      //
      // F-6 (phase 6 PR-A): wrap in a private step.do("finalizeManifest")
      // boundary so Workflows replay caches the result and does not
      // re-execute the body on a partial-success replay. This boundary is
      // deliberately NOT routed through recordStep — finalizeManifest is a
      // replay-safety boundary, not a logical workflow step, so it does NOT
      // add a run_steps row and the canonical 16-row invariant is preserved.
      const finalizeBody: StepDoBody<{ finished_at: string }> = async () => {
        const finalStepRows = await this.env.DB.prepare(
          `SELECT step_sequence, step_name, status, started_at, finished_at
             FROM run_steps WHERE run_id = ? ORDER BY step_sequence`,
        )
          .bind(runId)
          .all<{
            step_sequence: number;
            step_name: string;
            status: string;
            started_at: string;
            finished_at: string | null;
          }>();
        const finalEventCountRow = await this.env.DB.prepare(
          `SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?`,
        )
          .bind(runId)
          .first<{ n: number }>();
        const finalFinishedAt = new Date().toISOString();
        const finalSteps: ManifestStepEntry[] = (finalStepRows.results ?? []).map((r) => ({
          step_sequence: r.step_sequence,
          step_name: r.step_name,
          status: r.status as ManifestStepEntry["status"],
          duration_ms: r.finished_at
            ? new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()
            : 0,
        }));
        const finalManifest: ManifestPayload = {
          schema: "v1",
          run_id: runId,
          tenant_id: params.tenant_id,
          slug: params.slug,
          issue_external_id: params.external_id,
          attempt: params.attempt,
          steps: finalSteps,
          started_at: startedAt,
          finished_at: finalFinishedAt,
          token_usage: tokenUsage,
          events_count: finalEventCountRow?.n ?? 0,
        };
        await writeManifest(this.env.ARTIFACTS, params, finalManifest);
        await this.env.DB.prepare(
          `UPDATE runs SET status = 'completed', finished_at = ?, token_usage_json = ? WHERE id = ?`,
        )
          .bind(finalFinishedAt, JSON.stringify(tokenUsage), runId)
          .run();
        return { finished_at: finalFinishedAt };
      };
      const finalizeOptions = { retries: NO_RETRY } as Parameters<typeof step.do>[1];
      await step.do(
        "finalizeManifest",
        finalizeOptions,
        finalizeBody as Parameters<typeof step.do>[2],
      );
    } catch (e) {
      const lastError = String((e as Error)?.message ?? e);
      await this.env.DB.prepare(
        `UPDATE runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?`,
      )
        .bind(new Date().toISOString(), lastError, runId)
        .run();
      // Best-effort failure path: release the lease (running -> queued)
      // then bump the attempt counter via markFailed so the next dispatch
      // does not collide on runs.UNIQUE(issue_id, attempt) with the same
      // attempt number. markFailed picks retry_wait vs failed based on
      // the per-issue maxAttempts policy and schedules an alarm; the
      // alarm-driven re-dispatch creates a *new* workflow instance with
      // the bumped attempt. Swallow errors here — the workflow has
      // already failed and we do not want secondary failures to mask
      // the primary one.
      const stub = leaseStub(this.env, params);
      // Each call is independently best-effort: a stuck transition (e.g.
      // because the agent is already in a terminal state from an operator
      // cancel that raced this catch path) must not skip markFailed.
      try {
        await stub.transition(
          params.tenant_id,
          params.slug,
          params.external_id,
          "queued",
          "execution-workflow",
          "workflow-failed",
        );
      } catch {
        /* swallow — agent may already be in a terminal state */
      }
      try {
        await stub.markFailed(
          params.tenant_id,
          params.slug,
          params.external_id,
          lastError,
        );
      } catch {
        /* swallow — agent may not be in queued (terminal already) */
      }
      throw e;
    }
  }
}
