// Multi-turn smoke for the persistent codex bridge.
// Drives three turns + a reset against the same WorkerHost to verify that
// the bridge keeps a single thread alive across /run-turn calls and that
// /reset starts a fresh thread.
//
// Usage:
//   WORKER_URL=http://127.0.0.1:8788 bun run scripts/smoke-multi.ts
//
// Optional:
//   MODEL=gpt-5.5
//   TIMEOUT_MS=120000

const WORKER_URL = process.env.WORKER_URL;
if (!WORKER_URL) {
  console.error("Set WORKER_URL=https://...workers.dev or http://127.0.0.1:8788");
  process.exit(2);
}

const model = process.env.MODEL ?? "gpt-5.5";
const timeoutMs = parseInt(process.env.TIMEOUT_MS ?? "120000", 10);

type TurnResponse = {
  durationMs: number;
  outcome: {
    status: string;
    reason?: {
      threadId?: string;
      turn?: { status?: string; error?: { message?: string } };
    };
    error?: string;
  } | null;
  frameCount: number;
  frames: Array<{ kind: string; msg?: { method?: string } }>;
  stderrTail: string;
  threadId?: string | null;
};

async function runTurn(prompt: string, label: string): Promise<TurnResponse> {
  const startedAt = Date.now();
  const res = await fetch(`${WORKER_URL}/run-turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, model, timeoutMs }),
  });
  const totalMs = Date.now() - startedAt;
  const body = (await res.json()) as TurnResponse;
  const innerStatus = body.outcome?.reason?.turn?.status ?? "(none)";
  const tid = body.threadId ?? body.outcome?.reason?.threadId ?? "(missing)";
  console.error(
    `[smoke-multi] ${label}: HTTP=${res.status} totalMs=${totalMs} ` +
      `bridgeMs=${body.durationMs} outcome=${body.outcome?.status ?? "null"} ` +
      `inner=${innerStatus} frames=${body.frameCount} thread=${tid}`,
  );
  return body;
}

async function reset(): Promise<void> {
  const res = await fetch(`${WORKER_URL}/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  console.error(`[smoke-multi] /reset HTTP=${res.status} body=${await res.text()}`);
}

async function main() {
  // Health check
  const health = await fetch(`${WORKER_URL}/healthz`);
  console.error(`[smoke-multi] /healthz -> ${health.status} ${await health.text()}`);

  // Turn 1: cold init + first user message
  const t1 = await runTurn(
    "Reply with the single word ONE and nothing else.",
    "turn-1 (cold init)",
  );
  // Turn 2: same thread should be reused
  const t2 = await runTurn(
    "Reply with the single word TWO and nothing else.",
    "turn-2 (warm reuse)",
  );
  // Turn 3: still same thread
  const t3 = await runTurn(
    "Reply with the single word THREE and nothing else.",
    "turn-3 (warm reuse)",
  );

  await reset();

  // Turn 4: after reset, new thread expected
  const t4 = await runTurn(
    "Reply with the single word FOUR and nothing else.",
    "turn-4 (post-reset)",
  );

  const summary = {
    worker_url: WORKER_URL,
    model,
    turns: [t1, t2, t3, t4].map((t, i) => ({
      label: `turn-${i + 1}`,
      bridge_ms: t.durationMs,
      bridge_status: t.outcome?.status ?? null,
      inner_status: t.outcome?.reason?.turn?.status ?? null,
      thread_id: t.threadId ?? t.outcome?.reason?.threadId ?? null,
      frame_count: t.frameCount,
      stderr_lines: t.stderrTail.split("\n").length,
    })),
    thread_persistence:
      t1.threadId && t1.threadId === t2.threadId && t2.threadId === t3.threadId
        ? "ok"
        : "broken",
    reset_creates_new_thread:
      t3.threadId && t4.threadId && t3.threadId !== t4.threadId ? "ok" : "broken",
    cold_vs_warm_ms: {
      cold_init: t1.durationMs,
      warm_avg: Math.round((t2.durationMs + t3.durationMs) / 2),
      post_reset: t4.durationMs,
    },
  };

  console.log(JSON.stringify(summary, null, 2));

  const allInnerCompleted = [t1, t2, t3, t4].every(
    (t) => t.outcome?.reason?.turn?.status === "completed",
  );
  const persistenceOk =
    summary.thread_persistence === "ok" &&
    summary.reset_creates_new_thread === "ok";
  if (!allInnerCompleted || !persistenceOk) {
    console.error(
      `[smoke-multi] FAIL: allInnerCompleted=${allInnerCompleted} ` +
        `threadPersistence=${summary.thread_persistence} ` +
        `resetNewThread=${summary.reset_creates_new_thread}`,
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`[smoke-multi] error: ${e}`);
  process.exit(1);
});
