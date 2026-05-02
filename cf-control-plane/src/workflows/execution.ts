// ExecutionWorkflow — Phase 5 PR-A scaffold.
//
// Plan: docs/cloudflare-agent-native-phase5-plan.md. The durable workflow
// identity comes from docs/cloudflare-agent-native-target.md §8.4:
// `run:{tenant_id}:{profile_slug}:{issue_id}:{attempt}`. PR-B sets that id
// when calling env.EXECUTION_WORKFLOW.create({ id, params }).
//
// PR-C fills these step bodies with the Phase 5 mock implementation:
// 1. loadProfileAndIssue: read the D1 profile and issue snapshots.
// 2. acquireLease: acquire the IssueAgent workflow lease idempotently.
// 3. prepareWorkspace: emit the mock workspace-prepared event only.
// 4. materializeAssets: emit the mock assets-materialized event only.
// 5. afterCreateHook: record the skipped mock after_create hook.
// 6. renderPrompt: build the deterministic prompt from issue context.
// 7. beforeRunHook: record the skipped mock before_run hook.
// 8. runAgentTurnLoop: run the MockCodingAgentAdapter turn loop.
// 9. handleToolCalls: record the synthetic mock tool-call lifecycle.
// 10. pollTrackerBetweenTurns: record the skipped single-turn poll.
// 11. persistRunArtifacts: write the R2 manifest and D1 token summary.
// 12. afterRunHook: record the skipped mock after_run hook.
// 13. validateCompletion: apply the Phase 5 trivial completion check.
// 14. transitionIssueState: emit the mock issue transition event only.
// 15. archiveOrCleanupWorkspace: record the skipped mock cleanup step.
// 16. releaseLeaseAndNotify: release the IssueAgent lease idempotently.
//
// Anti-pattern: do NOT add real workspace operations, real tool calls, or
// real Codex execution here. Real workspace execution is Phase 6; Codex
// compatibility is Phase 7.

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

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
};

export class ExecutionWorkflow extends WorkflowEntrypoint<Env, ExecutionWorkflowParams> {
  async run(event: WorkflowEvent<ExecutionWorkflowParams>, step: WorkflowStep): Promise<void> {
    // 16 canonical steps from target.md §8.4. PR-A scaffolding: each step is a
    // step.do() that returns a small descriptor. PR-C wires the real bodies.
    const params = event.payload;

    await step.do("loadProfileAndIssue", async () => ({ step: "loadProfileAndIssue", attempt: params.attempt }));
    await step.do("acquireLease", async () => ({ step: "acquireLease" }));
    await step.do("prepareWorkspace", async () => ({ step: "prepareWorkspace" }));
    await step.do("materializeAssets", async () => ({ step: "materializeAssets" }));
    await step.do("afterCreateHook", async () => ({ step: "afterCreateHook" }));
    await step.do("renderPrompt", async () => ({ step: "renderPrompt" }));
    await step.do("beforeRunHook", async () => ({ step: "beforeRunHook" }));
    await step.do("runAgentTurnLoop", async () => ({ step: "runAgentTurnLoop" }));
    await step.do("handleToolCalls", async () => ({ step: "handleToolCalls" }));
    await step.do("pollTrackerBetweenTurns", async () => ({ step: "pollTrackerBetweenTurns" }));
    await step.do("persistRunArtifacts", async () => ({ step: "persistRunArtifacts" }));
    await step.do("afterRunHook", async () => ({ step: "afterRunHook" }));
    await step.do("validateCompletion", async () => ({ step: "validateCompletion" }));
    await step.do("transitionIssueState", async () => ({ step: "transitionIssueState" }));
    await step.do("archiveOrCleanupWorkspace", async () => ({ step: "archiveOrCleanupWorkspace" }));
    await step.do("releaseLeaseAndNotify", async () => ({ step: "releaseLeaseAndNotify" }));
  }
}
