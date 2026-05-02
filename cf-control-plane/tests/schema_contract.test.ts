import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { Database } from "bun:sqlite";

function tableColumns(db: Database, table: string): string[] {
  return db.query(`PRAGMA table_info(${table})`).all().map((row) => String((row as { name: string }).name));
}

function tableNames(db: Database): string[] {
  return db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String((row as { name: string }).name));
}

function indexes(db: Database): Array<{ name: string; sql: string | null }> {
  return db.query("SELECT name, sql FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string; sql: string | null }>;
}

function applyMigrations(): Database {
  const db = new Database(":memory:");
  for (const file of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  return db;
}

describe("D1 initial schema contract", () => {
  test("migration creates drift-resistant tables and review-critical columns/indexes", () => {
    const migrations = readdirSync("migrations")
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map((file) => readFileSync(`migrations/${file}`, "utf8"));
    expect(migrations[0]).not.toMatch(/CREATE TABLE IF NOT EXISTS/i);

    const db = new Database(":memory:");
    for (const migrationSql of migrations) db.exec(migrationSql);

    expect(tableColumns(db, "run_events")).toContain("archived_at");
    expect(tableColumns(db, "tool_calls")).toContain("archived_at");
    expect(tableColumns(db, "run_steps")).toContain("archived_at");
    expect(tableColumns(db, "idempotency_records")).toContain("lease_expires_at");
    expect(tableColumns(db, "idempotency_records")).toContain("retry_after");

    const indexRows = indexes(db);
    expect(indexRows.some((idx) => idx.name === "idx_issues_profile_external_unique" && idx.sql?.includes("WHERE external_id IS NOT NULL"))).toBe(true);
    expect(indexRows.some((idx) => idx.name === "idx_idempotency_lease_expires" && idx.sql?.includes("status = 'in_progress'"))).toBe(true);
  });

  test("G1 adds generic ticket workflow tables without removing compatibility tables", () => {
    const db = applyMigrations();

    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        "issues",
        "runs",
        "run_steps",
        "run_events",
        "tool_calls",
        "approvals",
        "idempotency_records",
        "tickets",
        "ticket_sources",
        "ticket_comments",
        "workflow_definitions",
        "workflow_instances",
        "workflow_steps",
        "agent_sessions",
        "tool_definitions",
        "tool_invocations",
        "artifacts",
        "audit_events",
        "notifications",
      ]),
    );

    expect(tableColumns(db, "tickets")).toEqual(
      expect.arrayContaining(["id", "tenant_id", "key", "status", "workflow_key", "input_json", "tags_json", "archived_at"]),
    );
    expect(tableColumns(db, "ticket_sources")).toEqual(
      expect.arrayContaining(["ticket_id", "source_kind", "external_id", "external_key", "sync_status"]),
    );
    expect(tableColumns(db, "workflow_instances")).toEqual(
      expect.arrayContaining(["ticket_id", "workflow_key", "workflow_version", "status", "current_step_key", "runtime_json"]),
    );
    expect(tableColumns(db, "workflow_steps")).toEqual(
      expect.arrayContaining(["workflow_instance_id", "step_key", "step_type", "status", "sequence", "retry_count"]),
    );
    expect(tableColumns(db, "agent_sessions")).toEqual(expect.arrayContaining(["ticket_id", "role", "adapter_kind", "memory_scope"]));
    expect(tableColumns(db, "tool_definitions")).toEqual(
      expect.arrayContaining(["tenant_id", "name", "input_schema_json", "output_schema_json", "risk_level", "requires_approval"]),
    );
    expect(tableColumns(db, "tool_invocations")).toEqual(
      expect.arrayContaining(["ticket_id", "workflow_instance_id", "workflow_step_id", "tool_name", "risk_level", "idempotency_key"]),
    );
    expect(tableColumns(db, "artifacts")).toEqual(expect.arrayContaining(["ticket_id", "workflow_instance_id", "r2_key", "mime_type"]));
    expect(tableColumns(db, "audit_events")).toEqual(expect.arrayContaining(["ticket_id", "actor_type", "action", "severity", "payload_ref"]));
    expect(tableColumns(db, "notifications")).toEqual(expect.arrayContaining(["ticket_id", "channel", "recipient", "status", "payload_ref"]));
    expect(tableColumns(db, "approvals")).toEqual(
      expect.arrayContaining(["ticket_id", "workflow_instance_id", "workflow_step_id", "approver_group", "expires_at"]),
    );

    const indexRows = indexes(db);
    for (const expectedIndex of [
      "idx_tickets_tenant_status",
      "idx_tickets_workflow_status",
      "idx_ticket_sources_external",
      "idx_ticket_comments_ticket_time",
      "idx_workflow_instances_ticket",
      "idx_workflow_instances_status",
      "idx_workflow_steps_instance_seq",
      "idx_agent_sessions_ticket",
      "idx_tool_definitions_tenant_active",
      "idx_tool_invocations_ticket",
      "idx_tool_invocations_step",
      "idx_tool_invocations_status",
      "idx_tool_invocations_idempotency",
      "idx_artifacts_ticket",
      "idx_audit_events_ticket_time",
      "idx_notifications_pending",
      "idx_approvals_ticket_status",
      "idx_approvals_workflow_step",
    ]) {
      expect(indexRows.some((idx) => idx.name === expectedIndex)).toBe(true);
    }
    expect(indexRows.some((idx) => idx.name === "idx_ticket_sources_external" && idx.sql?.includes("WHERE external_id IS NOT NULL"))).toBe(true);
  });
});
