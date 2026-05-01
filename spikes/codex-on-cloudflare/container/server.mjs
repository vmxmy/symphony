// HTTP-to-stdio bridge for codex app-server.
// Runs as PID 1 inside the Cloudflare Container.
//
// Endpoints:
//   GET  /healthz   -> 200 once the bridge has materialized auth and is ready
//   POST /run-turn  -> body: { prompt, cwd?, model?, timeoutMs? }
//                       1. spawns `codex app-server`
//                       2. drives initialize + thread/start + turn/start
//                       3. collects all JSON-RPC frames until turn settles
//                       4. returns { status, durationMs, frames, stderrTail }
//
// Spike v0: spawn-per-request. Phase 7 will reuse a single codex process
// across turns to mirror the existing engine's session lifecycle.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
const CODEX_HOME = process.env.CODEX_HOME ?? "/data/codex-home";
const WORKSPACE_ROOT = process.env.WORKSPACE ?? "/data/workspace";

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

const INITIALIZE_ID = 1;
const THREAD_START_ID = 2;
const TURN_START_ID = 3;

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
  const started = Date.now();
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `bad_json: ${e.message}` }));
    return;
  }

  const prompt = String(body.prompt ?? "").trim();
  const model = String(body.model ?? "gpt-5.5");
  const cwd = String(body.cwd ?? WORKSPACE_ROOT);
  const timeoutMs = Number(body.timeoutMs ?? 120_000);
  if (!prompt) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "missing prompt" }));
    return;
  }
  mkdirSync(cwd, { recursive: true });

  const command = `${CODEX_BIN} --config model=${model} app-server`;
  const proc = spawn("bash", ["-lc", command], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CODEX_HOME },
  });

  const frames = [];
  let stderrBuf = "";
  let settled = false;
  let outcome = null;

  const finish = (result) => {
    if (settled) return;
    settled = true;
    outcome = result;
    try {
      proc.kill("SIGTERM");
    } catch {}
  };

  proc.stderr.on("data", (b) => {
    stderrBuf += b.toString("utf8");
    if (stderrBuf.length > 16_384) {
      stderrBuf = stderrBuf.slice(-16_384);
    }
  });
  proc.on("error", (err) => finish({ status: "spawn_error", error: err.message }));
  proc.on("exit", (code, signal) => {
    if (!settled) {
      finish({ status: "exit_before_completion", code, signal });
    }
  });

  const rl = createInterface({ input: proc.stdout });
  const pending = new Map();

  function sendRaw(obj) {
    proc.stdin.write(JSON.stringify(obj) + "\n");
  }
  function request(id, method, params) {
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      sendRaw({ id, method, params });
    });
  }

  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      frames.push({ kind: "non-json", line: line.slice(0, 500) });
      return;
    }
    frames.push({ kind: "frame", msg });
    if ("id" in msg && ("result" in msg || "error" in msg) && !("method" in msg)) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if ("error" in msg) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result ?? {});
      }
      return;
    }
    if (msg.method === "turn/completed") {
      finish({ status: "completed", reason: msg.params ?? null });
    } else if (msg.method === "turn/failed") {
      finish({ status: "failed", reason: msg.params ?? null });
    } else if (msg.method === "turn/cancelled") {
      finish({ status: "cancelled", reason: msg.params ?? null });
    }
  });

  const timeoutHandle = setTimeout(() => finish({ status: "timeout" }), timeoutMs);

  try {
    await request(INITIALIZE_ID, "initialize", {
      capabilities: { experimentalApi: true },
      clientInfo: { name: "symphony-codex-spike", title: "Spike", version: "0.0.0" },
    });
    sendRaw({ method: "initialized", params: {} });

    const threadResult = await request(THREAD_START_ID, "thread/start", {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      cwd,
    });
    const threadId = threadResult?.thread?.id;
    if (!threadId) throw new Error(`no thread id: ${JSON.stringify(threadResult)}`);

    await request(TURN_START_ID, "turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
      cwd,
      title: "spike turn",
      approvalPolicy: "never",
      sandbox_policy: "dangerFullAccess",
    });

    // Wait for turn/* terminal notification, or timeout.
    while (!settled) {
      await new Promise((r) => setTimeout(r, 50));
    }
  } catch (e) {
    finish({ status: "driver_error", error: String(e) });
  } finally {
    clearTimeout(timeoutHandle);
    rl.close();
    try { proc.kill("SIGKILL"); } catch {}
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      durationMs: Date.now() - started,
      outcome,
      frameCount: frames.length,
      frames,
      stderrTail: stderrBuf.slice(-4_096),
    }),
  );
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
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  console.error(`[bridge] listening on :${PORT}`);
});
