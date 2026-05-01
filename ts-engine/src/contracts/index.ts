// Public engine contract surface.
//
// Phase 1 of the Cloudflare Agent native migration: orchestration depends on
// these interfaces, not on concrete LinearClient / WorkspaceManager / Logger
// classes. See docs/cloudflare-agent-native-phase1-plan.md.

export type { TrackerAdapter, RawTrackerToolAdapter } from "./tracker.js";
export type {
  WorkspaceAdapter,
  WorkspaceRef,
  HookName,
} from "./workspace.js";
export type {
  ToolGateway,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "./tools.js";
export type { EventSink, EventLevel } from "./events.js";
export type {
  CodingAgentAdapter,
  CodingAgentFactory,
  CodingAgentFactoryContext,
} from "./agent.js";

// Re-export domain types so consumers of contracts/* don't need to dig into
// types.js / agent/types.js. Source-of-truth definitions stay where they are.
export type {
  Issue,
  BlockedRef,
  TokenUsage,
  WorkflowConfig,
} from "../types.js";
export type {
  TurnHandlers,
  TurnResult,
  SessionOptions,
  AgentActivity,
  AgentTokenUsage,
} from "../agent/types.js";
