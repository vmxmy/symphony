import { describe, expect, test } from "bun:test";
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

describe("mirrorIssues", () => {
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
  });
});
