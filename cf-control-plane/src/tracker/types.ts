// TrackerAdapter contract.
//
// The reconciliation harness in src/reconcile/types.ts is parameterized
// by the result of these methods: any tracker source (Linear today,
// native cloudflare tracker tomorrow, in-memory fake in tests) must
// satisfy this interface. Method names match ts-engine/src/contracts/
// tracker.ts so the local engine and the cf-control-plane impl can
// be swapped behind a single contract.

import type { Issue } from "../types.js";

export interface TrackerAdapter {
  fetchActiveIssues(): Promise<Issue[]>;
  fetchTerminalIssues(): Promise<Issue[]>;
  fetchIssuesByIds(ids: string[]): Promise<Issue[]>;
}

/**
 * Optional escape-hatch surface for trackers (currently Linear) that let
 * the gateway-style raw GraphQL tool route raw queries through the same
 * authenticated client. cf-control-plane Phase 8 ToolGatewayAgent will
 * consume this; the reconcile path does not.
 */
export interface RawTrackerToolAdapter {
  graphql?<T>(
    query: string,
    variables?: Record<string, unknown>,
    operationName?: string,
  ): Promise<T>;
}

/**
 * Per-tenant tracker configuration. Mirrors the relevant subset of
 * WorkflowConfig.tracker (see ts-engine/src/types.ts). The Worker reads
 * this from profiles.config_json plus the LINEAR_API_KEY Worker secret.
 */
export type LinearTrackerConfig = {
  endpoint: string;
  apiKey: string;
  projectSlug: string;
  assignee: string | null;
  activeStates: string[];
  terminalStates: string[];
};
