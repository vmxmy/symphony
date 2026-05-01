// Dynamic tools that Symphony injects into Codex turns.
// Dynamic tool surface for Codex app-server turns.

import type { LinearClient } from "./linear.js";
import type { ToolDefinition, ToolResult, ToolCall } from "./agent/types.js";

export const LINEAR_GRAPHQL_TOOL_NAME = "linear_graphql";

export const linearGraphqlSpec: ToolDefinition = {
  name: LINEAR_GRAPHQL_TOOL_NAME,
  description:
    "Execute a raw GraphQL query or mutation against Linear using Symphony's configured auth.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: {
        type: "string",
        description: "GraphQL query or mutation document to execute against Linear.",
      },
      variables: {
        type: ["object", "null"],
        description: "Optional GraphQL variables object.",
        additionalProperties: true,
      },
    },
  },
};

export function makeLinearGraphqlHandler(client: LinearClient) {
  return async function handle(call: ToolCall): Promise<ToolResult> {
    if (call.name !== LINEAR_GRAPHQL_TOOL_NAME) {
      return {
        success: false,
        output: `Unsupported dynamic tool: ${call.name}`,
      };
    }
    const query = call.arguments.query;
    if (typeof query !== "string" || !query.trim()) {
      return { success: false, output: "linear_graphql: missing or empty 'query' argument" };
    }
    const variables = (call.arguments.variables ?? {}) as Record<string, unknown>;
    try {
      const data = await client.graphql<unknown>(query, variables);
      const text = JSON.stringify({ data }, null, 2);
      return {
        success: true,
        output: text,
        contentItems: [{ type: "inputText", text }],
      };
    } catch (e) {
      const message = (e as Error).message;
      return {
        success: false,
        output: `linear_graphql_error: ${message}`,
        contentItems: [{ type: "inputText", text: message }],
      };
    }
  };
}

export const symphonyDynamicToolSpecs: ToolDefinition[] = [linearGraphqlSpec];
