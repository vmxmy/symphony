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

const TOKEN = "test-bearer-token";

type SqliteDb = ReturnType<typeof createMigratedDatabase>;

function makeEnv(db: SqliteDb) {
  return {
    DB: asD1(db),
    OPERATOR_TOKEN: TOKEN,
    ARTIFACTS: {
      async put() {
        return {} as R2Object;
      },
    } as unknown as R2Bucket,
    EXECUTION_WORKFLOW: {
      async get(_id: string) {
        throw new Error("G2C must not launch or inspect workflow instances");
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

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://test.example.com" + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "X-Symphony-Tenant": "tenant_1",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createTicket(env: ReturnType<typeof makeEnv>, overrides: Record<string, unknown> = {}) {
  const res = await worker.fetch(
    request("POST", "/api/v2/tickets", {
      tenantId: "tenant_1",
      type: "vendor_review",
      title: "Review ACME Data Ltd",
      description: "Need vendor due diligence before signature.",
      priority: "high",
      workflowKey: "vendor-due-diligence",
      input: { vendor_name: "ACME Data Ltd", country: "UK" },
      ...overrides,
    }),
    env,
    {},
  );
  return res;
}

function tableCount(db: SqliteDb, table: string, where = "1 = 1"): number {
  return (db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get() as { count: number }).count;
}

describe("G3 Ticket API v2 routes", () => {
  test("POST /api/v2/tickets creates a canonical ticket without Linear credentials", async () => {
    const db = createMigratedDatabase();
    const env = makeEnv(db);
    expect("LINEAR_API_KEY" in env).toBe(false);

    const res = await createTicket(env);

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      ticketId: string;
      ticketKey: string;
      workflowInstanceId: string | null;
      status: string;
      source: { sourceKind: string; externalId: string | null };
    };
    expect(body.ticketId).toBeString();
    expect(body.ticketKey).toStartWith("TKT-");
    expect(body.workflowInstanceId).toBeNull();
    expect(body.status).toBe("CREATED");
    expect(body.source.sourceKind).toBe("api");
    expect(body.source.externalId).toBeNull();
    expect(tableCount(db, "tickets")).toBe(1);
    expect(tableCount(db, "ticket_sources")).toBe(1);
    expect(tableCount(db, "audit_events", "action = 'ticket.created'")).toBe(1);
  });

  test("GET list and detail expose ticket metadata, source, placeholders, and audit summaries", async () => {
    const db = createMigratedDatabase();
    const env = makeEnv(db);
    const created = await createTicket(env, {
      source: { kind: "api", externalKey: "manual-request" },
      tags: ["procurement"],
    });
    const createdBody = (await created.json()) as { ticketId: string };
    await createTicket(env, { workflowKey: "contract-review", type: "contract_review", title: "Review MSA" });

    const list = await worker.fetch(
      request("GET", "/api/v2/tickets?tenantId=tenant_1&workflowKey=vendor-due-diligence&status=CREATED"),
      env,
      {},
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { tickets: Array<{ id: string; workflowKey: string; input: { vendor_name?: string }; tags: string[] }> };
    expect(listBody.tickets).toHaveLength(1);
    expect(listBody.tickets[0]?.id).toBe(createdBody.ticketId);
    expect(listBody.tickets[0]?.workflowKey).toBe("vendor-due-diligence");
    expect(listBody.tickets[0]?.input.vendor_name).toBe("ACME Data Ltd");
    expect(listBody.tickets[0]?.tags).toEqual(["procurement"]);

    const detail = await worker.fetch(request("GET", `/api/v2/tickets/${createdBody.ticketId}`), env, {});
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      ticket: { id: string; status: string };
      sources: Array<{ sourceKind: string; externalKey: string | null }>;
      comments: unknown[];
      activeWorkflow: unknown | null;
      currentWaitingItem: unknown | null;
      artifactCount: number;
      recentAudits: Array<{ action: string }>;
    };
    expect(detailBody.ticket.id).toBe(createdBody.ticketId);
    expect(detailBody.ticket.status).toBe("CREATED");
    expect(detailBody.sources).toMatchObject([{ sourceKind: "api", externalKey: "manual-request" }]);
    expect(detailBody.comments).toEqual([]);
    expect(detailBody.activeWorkflow).toBeNull();
    expect(detailBody.currentWaitingItem).toBeNull();
    expect(detailBody.artifactCount).toBe(0);
    expect(detailBody.recentAudits.map((event) => event.action)).toContain("ticket.created");
  });

  test("POST comments inserts a comment and writes an audit event", async () => {
    const db = createMigratedDatabase();
    const env = makeEnv(db);
    const created = await createTicket(env);
    const { ticketId } = (await created.json()) as { ticketId: string };

    const res = await worker.fetch(
      request("POST", `/api/v2/tickets/${ticketId}/comments`, {
        body: "Requester uploaded the missing vendor policy document.",
        visibility: "external_sync",
      }),
      env,
      {},
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { comment: { ticketId: string; body: string; visibility: string; authorType: string } };
    expect(body.comment.ticketId).toBe(ticketId);
    expect(body.comment.body).toContain("missing vendor policy");
    expect(body.comment.visibility).toBe("external_sync");
    expect(body.comment.authorType).toBe("human");
    expect(tableCount(db, "ticket_comments")).toBe(1);
    expect(tableCount(db, "audit_events", "action = 'ticket.comment.created'")).toBe(1);
  });

  test("POST events records external event audit evidence", async () => {
    const db = createMigratedDatabase();
    const env = makeEnv(db);
    const created = await createTicket(env);
    const { ticketId } = (await created.json()) as { ticketId: string };

    const res = await worker.fetch(
      request("POST", `/api/v2/tickets/${ticketId}/events`, {
        type: "external_response_received",
        correlationKey: "vendor-docs",
        payload: { from: "vendor@example.com", message: "Supplemental materials uploaded." },
      }),
      env,
      {},
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as { event: { action: string; actorType: string; actorId: string; payloadRef: string } };
    expect(body.event.action).toBe("ticket.event.received");
    expect(body.event.actorType).toBe("connector");
    expect(body.event.actorId).toBe("operator-token");
    expect(JSON.parse(body.event.payloadRef)).toMatchObject({
      type: "external_response_received",
      correlationKey: "vendor-docs",
    });
    expect(tableCount(db, "audit_events", "action = 'ticket.event.received'")).toBe(1);
    expect(tableCount(db, "ticket_comments")).toBe(0);
  });

  test("tenant scope and source namespace rules protect v2 tickets", async () => {
    const db = createMigratedDatabase();
    const env = makeEnv(db);

    const reservedSource = await createTicket(env, {
      source: { kind: "linear", externalId: "lin_1", externalKey: "SYM-1" },
    });
    expect(reservedSource.status).toBe(400);
    expect((await reservedSource.json()) as { error: string }).toMatchObject({ error: "reserved_source_kind" });
    expect(tableCount(db, "tickets")).toBe(0);

    const forbiddenTenant = await worker.fetch(
      request("POST", "/api/v2/tickets", {
        tenantId: "tenant_2",
        type: "vendor_review",
        title: "Wrong tenant",
        workflowKey: "vendor-due-diligence",
      }),
      env,
      {},
    );
    expect(forbiddenTenant.status).toBe(403);
    expect((await forbiddenTenant.json()) as { error: string }).toMatchObject({ error: "tenant_forbidden" });

    const created = await createTicket(env);
    const { ticketId } = (await created.json()) as { ticketId: string };
    const forbiddenDetail = await worker.fetch(
      request("GET", `/api/v2/tickets/${ticketId}`, undefined, { "X-Symphony-Tenant": "tenant_2" }),
      env,
      {},
    );
    expect(forbiddenDetail.status).toBe(403);
    expect((await forbiddenDetail.json()) as { error: string }).toMatchObject({ error: "ticket_tenant_forbidden" });
  });

  test("invalid input, not found, auth, and method errors use JSON error responses", async () => {
    const db = createMigratedDatabase();
    const env = makeEnv(db);

    const invalidCreate = await worker.fetch(
      request("POST", "/api/v2/tickets", { tenantId: "tenant_1", type: "vendor_review", workflowKey: "vendor-due-diligence" }),
      env,
      {},
    );
    expect(invalidCreate.status).toBe(400);
    expect((await invalidCreate.json()) as { error: string }).toMatchObject({ error: "missing_field" });

    const missingComment = await worker.fetch(
      request("POST", "/api/v2/tickets/missing/comments", { body: "hello" }),
      env,
      {},
    );
    expect(missingComment.status).toBe(404);
    expect((await missingComment.json()) as { error: string }).toMatchObject({ error: "not_found" });

    const unauthenticated = await worker.fetch(
      new Request("https://test.example.com/api/v2/tickets", { method: "GET" }),
      env,
      {},
    );
    expect(unauthenticated.status).toBe(401);

    const wrongMethod = await worker.fetch(request("DELETE", "/api/v2/tickets"), env, {});
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET, POST");
  });
});
