// Server-rendered HTML dashboard.
//
// Pure function: state -> HTML. No DOM, no client JS, no fetch — operators
// reload the page to refresh. Mirrors the style choice in
// ts-engine/src/dashboard/render.ts: small inline CSS, escaped values,
// table-per-section layout.

export type TenantView = {
  id: string;
  name: string;
  status: string;
  policy?: { maxProjects?: number; maxRunningIssues?: number };
  agent?: { status: string; updatedAt?: string };
  agent_error?: string;
  created_at: string;
  updated_at: string;
};

export type ProfileView = {
  id: string;
  tenant_id: string;
  slug: string;
  active_version: string;
  tracker_kind: string;
  runtime_kind: string;
  status: string;
  source_schema_version: number;
  imported_schema_version: number;
  defaults_applied: string[];
  warnings: string[];
  imported_at?: string | null;
  agent?: { status: string; updatedAt?: string; drainStartedAt?: string };
  agent_error?: string;
};

export type RunView = {
  id: string;
  issue_id: string;
  issue_identifier?: string | null;
  attempt: number;
  status: string;
  adapter_kind: string;
  started_at: string;
  finished_at?: string | null;
  error?: string | null;
  token_usage_json?: string | null;
};

export type RetryView = {
  identifier: string;
  status: "retry_wait" | "failed";
  attempt: number;
  due_at?: string | null;
  last_error?: string | null;
};

export type IssueView = {
  id: string;
  identifier: string;
  title: string | null;
  state: string;
  url: string | null;
  last_seen_at: string;
  profile_slug?: string | null;
};

export type DashboardState = {
  generated_at: string;
  tenants: TenantView[];
  profiles: ProfileView[];
  runs?: RunView[];
  issues?: IssueView[];
  retries?: RetryView[];
};

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escape(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPE_MAP[c] ?? c);
}

function statusCell(d1: string, agent?: { status: string }, error?: string): string {
  if (error) {
    return `<span class="status-${escape(d1)}">${escape(d1)}</span> <span class="warn">(agent unreachable)</span>`;
  }
  if (!agent) return `<span class="status-${escape(d1)}">${escape(d1)}</span>`;
  if (agent.status === d1) return `<span class="status-${escape(d1)}">${escape(d1)}</span>`;
  return `<span class="status-${escape(d1)}">${escape(d1)}</span> <span class="warn">(agent: ${escape(agent.status)})</span>`;
}

function tenantsTable(tenants: TenantView[]): string {
  if (tenants.length === 0) return `<p class="empty">No tenants imported.</p>`;
  const rows = tenants
    .map(
      (t) => `
        <tr>
          <td><code>${escape(t.id)}</code></td>
          <td>${statusCell(t.status, t.agent, t.agent_error)}</td>
          <td>${escape(t.policy?.maxProjects ?? "-")}</td>
          <td>${escape(t.policy?.maxRunningIssues ?? "-")}</td>
          <td><time>${escape(t.updated_at)}</time></td>
        </tr>`,
    )
    .join("");
  return `
    <table>
      <thead>
        <tr><th>id</th><th>status</th><th>maxProjects</th><th>maxRunningIssues</th><th>updated</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function profilesTable(profiles: ProfileView[]): string {
  if (profiles.length === 0) return `<p class="empty">No profiles imported.</p>`;
  const rows = profiles
    .map((p) => {
      const defaults = p.defaults_applied.length
        ? `<details><summary>${p.defaults_applied.length} defaulted</summary>${p.defaults_applied
            .map((d) => `<code>${escape(d)}</code>`)
            .join(", ")}</details>`
        : `<span class="muted">0</span>`;
      const warnings = p.warnings.length
        ? `<details><summary class="warn">${p.warnings.length} warning(s)</summary><ul>${p.warnings
            .map((w) => `<li>${escape(w)}</li>`)
            .join("")}</ul></details>`
        : `<span class="muted">0</span>`;
      return `
        <tr>
          <td><code>${escape(p.id)}</code></td>
          <td>${statusCell(p.status, p.agent, p.agent_error)}</td>
          <td>${escape(p.tracker_kind)}</td>
          <td>${escape(p.runtime_kind)}</td>
          <td>v${escape(p.source_schema_version)} -> v${escape(p.imported_schema_version)}</td>
          <td>${defaults}</td>
          <td>${warnings}</td>
          <td><time>${escape(p.imported_at ?? "-")}</time></td>
        </tr>`;
    })
    .join("");
  return `
    <table>
      <thead>
        <tr>
          <th>id</th><th>status</th><th>tracker</th><th>runtime</th>
          <th>schema</th><th>defaults_applied</th><th>warnings</th><th>imported</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

const DASHBOARD_CSS = `
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; max-width: 1100px; margin: 1.5rem auto; padding: 0 1rem; color: #1a1a1a; }
  header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid #ddd; padding-bottom: 0.5rem; margin-bottom: 1rem; }
  header h1 { margin: 0; font-size: 1.2rem; }
  header .meta { color: #777; font-size: 0.85rem; }
  section { margin: 1.5rem 0; }
  section h2 { font-size: 1rem; border-left: 3px solid #5e6ad2; padding-left: 0.5rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #eee; vertical-align: top; }
  th { background: #f7f7f8; font-weight: 600; }
  code { font-size: 0.9em; }
  details summary { cursor: pointer; }
  details code { display: inline-block; margin: 2px; padding: 1px 4px; background: #f0f0f2; border-radius: 3px; }
  .muted { color: #aaa; }
  .warn { color: #c44; }
  .note { color: #555; line-height: 1.5; }
  .empty { color: #777; font-style: italic; }
  .status-active { color: #279847; font-weight: 600; }
  .status-paused { color: #b27000; font-weight: 600; }
  .status-suspended { color: #b22; font-weight: 600; }
  .status-draining { color: #aa5500; font-weight: 600; }
  .status-archived { color: #888; }
  .status-running { color: #0a7; font-weight: 600; }
  .status-completed { color: #279847; font-weight: 600; }
  .status-failed { color: #b22; font-weight: 600; }
  .status-cancelled { color: #888; }
  .status-retry_wait { color: #b27000; }
  footer { margin-top: 2rem; color: #888; font-size: 0.8rem; border-top: 1px solid #eee; padding-top: 0.5rem; display: flex; justify-content: space-between; }
  footer a { color: #555; }
`;

function formatDueAt(dueAt: string | null | undefined, nowIso: string): string {
  if (!dueAt) return "—";
  const dueMs = new Date(dueAt).getTime();
  const nowMs = new Date(nowIso).getTime();
  if (!Number.isFinite(dueMs) || !Number.isFinite(nowMs)) return "—";
  const deltaMs = dueMs - nowMs;
  if (deltaMs <= 0) return "due now";
  if (deltaMs < 60_000) return `in ${Math.ceil(deltaMs / 1000)}s`;
  if (deltaMs < 3_600_000) return `in ${Math.ceil(deltaMs / 60_000)}m`;
  if (deltaMs < 86_400_000) return `in ${Math.ceil(deltaMs / 3_600_000)}h`;
  return `in ${Math.ceil(deltaMs / 86_400_000)}d`;
}

function runsTable(runs: RunView[]): string {
  if (runs.length === 0) return `<p class="empty">No runs yet. POST /api/v1/projects/&lt;tenant&gt;/&lt;slug&gt;/issues/&lt;identifier&gt;/actions/mock-run to create one.</p>`;
  const rows = runs
    .map((r) => {
      const tu = safeParse<{ totalTokens?: number }>(r.token_usage_json ?? null) ?? {};
      const dur =
        r.finished_at && r.started_at
          ? Math.max(0, new Date(r.finished_at).getTime() - new Date(r.started_at).getTime())
          : null;
      return `
        <tr>
          <td><code>${escape(r.id.slice(0, 8))}…</code></td>
          <td><code>${escape(r.issue_identifier ?? r.issue_id)}</code></td>
          <td>#${escape(r.attempt)}</td>
          <td><span class="status-${escape(r.status)}">${escape(r.status)}</span></td>
          <td>${escape(r.adapter_kind)}</td>
          <td>${dur !== null ? escape(dur) + " ms" : `<span class="muted">-</span>`}</td>
          <td>${tu.totalTokens !== undefined ? escape(tu.totalTokens) : `<span class="muted">-</span>`}</td>
          <td><time>${escape(r.started_at)}</time></td>
        </tr>`;
    })
    .join("");
  return `
    <table>
      <thead>
        <tr><th>id</th><th>issue</th><th>attempt</th><th>status</th><th>adapter</th><th>duration</th><th>tokens</th><th>started</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function retriesTable(retries: RetryView[], generatedAt: string): string {
  const note = `
    <p class="note">
      Operator actions stay on the Bearer-protected API for CLI/curl:
      Retry now: <code>POST /api/v1/issues/:t/:s/:e/actions/retry-now</code> (Bearer);
      Resume failed: <code>POST /api/v1/issues/:t/:s/:e/actions/resume</code> (Bearer).
    </p>`;
  if (retries.length === 0) return `${note}<p class="empty">No retrying or failed issues.</p>`;
  const rows = retries
    .map((r) => {
      const due = r.status === "failed" ? "—" : formatDueAt(r.due_at, generatedAt);
      return `
        <tr>
          <td><code>${escape(r.identifier)}</code></td>
          <td><span class="status-${escape(r.status)}">${escape(r.status)}</span></td>
          <td>#${escape(r.attempt)}</td>
          <td>${escape(due)}</td>
          <td>${r.last_error ? escape(r.last_error) : `<span class="muted">-</span>`}</td>
        </tr>`;
    })
    .join("");
  return `
    ${note}
    <table>
      <thead>
        <tr><th>identifier</th><th>status</th><th>attempt</th><th>due countdown</th><th>last_error</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function issuesTable(issues: IssueView[]): string {
  if (issues.length === 0) {
    return `<p class="empty">No issues mirrored. POST /api/v1/projects/&lt;tenant&gt;/&lt;slug&gt;/actions/refresh to pull tracker state.</p>`;
  }
  const rows = issues
    .map((i) => {
      const titleCell = i.url
        ? `<a href="${escape(i.url)}" target="_blank" rel="noopener">${escape(i.title ?? i.identifier)}</a>`
        : escape(i.title ?? i.identifier);
      const stateClass = i.state.toLowerCase().replace(/\s+/g, "_");
      return `
        <tr>
          <td><code>${escape(i.identifier)}</code></td>
          <td>${titleCell}</td>
          <td><span class="status-${escape(stateClass)}">${escape(i.state)}</span></td>
          <td>${escape(i.profile_slug ?? "-")}</td>
          <td><time>${escape(i.last_seen_at)}</time></td>
        </tr>`;
    })
    .join("");
  return `
    <table>
      <thead>
        <tr><th>identifier</th><th>title</th><th>state</th><th>profile</th><th>last_seen</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function renderDashboard(state: DashboardState): string {
  const runs = state.runs ?? [];
  const issues = state.issues ?? [];
  const retries = state.retries ?? [];
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Symphony Control Plane</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>${DASHBOARD_CSS}</style>
</head>
<body>
  <header>
    <h1>Symphony Control Plane</h1>
    <span class="meta">generated <time>${escape(state.generated_at)}</time></span>
  </header>

  <section>
    <h2>Tenants (${state.tenants.length})</h2>
    ${tenantsTable(state.tenants)}
  </section>

  <section>
    <h2>Profiles (${state.profiles.length})</h2>
    ${profilesTable(state.profiles)}
  </section>

  <section>
    <h2>Issues (${issues.length})</h2>
    ${issuesTable(issues)}
  </section>

  <section>
    <h2>Retries (${retries.length})</h2>
    ${retriesTable(retries, state.generated_at)}
  </section>

  <section>
    <h2>Recent Runs (${runs.length})</h2>
    ${runsTable(runs)}
  </section>

  <footer>
    <span>Dashboard reads D1 only; Durable Object state is touched only by explicit mutation/refresh routes.</span>
    <span><a href="/logout">log out</a></span>
  </footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Per-run detail view (Phase 5 PR-D)
// ---------------------------------------------------------------------------

export type RunDetailStepView = {
  step_sequence: number;
  step_name: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped" | string;
  started_at: string;
  finished_at?: string | null;
  error?: string | null;
};

export type RunDetailEventView = {
  id: string;
  event_type: string;
  severity: string;
  message?: string | null;
  created_at: string;
};

import type { WorkerHostKind } from "../runtime/worker_host.js";

export type RunDetailView = {
  generated_at: string;
  run: {
    id: string;
    issue_id: string;
    issue_identifier?: string | null;
    attempt: number;
    status: string;
    workflow_id?: string | null;
    adapter_kind: string;
    started_at: string;
    finished_at?: string | null;
    error?: string | null;
    token_usage_json?: string | null;
    artifact_manifest_ref?: string | null;
    tenant_id: string;
    slug: string;
    external_id: string;
  };
  steps: RunDetailStepView[];
  events: RunDetailEventView[];
  runtime: { host: WorkerHostKind };
};

function stepDurationMs(s: RunDetailStepView): number | null {
  if (!s.finished_at) return null;
  const startMs = new Date(s.started_at).getTime();
  const finMs = new Date(s.finished_at).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(finMs)) return null;
  return Math.max(0, finMs - startMs);
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function stepGrid(steps: RunDetailStepView[]): string {
  // Always render exactly 16 cells. If a step is missing (failed mid-run),
  // show as 'pending' so operators see the gap.
  const byIndex = new Map<number, RunDetailStepView>();
  for (const s of steps) byIndex.set(s.step_sequence, s);
  const cells: string[] = [];
  for (let i = 1; i <= 16; i++) {
    const s = byIndex.get(i);
    if (!s) {
      cells.push(`
        <li class="step step-pending">
          <span class="seq">${i}</span>
          <span class="name muted">pending</span>
        </li>`);
      continue;
    }
    const dur = formatDuration(stepDurationMs(s));
    const errorAttr = s.error ? ` title="${escape(s.error)}"` : "";
    cells.push(`
      <li class="step step-${escape(s.status)}"${errorAttr}>
        <span class="seq">${i}</span>
        <span class="name"><code>${escape(s.step_name)}</code></span>
        <span class="dur muted">${escape(dur)}</span>
      </li>`);
  }
  return `<ul class="step-grid">${cells.join("")}</ul>`;
}

function eventsTable(events: RunDetailEventView[]): string {
  if (events.length === 0) return `<p class="empty">No events recorded.</p>`;
  const rows = events
    .map((e) => `
      <tr>
        <td><code>${escape(e.id.slice(0, 24))}…</code></td>
        <td><span class="status-${escape(e.severity)}">${escape(e.severity)}</span></td>
        <td><code>${escape(e.event_type)}</code></td>
        <td>${e.message ? escape(e.message) : `<span class="muted">—</span>`}</td>
        <td><time>${escape(e.created_at)}</time></td>
      </tr>`)
    .join("");
  return `
    <table>
      <thead>
        <tr><th>id</th><th>severity</th><th>event</th><th>message</th><th>at</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

const RUN_DETAIL_CSS = `
  ${DASHBOARD_CSS}
  .step-grid { list-style: none; padding: 0; margin: 0.5rem 0; display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.4rem; }
  .step { padding: 0.5rem; border-radius: 4px; border: 1px solid #e0e0e2; background: #fafafa; display: flex; flex-direction: column; gap: 0.15rem; min-height: 3.6rem; }
  .step .seq { font-size: 0.7rem; color: #888; }
  .step .name { font-size: 0.8rem; }
  .step .dur { font-size: 0.7rem; }
  .step-completed { background: #e8f6ec; border-color: #b9e2c5; }
  .step-running { background: #fff7e0; border-color: #f3d27a; }
  .step-failed { background: #fde9e9; border-color: #f1a4a4; }
  .step-skipped { background: #f0f0f2; border-color: #d8d8da; color: #777; }
  .step-pending { background: #fafafa; border-color: #e0e0e2; color: #888; }
  .run-meta { display: grid; grid-template-columns: max-content 1fr; gap: 0.3rem 1rem; font-size: 0.85rem; }
  .run-meta dt { font-weight: 600; color: #555; }
  .run-meta dd { margin: 0; }
`;

export function renderRunDetail(state: RunDetailView): string {
  const tu = safeParse<{ totalTokens?: number; inputTokens?: number; outputTokens?: number }>(
    state.run.token_usage_json ?? null,
  );
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Run ${escape(state.run.issue_identifier ?? state.run.external_id)} attempt ${escape(state.run.attempt)}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>${RUN_DETAIL_CSS}</style>
</head>
<body>
  <header>
    <h1>Run ${escape(state.run.issue_identifier ?? state.run.external_id)} attempt ${escape(state.run.attempt)}</h1>
    <span class="meta">
      <a href="/dashboard">&larr; dashboard</a>
      <span style="margin-left: 0.6rem">generated <time>${escape(state.generated_at)}</time></span>
    </span>
  </header>

  <section>
    <h2>Run</h2>
    <dl class="run-meta">
      <dt>Status</dt>
      <dd><span class="status-${escape(state.run.status)}">${escape(state.run.status)}</span></dd>
      <dt>Adapter</dt>
      <dd><code>${escape(state.run.adapter_kind)}</code></dd>
      <dt>Substrate</dt>
      <dd><code>${escape(state.runtime.host)}</code></dd>
      <dt>Tenant / Profile</dt>
      <dd><code>${escape(state.run.tenant_id)}</code> / <code>${escape(state.run.slug)}</code></dd>
      <dt>Issue</dt>
      <dd><code>${escape(state.run.issue_identifier ?? state.run.external_id)}</code></dd>
      <dt>Workflow</dt>
      <dd>${state.run.workflow_id ? `<code>${escape(state.run.workflow_id)}</code>` : `<span class="muted">—</span>`}</dd>
      <dt>Started</dt>
      <dd><time>${escape(state.run.started_at)}</time></dd>
      <dt>Finished</dt>
      <dd>${state.run.finished_at ? `<time>${escape(state.run.finished_at)}</time>` : `<span class="muted">in flight</span>`}</dd>
      <dt>Tokens</dt>
      <dd>${tu ? `total ${escape(tu.totalTokens ?? 0)} (in ${escape(tu.inputTokens ?? 0)} / out ${escape(tu.outputTokens ?? 0)})` : `<span class="muted">—</span>`}</dd>
      <dt>Manifest</dt>
      <dd>${state.run.artifact_manifest_ref ? `<code>${escape(state.run.artifact_manifest_ref)}</code>` : `<span class="muted">—</span>`}</dd>
      ${state.run.error ? `<dt>Error</dt><dd class="warn"><code>${escape(state.run.error)}</code></dd>` : ""}
    </dl>
  </section>

  <section>
    <h2>Steps</h2>
    ${stepGrid(state.steps)}
  </section>

  <section>
    <h2>Events (${state.events.length})</h2>
    ${eventsTable(state.events)}
  </section>

  <footer>
    <span>Operator actions stay on the Bearer-protected API. Cancel: <code>POST /api/v1/runs/${escape(state.run.tenant_id)}/${escape(state.run.slug)}/${escape(state.run.external_id)}/${escape(state.run.attempt)}/actions/cancel</code> (Bearer + write:run.cancel).</span>
  </footer>
</body>
</html>`;
}
