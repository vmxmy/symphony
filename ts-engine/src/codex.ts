// Codex App Server JSON-RPC client over stdio.
// Mirrors elixir/lib/symphony_elixir/codex/app_server.ex protocol.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import type { Logger } from "./log.js";

const INITIALIZE_ID = 1;
const THREAD_START_ID = 2;
const TURN_START_ID = 3;

export type CodexCommandConfig = {
  command: string; // shell command, e.g., "codex --config model=gpt-5.5 app-server"
  cwd: string;
  approvalPolicy: string | Record<string, unknown>;
  threadSandbox: string;
  turnSandboxPolicy: string | Record<string, unknown>;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
  autoApproveRequests: boolean;
  dynamicTools?: ToolDefinition[];
  env?: Record<string, string>;
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ToolResult = {
  success: boolean;
  output?: string;
  contentItems?: { type: string; text: string }[];
};

export type TurnHandlers = {
  onItem?: (item: Record<string, unknown>) => void;
  onAgentMessageDelta?: (text: string) => void;
  onToolCall?: (call: ToolCall) => Promise<ToolResult>;
  onTokenUsage?: (usage: Record<string, unknown>) => void;
  onAnyNotification?: (method: string, params: Record<string, unknown>) => void;
};

export type TurnResult = {
  status: "completed" | "failed" | "cancelled" | "timeout";
  reason?: unknown;
};

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export class CodexAppServer {
  private proc: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private rl: ReadlineInterface | null = null;
  private pending = new Map<number | string, PendingRequest>();
  private threadId: string | null = null;
  private turnFinishers: Array<(r: TurnResult) => void> = [];
  private currentHandlers: TurnHandlers | null = null;
  private stallTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private cfg: CodexCommandConfig, private log: Logger) {}

  // ---- lifecycle ---------------------------------------------------------

  async start(): Promise<void> {
    this.proc = spawn("bash", ["-lc", this.cfg.command], {
      cwd: this.cfg.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(this.cfg.env ?? {}) },
    }) as ChildProcessByStdio<Writable, Readable, Readable>;

    if (!this.proc.stdout || !this.proc.stdin || !this.proc.stderr) {
      throw new Error("codex_spawn: stdio pipes not available");
    }

    // Readline reads newline-delimited JSON-RPC frames
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

    // initialize handshake
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

  async startThread(): Promise<string> {
    const params: Record<string, unknown> = {
      approvalPolicy: this.cfg.approvalPolicy,
      sandbox: this.cfg.threadSandbox,
      cwd: this.cfg.cwd,
    };
    if (this.cfg.dynamicTools?.length) params.dynamicTools = this.cfg.dynamicTools;
    const result = await this.request(THREAD_START_ID, "thread/start", params);
    const threadObj = (result as { thread?: { id?: string } }).thread;
    if (!threadObj?.id) throw new Error(`thread_start_no_id: ${JSON.stringify(result)}`);
    this.threadId = threadObj.id;
    return this.threadId;
  }

  async runTurn(prompt: string, title: string, handlers: TurnHandlers = {}): Promise<TurnResult> {
    if (!this.threadId) throw new Error("turn_no_thread");
    this.currentHandlers = handlers;
    this.kickStallTimer();

    const turnPromise = new Promise<TurnResult>((resolve) => this.turnFinishers.push(resolve));

    await this.request(TURN_START_ID, "turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: prompt }],
      cwd: this.cfg.cwd,
      title,
      approvalPolicy: this.cfg.approvalPolicy,
      sandboxPolicy: this.cfg.turnSandboxPolicy,
    });

    // Race against turn timeout
    const timeoutPromise = new Promise<TurnResult>((resolve) =>
      setTimeout(() => resolve({ status: "timeout" }), this.cfg.turnTimeoutMs),
    );
    const result = await Promise.race([turnPromise, timeoutPromise]);
    this.clearStallTimer();
    this.currentHandlers = null;
    return result;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearStallTimer();
    if (this.proc) {
      try { this.proc.kill("SIGTERM"); } catch { /* ignore */ }
      // give it 2s, then SIGKILL
      await new Promise((r) => setTimeout(r, 2000));
      try { this.proc.kill("SIGKILL"); } catch { /* ignore */ }
    }
    if (this.rl) this.rl.close();
  }

  // ---- internals ---------------------------------------------------------

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
      }, this.cfg.readTimeoutMs * 6); // generous; some methods are slow
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

    // Response (has id + result/error, no method) -> resolve pending
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

    // Notification or server-side request
    const method = msg.method as string | undefined;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    if (!method) return;

    // diagnostic: surface every method + token-shaped params for debugging
    if (process.env.SYMPHONY_DEBUG_CODEX) {
      this.log.debug(`codex notif: ${method}`);
    }
    if (method.includes("oken") || method.includes("ateLimit") || method.includes("usage")) {
      this.log.info(`codex notif method=${method} params=${JSON.stringify(params).slice(0, 600)}`);
    }

    this.currentHandlers?.onAnyNotification?.(method, params);

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
      case "item/completed":
        this.currentHandlers?.onItem?.(params);
        // capture token usage if present
        if (typeof params.usage === "object" && params.usage) {
          this.currentHandlers?.onTokenUsage?.(params.usage as Record<string, unknown>);
        }
        return;

      case "item/agentMessage/delta":
        if (typeof params.text === "string") {
          this.currentHandlers?.onAgentMessageDelta?.(params.text);
        }
        return;

      case "thread/tokenUsage/updated":
      case "account/rateLimits/updated":
        this.currentHandlers?.onTokenUsage?.(params);
        return;

      // Tool/approval requests have id and expect a result
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
        result = await handler({ id: String(id), name, arguments: args });
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
      // Reject if not auto-approving; per SPEC the agent will get the rejection.
      this.send({ id: msg.id, result: { decision: decisionField === "acceptForSession" ? "denied" : "denied_for_session" } });
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
