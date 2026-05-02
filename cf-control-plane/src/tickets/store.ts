import type { Ticket, TicketPriority, TicketSource, TicketSourceResult, TicketStatus } from "./types.js";

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

export type CreateTicketInput = {
  id?: string;
  tenantId: string;
  key: string;
  type: string;
  title: string;
  description?: string | null;
  requester?: string | null;
  owner?: string | null;
  priority?: TicketPriority;
  status?: TicketStatus;
  workflowKey: string;
  workflowVersion?: number | null;
  inputJson?: string | null;
  tagsJson?: string;
};

export type CreateOrGetTicketFromSourceInput = {
  sourceId?: string;
  tenantId: string;
  sourceKind: string;
  externalId?: string | null;
  externalKey?: string | null;
  externalUrl?: string | null;
  now: string;
  ticket: CreateTicketInput;
};

export async function getTicketById(db: D1Database, id: string): Promise<Ticket | null> {
  const row = await db.prepare(`SELECT * FROM tickets WHERE id = ?`).bind(id).first<TicketRow>();
  return row ? ticketFromRow(row) : null;
}

export async function getTicketSourceByExternalId(
  db: D1Database,
  tenantId: string,
  sourceKind: string,
  externalId: string,
): Promise<TicketSource | null> {
  const row = await db
    .prepare(
      `SELECT *
         FROM ticket_sources
        WHERE tenant_id = ? AND source_kind = ? AND external_id = ?`,
    )
    .bind(tenantId, sourceKind, externalId)
    .first<TicketSourceRow>();
  return row ? sourceFromRow(row) : null;
}

export async function createOrGetTicketFromSource(
  db: D1Database,
  input: CreateOrGetTicketFromSourceInput,
): Promise<TicketSourceResult> {
  if (input.externalId) {
    const existingSource = await getTicketSourceByExternalId(db, input.tenantId, input.sourceKind, input.externalId);
    if (existingSource) {
      const source = await updateSourceMetadata(db, existingSource, input, input.now);
      const ticket = await requireTicket(db, source.ticketId);
      return { ticket, source, createdTicket: false, createdSource: false };
    }
  }

  const ticketResult = await createOrGetTicketByKey(db, input.ticket, input.now);
  const source = await createTicketSource(db, {
    id: input.sourceId,
    tenantId: input.tenantId,
    ticketId: ticketResult.ticket.id,
    sourceKind: input.sourceKind,
    externalId: input.externalId ?? null,
    externalKey: input.externalKey ?? null,
    externalUrl: input.externalUrl ?? null,
    now: input.now,
  });

  return {
    ticket: ticketResult.ticket,
    source,
    createdTicket: ticketResult.created,
    createdSource: true,
  };
}

async function createOrGetTicketByKey(
  db: D1Database,
  input: CreateTicketInput,
  now: string,
): Promise<{ ticket: Ticket; created: boolean }> {
  const existing = await db
    .prepare(`SELECT * FROM tickets WHERE tenant_id = ? AND key = ?`)
    .bind(input.tenantId, input.key)
    .first<TicketRow>();
  if (existing) return { ticket: ticketFromRow(existing), created: false };

  const id = input.id ?? crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO tickets (
         id, tenant_id, key, type, title, description, requester, owner,
         priority, status, workflow_key, workflow_version, input_json,
         tags_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.tenantId,
      input.key,
      input.type,
      input.title,
      input.description ?? null,
      input.requester ?? null,
      input.owner ?? null,
      input.priority ?? "normal",
      input.status ?? "CREATED",
      input.workflowKey,
      input.workflowVersion ?? null,
      input.inputJson ?? null,
      input.tagsJson ?? "[]",
      now,
      now,
    )
    .run();

  return { ticket: await requireTicket(db, id), created: true };
}

async function createTicketSource(
  db: D1Database,
  input: {
    id?: string;
    tenantId: string;
    ticketId: string;
    sourceKind: string;
    externalId: string | null;
    externalKey: string | null;
    externalUrl: string | null;
    now: string;
  },
): Promise<TicketSource> {
  const id = input.id ?? crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO ticket_sources (
         id, tenant_id, ticket_id, source_kind, external_id, external_key,
         external_url, sync_status, last_synced_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
    .bind(
      id,
      input.tenantId,
      input.ticketId,
      input.sourceKind,
      input.externalId,
      input.externalKey,
      input.externalUrl,
      input.now,
      input.now,
      input.now,
    )
    .run();
  const row = await db.prepare(`SELECT * FROM ticket_sources WHERE id = ?`).bind(id).first<TicketSourceRow>();
  if (!row) throw new Error(`ticket_source_not_found_after_insert:${id}`);
  return sourceFromRow(row);
}

async function updateSourceMetadata(
  db: D1Database,
  existing: TicketSource,
  input: CreateOrGetTicketFromSourceInput,
  now: string,
): Promise<TicketSource> {
  const externalKey = input.externalKey ?? null;
  const externalUrl = input.externalUrl ?? null;
  const changed = existing.externalKey !== externalKey || existing.externalUrl !== externalUrl || existing.syncStatus !== "active";

  if (changed) {
    await db
      .prepare(
        `UPDATE ticket_sources
            SET external_key = ?, external_url = ?, sync_status = 'active',
                last_synced_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(externalKey, externalUrl, now, now, existing.id)
      .run();
  } else {
    await db
      .prepare(`UPDATE ticket_sources SET last_synced_at = ?, updated_at = ? WHERE id = ?`)
      .bind(now, now, existing.id)
      .run();
  }

  const row = await db.prepare(`SELECT * FROM ticket_sources WHERE id = ?`).bind(existing.id).first<TicketSourceRow>();
  if (!row) throw new Error(`ticket_source_not_found_after_update:${existing.id}`);
  return sourceFromRow(row);
}

async function requireTicket(db: D1Database, id: string): Promise<Ticket> {
  const ticket = await getTicketById(db, id);
  if (!ticket) throw new Error(`ticket_not_found:${id}`);
  return ticket;
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
