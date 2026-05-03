import type { ApprovalCenterView, TicketDetailView, TicketInboxView } from "./control_center.js";

export async function loadTicketInbox(db: D1Database, tenantId: string, generatedAt: string): Promise<TicketInboxView> {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.key, t.type, t.title, t.priority, t.status,
              t.workflow_key, t.updated_at,
              (SELECT w.current_step_key
                 FROM workflow_instances w
                WHERE w.ticket_id = t.id AND w.completed_at IS NULL
                ORDER BY w.started_at DESC
                LIMIT 1) AS current_step_key,
              (SELECT COUNT(*)
                 FROM approvals a
                WHERE a.ticket_id = t.id AND a.status = 'pending') AS pending_approvals,
              (SELECT s.source_kind
                 FROM ticket_sources s
                WHERE s.ticket_id = t.id
                ORDER BY s.created_at ASC
                LIMIT 1) AS first_source_kind,
              (SELECT COALESCE(s.external_key, s.external_id)
                 FROM ticket_sources s
                WHERE s.ticket_id = t.id
                ORDER BY s.created_at ASC
                LIMIT 1) AS first_source_key
         FROM tickets t
        WHERE t.tenant_id = ? AND t.archived_at IS NULL
        ORDER BY t.updated_at DESC, t.created_at DESC
        LIMIT 100`,
    )
    .bind(tenantId)
    .all<TicketInboxView["tickets"][number]>();

  return { generated_at: generatedAt, tenant_id: tenantId, tickets: results ?? [] };
}

export async function loadTicketDetail(
  db: D1Database,
  tenantId: string,
  ticketId: string,
  generatedAt: string,
): Promise<TicketDetailView | null> {
  const ticket = await db
    .prepare(
      `SELECT id, key, type, title, description, requester, owner, priority,
              status, workflow_key, workflow_version, input_json, tags_json,
              created_at, updated_at
         FROM tickets
        WHERE tenant_id = ? AND id = ? AND archived_at IS NULL`,
    )
    .bind(tenantId, ticketId)
    .first<TicketDetailView["ticket"]>();
  if (!ticket) return null;

  const [sources, comments, workflows, steps, approvals, artifacts, audits] = await Promise.all([
    db
      .prepare(
        `SELECT source_kind, external_id, external_key, external_url, sync_status, updated_at
           FROM ticket_sources
          WHERE tenant_id = ? AND ticket_id = ?
          ORDER BY created_at ASC`,
      )
      .bind(tenantId, ticketId)
      .all<TicketDetailView["sources"][number]>(),
    db
      .prepare(
        `SELECT author_type, author_id, body, visibility, created_at
           FROM ticket_comments
          WHERE tenant_id = ? AND ticket_id = ?
          ORDER BY created_at ASC
          LIMIT 100`,
      )
      .bind(tenantId, ticketId)
      .all<TicketDetailView["comments"][number]>(),
    db
      .prepare(
        `SELECT id, workflow_key, workflow_version, status, current_step_key, started_at, completed_at
           FROM workflow_instances
          WHERE tenant_id = ? AND ticket_id = ?
          ORDER BY started_at DESC
          LIMIT 5`,
      )
      .bind(tenantId, ticketId)
      .all<TicketDetailView["workflows"][number]>(),
    db
      .prepare(
        `SELECT step_key, step_type, status, sequence, summary, retry_count,
                started_at, completed_at, error_message
           FROM workflow_steps
          WHERE tenant_id = ? AND ticket_id = ?
          ORDER BY sequence ASC
          LIMIT 100`,
      )
      .bind(tenantId, ticketId)
      .all<TicketDetailView["steps"][number]>(),
    db
      .prepare(
        `SELECT id, action, status, requested_by, decided_by, request_ref,
                decision_ref, approver_group, created_at, decided_at, expires_at
           FROM approvals
          WHERE tenant_id = ? AND ticket_id = ?
          ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, created_at DESC
          LIMIT 50`,
      )
      .bind(tenantId, ticketId)
      .all<TicketDetailView["approvals"][number]>(),
    db
      .prepare(
        `SELECT kind, r2_key, mime_type, created_by, created_at
           FROM artifacts
          WHERE tenant_id = ? AND ticket_id = ?
          ORDER BY created_at DESC
          LIMIT 50`,
      )
      .bind(tenantId, ticketId)
      .all<TicketDetailView["artifacts"][number]>(),
    db
      .prepare(
        `SELECT actor_type, actor_id, action, severity, summary, payload_ref, created_at
           FROM audit_events
          WHERE tenant_id = ? AND ticket_id = ?
          ORDER BY created_at DESC
          LIMIT 50`,
      )
      .bind(tenantId, ticketId)
      .all<TicketDetailView["audits"][number]>(),
  ]);

  return {
    generated_at: generatedAt,
    tenant_id: tenantId,
    ticket,
    sources: sources.results ?? [],
    comments: comments.results ?? [],
    workflows: workflows.results ?? [],
    steps: steps.results ?? [],
    approvals: approvals.results ?? [],
    artifacts: artifacts.results ?? [],
    audits: audits.results ?? [],
  };
}

export async function loadApprovalCenter(db: D1Database, tenantId: string, generatedAt: string): Promise<ApprovalCenterView> {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.ticket_id, t.key AS ticket_key, t.title AS ticket_title,
              t.status AS ticket_status, a.action, a.status, a.requested_by,
              a.decided_by, a.request_ref, a.decision_ref, a.approver_group,
              a.created_at, a.decided_at, a.expires_at
         FROM approvals a
         LEFT JOIN tickets t ON t.id = a.ticket_id AND t.tenant_id = a.tenant_id
        WHERE a.tenant_id = ? AND a.ticket_id IS NOT NULL
        ORDER BY CASE WHEN a.status = 'pending' THEN 0 ELSE 1 END,
                 a.created_at DESC
        LIMIT 100`,
    )
    .bind(tenantId)
    .all<ApprovalCenterView["approvals"][number]>();

  return { generated_at: generatedAt, tenant_id: tenantId, approvals: results ?? [] };
}
