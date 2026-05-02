import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mirrorIssues } from "../src/tracker/mirror.js";
import type { Issue } from "../src/types.js";
import { asD1, createMigratedDatabase } from "./support/sqlite_d1.js";

function makeIssue(overrides: Partial<Issue> & { id: string; identifier: string; state?: string }): Issue {
  return {
    title: overrides.identifier,
    description: null,
    state: "In Progress",
    priority: null,
    url: `https://linear.test/${overrides.identifier}`,
    branchName: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function tableCount(db: Database, table: string): number {
  const row = db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function ticketSourceRows(db: Database) {
  return db
    .query(
      `SELECT
         t.id AS ticket_id,
         t.tenant_id,
         t.key,
         t.type,
         t.title,
         t.description,
         t.priority,
         t.status,
         t.workflow_key,
         t.input_json,
         t.tags_json,
         s.id AS source_id,
         s.source_kind,
         s.external_id,
         s.external_key,
         s.external_url
       FROM tickets t
       JOIN ticket_sources s ON s.ticket_id = t.id
       ORDER BY t.created_at, t.id`,
    )
    .all() as Array<{
    ticket_id: string;
    tenant_id: string;
    key: string;
    type: string;
    title: string;
    description: string | null;
    priority: string;
    status: string;
    workflow_key: string;
    input_json: string | null;
    tags_json: string;
    source_id: string;
    source_kind: string;
    external_id: string | null;
    external_key: string | null;
    external_url: string | null;
  }>;
}

describe("mirrorIssues", () => {
  test("creates a canonical ticket and source for a new Linear issue mirror", async () => {
    const db = createMigratedDatabase();
    const issue = makeIssue({
      id: "linear-issue-new",
      identifier: "SYM-NEW",
      title: "Mirror me",
      description: "Create a generic ticket too",
      priority: 2,
      labels: ["bug", "customer"],
    });

    const stats = await mirrorIssues(
      asD1(db),
      "personal/content-wechat",
      "personal",
      [issue],
      "2026-05-02T00:00:00Z",
    );

    expect(stats).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
    expect(tableCount(db, "issues")).toBe(1);
    expect(tableCount(db, "tickets")).toBe(1);
    expect(tableCount(db, "ticket_sources")).toBe(1);

    const issueRow = db.query("SELECT id, tenant_id, profile_id, external_id, identifier, title, state, url FROM issues").get() as {
      id: string;
      tenant_id: string;
      profile_id: string;
      external_id: string | null;
      identifier: string;
      title: string | null;
      state: string;
      url: string | null;
    };
    expect(issueRow).toMatchObject({
      id: "personal/content-wechat:linear-issue-new",
      tenant_id: "personal",
      profile_id: "personal/content-wechat",
      external_id: "linear-issue-new",
      identifier: "SYM-NEW",
      title: "Mirror me",
      state: "In Progress",
      url: "https://linear.test/SYM-NEW",
    });

    const [row] = ticketSourceRows(db);
    expect(row).toMatchObject({
      tenant_id: "personal",
      key: "linear:personal/content-wechat:linear-issue-new",
      type: "linear_issue",
      title: "Mirror me",
      description: "Create a generic ticket too",
      priority: "high",
      status: "CREATED",
      workflow_key: "linear-issue",
      source_kind: "linear",
      external_id: "linear-issue-new",
      external_key: "SYM-NEW",
      external_url: "https://linear.test/SYM-NEW",
      tags_json: JSON.stringify(["bug", "customer"]),
    });
    expect(row?.ticket_id).not.toBe(issue.id);
    expect(row?.ticket_id).not.toBe(issueRow.id);
    expect(JSON.parse(row!.input_json!)).toMatchObject({
      source: { kind: "linear", profileId: "personal/content-wechat" },
      issue: { id: issue.id, identifier: issue.identifier },
    });
  });

  test("repeated mirror is idempotent for generic tickets and sources", async () => {
    const db = createMigratedDatabase();
    const issue = makeIssue({ id: "linear-issue-idem", identifier: "SYM-IDEM" });

    await mirrorIssues(asD1(db), "personal/content-wechat", "personal", [issue], "2026-05-02T00:00:00Z");
    const [firstRow] = ticketSourceRows(db);
    const second = await mirrorIssues(asD1(db), "personal/content-wechat", "personal", [issue], "2026-05-02T00:01:00Z");
    const [secondRow] = ticketSourceRows(db);

    expect(second).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    expect(tableCount(db, "issues")).toBe(1);
    expect(tableCount(db, "tickets")).toBe(1);
    expect(tableCount(db, "ticket_sources")).toBe(1);
    expect(secondRow?.ticket_id).toBe(firstRow?.ticket_id);
    expect(secondRow?.source_id).toBe(firstRow?.source_id);
    expect(secondRow).toMatchObject({
      external_id: "linear-issue-idem",
      external_key: "SYM-IDEM",
    });
  });

  test("identifier reuse with a new Linear id creates a distinct ticket", async () => {
    const db = createMigratedDatabase();
    const first = makeIssue({ id: "linear-issue-reused-a", identifier: "SYM-REUSED" });
    const second = makeIssue({ id: "linear-issue-reused-b", identifier: "SYM-REUSED" });

    await mirrorIssues(asD1(db), "personal/content-wechat", "personal", [first], "2026-05-02T00:00:00Z");
    await mirrorIssues(asD1(db), "personal/content-wechat", "personal", [makeIssue({ id: first.id, identifier: "SYM-RENAMED" })], "2026-05-02T00:01:00Z");
    await mirrorIssues(asD1(db), "personal/content-wechat", "personal", [second], "2026-05-02T00:02:00Z");

    const rows = ticketSourceRows(db);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.external_id).sort()).toEqual(["linear-issue-reused-a", "linear-issue-reused-b"]);
    expect(new Set(rows.map((row) => row.ticket_id)).size).toBe(2);
  });

  test("renamed Linear issue keeps the same generic ticket and source", async () => {
    const db = createMigratedDatabase();
    const oldIssue = makeIssue({ id: "linear-issue-rename", identifier: "SYM-OLD" });
    const renamedIssue = makeIssue({ id: "linear-issue-rename", identifier: "SYM-NEW" });

    await mirrorIssues(asD1(db), "personal/content-wechat", "personal", [oldIssue], "2026-05-02T00:00:00Z");
    const [before] = ticketSourceRows(db);
    const stats = await mirrorIssues(asD1(db), "personal/content-wechat", "personal", [renamedIssue], "2026-05-02T00:01:00Z");
    const [after] = ticketSourceRows(db);

    expect(stats).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    expect(tableCount(db, "issues")).toBe(1);
    expect(tableCount(db, "tickets")).toBe(1);
    expect(tableCount(db, "ticket_sources")).toBe(1);
    expect(after?.ticket_id).toBe(before?.ticket_id);
    expect(after?.source_id).toBe(before?.source_id);
    expect(after).toMatchObject({
      key: "linear:personal/content-wechat:linear-issue-rename",
      external_id: "linear-issue-rename",
      external_key: "SYM-NEW",
    });
  });

  test("attaches external identity to an existing null-external identifier row", async () => {
    const db = createMigratedDatabase();
    db.run(`
      INSERT INTO issues (
        id, tenant_id, profile_id, external_id, identifier, title, state,
        snapshot_json, first_seen_at, last_seen_at, created_at, updated_at
      ) VALUES (
        'personal/content-wechat:SYM-1', 'personal', 'personal/content-wechat',
        NULL, 'SYM-1', 'Mock SYM-1', 'In Progress', '{}',
        '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
        '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z'
      )
    `);

    const stats = await mirrorIssues(
      asD1(db),
      "personal/content-wechat",
      "personal",
      [makeIssue({ id: "linear-issue-1", identifier: "SYM-1" })],
      "2026-05-02T00:00:00Z",
    );

    expect(stats).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    const rows = db.query("SELECT id, external_id, identifier, title FROM issues").all() as Array<{
      id: string;
      external_id: string | null;
      identifier: string;
      title: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "personal/content-wechat:SYM-1",
      external_id: "linear-issue-1",
      identifier: "SYM-1",
      title: "SYM-1",
    });
    const [ticketSource] = ticketSourceRows(db);
    expect(ticketSource).toMatchObject({
      tenant_id: "personal",
      key: "linear:personal/content-wechat:linear-issue-1",
      source_kind: "linear",
      external_id: "linear-issue-1",
      external_key: "SYM-1",
    });
    expect(ticketSource?.ticket_id).not.toBe("linear-issue-1");
  });

  test("keeps archived_at stable for identical terminal snapshots", async () => {
    const db = createMigratedDatabase();
    const issue = makeIssue({ id: "linear-issue-2", identifier: "SYM-2", state: "Done" });
    const snapshot = JSON.stringify(issue);
    db.query(`
      INSERT INTO issues (
        id, tenant_id, profile_id, external_id, identifier, title, state,
        priority, url, snapshot_json, first_seen_at, last_seen_at,
        created_at, updated_at, archived_at
      ) VALUES (?, 'personal', 'personal/content-wechat', ?, ?, ?, ?, ?, ?, ?,
        '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
        '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
        '2026-05-01T01:00:00Z')
    `).run(
      "personal/content-wechat:linear-issue-2",
      issue.id,
      issue.identifier,
      issue.title,
      issue.state,
      issue.priority,
      issue.url,
      snapshot,
    );

    const stats = await mirrorIssues(
      asD1(db),
      "personal/content-wechat",
      "personal",
      [issue],
      "2026-05-02T00:00:00Z",
    );

    expect(stats).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    const row = db.query("SELECT archived_at, last_seen_at FROM issues WHERE external_id = ?").get(issue.id) as {
      archived_at: string | null;
      last_seen_at: string;
    };
    expect(row.archived_at).toBe("2026-05-01T01:00:00Z");
    expect(row.last_seen_at).toBe("2026-05-02T00:00:00Z");
    const [ticketSource] = ticketSourceRows(db);
    expect(ticketSource).toMatchObject({
      source_kind: "linear",
      external_id: "linear-issue-2",
      external_key: "SYM-2",
    });
  });

  test("updates the existing row when a tracker identifier is renamed", async () => {
    const db = createMigratedDatabase();
    const oldIssue = makeIssue({ id: "linear-issue-3", identifier: "SYM-OLD" });
    db.query(`
      INSERT INTO issues (
        id, tenant_id, profile_id, external_id, identifier, title, state,
        priority, url, snapshot_json, first_seen_at, last_seen_at,
        created_at, updated_at
      ) VALUES (?, 'personal', 'personal/content-wechat', ?, ?, ?, ?, ?, ?, ?,
        '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
        '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')
    `).run(
      "personal/content-wechat:linear-issue-3",
      oldIssue.id,
      oldIssue.identifier,
      oldIssue.title,
      oldIssue.state,
      oldIssue.priority,
      oldIssue.url,
      JSON.stringify(oldIssue),
    );

    const stats = await mirrorIssues(
      asD1(db),
      "personal/content-wechat",
      "personal",
      [makeIssue({ id: "linear-issue-3", identifier: "SYM-NEW" })],
      "2026-05-02T00:00:00Z",
    );

    expect(stats).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    const identifiers = db.query("SELECT identifier FROM issues").all() as Array<{ identifier: string }>;
    expect(identifiers).toEqual([{ identifier: "SYM-NEW" }]);
    const rows = ticketSourceRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_kind: "linear",
      external_id: "linear-issue-3",
      external_key: "SYM-NEW",
    });
  });
});
