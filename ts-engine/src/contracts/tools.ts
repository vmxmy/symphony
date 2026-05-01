// ToolGateway contract.
//
// Mediates dynamic tool calls from a coding agent. Phase 1 backs this with the
// existing `linear_graphql` handler; later phases add policy enforcement,
// audit, approvals, and MCP fan-out under the same surface. See phase1-plan §5.4.

import type { ToolCall, ToolDefinition, ToolResult } from "../agent/types.js";

export interface ToolGateway {
  /** Tool specs exposed to the agent at session start. */
  definitions(): ToolDefinition[];
  /** Dispatch one tool call. Unknown tool names must return a failed result. */
  handle(call: ToolCall): Promise<ToolResult>;
}

export type { ToolCall, ToolDefinition, ToolResult };
