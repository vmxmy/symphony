import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { asD1, createMigratedDatabase } from "./support/sqlite_d1.js";
import { createOrGetTicketFromSource, getTicketById, getTicketSourceByExternalId, type CreateTicketInput } from "../src/tickets/store.js";

function baseTicket(overrides: Partial<CreateTicketInput> = {}) {
  return {
    tenantId: "tenant_1",
    key: "TKT-1",
    type: "vendor_review",
    title: "Review ACME",
    workflowKey: "vendor-due-diligence",
    inputJson: JSON.stringify({ vendor: "ACME" }),
    ...overrides,
  };
}

function tableCount(db: Database, table: string): number {
  const row = db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function staleFirstSourceLookup(db: D1Database): D1Database {
  let shouldMiss = true;

  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      const isSourceLookup =
        sql.includes("FROM ticket_sources") &&
        sql.includes("WHERE tenant_id = ? AND source_kind = ? AND external_id = ?");

      return {
        bind(...params: (string | number | null)[]) {
          const bound = statement.bind(...params);

          return {
            async first<T = unknown>() {
              if (isSourceLookup && shouldMiss) {
                shouldMiss = false;
                return null as T | null;
              }

              return await bound.first<T>();
            },
            all: bound.all.bind(bound),
            run: bound.run.bind(bound),
          };
        },
        first: statement.first.bind(statement),
        all: statement.all.bind(statement),
        run: statement.run.bind(statement),
      };
    },
  } as unknown as D1Database;
}

function interleaveAfterSourceInsert(
  db: D1Database,
  interleavedInput: Parameters<typeof createOrGetTicketFromSource>[1],
  onInterleaved: (result: Awaited<ReturnType<typeof createOrGetTicketFromSource>>) => void,
): D1Database {
  let shouldInterleave = true;

  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      const isSourceInsert = sql.includes("INSERT OR IGNORE INTO ticket_sources");

      return {
        bind(...params: (string | number | null)[]) {
          const bound = statement.bind(...params);

          return {
            first: bound.first.bind(bound),
            all: bound.all.bind(bound),
            async run() {
              const result = await bound.run();

              if (isSourceInsert && shouldInterleave) {
                shouldInterleave = false;
                onInterleaved(await createOrGetTicketFromSource(db, interleavedInput));
              }

              return result;
            },
          };
        },
        first: statement.first.bind(statement),
        all: statement.all.bind(statement),
        run: statement.run.bind(statement),
      };
    },
  } as unknown as D1Database;
}

describe("ticket store source idempotency", () => {
  test("same external source maps to the same canonical ticket and source", async () => {
    const db = asD1(createMigratedDatabase());

    const first = await createOrGetTicketFromSource(db, {
      tenantId: "tenant_1",
      sourceKind: "linear",
      externalId: "lin_issue_1",
      externalKey: "SYM-1",
      externalUrl: "https://linear.example/SYM-1",
      now: "2026-05-02T00:00:00Z",
      ticket: baseTicket({ id: "ticket_1" }),
    });
    const second = await createOrGetTicketFromSource(db, {
      tenantId: "tenant_1",
      sourceKind: "linear",
      externalId: "lin_issue_1",
      externalKey: "SYM-1",
      externalUrl: "https://linear.example/SYM-1",
      now: "2026-05-02T00:01:00Z",
      ticket: baseTicket({ id: "ticket_should_not_be_used", key: "TKT-duplicate" }),
    });

    expect(first.createdTicket).toBe(true);
    expect(first.createdSource).toBe(true);
    expect(second.createdTicket).toBe(false);
    expect(second.createdSource).toBe(false);
    expect(second.ticket.id).toBe(first.ticket.id);
    expect(second.source.id).toBe(first.source.id);
  });

  test("stable external_id survives external key rename", async () => {
    const db = asD1(createMigratedDatabase());

    const first = await createOrGetTicketFromSource(db, {
      tenantId: "tenant_1",
      sourceKind: "linear",
      externalId: "lin_issue_2",
      externalKey: "OLD-2",
      externalUrl: "https://linear.example/OLD-2",
      now: "2026-05-02T00:00:00Z",
      ticket: baseTicket({ id: "ticket_2", key: "TKT-2" }),
    });
    const renamed = await createOrGetTicketFromSource(db, {
      tenantId: "tenant_1",
      sourceKind: "linear",
      externalId: "lin_issue_2",
      externalKey: "NEW-2",
      externalUrl: "https://linear.example/NEW-2",
      now: "2026-05-02T00:02:00Z",
      ticket: baseTicket({ id: "ticket_2_duplicate", key: "TKT-2-renamed" }),
    });

    expect(renamed.ticket.id).toBe(first.ticket.id);
    expect(renamed.source.id).toBe(first.source.id);
    expect(renamed.source.externalKey).toBe("NEW-2");
    expect(renamed.source.externalUrl).toBe("https://linear.example/NEW-2");
    expect(renamed.source.updatedAt).toBe("2026-05-02T00:02:00Z");
  });

  test("missing external_id does not create false idempotency collision", async () => {
    const db = asD1(createMigratedDatabase());

    const first = await createOrGetTicketFromSource(db, {
      tenantId: "tenant_1",
      sourceKind: "api",
      externalKey: "manual-a",
      now: "2026-05-02T00:00:00Z",
      ticket: baseTicket({ id: "ticket_manual_a", key: "MANUAL-A" }),
    });
    const second = await createOrGetTicketFromSource(db, {
      tenantId: "tenant_1",
      sourceKind: "api",
      externalKey: "manual-b",
      now: "2026-05-02T00:01:00Z",
      ticket: baseTicket({ id: "ticket_manual_b", key: "MANUAL-B" }),
    });

    expect(first.ticket.id).toBe("ticket_manual_a");
    expect(second.ticket.id).toBe("ticket_manual_b");
    expect(first.source.externalId).toBeNull();
    expect(second.source.externalId).toBeNull();
  });

  test("empty external_id normalizes to null and does not collide", async () => {
    const db = asD1(createMigratedDatabase());

    const first = await createOrGetTicketFromSource(db, {
      tenantId: "tenant_1",
      sourceKind: "api",
      externalId: "",
      externalKey: "manual-empty-a",
      now: "2026-05-02T00:00:00Z",
      ticket: baseTicket({ id: "ticket_empty_a", key: "EMPTY-A" }),
    });
    const second = await createOrGetTicketFromSource(db, {
      tenantId: "tenant_1",
      sourceKind: "api",
      externalId: "   ",
      externalKey: "manual-empty-b",
      now: "2026-05-02T00:01:00Z",
      ticket: baseTicket({ id: "ticket_empty_b", key: "EMPTY-B" }),
    });

    expect(first.ticket.id).toBe("ticket_empty_a");
    expect(second.ticket.id).toBe("ticket_empty_b");
    expect(first.source.externalId).toBeNull();
    expect(second.source.externalId).toBeNull();
  });

  test("rejects tenant mismatch before writing ticket or source rows", async () => {
    const sqlite = createMigratedDatabase();
    const db = asD1(sqlite);

    await expect(
      createOrGetTicketFromSource(db, {
        tenantId: "tenant_source",
        sourceKind: "linear",
        externalId: "lin_cross_tenant",
        externalKey: "SYM-1",
        now: "2026-05-02T00:00:00Z",
        ticket: baseTicket({ id: "ticket_cross_tenant", tenantId: "tenant_ticket", key: "CROSS-TENANT" }),
      }),
    ).rejects.toThrow("ticket_tenant_mismatch:tenant_source:tenant_ticket");

    expect(tableCount(sqlite, "tickets")).toBe(0);
    expect(tableCount(sqlite, "ticket_sources")).toBe(0);
  });

  test("recovers from source unique conflict without creating duplicate tickets", async () => {
    const sqlite = createMigratedDatabase();
    const db = asD1(sqlite);

    const existing = await createOrGetTicketFromSource(db, {
      tenantId: "tenant_1",
      sourceKind: "linear",
      externalId: "lin_conflict",
      externalKey: "SYM-OLD",
      now: "2026-05-02T00:00:00Z",
      ticket: baseTicket({ id: "ticket_conflict_winner", key: "CONFLICT-WINNER" }),
    });

    const recovered = await createOrGetTicketFromSource(staleFirstSourceLookup(db), {
      tenantId: "tenant_1",
      sourceKind: "linear",
      externalId: "lin_conflict",
      externalKey: "SYM-NEW",
      now: "2026-05-02T00:01:00Z",
      ticket: baseTicket({ id: "ticket_conflict_loser", key: "CONFLICT-LOSER" }),
    });

    expect(recovered.createdTicket).toBe(false);
    expect(recovered.createdSource).toBe(false);
    expect(recovered.ticket.id).toBe(existing.ticket.id);
    expect(recovered.source.id).toBe(existing.source.id);
    expect(recovered.source.externalKey).toBe("SYM-NEW");
    expect(tableCount(sqlite, "tickets")).toBe(1);
    expect(tableCount(sqlite, "ticket_sources")).toBe(1);
  });

  test("same-source interleaving after source claim sees an existing ticket", async () => {
    const sqlite = createMigratedDatabase();
    const db = asD1(sqlite);
    let interleaved: Awaited<ReturnType<typeof createOrGetTicketFromSource>> | undefined;

    const outer = await createOrGetTicketFromSource(
      interleaveAfterSourceInsert(
        db,
        {
          tenantId: "tenant_1",
          sourceKind: "linear",
          externalId: "lin_race",
          externalKey: "SYM-RACE-B",
          now: "2026-05-02T00:01:00Z",
          ticket: baseTicket({ id: "ticket_race_b", key: "RACE-B" }),
        },
        (result) => {
          interleaved = result;
        },
      ),
      {
        tenantId: "tenant_1",
        sourceKind: "linear",
        externalId: "lin_race",
        externalKey: "SYM-RACE-A",
        now: "2026-05-02T00:00:00Z",
        ticket: baseTicket({ id: "ticket_race_a", key: "RACE-A" }),
      },
    );

    expect(interleaved).toBeDefined();
    expect(interleaved?.ticket.id).toBe(outer.ticket.id);
    expect(interleaved?.source.id).toBe(outer.source.id);
    expect(interleaved?.source.ticketId).toBe(interleaved?.ticket.id);
    expect(interleaved?.source.tenantId).toBe(interleaved?.ticket.tenantId);
    expect(tableCount(sqlite, "tickets")).toBe(1);
    expect(tableCount(sqlite, "ticket_sources")).toBe(1);
  });

  test("rejects ticket id conflicts before claiming an external source", async () => {
    const sqlite = createMigratedDatabase();
    const db = asD1(sqlite);

    await createOrGetTicketFromSource(db, {
      tenantId: "tenant_1",
      sourceKind: "api",
      externalKey: "manual-existing",
      now: "2026-05-02T00:00:00Z",
      ticket: baseTicket({ id: "ticket_id_conflict", key: "EXISTING-TICKET" }),
    });

    await expect(
      createOrGetTicketFromSource(db, {
        tenantId: "tenant_1",
        sourceKind: "linear",
        externalId: "lin_id_conflict",
        externalKey: "SYM-CONFLICT",
        now: "2026-05-02T00:01:00Z",
        ticket: baseTicket({ id: "ticket_id_conflict", key: "NEW-TICKET" }),
      }),
    ).rejects.toThrow("ticket_id_conflict:ticket_id_conflict");

    expect(tableCount(sqlite, "tickets")).toBe(1);
    expect(tableCount(sqlite, "ticket_sources")).toBe(1);
    await expect(getTicketSourceByExternalId(db, "tenant_1", "linear", "lin_id_conflict")).resolves.toBeNull();
  });

  test("lookup helpers return persisted ticket and external source", async () => {
    const db = asD1(createMigratedDatabase());

    const result = await createOrGetTicketFromSource(db, {
      tenantId: "tenant_1",
      sourceKind: "jira",
      externalId: "jira_123",
      externalKey: "PROJ-123",
      now: "2026-05-02T00:00:00Z",
      ticket: baseTicket({ id: "ticket_lookup", key: "LOOKUP-1", workflowKey: "contract-review" }),
    });

    await expect(getTicketById(db, result.ticket.id)).resolves.toMatchObject({
      id: "ticket_lookup",
      workflowKey: "contract-review",
    });
    await expect(getTicketSourceByExternalId(db, "tenant_1", "jira", "jira_123")).resolves.toMatchObject({
      ticketId: "ticket_lookup",
      externalKey: "PROJ-123",
    });
  });
});
