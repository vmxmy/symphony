// HTTP API exposing orchestrator state, mirroring SPEC §15.
// Endpoints:
//   GET  /api/v1/state             — full snapshot
//   GET  /api/v1/<issue-id-or-identifier>  — single issue
//   POST /api/v1/refresh           — trigger immediate poll
//   GET  /                          — minimal HTML dashboard

import type { State } from "./state.js";
import type { Orchestrator } from "./orchestrator.js";
import type { Logger } from "./log.js";

export type ServerHandle = {
  port: number;
  stop: () => Promise<void>;
};

export function startServer(opts: {
  port: number;
  state: State;
  orchestrator: Orchestrator;
  log: Logger;
}): ServerHandle {
  const server = Bun.serve({
    port: opts.port,
    fetch: async (req) => {
      const url = new URL(req.url);
      const pathname = url.pathname;

      if (req.method === "GET" && pathname === "/") {
        return new Response(renderDashboardHtml(opts.state), {
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
    },
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderDashboardHtml(state: State): string {
  const snap = state.snapshot();
  const rows = snap.running
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.issueIdentifier)}</td><td>${escapeHtml(r.state)}</td><td>${r.turnCount}</td><td>${r.tokens.totalTokens.toLocaleString()}</td><td>${escapeHtml(r.lastEvent ?? "")}</td><td>${escapeHtml(r.lastEventAt ?? "")}</td></tr>`,
    )
    .join("");
  const retryRows = snap.retrying
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.issueIdentifier)}</td><td>${r.attempt}</td><td>${escapeHtml(r.dueAt)}</td><td>${escapeHtml((r.error ?? "").slice(0, 80))}</td></tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Symphony TS · status</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 2em; }
  h1 { font-size: 1.4em; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 2em; }
  th, td { border: 1px solid #ddd; padding: 6px 10px; font-size: 13px; text-align: left; }
  th { background: #f5f5f5; }
  .meta { color: #666; font-size: 12px; }
</style>
</head><body>
<h1>Symphony TS</h1>
<p class="meta">Counts: running=${snap.counts.running}, retrying=${snap.counts.retrying}
&nbsp;|&nbsp; tokens total=${snap.codex_totals.total_tokens.toLocaleString()}
&nbsp;|&nbsp; updated ${snap.generated_at}</p>

<h2>Running</h2>
<table>
<tr><th>Issue</th><th>State</th><th>Turns</th><th>Tokens</th><th>Last event</th><th>At</th></tr>
${rows || `<tr><td colspan="6" class="meta">No active agents</td></tr>`}
</table>

<h2>Retrying</h2>
<table>
<tr><th>Issue</th><th>Attempt</th><th>Due</th><th>Error</th></tr>
${retryRows || `<tr><td colspan="4" class="meta">No retries queued</td></tr>`}
</table>

<p class="meta">JSON: <a href="/api/v1/state">/api/v1/state</a> &nbsp;
POST /api/v1/refresh to trigger immediate poll.</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
