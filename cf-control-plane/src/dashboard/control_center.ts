// Server-rendered Agent Control Center pages for generic tickets.
// These views are read-only and display action summaries/metadata only.

export type TicketInboxItemView = {
  id: string;
  key: string;
  type: string;
  title: string;
  priority: string;
  status: string;
  workflow_key: string;
  current_step_key: string | null;
  pending_approvals: number;
  first_source_kind: string | null;
  first_source_key: string | null;
  updated_at: string;
};

export type TicketInboxView = {
  generated_at: string;
  tenant_id: string;
  tickets: TicketInboxItemView[];
};

export type TicketDetailView = {
  generated_at: string;
  tenant_id: string;
  ticket: {
    id: string;
    key: string;
    type: string;
    title: string;
    description: string | null;
    requester: string | null;
    owner: string | null;
    priority: string;
    status: string;
    workflow_key: string;
    workflow_version: number | null;
    input_json: string | null;
    tags_json: string;
    created_at: string;
    updated_at: string;
  };
  sources: Array<{
    source_kind: string;
    external_id: string | null;
    external_key: string | null;
    external_url: string | null;
    sync_status: string;
    updated_at: string;
  }>;
  comments: Array<{
    author_type: string;
    author_id: string | null;
    body: string;
    visibility: string;
    created_at: string;
  }>;
  workflows: Array<{
    id: string;
    workflow_key: string;
    workflow_version: number;
    status: string;
    current_step_key: string | null;
    started_at: string;
    completed_at: string | null;
  }>;
  steps: Array<{
    step_key: string;
    step_type: string;
    status: string;
    sequence: number;
    summary: string | null;
    retry_count: number;
    started_at: string | null;
    completed_at: string | null;
    error_message: string | null;
  }>;
  approvals: Array<{
    id: string;
    action: string;
    status: string;
    requested_by: string | null;
    decided_by: string | null;
    request_ref: string;
    decision_ref: string | null;
    approver_group: string | null;
    created_at: string;
    decided_at: string | null;
    expires_at: string | null;
  }>;
  artifacts: Array<{
    kind: string;
    r2_key: string;
    mime_type: string;
    created_by: string;
    created_at: string;
  }>;
  audits: Array<{
    actor_type: string;
    actor_id: string | null;
    action: string;
    severity: string;
    summary: string;
    payload_ref: string | null;
    created_at: string;
  }>;
};

export type ApprovalCenterView = {
  generated_at: string;
  tenant_id: string;
  approvals: Array<{
    id: string;
    ticket_id: string;
    ticket_key: string | null;
    ticket_title: string | null;
    ticket_status: string | null;
    action: string;
    status: string;
    requested_by: string | null;
    decided_by: string | null;
    request_ref: string;
    decision_ref: string | null;
    approver_group: string | null;
    created_at: string;
    decided_at: string | null;
    expires_at: string | null;
  }>;
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

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function safeExternalHref(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const CONTROL_CENTER_CSS = `
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; max-width: 1180px; margin: 1.5rem auto; padding: 0 1rem; color: #1b1d21; background: #fbfaf7; }
  header { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; border-bottom: 2px solid #1b1d21; padding-bottom: 0.65rem; margin-bottom: 1rem; }
  header h1 { margin: 0; font-size: 1.25rem; letter-spacing: -0.03em; }
  nav { display: flex; gap: 0.75rem; flex-wrap: wrap; }
  a { color: #9f3f14; text-decoration-thickness: 2px; }
  .meta, .muted { color: #707070; }
  .panel { border: 1px solid #ddd7ca; background: #fffefb; border-radius: 10px; padding: 1rem; margin: 1rem 0; box-shadow: 0 1px 0 rgba(0,0,0,0.04); }
  .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.75rem; }
  .kv { display: grid; grid-template-columns: max-content 1fr; gap: 0.35rem 0.75rem; font-size: 0.9rem; }
  .kv dt { font-weight: 700; color: #4c4036; }
  .kv dd { margin: 0; overflow-wrap: anywhere; }
  table { width: 100%; border-collapse: collapse; font-size: 0.86rem; }
  th, td { text-align: left; padding: 0.48rem 0.55rem; border-bottom: 1px solid #ebe6dc; vertical-align: top; }
  th { background: #f2eee6; font-weight: 700; }
  code { background: #f4f1ea; border-radius: 4px; padding: 0.08rem 0.25rem; font-size: 0.9em; }
  pre { background: #151515; color: #f3f0e8; padding: 0.75rem; border-radius: 8px; overflow: auto; }
  .empty { color: #777; font-style: italic; }
  .status-CREATED, .status-TRIAGING, .status-PLANNING { color: #7057ff; font-weight: 700; }
  .status-RUNNING, .status-WAITING_HUMAN, .status-WAITING_EXTERNAL, .status-pending { color: #b86b00; font-weight: 700; }
  .status-COMPLETED, .status-approved, .status-completed { color: #16833a; font-weight: 700; }
  .status-FAILED, .status-CANCELLED, .status-rejected, .status-error { color: #b42318; font-weight: 700; }
  .badge { display: inline-block; border: 1px solid #ddd7ca; border-radius: 999px; padding: 0.12rem 0.45rem; background: #fffaf0; }
  .warn { color: #b42318; }
  footer { margin-top: 2rem; color: #777; font-size: 0.8rem; border-top: 1px solid #e4ded2; padding-top: 0.6rem; }
  @media (max-width: 780px) { header, .grid { display: block; } nav { margin-top: 0.5rem; } }
`;

function page(title: string, tenantId: string, generatedAt: string, body: string): string {
  const tenantParam = encodeURIComponent(tenantId);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escape(title)}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>${CONTROL_CENTER_CSS}</style>
</head>
<body>
  <header>
    <div>
      <h1>${escape(title)}</h1>
      <span class="meta">tenant <code>${escape(tenantId)}</code> · generated <time>${escape(generatedAt)}</time></span>
    </div>
    <nav>
      <a href="/tickets?tenantId=${tenantParam}">Ticket Inbox</a>
      <a href="/approvals?tenantId=${tenantParam}">Approval Center</a>
      <a href="/dashboard">Ops Dashboard</a>
    </nav>
  </header>
  ${body}
  <footer>Agent Control Center renders a safe read-only operator view; approval decisions are handled through the authenticated API.</footer>
</body>
</html>`;
}

export function renderTicketInbox(state: TicketInboxView): string {
  const rows = state.tickets.length
    ? state.tickets
        .map((ticket) => {
          const source = ticket.first_source_kind ? `${ticket.first_source_kind}:${ticket.first_source_key ?? "-"}` : "-";
          const current = ticket.current_step_key ?? "not started";
          return `<tr>
            <td><a href="/tickets/${encodeURIComponent(ticket.id)}?tenantId=${encodeURIComponent(state.tenant_id)}"><code>${escape(ticket.key)}</code></a></td>
            <td>${escape(ticket.title)}</td>
            <td><span class="status-${escape(ticket.status)}">${escape(ticket.status)}</span></td>
            <td>${escape(ticket.priority)}</td>
            <td>${escape(ticket.workflow_key)}</td>
            <td>${escape(current)}</td>
            <td>${ticket.pending_approvals ? `<span class="badge">${escape(ticket.pending_approvals)} pending</span>` : `<span class="muted">none</span>`}</td>
            <td><code>${escape(source)}</code></td>
            <td><time>${escape(ticket.updated_at)}</time></td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="9" class="empty">No canonical tickets for this tenant yet.</td></tr>`;

  return page(
    "Agent Control Center · Ticket Inbox",
    state.tenant_id,
    state.generated_at,
    `<section class="panel">
      <h2>Tickets (${state.tickets.length})</h2>
      <p class="muted">Canonical tickets are the workflow carrier; external issue trackers are shown only as sources.</p>
      <table>
        <thead><tr><th>key</th><th>title</th><th>status</th><th>priority</th><th>workflow</th><th>current step</th><th>approvals</th><th>source</th><th>updated</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`,
  );
}

export function renderTicketDetail(state: TicketDetailView): string {
  const ticket = state.ticket;
  const tags = safeParse<string[]>(ticket.tags_json, []);
  const input = safeParse<unknown>(ticket.input_json, {});
  const currentWorkflow = state.workflows[0];
  return page(
    `Agent Control Center · ${ticket.key}`,
    state.tenant_id,
    state.generated_at,
    `<section class="panel">
      <h2>${escape(ticket.title)}</h2>
      <div class="grid">
        <dl class="kv">
          <dt>Status</dt><dd><span class="status-${escape(ticket.status)}">${escape(ticket.status)}</span></dd>
          <dt>Priority</dt><dd>${escape(ticket.priority)}</dd>
          <dt>Workflow</dt><dd><code>${escape(ticket.workflow_key)}</code>${ticket.workflow_version ? ` v${escape(ticket.workflow_version)}` : ""}</dd>
          <dt>Owner</dt><dd>${escape(ticket.owner ?? "-")}</dd>
        </dl>
        <dl class="kv">
          <dt>Requester</dt><dd>${escape(ticket.requester ?? "-")}</dd>
          <dt>Created</dt><dd><time>${escape(ticket.created_at)}</time></dd>
          <dt>Updated</dt><dd><time>${escape(ticket.updated_at)}</time></dd>
          <dt>Tags</dt><dd>${tags.length ? tags.map((tag) => `<span class="badge">${escape(tag)}</span>`).join(" ") : `<span class="muted">none</span>`}</dd>
        </dl>
        <dl class="kv">
          <dt>Active workflow</dt><dd>${currentWorkflow ? `<code>${escape(currentWorkflow.id)}</code>` : `<span class="muted">not started</span>`}</dd>
          <dt>Current step</dt><dd>${escape(currentWorkflow?.current_step_key ?? "-")}</dd>
          <dt>Sources</dt><dd>${escape(state.sources.length)}</dd>
          <dt>Artifacts</dt><dd>${escape(state.artifacts.length)}</dd>
        </dl>
      </div>
      <h3>Description</h3>
      <p>${ticket.description ? escape(ticket.description) : `<span class="empty">No description.</span>`}</p>
      <h3>Input JSON</h3>
      <pre>${escape(JSON.stringify(input, null, 2))}</pre>
    </section>
    ${sourcesSection(state.sources)}
    ${workflowSection(state.workflows, state.steps)}
    ${approvalsSection(state.approvals, state.tenant_id)}
    ${commentsSection(state.comments)}
    ${artifactsSection(state.artifacts)}
    ${auditsSection(state.audits)}
    `,
  );
}

export function renderApprovalCenter(state: ApprovalCenterView): string {
  const rows = state.approvals.length
    ? state.approvals
        .map((approval) => {
          const ticketLink = approval.ticket_id
            ? `<a href="/tickets/${encodeURIComponent(approval.ticket_id)}?tenantId=${encodeURIComponent(state.tenant_id)}"><code>${escape(approval.ticket_key ?? approval.ticket_id)}</code></a>`
            : `<span class="muted">-</span>`;
          return `<tr>
            <td>${ticketLink}</td>
            <td>${escape(approval.ticket_title ?? "-")}</td>
            <td><code>${escape(approval.action)}</code></td>
            <td><span class="status-${escape(approval.status)}">${escape(approval.status)}</span></td>
            <td>${escape(approval.approver_group ?? "-")}</td>
            <td>${escape(approval.requested_by ?? "-")}</td>
            <td><code>${escape(approval.request_ref)}</code></td>
            <td>${approval.decision_ref ? `<code>${escape(approval.decision_ref)}</code>` : `<span class="muted">-</span>`}</td>
            <td><time>${escape(approval.created_at)}</time></td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="9" class="empty">No ticket approvals yet.</td></tr>`;

  return page(
    "Agent Control Center · Approval Center",
    state.tenant_id,
    state.generated_at,
    `<section class="panel">
      <h2>Approvals (${state.approvals.length})</h2>
      <p class="muted">Approval decisions are first-class workflow events; this MVP page keeps the queue read-only while API actions drive resume/stop behavior.</p>
      <table>
        <thead><tr><th>ticket</th><th>title</th><th>exact effect</th><th>status</th><th>group</th><th>requester</th><th>risk/evidence ref</th><th>decision ref</th><th>requested</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`,
  );
}

function sourcesSection(sources: TicketDetailView["sources"]): string {
  if (sources.length === 0) return `<section class="panel"><h2>Sources</h2><p class="empty">No external sources.</p></section>`;
  const rows = sources
    .map((source) => {
      const href = safeExternalHref(source.external_url);
      return `<tr>
        <td>${escape(source.source_kind)}</td>
        <td>${escape(source.external_key ?? "-")}</td>
        <td>${href ? `<a href="${escape(href)}" rel="noopener" target="_blank">external link</a>` : `<span class="muted">-</span>`}</td>
        <td>${escape(source.sync_status)}</td>
        <td><time>${escape(source.updated_at)}</time></td>
      </tr>`;
    })
    .join("");
  return `<section class="panel"><h2>Sources</h2><table><thead><tr><th>kind</th><th>key</th><th>url</th><th>sync</th><th>updated</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function workflowSection(workflows: TicketDetailView["workflows"], steps: TicketDetailView["steps"]): string {
  const workflow = workflows[0];
  const workflowMeta = workflow
    ? `<dl class="kv"><dt>Status</dt><dd><span class="status-${escape(workflow.status)}">${escape(workflow.status)}</span></dd><dt>Current step</dt><dd>${escape(workflow.current_step_key ?? "-")}</dd><dt>Started</dt><dd><time>${escape(workflow.started_at)}</time></dd></dl>`
    : `<p class="empty">No workflow instance has started yet.</p>`;
  const rows = steps.length
    ? steps
        .map((step) => `<tr>
          <td>${escape(step.sequence)}</td>
          <td><code>${escape(step.step_key)}</code></td>
          <td>${escape(step.step_type)}</td>
          <td><span class="status-${escape(step.status)}">${escape(step.status)}</span></td>
          <td>${escape(step.summary ?? "-")}</td>
          <td>${escape(step.retry_count)}</td>
          <td>${step.error_message ? `<span class="warn">${escape(step.error_message)}</span>` : `<span class="muted">-</span>`}</td>
        </tr>`)
        .join("")
    : `<tr><td colspan="7" class="empty">No workflow steps recorded.</td></tr>`;
  return `<section class="panel"><h2>Workflow Timeline</h2>${workflowMeta}<table><thead><tr><th>#</th><th>step</th><th>type</th><th>status</th><th>safe summary</th><th>retries</th><th>error</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function approvalsSection(approvals: TicketDetailView["approvals"], tenantId: string): string {
  if (approvals.length === 0) return `<section class="panel"><h2>Approvals</h2><p class="empty">No approvals for this ticket.</p></section>`;
  const rows = approvals
    .map((approval) => `<tr>
      <td><code>${escape(approval.action)}</code></td>
      <td><span class="status-${escape(approval.status)}">${escape(approval.status)}</span></td>
      <td>${escape(approval.approver_group ?? "-")}</td>
      <td>${escape(approval.requested_by ?? "-")}</td>
      <td><code>${escape(approval.request_ref)}</code></td>
      <td><time>${escape(approval.created_at)}</time></td>
    </tr>`)
    .join("");
  return `<section class="panel"><h2>Approvals</h2><p><a href="/approvals?tenantId=${encodeURIComponent(tenantId)}">Open Approval Center</a></p><table><thead><tr><th>exact effect</th><th>status</th><th>group</th><th>requester</th><th>risk/evidence ref</th><th>requested</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function commentsSection(comments: TicketDetailView["comments"]): string {
  if (comments.length === 0) return `<section class="panel"><h2>Comments</h2><p class="empty">No comments yet.</p></section>`;
  const rows = comments
    .map((comment) => `<tr><td>${escape(comment.author_type)}</td><td>${escape(comment.author_id ?? "-")}</td><td>${escape(comment.visibility)}</td><td>${escape(comment.body)}</td><td><time>${escape(comment.created_at)}</time></td></tr>`)
    .join("");
  return `<section class="panel"><h2>Comments</h2><table><thead><tr><th>author type</th><th>author</th><th>visibility</th><th>body</th><th>created</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function artifactsSection(artifacts: TicketDetailView["artifacts"]): string {
  if (artifacts.length === 0) return `<section class="panel"><h2>Artifacts</h2><p class="empty">No artifacts yet.</p></section>`;
  const rows = artifacts
    .map((artifact) => `<tr><td>${escape(artifact.kind)}</td><td><code>${escape(artifact.r2_key)}</code></td><td>${escape(artifact.mime_type)}</td><td>${escape(artifact.created_by)}</td><td><time>${escape(artifact.created_at)}</time></td></tr>`)
    .join("");
  return `<section class="panel"><h2>Artifacts</h2><table><thead><tr><th>kind</th><th>metadata/R2 key</th><th>mime</th><th>created by</th><th>created</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function auditsSection(audits: TicketDetailView["audits"]): string {
  if (audits.length === 0) return `<section class="panel"><h2>Audit</h2><p class="empty">No audit events yet.</p></section>`;
  const rows = audits
    .map((audit) => `<tr><td><span class="status-${escape(audit.severity)}">${escape(audit.severity)}</span></td><td>${escape(audit.actor_type)}</td><td><code>${escape(audit.action)}</code></td><td>${escape(audit.summary)}</td><td>${audit.payload_ref ? `<code>${escape(audit.payload_ref)}</code>` : `<span class="muted">-</span>`}</td><td><time>${escape(audit.created_at)}</time></td></tr>`)
    .join("");
  return `<section class="panel"><h2>Audit</h2><table><thead><tr><th>severity</th><th>actor</th><th>action</th><th>safe summary</th><th>payload ref</th><th>created</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}
