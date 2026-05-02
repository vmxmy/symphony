import { describe, expect, mock, test } from "bun:test";
import { asD1, createMigratedDatabase } from "./support/sqlite_d1.js";

class MockDurableObject {
  protected ctx: DurableObjectState;
  protected env: unknown;
  constructor(ctx: DurableObjectState, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}
class MockWorkflowEntrypoint {
  protected env: unknown;
  constructor(_ctx: unknown, env: unknown) {
    this.env = env;
  }
}

mock.module("cloudflare:workers", () => ({
  DurableObject: MockDurableObject,
  WorkflowEntrypoint: MockWorkflowEntrypoint,
}));

const workerModule = (await import("../src/worker.js")) as {
  default: { fetch: (req: Request, env: unknown, ctx: unknown) => Promise<Response> };
};
const worker = workerModule.default;

const TENANT = "tenant";
const SLUG = "profile";
const EXTERNAL_ID = "issue-1";
const ATTEMPT = 0;
const RUN_ID = `run:${TENANT}:${SLUG}:${EXTERNAL_ID}:${ATTEMPT}`;
const PROFILE_ID = `${TENANT}/${SLUG}`;
const ISSUE_ID = `${PROFILE_ID}:${EXTERNAL_ID}`;
const TOKEN = "test-bearer-token";

function seedRun(
  db: ReturnType<typeof createMigratedDatabase>,
  status: string = "completed",
) {
  db.query(`
    INSERT INTO tenants (id, name, status, policy_json, created_at, updated_at)
    VALUES (?, ?, 'active', '{}', '2026-05-03T00:00:00Z', '2026-05-03T00:00:00Z')
  `).run(TENANT, TENANT);
  db.query(`
    INSERT INTO profiles (
      id, tenant_id, slug, active_version, tracker_kind, runtime_kind, status,
      config_json, source_schema_version, imported_schema_version,
      defaults_applied, imported_at, created_at, updated_at
    ) VALUES (?, ?, ?, '1.0.0', 'linear', 'cloudflare-agent-native', 'active',
      '{}', 1, 2, '[]', '2026-05-03T00:00:00Z',
      '2026-05-03T00:00:00Z', '2026-05-03T00:00:00Z')
  `).run(PROFILE_ID, TENANT, SLUG);
  db.query(`
    INSERT INTO issues (
      id, tenant_id, profile_id, external_id, identifier, title, state,
      snapshot_json, first_seen_at, last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'SYM-1', 'Sample', 'Todo', '{}',
      '2026-05-03T00:00:00Z', '2026-05-03T00:00:00Z',
      '2026-05-03T00:00:00Z', '2026-05-03T00:00:00Z')
  `).run(ISSUE_ID, TENANT, PROFILE_ID, EXTERNAL_ID);
  db.query(`
    INSERT INTO runs (
      id, issue_id, attempt, status, workflow_id, adapter_kind, started_at, finished_at, token_usage_json
    ) VALUES (?, ?, 0, ?, ?, 'mock', '2026-05-03T00:00:00Z', '2026-05-03T00:00:01Z', ?)
  `).run(
    RUN_ID,
    ISSUE_ID,
    status,
    RUN_ID,
    JSON.stringify({ totalTokens: 100, inputTokens: 70, outputTokens: 30 }),
  );
  for (let i = 1; i <= 3; i++) {
    db.query(`
      INSERT INTO run_steps (id, run_id, step_name, step_sequence, status, started_at, finished_at)
      VALUES (?, ?, ?, ?, 'completed', '2026-05-03T00:00:00Z', '2026-05-03T00:00:00.500Z')
    `).run(`${RUN_ID}:${i}`, RUN_ID, `step-${i}`, i);
    db.query(`
      INSERT INTO run_events (id, run_id, event_type, severity, message, created_at)
      VALUES (?, ?, ?, 'info', 'msg', ?)
    `).run(`${RUN_ID}:${i}:started`, RUN_ID, `step.step-${i}.started`, "2026-05-03T00:00:00Z");
    db.query(`
      INSERT INTO run_events (id, run_id, event_type, severity, message, created_at)
      VALUES (?, ?, ?, 'info', 'msg', ?)
    `).run(`${RUN_ID}:${i}:completed`, RUN_ID, `step.step-${i}.completed`, "2026-05-03T00:00:00.500Z");
  }
}

function makeEnv(opts: {
  db: ReturnType<typeof createMigratedDatabase>;
  recordCancel?: (msg: string) => void;
  workflowTerminate?: () => Promise<void>;
}) {
  const onRunFinishedCalls: Array<{ outcome: string }> = [];
  const env = {
    DB: asD1(opts.db),
    OPERATOR_TOKEN: TOKEN,
    SESSION_SIGNING_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ARTIFACTS: {
      async put() {
        return {} as R2Object;
      },
    } as unknown as R2Bucket,
    EXECUTION_WORKFLOW: {
      async get(_id: string) {
        return {
          async terminate() {
            if (opts.workflowTerminate) await opts.workflowTerminate();
          },
        };
      },
    },
    TENANT_AGENT: {
      idFromName: (name: string) => name,
      get: () => ({}),
    } as unknown as DurableObjectNamespace,
    PROJECT_AGENT: {
      idFromName: (name: string) => name,
      get: () => ({}),
    } as unknown as DurableObjectNamespace,
    ISSUE_AGENT: {
      idFromName: (name: string) => name,
      get: () => ({
        async onRunFinished(_t: string, _s: string, _e: string, outcome: string) {
          onRunFinishedCalls.push({ outcome });
          opts.recordCancel?.(outcome);
          return {};
        },
      }),
    } as unknown as DurableObjectNamespace,
    TRACKER_EVENTS: {
      async send() {
        return {};
      },
      async sendBatch() {
        return {};
      },
    },
    DISPATCH: {
      async send() {
        return {};
      },
      async sendBatch() {
        return {};
      },
    },
  };
  return { env, onRunFinishedCalls };
}

function call(method: string, path: string, headers: Record<string, string> = {}): Request {
  return new Request("https://test.example.com" + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...headers },
  });
}

describe("Phase 5 PR-D run routes", () => {
  test("GET /api/v1/runs/:t/:s/:e/:attempt/state returns shape with steps", async () => {
    const db = createMigratedDatabase();
    seedRun(db);
    const { env } = makeEnv({ db });
    const res = await worker.fetch(
      call("GET", `/api/v1/runs/${TENANT}/${SLUG}/${EXTERNAL_ID}/${ATTEMPT}/state`),
      env,
      {},
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: { id: string; status: string }; steps: unknown[] };
    expect(body.run.id).toBe(RUN_ID);
    expect(body.run.status).toBe("completed");
    expect(body.steps).toHaveLength(3);
  });

  test("GET /state returns 404 when run is missing", async () => {
    const db = createMigratedDatabase();
    seedRun(db);
    const { env } = makeEnv({ db });
    const res = await worker.fetch(
      call("GET", `/api/v1/runs/${TENANT}/${SLUG}/${EXTERNAL_ID}/99/state`),
      env,
      {},
    );
    expect(res.status).toBe(404);
  });

  test("POST /actions/cancel terminates running run + notifies IssueAgent", async () => {
    const db = createMigratedDatabase();
    seedRun(db, "running");
    const { env, onRunFinishedCalls } = makeEnv({ db });
    let terminated = false;
    env.EXECUTION_WORKFLOW = {
      async get(_id: string) {
        return {
          async terminate() {
            terminated = true;
          },
        };
      },
    };
    const res = await worker.fetch(
      call("POST", `/api/v1/runs/${TENANT}/${SLUG}/${EXTERNAL_ID}/${ATTEMPT}/actions/cancel`),
      env,
      {},
    );
    expect(res.status).toBe(200);
    expect(terminated).toBe(true);
    expect(onRunFinishedCalls).toEqual([{ outcome: "cancelled" }]);
    const after = db
      .query("SELECT status FROM runs WHERE id = ?")
      .get(RUN_ID) as { status: string } | null;
    expect(after?.status).toBe("cancelled");
  });

  test("POST /actions/cancel returns 409 when run already terminal", async () => {
    const db = createMigratedDatabase();
    seedRun(db, "completed");
    const { env } = makeEnv({ db });
    const res = await worker.fetch(
      call("POST", `/api/v1/runs/${TENANT}/${SLUG}/${EXTERNAL_ID}/${ATTEMPT}/actions/cancel`),
      env,
      {},
    );
    expect(res.status).toBe(409);
  });

  test("POST /actions/cancel returns 401 without bearer", async () => {
    const db = createMigratedDatabase();
    seedRun(db, "running");
    const { env } = makeEnv({ db });
    const res = await worker.fetch(
      new Request(
        `https://test.example.com/api/v1/runs/${TENANT}/${SLUG}/${EXTERNAL_ID}/${ATTEMPT}/actions/cancel`,
        { method: "POST" },
      ),
      env,
      {},
    );
    expect([401, 403]).toContain(res.status);
  });

  test("GET /events returns paged response with cursor", async () => {
    const db = createMigratedDatabase();
    seedRun(db);
    const { env } = makeEnv({ db });
    const res = await worker.fetch(
      call("GET", `/api/v1/runs/${TENANT}/${SLUG}/${EXTERNAL_ID}/${ATTEMPT}/events?limit=2`),
      env,
      {},
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }>; next_cursor: string | null };
    expect(body.data).toHaveLength(2);
    expect(body.next_cursor).not.toBeNull();
    // Follow cursor to the second page.
    const res2 = await worker.fetch(
      call(
        "GET",
        `/api/v1/runs/${TENANT}/${SLUG}/${EXTERNAL_ID}/${ATTEMPT}/events?limit=10&after=${encodeURIComponent(body.next_cursor!)}`,
      ),
      env,
      {},
    );
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { data: Array<{ id: string }>; next_cursor: string | null };
    // Page 1 had 2 of 6 events; page 2 fetches remaining 4.
    expect(body2.data.length).toBeLessThanOrEqual(4);
  });
});
