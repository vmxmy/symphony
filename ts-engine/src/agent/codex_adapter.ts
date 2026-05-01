// Codex adapter: implements the generic Agent interface on top of
// `codex app-server` JSON-RPC over stdio. Owns all Codex-specific concerns
// (approval policies, sandbox config, multi-shape token usage extraction,
// thread/turn JSON-RPC frames). Mirrors elixir/lib/symphony_elixir/codex/app_server.ex.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import type { Logger } from "../log.js";
import type {
  Agent,
  AgentTokenUsage,
  SessionOptions,
  ToolCall,
  ToolDefinition,
  ToolResult,
  TurnHandlers,
  TurnResult,
} from "./types.js";

const INITIALIZE_ID = 1;
const THREAD_START_ID = 2;
const TURN_START_ID = 3;

export type CodexAdapterConfig = {
  command: string; // shell command, e.g., "codex --config model=gpt-5.5 app-server"
  approvalPolicy: string | Record<string, unknown>;
  threadSandbox: string;
  turnSandboxPolicy: string | Record<string, unknown>;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
  autoApproveRequests: boolean;
  env?: Record<string, string>;
};

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export class CodexAdapter implements Agent {
  private proc: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private rl: ReadlineInterface | null = null;
  private pending = new Map<number | string, PendingRequest>();
  private threadId: string | null = null;
  private turnFinishers: Array<(r: TurnResult) => void> = [];
  private currentHandlers: TurnHandlers | null = null;
  private stallTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private cwd: string | null = null;
  private tools: ToolDefinition[] = [];

  constructor(private cfg: CodexAdapterConfig, private log: Logger) {}

  // ---- Agent interface --------------------------------------------------

  async start(): Promise<void> {
    // cwd is needed to spawn — but Agent.start() takes no args. We defer the
    // actual spawn to startSession() where cwd arrives. Keeping start() as a
    // no-op preserves interface symmetry with HTTP/SDK adapters that may have
    // their own auth/handshake step.
    return;
  }

  async startSession(opts: SessionOptions): Promise<string> {
    this.cwd = opts.cwd;
    this.tools = opts.tools ?? [];
    await this.spawnProcess();
    await this.handshake();
    return this.startThread();
  }

  async runTurn(prompt: string, title: string, handlers: TurnHandlers = {}): Promise<TurnResult> {
    if (!this.threadId) throw new Error("turn_no_thread");
    if (!this.cwd) throw new Error("turn_no_cwd");
    this.currentHandlers = handlers;
    this.kickStallTimer();

    const turnPromise = new Promise<TurnResult>((resolve) => this.turnFinishers.push(resolve));

    await this.request(TURN_START_ID, "turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: prompt }],
      cwd: this.cwd,
      title,
      approvalPolicy: this.cfg.approvalPolicy,
      sandboxPolicy: this.cfg.turnSandboxPolicy,
    });

    const timeoutPromise = new Promise<TurnResult>((resolve) =>
      setTimeout(() => resolve({ status: "timeout" }), this.cfg.turnTimeoutMs),
    );
    const result = await Promise.race([turnPromise, timeoutPromise]);
    this.clearStallTimer();
    this.currentHandlers = null;

    // Surface session id from Codex turn-completion payload so the runner can
    // populate the dashboard. This is the one place we know it for sure.
    const sid = (result.reason as { session_id?: string } | undefined)?.session_id ?? null;
    return { ...result, sessionId: sid };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearStallTimer();
    if (this.proc) {
      try { this.proc.kill("SIGTERM"); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 2000));
      try { this.proc.kill("SIGKILL"); } catch { /* ignore */ }
    }
    if (this.rl) this.rl.close();
  }

  // ---- internals --------------------------------------------------------

  private async spawnProcess(): Promise<void> {
    this.proc = spawn("bash", ["-lc", this.cfg.command], {
      cwd: this.cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(this.cfg.env ?? {}) },
    }) as ChildProcessByStdio<Writable, Readable, Readable>;

    if (!this.proc.stdout || !this.proc.stdin || !this.proc.stderr) {
      throw new Error("codex_spawn: stdio pipes not available");
    }

    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.onLine(line));

    this.proc.stderr.on("data", (chunk: Buffer) => {
      this.log.debug(`codex stderr: ${chunk.toString().slice(0, 500)}`);
    });

    this.proc.on("exit", (code, signal) => {
      this.log.warn(`codex exit code=${code} signal=${signal}`);
      const err = new Error(`codex_exit:${code}`);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      for (const f of this.turnFinishers) f({ status: "failed", reason: err.message });
      this.turnFinishers = [];
      this.stopped = true;
    });
  }

  private async handshake(): Promise<void> {
    await this.request(INITIALIZE_ID, "initialize", {
      capabilities: { experimentalApi: true },
      clientInfo: {
        name: "symphony-ts-orchestrator",
        title: "Symphony TS Orchestrator",
        version: "0.0.1",
      },
    });
    this.notify("initialized", {});
  }

  private async startThread(): Promise<string> {
    const params: Record<string, unknown> = {
      approvalPolicy: this.cfg.approvalPolicy,
      sandbox: this.cfg.threadSandbox,
      cwd: this.cwd,
    };
    if (this.tools.length) params.dynamicTools = this.tools;
    const result = await this.request(THREAD_START_ID, "thread/start", params);
    const threadObj = (result as { thread?: { id?: string } }).thread;
    if (!threadObj?.id) throw new Error(`thread_start_no_id: ${JSON.stringify(result)}`);
    this.threadId = threadObj.id;
    return this.threadId;
  }

  private send(message: Record<string, unknown>): void {
    if (!this.proc?.stdin) throw new Error("codex_not_started");
    const line = JSON.stringify(message) + "\n";
    this.proc.stdin.write(line);
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ method, params });
  }

  private request(id: number | string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex_response_timeout:${method}`));
      }, this.cfg.readTimeoutMs * 6);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log.debug(`codex non-json line: ${line.slice(0, 200)}`);
      return;
    }
    this.kickStallTimer();

    if ("id" in msg && ("result" in msg || "error" in msg) && !("method" in msg)) {
      const id = msg.id as number | string;
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        if ("error" in msg) pending.reject(new Error(`codex_error: ${JSON.stringify(msg.error)}`));
        else pending.resolve((msg.result ?? {}) as Record<string, unknown>);
      }
      return;
    }

    const method = msg.method as string | undefined;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    if (!method) return;

    if (process.env.SYMPHONY_DEBUG_CODEX) {
      this.log.debug(`codex notif: ${method}`);
    }

    switch (method) {
      case "turn/completed":
        this.finishTurn({ status: "completed", reason: params });
        return;
      case "turn/failed":
        this.finishTurn({ status: "failed", reason: params });
        return;
      case "turn/cancelled":
        this.finishTurn({ status: "cancelled", reason: params });
        return;

      case "item/started":
      case "item/completed": {
        this.emitActivity(method, params);
        const usage = (params as { usage?: unknown }).usage;
        if (typeof usage === "object" && usage) {
          this.emitTokenUsage(usage as Record<string, unknown>);
        }
        return;
      }

      case "item/agentMessage/delta":
        if (typeof params.text === "string") {
          this.currentHandlers?.onActivity?.({ label: "message_delta", text: params.text });
        }
        return;

      case "thread/tokenUsage/updated":
      case "account/rateLimits/updated":
        this.emitActivity(method, params);
        this.emitTokenUsage(params);
        return;

      case "item/tool/call":
        this.handleToolCall(msg).catch((e) => this.log.error(`tool_call_error: ${(e as Error).message}`));
        return;

      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        this.respondApproval(msg, "acceptForSession");
        return;

      case "execCommandApproval":
      case "applyPatchApproval":
        this.respondApproval(msg, "approved_for_session");
        return;

      default:
        return;
    }
  }

  /**
   * Defensive token-usage normalizer. Codex emits usage in multiple shapes:
   *   - thread/tokenUsage/updated.tokenUsage.total = {totalTokens, inputTokens, ...}
   *   - older builds: usage.usage.{totalTokens, total_tokens}
   *   - item events sometimes nest as item.usage.{...}
   * Returns null if no recognizable numbers were found.
   */
  private emitTokenUsage(raw: Record<string, unknown>): void {
    const tu = raw.tokenUsage as Record<string, unknown> | undefined;
    const u: Record<string, unknown> =
      (tu?.total as Record<string, unknown>) ??
      (tu as Record<string, unknown>) ??
      (raw.usage as Record<string, unknown>) ??
      (raw.tokens as Record<string, unknown>) ??
      raw;
    const total = num(u.totalTokens) + num(u.total_tokens);
    const inT = num(u.inputTokens) + num(u.input_tokens);
    const outT = num(u.outputTokens) + num(u.output_tokens);
    if (total === 0 && inT === 0 && outT === 0) return;
    const usage: AgentTokenUsage = { totalTokens: total, inputTokens: inT, outputTokens: outT };
    this.currentHandlers?.onTokenUsage?.(usage);
  }

  private emitActivity(method: string, params: Record<string, unknown>): void {
    const text = (params.text ?? params.kind ?? params.type ?? "") as unknown;
    this.currentHandlers?.onActivity?.({
      label: method,
      text: typeof text === "string" && text ? text.slice(0, 240) : undefined,
    });
  }

  private async handleToolCall(msg: Record<string, unknown>): Promise<void> {
    const id = msg.id;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const name = (params.tool ?? params.name) as string;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const handler = this.currentHandlers?.onToolCall;
    let result: ToolResult;
    if (!handler) {
      result = { success: false, output: `unsupported tool: ${name}` };
    } else {
      try {
        const call: ToolCall = { id: String(id), name, arguments: args };
        result = await handler(call);
      } catch (e) {
        result = { success: false, output: `tool_error: ${(e as Error).message}` };
      }
    }
    if (!result.contentItems) {
      result.contentItems = [{ type: "inputText", text: result.output ?? "" }];
    }
    this.send({ id, result });
  }

  private respondApproval(msg: Record<string, unknown>, decisionField: string): void {
    if (!this.cfg.autoApproveRequests) {
      this.send({
        id: msg.id,
        result: { decision: decisionField === "acceptForSession" ? "denied" : "denied_for_session" },
      });
      return;
    }
    this.send({ id: msg.id, result: { decision: decisionField } });
  }

  private finishTurn(r: TurnResult): void {
    const finishers = this.turnFinishers;
    this.turnFinishers = [];
    this.clearStallTimer();
    for (const f of finishers) f(r);
  }

  private kickStallTimer(): void {
    if (this.cfg.stallTimeoutMs <= 0) return;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      if (this.stopped) return;
      this.log.warn(`codex stall timeout (${this.cfg.stallTimeoutMs}ms)`);
      this.finishTurn({ status: "failed", reason: "stalled" });
    }, this.cfg.stallTimeoutMs);
  }

  private clearStallTimer(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
