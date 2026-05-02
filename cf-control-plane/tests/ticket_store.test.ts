import { describe, expect, test } from "bun:test";
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
