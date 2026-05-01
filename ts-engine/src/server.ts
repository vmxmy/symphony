// HTTP API exposing orchestrator state, mirroring SPEC §15.
// Endpoints:
//   GET  /api/v1/state             — full snapshot
//   GET  /api/v1/<issue-id-or-identifier>  — single issue
//   POST /api/v1/refresh           — trigger immediate poll
//   GET  /                          — minimal HTML dashboard

import type { State } from "./state.js";
import type { Orchestrator } from "./orchestrator.js";
import type { Logger } from "./log.js";
import { renderDashboardHtml } from "./dashboard/render.js";
import { dashboardViewModelFromSnapshot } from "./dashboard/view_model.js";

export type ServerHandle = {
  port: number;
  stop: () => Promise<void>;
};

export type ServerDependencies = {
  state: State;
  orchestrator: Pick<Orchestrator, "refresh">;
};

export type ServerOptions = ServerDependencies & {
  port: number;
  log: Logger;
};

export function startServer(opts: ServerOptions): ServerHandle {
  const server = Bun.serve({
    port: opts.port,
    fetch: createServerFetchHandler(opts),
  });
  const boundPort = server.port ?? opts.port;
  opts.log.info(`server listening on :${boundPort}`);
  return {
    port: boundPort,
    stop: async () => {
      server.stop();
      opts.log.info("server stopped");
    },
  };
}

export function createServerFetchHandler(opts: ServerDependencies): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/") {
      const viewModel = dashboardViewModelFromSnapshot(opts.state.snapshot());
      return new Response(renderDashboardHtml(viewModel), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (req.method === "GET" && pathname === "/api/v1/state") {
      return jsonResponse(opts.state.snapshot());
    }
    if (req.method === "POST" && pathname === "/api/v1/refresh") {
      opts.orchestrator.refresh();
      return jsonResponse(
        {
          coalesced: false,
          operations: ["poll", "reconcile"],
          queued: true,
          requested_at: new Date().toISOString(),
        },
        202,
      );
    }
    const detailMatch = pathname.match(/^\/api\/v1\/([^/]+)$/);
    if (req.method === "GET" && detailMatch) {
      const key = decodeURIComponent(detailMatch[1] ?? "");
      const session =
        [...opts.state.running.values()].find(
          (s) => s.issueId === key || s.issueIdentifier === key,
        ) ?? null;
      const retry =
        [...opts.state.retrying.values()].find(
          (r) => r.issueId === key || r.issueIdentifier === key,
        ) ?? null;
      if (!session && !retry) {
        return jsonResponse({ error: "not_found", key }, 404);
      }
      return jsonResponse({
        status: session ? "running" : "retrying",
        running: session,
        retry,
        issue_id: session?.issueId ?? retry?.issueId,
        issue_identifier: session?.issueIdentifier ?? retry?.issueIdentifier,
        workspace: session
          ? { path: session.workspacePath, host: session.workerHost }
          : null,
      });
    }
    return new Response("not_found", { status: 404 });
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
