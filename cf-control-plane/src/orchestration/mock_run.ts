// Mock orchestration: drives a fake "issue run" from the Worker handler
// directly, exercising the full D1 row trail (issues + runs + run_events
// + tool_calls) without touching IssueAgent / ExecutionWorkflow / a real
// WorkerHost. Phase 3 will replace this with a queue-driven IssueAgent
// lease and Phase 5 will replace the Worker-resident loop with a durable
// Cloudflare Workflows instance.
//
// The shape of the events emitted here matches the canonical step list in
// docs/cloudflare-agent-native-target.md §8.4 so future code can replay
// against the same dashboard / R2 manifest format.

type RunResult = {
  issue_id: string;
  run_id: string;
  attempt: number;
  status: "completed" | "failed";
  events_emitted: number;
  duration_ms: number;
};

type Profile = {
  id: string;
  tenant_id: string;
  slug: string;
};

type Env = {
  DB: D1Database;
};

const MOCK_TURN_EVENTS = [
  { type: "workflow.start", severity: "info" as const, message: "mock workflow started" },
  { type: "step.prepareWorkspace.completed", severity: "info" as const, message: "workspace prepared (mock)" },
  { type: "step.beforeRunHook.skipped", severity: "info" as const, message: "no before_run hook in mock profile" },
  { type: "step.runAgentTurn.started", severity: "info" as const, message: "turn 1/1 begin" },
  // tool_calls.linear_graphql is also written as its own row by the caller
  { type: "tool.call.started", severity: "info" as const, message: "mock linear_graphql tool call" },
  { type: "tool.call.completed", severity: "info" as const, message: "mock linear_graphql returned 1 row" },
  { type: "step.runAgentTurn.completed", severity: "info" as const, message: "turn 1 completed; tokens=100" },
  { type: "step.afterRunHook.skipped", severity: "info" as const, message: "no after_run hook in mock profile" },
  { type: "workflow.completed", severity: "info" as const, message: "mock workflow completed" },
];

const MOCK_STEPS = [
  "prepareWorkspace",
  "beforeRunHook",
  "runAgentTurn",
  "afterRunHook",
];

export type MockRunInput = {
  profile: Profile;
  issueIdentifier: string;
  issueTitle?: string;
};

/**
 * Drives the mock run end-to-end. All writes go through D1; nothing
 * touches R2/Queues/Workflows yet. Idempotent on `issues` (deterministic
 * id + INSERT OR IGNORE) but each invocation starts a fresh `runs` row.
 */
export async function executeMockRun(
  env: Env,
  input: MockRunInput,
): Promise<RunResult> {
  const startedAt = new Date();
  const startedAtIso = startedAt.toISOString();

  const issueId = `${input.profile.id}:${input.issueIdentifier}`;
  const runId = crypto.randomUUID();
  const toolCallId = crypto.randomUUID();
  let openedRun = false;

  // 1. Ensure the issue row exists (deterministic id; rerun = same row).
  await env.DB.prepare(
    `INSERT OR IGNORE INTO issues (
       id, tenant_id, profile_id, external_id, identifier, title,
       state, snapshot_json, first_seen_at, last_seen_at,
       created_at, updated_at
     ) VALUES (?, ?, ?, NULL, ?, ?, 'In Progress', ?, ?, ?, ?, ?)`,
  )
    .bind(
      issueId,
      input.profile.tenant_id,
      input.profile.id,
      input.issueIdentifier,
      input.issueTitle ?? input.issueIdentifier,
      JSON.stringify({
        identifier: input.issueIdentifier,
        title: input.issueTitle ?? input.issueIdentifier,
        state: "In Progress",
        mock: true,
      }),
      startedAtIso,
      startedAtIso,
      startedAtIso,
      startedAtIso,
    )
    .run();

  // Always bump last_seen_at so re-running surfaces the issue as recent.
  await env.DB.prepare(
    `UPDATE issues SET last_seen_at = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(startedAtIso, startedAtIso, issueId)
    .run();

  // 2. Open the run and allocate attempt in one statement.
  await env.DB.prepare(
    `INSERT INTO runs (
       id, issue_id, attempt, status, workflow_id, adapter_kind,
       workspace_ref, started_at, finished_at, error,
       token_usage_json, artifact_manifest_ref
     )
     SELECT ?, ?, COALESCE(MAX(attempt), 0) + 1, 'running', NULL, 'mock',
            NULL, ?, NULL, NULL, NULL, NULL
       FROM runs
      WHERE issue_id = ?`,
  )
    .bind(runId, issueId, startedAtIso, issueId)
    .run();
  openedRun = true;

  try {
    const attemptRow = await env.DB.prepare(
      `SELECT attempt FROM runs WHERE id = ?`,
    )
      .bind(runId)
      .first<{ attempt: number }>();
    if (!attemptRow) throw new Error("mock_run_attempt_missing");
    const attempt = attemptRow.attempt;

    // 3. Emit step rows and the canonical mock event sequence.
    for (let i = 0; i < MOCK_STEPS.length; i++) {
      const step = MOCK_STEPS[i]!;
      const ts = new Date(startedAt.getTime() + (i + 1) * 75).toISOString();
      await env.DB.prepare(
        `INSERT INTO run_steps (id, run_id, step_name, step_sequence, status, started_at, finished_at, input_ref, output_ref, error)
         VALUES (?, ?, ?, ?, 'completed', ?, ?, NULL, NULL, NULL)`,
      )
        .bind(crypto.randomUUID(), runId, step, i + 1, ts, ts)
        .run();
    }

    let eventsEmitted = 0;
    for (let i = 0; i < MOCK_TURN_EVENTS.length; i++) {
      const ev = MOCK_TURN_EVENTS[i]!;
      const ts = new Date(startedAt.getTime() + (i + 1) * 50).toISOString();
      await env.DB.prepare(
        `INSERT INTO run_events (id, run_id, issue_id, event_type, severity, message, payload_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
        .bind(crypto.randomUUID(), runId, issueId, ev.type, ev.severity, ev.message, ts)
        .run();
      eventsEmitted++;
    }

    // 4. Audit the simulated tool call.
    const toolStartIso = new Date(startedAt.getTime() + 200).toISOString();
    const toolEndIso = new Date(startedAt.getTime() + 250).toISOString();
    await env.DB.prepare(
      `INSERT INTO tool_calls (id, run_id, turn_number, tool_name, status, input_ref, output_ref, approval_id, started_at, finished_at)
       VALUES (?, ?, 1, 'linear_graphql', 'completed', 'mock://input', 'mock://output', NULL, ?, ?)`,
    )
      .bind(toolCallId, runId, toolStartIso, toolEndIso)
      .run();

    // 5. Close the run.
    const finishedAtIso = new Date(startedAt.getTime() + 600).toISOString();
    const tokenUsage = { totalTokens: 100, inputTokens: 60, outputTokens: 40, secondsRunning: 1 };
    await env.DB.prepare(
      `UPDATE runs
          SET status = 'completed', finished_at = ?, token_usage_json = ?
        WHERE id = ?`,
    )
      .bind(finishedAtIso, JSON.stringify(tokenUsage), runId)
      .run();

    return {
      issue_id: issueId,
      run_id: runId,
      attempt,
      status: "completed",
      events_emitted: eventsEmitted,
      duration_ms: 600,
    };
  } catch (e) {
    if (openedRun) {
      await env.DB.prepare(
        `UPDATE runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?`,
      )
        .bind(new Date().toISOString(), String((e as Error).message ?? e), runId)
        .run();
    }
    throw e;
  }
}
