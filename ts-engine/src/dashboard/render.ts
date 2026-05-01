import type { DashboardViewModel, RetryRow, RunningAgentRow } from "./view_model.js";
import { dashboardStyles } from "./styles.js";

export function renderDashboardHtml(viewModel: DashboardViewModel): string {
  const stateApiPath = escapeHtml(viewModel.stateApiPath);
  const refreshPath = escapeHtml(viewModel.refreshPath);

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Symphony TS · status</title>
<style>${dashboardStyles}</style>
</head><body>
<main>
<header>
<h1>Symphony TS</h1>
<p class="meta">A lightweight operator dashboard for the TypeScript engine.</p>
<div class="summary">
<span class="pill">Running <strong>${viewModel.summary.runningCount}</strong></span>
<span class="pill">Retrying <strong>${viewModel.summary.retryingCount}</strong></span>
<span class="pill">Tokens <strong>${escapeHtml(viewModel.summary.totalTokens)}</strong></span>
<span class="pill">Updated <strong>${escapeHtml(viewModel.summary.generatedAt)}</strong></span>
</div>
</header>

<section aria-labelledby="running-heading">
<h2 id="running-heading">Running</h2>
<table>
<thead><tr><th>Issue</th><th>State</th><th>Turns</th><th>Tokens</th><th>Last event</th><th>At</th></tr></thead>
<tbody>
${viewModel.hasRunning
  ? viewModel.runningRows.map(renderRunningRow).join("")
  : `<tr><td colspan="6" class="empty">No active agents</td></tr>`}
</tbody>
</table>
</section>

<section aria-labelledby="retrying-heading">
<h2 id="retrying-heading">Retrying</h2>
<table>
<thead><tr><th>Issue</th><th>Attempt</th><th>Due</th><th>Error</th></tr></thead>
<tbody>
${viewModel.hasRetries
  ? viewModel.retryRows.map(renderRetryRow).join("")
  : `<tr><td colspan="4" class="empty">No retries queued</td></tr>`}
</tbody>
</table>
</section>

<p class="control-note">JSON: <a href="${stateApiPath}">${stateApiPath}</a> &nbsp; ${viewModel.refreshMethod} <code>${refreshPath}</code> to trigger immediate poll.</p>
</main>
</body></html>`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderRunningRow(row: RunningAgentRow): string {
  const cells = [
    escapeHtml(row.issueIdentifier),
    escapeHtml(row.state),
    String(row.turnCount),
    escapeHtml(row.totalTokens),
    escapeHtml(row.lastEvent),
    escapeHtml(row.lastEventAt),
  ];

  return `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
}

function renderRetryRow(row: RetryRow): string {
  return `<tr><td>${escapeHtml(row.issueIdentifier)}</td><td>${row.attempt}</td><td>${escapeHtml(row.dueAt)}</td><td>${escapeHtml(row.error)}</td></tr>`;
}
