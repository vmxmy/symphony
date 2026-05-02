import { describe, expect, mock, test } from "bun:test";
import type { Issue } from "../src/types.js";
import { asD1, createMigratedDatabase } from "./support/sqlite_d1.js";

class DurableObjectMock<Env = unknown> {
  ctx: DurableObjectState;
  env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

mock.module("cloudflare:workers", () => ({ DurableObject: DurableObjectMock }));

const { ProjectAgent } = await import("../src/agents/project.js");

const TENANT_ID = "tenant";
const SLUG = "profile";
const PROFILE_ID = `${TENANT_ID}/${SLUG}`;

function makeIssue(overrides: Partial<Issue> & { id: string; identifier: string; state?: string }): Issue {
  return {
    title: overrides.identifier,
    description: null,
    state: "Todo",
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

function toLinearNode(issue: Issue) {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: { name: issue.state },
    branchName: issue.branchName,
    url: issue.url,
    assignee: null,
    labels: { nodes: issue.labels.map((name) => ({ name })) },
    inverseRelations: { nodes: [] },
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

function seedTenantAndProfile(db: ReturnType<typeof createMigratedDatabase>) {
  db.query(`
    INSERT INTO tenants (id, name, status, policy_json, created_at, updated_at)
    VALUES (?, ?, 'active', '{}', '2026-05-02T00:00:00Z', '2026-05-02T00:00:00Z')
  `).run(TENANT_ID, TENANT_ID);

  db.query(`
    INSERT INTO profiles (
      id, tenant_id, slug, active_version, tracker_kind, runtime_kind, status,
      config_json, source_schema_version, imported_schema_version,
      defaults_applied, imported_at, created_at, updated_at
    ) VALUES (?, ?, ?, '1.0.0', 'linear', 'cloudflare-agent-native', 'active',
      ?, 1, 2, '[]', '2026-05-02T00:00:00Z',
      '2026-05-02T00:00:00Z', '2026-05-02T00:00:00Z')
  `).run(
    PROFILE_ID,
    TENANT_ID,
    SLUG,
    JSON.stringify({
      tracker: {
        endpoint: "https://linear.test/graphql",
        project_slug: "SYM",
        active_states: ["Todo"],
        terminal_states: ["Done"],
      },
      agent: { max_concurrent_agents: 5 },
    }),
  );
}

function seedRetry(db: ReturnType<typeof createMigratedDatabase>, issue: Issue, dueAt: string, attempt = 2) {
  db.query(`
    INSERT INTO issue_retries (
      issue_id, tenant_id, profile_id, external_id, attempt, due_at, last_error, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'synthetic failure', '2026-05-02T00:00:00Z')
  `).run(issue.id, TENANT_ID, PROFILE_ID, issue.id, attempt, dueAt);
}

async function withLinearIssues<T>(issues: Issue[], fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { variables?: { stateNames?: string[] } };
    const stateNames = body.variables?.stateNames ?? [];
    const nodes = issues.filter((issue) => stateNames.includes(issue.state)).map(toLinearNode);
    return Response.json({
      data: {
        issues: {
          nodes,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
  }) as typeof fetch;

  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function pollWithIssues(db: ReturnType<typeof createMigratedDatabase>, issues: Issue[]) {
  return withLinearIssues(issues, async () => {
    const ctx = {} as unknown as ConstructorParameters<typeof ProjectAgent>[0];
    const env = {
      DB: asD1(db),
      PROJECT_AGENT: {} as unknown as DurableObjectNamespace,
      LINEAR_API_KEY: "linear-key",
    } as unknown as ConstructorParameters<typeof ProjectAgent>[1];
    const agent = new ProjectAgent(ctx, env);
    return agent.poll(TENANT_ID, SLUG);
  });
}

describe("ProjectAgent retry mirror gate", () => {
  test("empty issue_retries preserves first dispatch behavior", async () => {
    const db = createMigratedDatabase();
    seedTenantAndProfile(db);
    const issue = makeIssue({ id: "linear-issue-1", identifier: "SYM-1" });

    const result = await pollWithIssues(db, [issue]);

    expect(result.decisions).toEqual([
      { kind: "dispatch", issueId: issue.id, issueIdentifier: issue.identifier, attempt: 1 },
    ]);
  });

  test("future retry due_at suppresses dispatch for that issue", async () => {
    const db = createMigratedDatabase();
    seedTenantAndProfile(db);
    const issue = makeIssue({ id: "linear-issue-2", identifier: "SYM-2" });
    seedRetry(db, issue, new Date(Date.now() + 60_000).toISOString(), 2);

    const result = await pollWithIssues(db, [issue]);

    expect(result.decisions.some((decision) => decision.kind === "dispatch" && decision.issueId === issue.id)).toBe(false);
  });

  test("past retry due_at dispatches with the next attempt", async () => {
    const db = createMigratedDatabase();
    seedTenantAndProfile(db);
    const issue = makeIssue({ id: "linear-issue-3", identifier: "SYM-3" });
    seedRetry(db, issue, new Date(Date.now() - 60_000).toISOString(), 2);

    const result = await pollWithIssues(db, [issue]);

    expect(result.decisions).toContainEqual({
      kind: "dispatch",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      attempt: 3,
    });
  });
});
