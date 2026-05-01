// Single source of truth for parsing LinearTrackerConfig out of a profile's
// v2 normalized config. Used by both the Worker debug routes and
// ProjectAgent.poll(); without this helper, the snake/camel fallback chain
// has to be repeated at every consumer.
//
// Returns a discriminated union so the caller can map to the right error
// shape (HTTP status code in the Worker, thrown error in ProjectAgent).

import type { LinearTrackerConfig } from "./types.js";

export type ExtractResult =
  | { ok: true; config: LinearTrackerConfig }
  | { ok: false; code: string; detail?: string };

export function extractLinearTrackerConfig(
  rawConfig: unknown,
  apiKey: string,
): ExtractResult {
  const config = (rawConfig ?? {}) as Record<string, unknown>;
  const tracker = (config.tracker as Record<string, unknown> | undefined) ?? {};

  const projectSlug =
    (tracker.projectSlug as string | undefined) ??
    (tracker.project_slug as string | undefined);
  const activeStates =
    (tracker.activeStates as string[] | undefined) ??
    (tracker.active_states as string[] | undefined);
  const terminalStates =
    (tracker.terminalStates as string[] | undefined) ??
    (tracker.terminal_states as string[] | undefined);

  if (!projectSlug || !activeStates?.length || !terminalStates?.length) {
    return {
      ok: false,
      code: "tracker_config_incomplete",
      detail:
        "config_json.tracker is missing project_slug / active_states / terminal_states",
    };
  }

  return {
    ok: true,
    config: {
      endpoint:
        (tracker.endpoint as string | undefined) ?? "https://api.linear.app/graphql",
      apiKey,
      projectSlug,
      assignee: ((tracker.assignee as string | null | undefined) ?? null) || null,
      activeStates,
      terminalStates,
    },
  };
}
