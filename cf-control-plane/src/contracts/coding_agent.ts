// CodingAgentAdapter contract — Phase 7 verbatim port of
// ts-engine/src/agent/types.ts + ts-engine/src/contracts/agent.ts.
//
// Plan: docs/cloudflare-agent-native-phase7-plan.md §3 R1.
//
// Phase 7 ships only the type contract + Mock here (PR-A); the
// CodexCompatAdapter implementation lands in PR-B and execution.ts
// step 8 swaps to factory dispatch in PR-C.

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

export type AgentTokenUsage = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
};

export type TurnHandlers = {
  onActivity?: (info: AgentActivity) => void;
  onTokenUsage?: (usage: AgentTokenUsage) => void;
  onToolCall?: (call: ToolCall) => Promise<ToolResult>;
};

export type AgentActivity = {
  label: string;
  text?: string;
};

export type TurnResult = {
  status: "completed" | "failed" | "cancelled" | "timeout";
  reason?: unknown;
  sessionId?: string | null;
};

export type SessionOptions = {
  cwd: string;
  tools?: ToolDefinition[];
  hints?: Record<string, unknown>;
};

export interface CodingAgentAdapter {
  start(): Promise<void>;
  startSession(opts: SessionOptions): Promise<string>;
  runTurn(prompt: string, title: string, handlers: TurnHandlers): Promise<TurnResult>;
  stop(): Promise<void>;
}

export type CodingAgentFactoryContext = {
  cwd: string;
};

export type CodingAgentFactory = (ctx: CodingAgentFactoryContext) => CodingAgentAdapter;

export type CodingAgentKind = "mock" | "codex_compat";
