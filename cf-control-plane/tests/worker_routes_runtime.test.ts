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
const TOKEN = "test-bearer-token";
const PROFILE_ID = `${TENANT}/${SLUG}`;

function seedProfile(
  db: ReturnType<typeof createMigratedDatabase>,
  configJson: string = "{}",
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
      ?, 1, 2, '[]', '2026-05-03T00:00:00Z',
      '2026-05-03T00:00:00Z', '2026-05-03T00:00:00Z')
  `).run(PROFILE_ID, TENANT, SLUG, configJson);
}

function makeEnv(db: ReturnType<typeof createMigratedDatabase>) {
  return {
    DB: asD1(db),
    OPERATOR_TOKEN: TOKEN,
    SESSION_SIGNING_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ARTIFACTS: {
      async put() {
        return {} as R2Object;
      },
    } as unknown as R2Bucket,
    EXECUTION_WORKFLOW: {
      async get(_id: string) {
        return { async terminate() {} };
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
      get: () => ({}),
    } as unknown as DurableObjectNamespace,
    TRACKER_EVENTS: {
      async send() { return {}; },
      async sendBatch() { return {}; },
    },
    DISPATCH: {
      async send() { return {}; },
      async sendBatch() { return {}; },
    },
  };
}

function call(method: string, path: string, headers: Record<string, string> = {}): Request {
  return new Request("https://test.example.com" + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...headers },
  });
}

describe("Phase 6 PR-E-1 runtime route", () => {
  test("200 returns mock host when config_json is empty object", async () => {
    const db = createMigratedDatabase();
    seedProfile(db, "{}");
    const env = makeEnv(db);
    const res = await worker.fetch(
      call("GET", `/api/v1/profiles/${TENANT}/${SLUG}/runtime`),
      env,
      {},
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runtime: { host: string } };
    expect(body.runtime.host).toBe("mock");
  });

  test("200 returns mock host when runtime.host is explicitly mock", async () => {
    const db = createMigratedDatabase();
    seedProfile(db, JSON.stringify({ runtime: { host: "mock" } }));
    const env = makeEnv(db);
    const res = await worker.fetch(
      call("GET", `/api/v1/profiles/${TENANT}/${SLUG}/runtime`),
      env,
      {},
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runtime: { host: string } };
    expect(body.runtime.host).toBe("mock");
  });

  test("200 returns vps_docker host when runtime.host is vps_docker", async () => {
    const db = createMigratedDatabase();
    seedProfile(db, JSON.stringify({ runtime: { host: "vps_docker" } }));
    const env = makeEnv(db);
    const res = await worker.fetch(
      call("GET", `/api/v1/profiles/${TENANT}/${SLUG}/runtime`),
      env,
      {},
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runtime: { host: string } };
    expect(body.runtime.host).toBe("vps_docker");
  });

  test("404 when profile does not exist in DB", async () => {
    const db = createMigratedDatabase();
    // No profile seeded.
    const env = makeEnv(db);
    const res = await worker.fetch(
      call("GET", `/api/v1/profiles/${TENANT}/${SLUG}/runtime`),
      env,
      {},
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("profile_not_found");
  });

  test("400 when tenantId contains invalid characters", async () => {
    const db = createMigratedDatabase();
    const env = makeEnv(db);
    const res = await worker.fetch(
      call("GET", `/api/v1/profiles/bad%20tenant/${SLUG}/runtime`),
      env,
      {},
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_profile_id");
  });

  test("401 or 403 when Authorization header is missing", async () => {
    const db = createMigratedDatabase();
    seedProfile(db);
    const env = makeEnv(db);
    const res = await worker.fetch(
      new Request(`https://test.example.com/api/v1/profiles/${TENANT}/${SLUG}/runtime`, {
        method: "GET",
      }),
      env,
      {},
    );
    expect([401, 403]).toContain(res.status);
  });

  test("405 when method is POST", async () => {
    const db = createMigratedDatabase();
    seedProfile(db);
    const env = makeEnv(db);
    const res = await worker.fetch(
      call("POST", `/api/v1/profiles/${TENANT}/${SLUG}/runtime`),
      env,
      {},
    );
    expect(res.status).toBe(405);
  });
});
