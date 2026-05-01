// End-to-end smoke for the codex-on-cloudflare spike.
// Hits the deployed Worker /run-turn with a trivial prompt and prints the
// response shape so it can be pasted into REPORT.md.
//
// Usage:
//   WORKER_URL="https://symphony-codex-spike.<sub>.workers.dev" \
//     bun run scripts/smoke.ts
//
// Optional:
//   PROMPT=...           override the default prompt
//   MODEL=gpt-5.5        override the codex model id
//   TIMEOUT_MS=120000    per-turn timeout passed to the bridge

const WORKER_URL = process.env.WORKER_URL;
if (!WORKER_URL) {
  console.error("Set WORKER_URL=https://...workers.dev");
  process.exit(2);
}

const prompt = process.env.PROMPT ?? "Reply with the single word READY and nothing else.";
const model = process.env.MODEL ?? "gpt-5.5";
const timeoutMs = parseInt(process.env.TIMEOUT_MS ?? "120000", 10);

console.error(`[smoke] worker = ${WORKER_URL}`);
console.error(`[smoke] model  = ${model}`);
console.error(`[smoke] prompt = ${prompt}`);

const startedAt = Date.now();

const health = await fetch(`${WORKER_URL}/healthz`).catch((e) => {
  console.error(`[smoke] /healthz fetch failed: ${e}`);
  process.exit(1);
});
console.error(`[smoke] /healthz -> ${health.status} ${await health.text()}`);

const res = await fetch(`${WORKER_URL}/run-turn`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt, model, timeoutMs }),
});
const totalMs = Date.now() - startedAt;
const body = (await res.json()) as {
  durationMs: number;
  outcome: { status: string; reason?: unknown; error?: string } | null;
  frameCount: number;
  frames: Array<{ kind: string; msg?: { method?: string } }>;
  stderrTail: string;
};

console.error(
  `[smoke] HTTP ${res.status} | totalMs=${totalMs} bridgeMs=${body.durationMs} ` +
    `outcome=${body.outcome?.status ?? "null"} frames=${body.frameCount}`,
);

const methodCounts: Record<string, number> = {};
for (const f of body.frames) {
  const m = f.msg?.method ?? (f.kind === "frame" ? "<response>" : f.kind);
  methodCounts[m] = (methodCounts[m] ?? 0) + 1;
}
console.error("[smoke] frame method histogram:");
for (const [m, n] of Object.entries(methodCounts).sort((a, b) => b[1] - a[1])) {
  console.error(`  ${n.toString().padStart(4)}  ${m}`);
}

if (body.stderrTail) {
  console.error("[smoke] container stderr tail:");
  console.error(
    body.stderrTail
      .split("\n")
      .map((l) => "    " + l)
      .join("\n"),
  );
}

// Pretty print a JSON summary that can be pasted into REPORT.md
console.log(
  JSON.stringify(
    {
      worker_url: WORKER_URL,
      model,
      prompt,
      total_ms: totalMs,
      bridge_ms: body.durationMs,
      outcome: body.outcome,
      frame_count: body.frameCount,
      frame_method_histogram: methodCounts,
      stderr_tail: body.stderrTail.split("\n").slice(-20).join("\n"),
    },
    null,
    2,
  ),
);

if (body.outcome?.status !== "completed") {
  process.exit(1);
}
