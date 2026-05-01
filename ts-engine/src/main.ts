// CLI entry point for the active TypeScript Symphony engine. Accepts:
//   symphony-ts <WORKFLOW.md> [--port N] [--logs-root DIR]
//                             [--i-understand-that-this-will-be-running-without-the-usual-guardrails]
//
// Run via:
//   bun run src/main.ts ../profiles/content-wechat/WORKFLOW.md --port 4002

import { resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { loadWorkflow } from "./workflow.js";
import { Logger } from "./log.js";
import { LinearClient } from "./linear.js";
import { WorkspaceManager } from "./workspace.js";
import { State } from "./state.js";
import { PromptBuilder } from "./prompt.js";
import { Orchestrator } from "./orchestrator.js";
import { startServer } from "./server.js";
import { CodexAdapter } from "./agent/codex_adapter.js";
import type { AgentFactory } from "./agent/types.js";
import { LinearToolGateway } from "./dynamic_tool.js";

type Args = {
  workflowPath: string;
  port: number | null;
  logsRoot: string;
  bypassGuardrails: boolean;
};

function parseArgs(argv: string[]): Args {
  if (argv.length === 0) {
    console.error("Usage: symphony-ts <WORKFLOW.md> [--port N] [--logs-root DIR] [--i-understand-...]");
    process.exit(1);
  }
  const args: Args = {
    workflowPath: "",
    port: null,
    logsRoot: "./log",
    bypassGuardrails: false,
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i] ?? "";
    if (a === "--port") {
      args.port = parseInt(argv[++i] ?? "", 10);
    } else if (a === "--logs-root") {
      args.logsRoot = argv[++i] ?? args.logsRoot;
    } else if (a === "--i-understand-that-this-will-be-running-without-the-usual-guardrails") {
      args.bypassGuardrails = true;
    } else if (!a.startsWith("--")) {
      if (!args.workflowPath) args.workflowPath = a;
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(1);
    }
    i++;
  }
  if (!args.workflowPath) {
    console.error("workflow path is required");
    process.exit(1);
  }
  return args;
}

function expandPath(p: string): string {
  if (p.startsWith("~")) return homedir() + p.slice(1);
  return p;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workflowPath = isAbsolute(args.workflowPath) ? args.workflowPath : resolve(process.cwd(), args.workflowPath);

  // Refuse to start without the explicit ack — Symphony parity
  if (!args.bypassGuardrails) {
    console.error(
      "This Symphony implementation runs Codex without the usual guardrails.\n" +
        "Pass --i-understand-that-this-will-be-running-without-the-usual-guardrails to proceed.",
    );
    process.exit(1);
  }

  const logger = new Logger({ logsRoot: expandPath(args.logsRoot) });
  logger.info(`symphony-ts starting; workflow=${workflowPath}`);

  let loaded;
  try {
    loaded = loadWorkflow(workflowPath);
  } catch (e) {
    logger.error(`workflow load failed: ${(e as Error).message}`);
    process.exit(1);
  }

  const cfg = loaded.config;
  const port = args.port ?? 4001;

  const linear = new LinearClient(cfg.tracker);
  const workspace = new WorkspaceManager(
    { root: cfg.workspace.root, hooks: cfg.hooks },
    logger,
  );
  const state = new State();
  const promptBuilder = new PromptBuilder(loaded.promptTemplate);
  const toolGateway = new LinearToolGateway(linear);

  // For now, every workflow uses Codex. When a second adapter (Claude SDK,
  // HTTP agent, etc.) lands, dispatch on cfg.agent.kind here.
  const agentFactory: AgentFactory = () =>
    new CodexAdapter(
      {
        command: cfg.codex.command,
        approvalPolicy: cfg.codex.approvalPolicy,
        threadSandbox: cfg.codex.threadSandbox,
        turnSandboxPolicy: cfg.codex.turnSandboxPolicy,
        turnTimeoutMs: cfg.codex.turnTimeoutMs,
        readTimeoutMs: cfg.codex.readTimeoutMs,
        stallTimeoutMs: cfg.codex.stallTimeoutMs,
        autoApproveRequests: true,
      },
      logger,
    );

  const orchestrator = new Orchestrator({
    linear,
    workspace,
    state,
    promptBuilder,
    log: logger,
    config: () => cfg,
    agentFactory,
    toolGateway,
  });

  const server = startServer({ port, state, orchestrator, log: logger });
  await orchestrator.start();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`received ${signal}, shutting down`);
    try { await orchestrator.stop(); } catch (e) { logger.error(`orch stop: ${(e as Error).message}`); }
    try { await server.stop(); } catch (e) { logger.error(`server stop: ${(e as Error).message}`); }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  logger.info(`symphony-ts up on :${port}, dashboard http://127.0.0.1:${port}/`);
}

main().catch((e) => {
  console.error("fatal:", (e as Error).stack ?? e);
  process.exit(1);
});
