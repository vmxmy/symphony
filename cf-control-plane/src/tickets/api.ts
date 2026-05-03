import { requireCapability, type Principal } from "../auth/operator.js";
import { createOrGetTicketFromSource, getTicketById } from "./store.js";
import type { Ticket, TicketPriority, TicketSource, TicketStatus } from "./types.js";

const TICKET_PRIORITIES = new Set<TicketPriority>(["low", "normal", "high", "urgent"]);
const COMMENT_VISIBILITIES = new Set(["internal", "external_sync"]);

export async function handleTicketApiV2(req: Request, db: D1Database, principal: Principal): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/api/v2/tickets") {
    if (req.method === "POST") return createTicket(req, db, principal);
    if (req.method === "GET") return listTickets(url, db, principal);
    return methodNotAllowed(["GET", "POST"]);
  }

  const ticketRoute = url.pathname.match(/^\/api\/v2\/tickets\/([^/]+)$/);
  if (ticketRoute) {
    if (req.method !== "GET") return methodNotAllowed(["GET"]);
    return getTicketDetail(db, principal, decodeURIComponent(ticketRoute[1]!));
  }

  const commentRoute = url.pathname.match(/^\/api\/v2\/tickets\/([^/]+)\/comments$/);
  if (commentRoute) {
    if (req.method !== "POST") return methodNotAllowed(["POST"]);
    return addTicketComment(req, db, principal, decodeURIComponent(commentRoute[1]!));
  }

  const eventRoute = url.pathname.match(/^\/api\/v2\/tickets\/([^/]+)\/events$/);
  if (eventRoute) {
    if (req.method !== "POST") return methodNotAllowed(["POST"]);
    return addTicketEvent(req, db, principal, decodeURIComponent(eventRoute[1]!));
  }

  return notFound();
}

async function createTicket(req: Request, db: D1Database, principal: Principal): Promise<Response> {
  const denied = requireCapability(principal, "write:ticket");
  if (denied) return denied;

  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;

  const body = parsed.value;
  const tenantId = stringField(body, "tenantId") ?? "default";
  const type = requiredStringField(body, "type");
  const title = requiredStringField(body, "title");
  const workflowKey = requiredStringField(body, "workflowKey");
  if (!type.ok) return type.response;
  if (!title.ok) return title.response;
  if (!workflowKey.ok) return workflowKey.response;

  const priority = optionalPriority(body.priority);
  if (!priority.ok) return priority.response;

  const source = sourceFields(body.source);
  if (!source.ok) return source.response;

  const now = new Date().toISOString();
  const ticketId = crypto.randomUUID();
  const key = `TKT-${ticketId.slice(0, 8).toUpperCase()}`;
  const result = await createOrGetTicketFromSource(db, {
    tenantId,
    sourceKind: source.value.kind,
    externalId: source.value.externalId,
    externalKey: source.value.externalKey,
    externalUrl: source.value.externalUrl,
    now,
    ticket: {
      id: ticketId,
      tenantId,
      key,
      type: type.value,
      title: title.value,
      description: nullableStringField(body, "description"),
      requester: nullableStringField(body, "requester"),
      owner: nullableStringField(body, "owner"),
      priority: priority.value,
      status: "CREATED",
      workflowKey: workflowKey.value,
      workflowVersion: optionalInteger(body.workflowVersion),
      inputJson: JSON.stringify(body.input ?? {}),
      tagsJson: JSON.stringify(arrayField(body.tags)),
    },
  });

  await insertAuditEvent(db, {
    tenantId,
    ticketId: result.ticket.id,
    actorType: "human",
    actorId: principal.subject,
    action: "ticket.created",
    summary: `Ticket ${result.ticket.key} created`,
    createdAt: now,
  });

  return jsonResponse(
    {
      ticketId: result.ticket.id,
      ticketKey: result.ticket.key,
      workflowInstanceId: null,
      status: result.ticket.status,
      created: result.createdTicket,
      source: shapeSource(result.source),
    },
    { status: result.createdTicket ? 201 : 200 },
  );
}

async function listTickets(url: URL, db: D1Database, principal: Principal): Promise<Response> {
  const denied = requireCapability(principal, "read:state");
  if (denied) return denied;

  const filters: string[] = ["archived_at IS NULL"];
  const params: Array<string | number | null> = [];
  const tenantId = url.searchParams.get("tenantId");
  const status = url.searchParams.get("status");
  const workflowKey = url.searchParams.get("workflowKey");
  const limit = boundedLimit(url.searchParams.get("limit"));

  if (tenantId) {
    filters.push("tenant_id = ?");
    params.push(tenantId);
  }
  if (status) {
    filters.push("status = ?");
    params.push(status);
  }
  if (workflowKey) {
    filters.push("workflow_key = ?");
    params.push(workflowKey);
  }

  const { results } = await db
    .prepare(
      `SELECT *
         FROM tickets
        WHERE ${filters.join(" AND ")}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT ?`,
    )
    .bind(...params, limit)
    .all<TicketRow>();

  return jsonResponse({ tickets: (results ?? []).map((row) => shapeTicket(ticketFromRow(row))) });
}

async function getTicketDetail(db: D1Database, principal: Principal, ticketId: string): Promise<Response> {
  const denied = requireCapability(principal, "read:state");
  if (denied) return denied;

  const ticket = await getTicketById(db, ticketId);
  if (!ticket || ticket.archivedAt) return notFound();

  const [sources, comments, activeWorkflow, currentWaitingItem, artifactCount, recentAudits] = await Promise.all([
    listSources(db, ticketId),
    listComments(db, ticketId),
    getActiveWorkflowSummary(db, ticketId),
    getCurrentWaitingItem(db, ticketId),
    countArtifacts(db, ticketId),
    listRecentAudits(db, ticketId),
  ]);

  return jsonResponse({
    ticket: shapeTicket(ticket),
    sources,
    comments,
    activeWorkflow,
    currentWaitingItem,
    artifactCount,
    recentAudits,
  });
}

async function addTicketComment(req: Request, db: D1Database, principal: Principal, ticketId: string): Promise<Response> {
  const denied = requireCapability(principal, "write:ticket");
  if (denied) return denied;

  const ticket = await getTicketById(db, ticketId);
  if (!ticket || ticket.archivedAt) return notFound();

  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;

  const body = parsed.value;
  const bodyText = requiredStringField(body, "body");
  if (!bodyText.ok) return bodyText.response;

  const visibility = stringField(body, "visibility") ?? "internal";
  if (!COMMENT_VISIBILITIES.has(visibility)) {
    return jsonResponse({ error: "invalid_field", field: "visibility" }, { status: 400 });
  }

  const authorType = stringField(body, "authorType") ?? "human";
  if (!["human", "agent", "system"].includes(authorType)) {
    return jsonResponse({ error: "invalid_field", field: "authorType" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const commentId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO ticket_comments (
         id, tenant_id, ticket_id, author_type, author_id, body, visibility, source_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      commentId,
      ticket.tenantId,
      ticket.id,
      authorType,
      nullableStringField(body, "authorId") ?? principal.subject,
      bodyText.value,
      visibility,
      nullableStringField(body, "sourceId"),
      now,
    )
    .run();

  await insertAuditEvent(db, {
    tenantId: ticket.tenantId,
    ticketId: ticket.id,
    actorType: authorType,
    actorId: nullableStringField(body, "authorId") ?? principal.subject,
    action: "ticket.comment.created",
    summary: `Comment added to ${ticket.key}`,
    createdAt: now,
  });

  return jsonResponse({ comment: await requireComment(db, commentId) }, { status: 201 });
}

async function addTicketEvent(req: Request, db: D1Database, principal: Principal, ticketId: string): Promise<Response> {
  const denied = requireCapability(principal, "write:ticket");
  if (denied) return denied;

  const ticket = await getTicketById(db, ticketId);
  if (!ticket || ticket.archivedAt) return notFound();

  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;

  const body = parsed.value;
  const eventType = requiredStringField(body, "type");
  if (!eventType.ok) return eventType.response;

  const now = new Date().toISOString();
  const audit = await insertAuditEvent(db, {
    tenantId: ticket.tenantId,
    ticketId: ticket.id,
    actorType: "connector",
    actorId: stringField(body, "correlationKey") ?? principal.subject,
    action: "ticket.event.received",
    summary: `External event received: ${eventType.value}`,
    payloadRef: JSON.stringify({
      type: eventType.value,
      correlationKey: stringField(body, "correlationKey"),
      payload: body.payload ?? {},
    }),
    createdAt: now,
  });

  return jsonResponse({ event: audit }, { status: 202 });
}

type TicketRow = {
  id: string;
  tenant_id: string;
  key: string;
  type: string;
  title: string;
  description: string | null;
  requester: string | null;
  owner: string | null;
  priority: TicketPriority;
  status: TicketStatus;
  workflow_key: string;
  workflow_version: number | null;
  input_json: string | null;
  tags_json: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type TicketSourceRow = {
  id: string;
  tenant_id: string;
  ticket_id: string;
  source_kind: string;
  external_id: string | null;
  external_key: string | null;
  external_url: string | null;
  sync_status: string;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

type TicketCommentRow = {
  id: string;
  tenant_id: string;
  ticket_id: string;
  author_type: string;
  author_id: string | null;
  body: string;
  visibility: string;
  source_id: string | null;
  created_at: string;
};

type WorkflowInstanceRow = {
  id: string;
  workflow_key: string;
  workflow_version: number;
  status: string;
  current_step_key: string | null;
  started_at: string;
  completed_at: string | null;
};

type ApprovalRow = {
  id: string;
  action: string;
  status: string;
  approver_group: string | null;
  created_at: string;
  expires_at: string | null;
};

type AuditEventRow = {
  id: string;
  tenant_id: string;
  ticket_id: string | null;
  workflow_instance_id: string | null;
  workflow_step_id: string | null;
  actor_type: string;
  actor_id: string | null;
  action: string;
  severity: string;
  summary: string;
  payload_ref: string | null;
  created_at: string;
};

type AuditInsert = {
  tenantId: string;
  ticketId: string;
  actorType: string;
  actorId: string | null;
  action: string;
  summary: string;
  createdAt: string;
  payloadRef?: string | null;
  severity?: string;
};

async function listSources(db: D1Database, ticketId: string) {
  const { results } = await db
    .prepare(`SELECT * FROM ticket_sources WHERE ticket_id = ? ORDER BY created_at ASC`)
    .bind(ticketId)
    .all<TicketSourceRow>();
  return (results ?? []).map((row) => shapeSource(sourceFromRow(row)));
}

async function listComments(db: D1Database, ticketId: string) {
  const { results } = await db
    .prepare(`SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at ASC LIMIT 100`)
    .bind(ticketId)
    .all<TicketCommentRow>();
  return (results ?? []).map(shapeComment);
}

async function requireComment(db: D1Database, commentId: string) {
  const row = await db.prepare(`SELECT * FROM ticket_comments WHERE id = ?`).bind(commentId).first<TicketCommentRow>();
  if (!row) throw new Error(`ticket_comment_not_found_after_insert:${commentId}`);
  return shapeComment(row);
}

async function getActiveWorkflowSummary(db: D1Database, ticketId: string) {
  const row = await db
    .prepare(
      `SELECT id, workflow_key, workflow_version, status, current_step_key, started_at, completed_at
         FROM workflow_instances
        WHERE ticket_id = ? AND completed_at IS NULL
        ORDER BY started_at DESC
        LIMIT 1`,
    )
    .bind(ticketId)
    .first<WorkflowInstanceRow>();
  if (!row) return null;
  return {
    id: row.id,
    workflowKey: row.workflow_key,
    workflowVersion: row.workflow_version,
    status: row.status,
    currentStepKey: row.current_step_key,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

async function getCurrentWaitingItem(db: D1Database, ticketId: string) {
  const row = await db
    .prepare(
      `SELECT id, action, status, approver_group, created_at, expires_at
         FROM approvals
        WHERE ticket_id = ? AND status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1`,
    )
    .bind(ticketId)
    .first<ApprovalRow>();
  if (!row) return null;
  return {
    kind: "approval",
    id: row.id,
    action: row.action,
    status: row.status,
    approverGroup: row.approver_group,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

async function countArtifacts(db: D1Database, ticketId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS count FROM artifacts WHERE ticket_id = ?`)
    .bind(ticketId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function listRecentAudits(db: D1Database, ticketId: string) {
  const { results } = await db
    .prepare(
      `SELECT *
         FROM audit_events
        WHERE ticket_id = ?
        ORDER BY created_at DESC
        LIMIT 20`,
    )
    .bind(ticketId)
    .all<AuditEventRow>();
  return (results ?? []).map(shapeAuditEvent);
}

async function insertAuditEvent(db: D1Database, input: AuditInsert) {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO audit_events (
         id, tenant_id, ticket_id, workflow_instance_id, workflow_step_id,
         actor_type, actor_id, action, severity, summary, payload_ref, created_at
       ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.tenantId,
      input.ticketId,
      input.actorType,
      input.actorId,
      input.action,
      input.severity ?? "info",
      input.summary,
      input.payloadRef ?? null,
      input.createdAt,
    )
    .run();
  const row = await db.prepare(`SELECT * FROM audit_events WHERE id = ?`).bind(id).first<AuditEventRow>();
  if (!row) throw new Error(`audit_event_not_found_after_insert:${id}`);
  return shapeAuditEvent(row);
}

function ticketFromRow(row: TicketRow): Ticket {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    key: row.key,
    type: row.type,
    title: row.title,
    description: row.description,
    requester: row.requester,
    owner: row.owner,
    priority: row.priority,
    status: row.status,
    workflowKey: row.workflow_key,
    workflowVersion: row.workflow_version,
    inputJson: row.input_json,
    tagsJson: row.tags_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function sourceFromRow(row: TicketSourceRow): TicketSource {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ticketId: row.ticket_id,
    sourceKind: row.source_kind,
    externalId: row.external_id,
    externalKey: row.external_key,
    externalUrl: row.external_url,
    syncStatus: row.sync_status,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function shapeTicket(ticket: Ticket) {
  return {
    id: ticket.id,
    tenantId: ticket.tenantId,
    key: ticket.key,
    type: ticket.type,
    title: ticket.title,
    description: ticket.description,
    requester: ticket.requester,
    owner: ticket.owner,
    priority: ticket.priority,
    status: ticket.status,
    workflowKey: ticket.workflowKey,
    workflowVersion: ticket.workflowVersion,
    input: parseJson(ticket.inputJson, {}),
    tags: parseJson(ticket.tagsJson, []),
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

function shapeSource(source: TicketSource) {
  return {
    id: source.id,
    tenantId: source.tenantId,
    ticketId: source.ticketId,
    sourceKind: source.sourceKind,
    externalId: source.externalId,
    externalKey: source.externalKey,
    externalUrl: source.externalUrl,
    syncStatus: source.syncStatus,
    lastSyncedAt: source.lastSyncedAt,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

function shapeComment(row: TicketCommentRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ticketId: row.ticket_id,
    authorType: row.author_type,
    authorId: row.author_id,
    body: row.body,
    visibility: row.visibility,
    sourceId: row.source_id,
    createdAt: row.created_at,
  };
}

function shapeAuditEvent(row: AuditEventRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ticketId: row.ticket_id,
    workflowInstanceId: row.workflow_instance_id,
    workflowStepId: row.workflow_step_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    severity: row.severity,
    summary: row.summary,
    payloadRef: row.payload_ref,
    createdAt: row.created_at,
  };
}

async function readJsonObject(req: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  try {
    const value = await req.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, response: jsonResponse({ error: "bad_json", reason: "expected object" }, { status: 400 }) };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, response: jsonResponse({ error: "bad_json" }, { status: 400 }) };
  }
}

function requiredStringField(body: Record<string, unknown>, field: string): { ok: true; value: string } | { ok: false; response: Response } {
  const value = stringField(body, field);
  if (value) return { ok: true, value };
  return { ok: false, response: jsonResponse({ error: "missing_field", field }, { status: 400 }) };
}

function stringField(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableStringField(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : null;
}

function optionalPriority(value: unknown): { ok: true; value: TicketPriority } | { ok: false; response: Response } {
  if (value === undefined || value === null) return { ok: true, value: "normal" };
  if (typeof value === "string" && TICKET_PRIORITIES.has(value as TicketPriority)) {
    return { ok: true, value: value as TicketPriority };
  }
  return { ok: false, response: jsonResponse({ error: "invalid_field", field: "priority" }, { status: 400 }) };
}

function optionalInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function sourceFields(value: unknown):
  | { ok: true; value: { kind: string; externalId: string | null; externalKey: string | null; externalUrl: string | null } }
  | { ok: false; response: Response } {
  if (value === undefined || value === null) {
    return { ok: true, value: { kind: "api", externalId: null, externalKey: null, externalUrl: null } };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, response: jsonResponse({ error: "invalid_field", field: "source" }, { status: 400 }) };
  }
  const source = value as Record<string, unknown>;
  const kind = stringField(source, "kind") ?? "api";
  return {
    ok: true,
    value: {
      kind,
      externalId: nullableStringField(source, "externalId"),
      externalKey: nullableStringField(source, "externalKey"),
      externalUrl: nullableStringField(source, "externalUrl"),
    },
  };
}

function arrayField(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function boundedLimit(raw: string | null): number {
  const parsed = Number(raw ?? "50");
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(Math.max(Math.trunc(parsed), 1), 200);
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

function notFound(): Response {
  return jsonResponse({ error: "not_found" }, { status: 404 });
}

function methodNotAllowed(allowed: string[]): Response {
  return jsonResponse(
    { error: "method_not_allowed", allowed },
    { status: 405, headers: { allow: allowed.join(", ") } },
  );
}
