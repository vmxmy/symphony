// Mirror tracker-fetched issues into the D1 issues table.
//
// UPSERT semantics:
//   - Identity oracle is the partial unique index
//     idx_issues_profile_external_unique on (profile_id, external_id)
//     WHERE external_id IS NOT NULL. Looking up by that pair survives both
//     identifier renames AND historical rows whose primary-key id was
//     constructed differently (e.g. earlier Phase 3 work used
//     `${profileId}:${identifier}` while current code uses
//     `${profileId}:${issue.id}`). Mixed id-format rows coexist safely.
//   - If a pre-tracker/mock row exists with the same human identifier and a
//     NULL external_id, attach the tracker external_id to that row instead of
//     inserting a duplicate that would violate UNIQUE(profile_id, identifier).
//   - Tracker-fetched issues always carry a non-null `issue.id` so the
//     partial-index lookup is always valid in this code path; mock /
//     non-tracker rows that have NULL external_id are managed elsewhere.
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

type ExistingIssueRow = {
  id: string;
  external_id: string | null;
  state: string;
  identifier: string;
  title: string | null;
  url: string | null;
  priority: number | null;
  snapshot_json: string;
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
    const id = `${profileId}:${issue.id}`;
    const snapshot = JSON.stringify(issue);

    const existing = await db
      .prepare(
          `SELECT id, external_id, identifier, state, title, url, priority, snapshot_json
           FROM issues
          WHERE profile_id = ? AND external_id = ?`,
      )
      .bind(profileId, issue.id)
      .first<ExistingIssueRow>() ??
      await db
        .prepare(
          `SELECT id, external_id, identifier, state, title, url, priority, snapshot_json
             FROM issues
            WHERE profile_id = ? AND identifier = ? AND external_id IS NULL`,
        )
        .bind(profileId, issue.identifier)
        .first<ExistingIssueRow>();

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
      existing.external_id !== issue.id ||
      existing.state !== issue.state ||
      existing.identifier !== issue.identifier ||
      existing.title !== issue.title ||
      existing.url !== issue.url ||
      existing.priority !== issue.priority ||
      existing.snapshot_json !== snapshot;

    if (changed) {
      await db
        .prepare(
          `UPDATE issues
              SET external_id = ?, identifier = ?, state = ?, title = ?, url = ?, priority = ?,
                  snapshot_json = ?, last_seen_at = ?, updated_at = ?,
                  archived_at = NULL
            WHERE id = ?`,
        )
        .bind(
          issue.id,
          issue.identifier,
          issue.state,
          issue.title,
          issue.url,
          issue.priority,
          snapshot,
          now,
          now,
          existing.id,
        )
        .run();
      stats.updated++;
    } else {
      // Identical snapshot: only bump last_seen_at; do NOT touch
      // archived_at. The earlier "defense-in-depth clear archived_at"
      // here oscillated with the cleanup decision loop — every other
      // poll would un-archive (here) then re-archive (cleanup), a
      // permanent flap on stable terminal state. Meaningful re-
      // emergence (terminal -> active) carries a state change and
      // lands in the `changed` branch above, which clears archived_at.
      await db
        .prepare(`UPDATE issues SET last_seen_at = ? WHERE id = ?`)
        .bind(now, existing.id)
        .run();
      stats.unchanged++;
    }
  }

  return stats;
}
