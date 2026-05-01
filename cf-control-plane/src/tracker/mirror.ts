// Mirror tracker-fetched issues into the D1 issues table.
//
// UPSERT semantics:
//   - Deterministic row id `${profileId}:${issue.identifier}` (matches the
//     id format used by orchestration/mock_run.ts).
//   - INSERT path sets first_seen_at AND last_seen_at to `now`.
//   - UPDATE path bumps last_seen_at always; updates state / title / url /
//     priority / snapshot_json only when changed; clears archived_at if
//     the tracker still considers the issue alive (i.e. the upsert is
//     called with an issue from the active or terminal lists).
//
// Returns counts so the operator dashboard / refresh response can show
// what changed.

import type { Issue } from "../types.js";

type MirrorStats = {
  inserted: number;
  updated: number;
  unchanged: number;
};

export async function mirrorIssues(
  db: D1Database,
  profileId: string,
  tenantId: string,
  issues: Issue[],
  now: string,
): Promise<MirrorStats> {
  const stats: MirrorStats = { inserted: 0, updated: 0, unchanged: 0 };

  for (const issue of issues) {
    const id = `${profileId}:${issue.identifier}`;
    const snapshot = JSON.stringify(issue);

    const existing = await db
      .prepare(
        `SELECT state, title, url, priority, snapshot_json
           FROM issues
          WHERE id = ?`,
      )
      .bind(id)
      .first<{
        state: string;
        title: string | null;
        url: string | null;
        priority: number | null;
        snapshot_json: string;
      }>();

    if (!existing) {
      await db
        .prepare(
          `INSERT INTO issues (
             id, tenant_id, profile_id, external_id, identifier, title,
             state, priority, url, snapshot_json,
             first_seen_at, last_seen_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          tenantId,
          profileId,
          issue.id,
          issue.identifier,
          issue.title,
          issue.state,
          issue.priority,
          issue.url,
          snapshot,
          now,
          now,
          now,
          now,
        )
        .run();
      stats.inserted++;
      continue;
    }

    const changed =
      existing.state !== issue.state ||
      existing.title !== issue.title ||
      existing.url !== issue.url ||
      existing.priority !== issue.priority ||
      existing.snapshot_json !== snapshot;

    if (changed) {
      await db
        .prepare(
          `UPDATE issues
              SET state = ?, title = ?, url = ?, priority = ?,
                  snapshot_json = ?, last_seen_at = ?, updated_at = ?,
                  archived_at = NULL
            WHERE id = ?`,
        )
        .bind(
          issue.state,
          issue.title,
          issue.url,
          issue.priority,
          snapshot,
          now,
          now,
          id,
        )
        .run();
      stats.updated++;
    } else {
      // Stale data still bumps last_seen_at so the dashboard "freshness"
      // column stays useful, but we report this as `unchanged` to the
      // operator since nothing meaningful changed.
      //
      // Defense-in-depth: also clear archived_at when an issue we already
      // archived reappears in the tracker's active/terminal set with an
      // identical snapshot. Without this, a same-snapshot re-emergence
      // would land here and stay archived in D1 forever — operator-
      // visible drift between tracker and dashboard. The change-detection
      // path above already clears archived_at via UPDATE, so this is the
      // strict edge case.
      await db
        .prepare(`UPDATE issues SET last_seen_at = ?, archived_at = NULL WHERE id = ?`)
        .bind(now, id)
        .run();
      stats.unchanged++;
    }
  }

  return stats;
}
