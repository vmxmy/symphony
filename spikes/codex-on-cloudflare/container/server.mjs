// HTTP-to-stdio bridge for codex app-server.
// Runs as PID 1 inside the WorkerHost (Cloudflare Container or VPS Docker).
//
// Endpoints:
//   GET  /healthz   -> 200 once auth is materialized; 503 otherwise.
//                      Codex itself is started lazily on the first /run-turn.
//   POST /run-turn  -> body: { prompt, cwd?, model?, timeoutMs? }
//                       1. lazily spawn `codex app-server` and run
//                          initialize + thread/start once per container life;
//                       2. drive turn/start on the persistent thread;
//                       3. collect JSON-RPC frames belonging to this turn;
//                       4. return { durationMs, outcome, frameCount, frames,
//                                  stderrTail }.
//   POST /reset     -> kill the codex process and drop the thread; the next
//                      /run-turn will re-initialize. Useful for tests that
//                      want a fresh thread without redeploying the container.
//
// Spike v1: spawn-once + persistent thread. The current TS engine binds one
// codex session per issue and keeps it alive across turns; this bridge mirrors
// that lifecycle so multi-turn cost/perf can be measured without re-paying
// codex cold-start each call. Phase 7 will reuse this shape.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
const CODEX_HOME = process.env.CODEX_HOME ?? "/data/codex-home";
const WORKSPACE_ROOT = process.env.WORKSPACE ?? "/data/workspace";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const STDERR_BUFFER_CAP = 65_536;

let authReady = false;

function readSecretEnv(rawName, b64Name) {
  const rawValue = process.env[rawName];
  if (rawValue) return rawValue;

  const encodedValue = process.env[b64Name];
  if (!encodedValue) return "";

  try {
    return Buffer.from(encodedValue, "base64").toString("utf8");
  } catch (e) {
    console.error(`[bridge] failed to decode ${b64Name}: ${e.message}`);
    return "";
  }
}

function materializeAuth() {
  const authJson = readSecretEnv("CODEX_AUTH_JSON", "CODEX_AUTH_JSON_B64");
  if (!authJson) {
    console.error(
      "[bridge] CODEX_AUTH_JSON(_B64) env var not set; codex will likely fail to authenticate",
    );
    return;
  }
  mkdirSync(CODEX_HOME, { recursive: true, mode: 0o700 });
  writeFileSync(`${CODEX_HOME}/auth.json`, authJson, { mode: 0o600 });
  console.error("[bridge] codex auth materialized");

  const configToml = readSecretEnv("CODEX_CONFIG_TOML", "CODEX_CONFIG_TOML_B64");
  if (configToml) {
    writeFileSync(`${CODEX_HOME}/config.toml`, configToml, { mode: 0o600 });
    console.error("[bridge] codex config materialized");
  }
  authReady = true;
}

mkdirSync(WORKSPACE_ROOT, { recursive: true });
materializeAuth();

// ----- codex singleton state ------------------------------------------------

let codexProc = null;
let codexRl = null;
let codexInitialized = false;
let threadId = null;
let initializing = null; // Promise gate so concurrent first-callers don't race

const pending = new Map(); // requestId -> { resolve, reject, timer }
let nextRequestId = 100;
let stderrBuf = "";

// Per-turn capture; only set while a turn is running.
let activeTurnFrames = null;
let activeTurnFinish = null;

// Mutex serializing /run-turn calls.
let turnLock = Promise.resolve();
async function acquireTurnLock() {
  const prev = turnLock;
  let release;
  turnLock = new Promise((r) => {
    release = r;
  });
  await prev;
  return release;
}

function clearCodexState(reason) {
  const err = new Error(reason);
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(err);
  }
  pending.clear();
  if (activeTurnFinish) {
    const finish = activeTurnFinish;
    activeTurnFinish = null;
    finish({ status: "exit_before_completion", error: reason });
  }
  codexProc = null;
  codexRl = null;
  codexInitialized = false;
  threadId = null;
}

function sendRaw(obj) {
  if (!codexProc || !codexProc.stdin || !codexProc.stdin.writable) {
    throw new Error("codex_not_running");
  }
  codexProc.stdin.write(JSON.stringify(obj) + "\n");
}

function sendRequest(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`codex_response_timeout:${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      sendRaw({ id, method, params });
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e);
    }
  });
}

function sendNotification(method, params) {
  sendRaw({ method, params });
}

function onCodexLine(line) {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    if (activeTurnFrames) {
      activeTurnFrames.push({ kind: "non-json", line: line.slice(0, 500) });
    }
    return;
  }
  if (activeTurnFrames) activeTurnFrames.push({ kind: "frame", msg });

  // Response (id + result|error, no method)
  if (
    "id" in msg &&
    ("result" in msg || "error" in msg) &&
    !("method" in msg)
  ) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if ("error" in msg) {
        p.reject(new Error(JSON.stringify(msg.error)));
      } else {
        p.resolve(msg.result ?? {});
      }
    }
    return;
  }

  // Terminal turn notifications resolve the active turn's finisher.
  const method = msg.method;
  if (
    method === "turn/completed" ||
    method === "turn/failed" ||
    method === "turn/cancelled"
  ) {
    const status =
      method === "turn/completed"
        ? "completed"
        : method === "turn/failed"
          ? "failed"
          : "cancelled";
    if (activeTurnFinish) {
      const finish = activeTurnFinish;
      activeTurnFinish = null;
      finish({ status, reason: msg.params ?? null });
    }
  }
}

function spawnCodex() {
  const command = `${CODEX_BIN} app-server`;
  codexProc = spawn("bash", ["-lc", command], {
    cwd: WORKSPACE_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CODEX_HOME },
  });
  codexProc.stderr.on("data", (b) => {
    stderrBuf += b.toString("utf8");
    if (stderrBuf.length > STDERR_BUFFER_CAP) {
      stderrBuf = stderrBuf.slice(-STDERR_BUFFER_CAP);
    }
  });
  codexProc.on("error", (err) => {
    console.error(`[bridge] codex spawn error: ${err.message}`);
    clearCodexState(`codex_spawn_error:${err.message}`);
  });
  codexProc.on("exit", (code, signal) => {
    console.error(`[bridge] codex exit code=${code} signal=${signal}`);
    clearCodexState(`codex_exit:code=${code} signal=${signal}`);
  });
  codexRl = createInterface({ input: codexProc.stdout });
  codexRl.on("line", onCodexLine);
}

async function ensureInitialized() {
  if (codexInitialized && codexProc) return;
  if (initializing) return initializing;

  initializing = (async () => {
    if (codexProc) {
      // Process exists but is not initialized; reset before re-trying.
      try {
        codexProc.kill("SIGKILL");
      } catch {}
      clearCodexState("codex_reinit");
    }
    spawnCodex();
    try {
      await sendRequest("initialize", {
        capabilities: { experimentalApi: true },
        clientInfo: {
          name: "symphony-codex-spike",
          title: "Spike",
          version: "0.0.0",
        },
      });
      sendNotification("initialized", {});
      const threadResult = await sendRequest("thread/start", {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        cwd: WORKSPACE_ROOT,
      });
      const tid = threadResult?.thread?.id;
      if (!tid) throw new Error(`no thread id: ${JSON.stringify(threadResult)}`);
      threadId = tid;
      codexInitialized = true;
      console.error(`[bridge] codex initialized, thread=${threadId}`);
    } catch (e) {
      clearCodexState(`codex_init_failed:${String(e)}`);
      throw e;
    }
  })();

  try {
    await initializing;
  } finally {
    initializing = null;
  }
}

async function resetCodex() {
  if (codexProc) {
    try {
      codexProc.kill("SIGTERM");
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
    try {
      codexProc.kill("SIGKILL");
    } catch {}
  }
  clearCodexState("codex_reset");
}

// ----- HTTP layer -----------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function runTurn(req, res) {
  const release = await acquireTurnLock();
  const started = Date.now();
  try {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `bad_json: ${e.message}` }));
      return;
    }

    const prompt = String(body.prompt ?? "").trim();
    const cwd = String(body.cwd ?? WORKSPACE_ROOT);
    const timeoutMs = Number(body.timeoutMs ?? 120_000);
    if (!prompt) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing prompt" }));
      return;
    }
    mkdirSync(cwd, { recursive: true });

    try {
      await ensureInitialized();
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `codex_init_failed: ${String(e)}` }));
      return;
    }

    const stderrStart = stderrBuf.length;
    activeTurnFrames = [];
    const turnPromise = new Promise((resolve) => {
      activeTurnFinish = resolve;
    });

    let turnStartFailed = null;
    try {
      await sendRequest("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt }],
        cwd,
        title: "spike persistent turn",
        approvalPolicy: "never",
        sandbox_policy: "dangerFullAccess",
      });
    } catch (e) {
      turnStartFailed = String(e);
    }

    let outcome;
    if (turnStartFailed) {
      outcome = { status: "turn_start_failed", error: turnStartFailed };
      // Drain finish state
      if (activeTurnFinish) activeTurnFinish = null;
    } else {
      const timeoutPromise = new Promise((resolve) =>
        setTimeout(() => resolve({ status: "timeout" }), timeoutMs),
      );
      outcome = await Promise.race([turnPromise, timeoutPromise]);
    }

    const frames = activeTurnFrames;
    const stderrSlice = stderrBuf.slice(stderrStart);
    activeTurnFrames = null;
    activeTurnFinish = null;

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        durationMs: Date.now() - started,
        outcome,
        frameCount: frames.length,
        frames,
        stderrTail: stderrSlice.slice(-4_096),
        threadId,
      }),
    );
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e) }));
  } finally {
    release();
  }
}

async function reset(req, res) {
  const release = await acquireTurnLock();
  try {
    await resetCodex();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ reset: true }));
  } finally {
    release();
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/healthz") {
    res.writeHead(authReady ? 200 : 503, { "content-type": "text/plain" });
    res.end(authReady ? "ok" : "no_auth");
    return;
  }
  if (req.method === "POST" && url.pathname === "/run-turn") {
    try {
      await runTurn(req, res);
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/reset") {
    try {
      await reset(req, res);
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  console.error(`[bridge] listening on :${PORT}`);
});

// Graceful shutdown so the codex process gets a SIGTERM before the container dies.
function shutdown(signal) {
  console.error(`[bridge] received ${signal}, shutting down`);
  if (codexProc) {
    try {
      codexProc.kill("SIGTERM");
    } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
