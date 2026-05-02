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
      Operator actions stay on the Bearer-protected API:
      Retry now <code>POST /api/v1/issues/:t/:s/:e/actions/retry-now</code> (Bearer);
      Resume failed <code>POST /api/v1/issues/:t/:s/:e/actions/resume</code> (Bearer).
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
        <tr><th>identifier</th><th>status</th><th>attempt</th><th>due</th><th>last_error</th></tr>
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
