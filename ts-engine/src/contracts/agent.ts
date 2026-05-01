// CodingAgentAdapter contract.
//
// Aliases the existing generic `Agent` contract to the target architecture's
// vocabulary without churning callers. The shape is unchanged from
// agent/types.ts; future native Cloudflare adapters implement the same
// interface as CodexAdapter and MockAgent. See phase1-plan §5.3.

import type {
  Agent,
  AgentFactory,
  AgentFactoryContext,
} from "../agent/types.js";

export type CodingAgentAdapter = Agent;
export type CodingAgentFactory = AgentFactory;
export type CodingAgentFactoryContext = AgentFactoryContext;
