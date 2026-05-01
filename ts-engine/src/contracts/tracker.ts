// TrackerAdapter contract.
//
// Lets Orchestrator and AgentRunner operate on normalized issues without
// knowing whether the source is Linear, a Cloudflare-native D1 tracker, or a
// test memory tracker. See docs/cloudflare-agent-native-phase1-plan.md §5.1.

import type { Issue } from "../types.js";

export interface TrackerAdapter {
  fetchActiveIssues(): Promise<Issue[]>;
  fetchTerminalIssues(): Promise<Issue[]>;
  fetchIssuesByIds(ids: string[]): Promise<Issue[]>;
}

/**
 * Optional companion contract for trackers that expose a raw query escape
 * hatch to dynamic tools (e.g. Linear's `linear_graphql`). Implementations
 * that don't support raw queries simply omit `graphql`.
 */
export interface RawTrackerToolAdapter {
  graphql?<T>(
    query: string,
    variables?: Record<string, unknown>,
    operationName?: string,
  ): Promise<T>;
}
