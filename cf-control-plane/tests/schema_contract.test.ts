import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";

function tableColumns(db: Database, table: string): string[] {
  return db.query(`PRAGMA table_info(${table})`).all().map((row) => String((row as { name: string }).name));
}

describe("D1 initial schema contract", () => {
  test("migration creates drift-resistant tables and review-critical columns/indexes", () => {
    const migrationSql = readFileSync("migrations/0001_init.sql", "utf8");
    expect(migrationSql).not.toMatch(/CREATE TABLE IF NOT EXISTS/i);

    const db = new Database(":memory:");
    db.exec(migrationSql);

    expect(tableColumns(db, "run_events")).toContain("archived_at");
    expect(tableColumns(db, "tool_calls")).toContain("archived_at");
    expect(tableColumns(db, "run_steps")).toContain("archived_at");
    expect(tableColumns(db, "idempotency_records")).toContain("lease_expires_at");
    expect(tableColumns(db, "idempotency_records")).toContain("retry_after");

    const indexes = db.query("SELECT name, sql FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string; sql: string | null }>;
    expect(indexes.some((idx) => idx.name === "idx_issues_profile_external_unique" && idx.sql?.includes("WHERE external_id IS NOT NULL"))).toBe(true);
    expect(indexes.some((idx) => idx.name === "idx_idempotency_lease_expires" && idx.sql?.includes("status = 'in_progress'"))).toBe(true);
  });
});
