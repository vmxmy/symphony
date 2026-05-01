// Generic Agent interface — what AgentRunner needs from any agent implementation.
//
// Design goals:
//   - Same shape can wrap Codex (stdio JSON-RPC), Claude/Anthropic SDK, OpenAI
//     Assistants, or a remote HTTP agent.
//   - Adapters absorb protocol-specific normalization (token usage shapes,
//     approval flows, threading semantics) so AgentRunner stays adapter-agnostic.
//   - Anything that's truly agent-specific lives in `SessionOptions.hints`
//     (a typed escape hatch) rather than polluting the interface.
//
// NOTE: this is the *contract* layer. Concrete adapters live in
// agent/codex_adapter.ts (production) and agent/mock_adapter.ts (tests).

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

/**
 * Normalized token usage. Adapters convert their native shape into this.
 * (Codex emits usage in 4+ different shapes; CodexAdapter does the parsing.)
 */
export type AgentTokenUsage = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
};

/**
 * Per-turn callbacks. AgentRunner uses these to update the dashboard, dispatch
 * dynamic tool calls, and accumulate token usage. Adapters MAY emit any subset.
 */
export type TurnHandlers = {
  /**
   * Adapter emits whenever it has any sign of life from the agent.
   * Used to refresh dashboard's lastEvent / lastEventAt / lastMessage fields.
   */
  onActivity?: (info: AgentActivity) => void;
  /** Normalized token usage update. Adapter may emit multiple times per turn. */
  onTokenUsage?: (usage: AgentTokenUsage) => void;
  /** Dynamic tool invocation by the agent. Return a result to send back. */
  onToolCall?: (call: ToolCall) => Promise<ToolResult>;
};

export type AgentActivity = {
  /** Stable label, suitable for `lastEvent` field. e.g. "message", "tool_call", "rate_limit". */
  label: string;
  /** Optional preview text, used as `lastMessage`. Adapter trims to a reasonable length. */
  text?: string;
};

export type TurnResult = {
  status: "completed" | "failed" | "cancelled" | "timeout";
  /** Adapter-specific reason payload (kept opaque by AgentRunner). */
  reason?: unknown;
  /**
   * Adapter-provided session/thread identifier surfaced after the first turn.
   * Used by AgentRunner to populate the dashboard's session_id field.
   */
  sessionId?: string | null;
};

export type SessionOptions = {
  /** Working directory the agent should run in. */
  cwd: string;
  /** Tools the orchestrator wants to expose. Adapter decides registration mechanism. */
  tools?: ToolDefinition[];
  /**
   * Adapter-specific hints (e.g. Codex sandbox/approval policies). Adapters
   * pluck the keys they understand and ignore the rest.
   */
  hints?: Record<string, unknown>;
};

/**
 * The Agent contract. Lifecycle is two-stage:
 *   start()        - spawn process / open connection / authenticate
 *   startSession() - begin a conversation; returns the adapter's session id
 *   runTurn()...   - one user input + agent response loop, repeated by AgentRunner
 *   stop()         - tear everything down (idempotent)
 */
export interface Agent {
  start(): Promise<void>;
  startSession(opts: SessionOptions): Promise<string>;
  runTurn(prompt: string, title: string, handlers: TurnHandlers): Promise<TurnResult>;
  stop(): Promise<void>;
}

/**
 * Factory the orchestrator wires up at boot. Each AgentRunner invocation builds
 * a fresh Agent for one issue's session.
 */
export type AgentFactory = (ctx: AgentFactoryContext) => Agent;

export type AgentFactoryContext = {
  /** Workspace directory for this run. */
  cwd: string;
};
