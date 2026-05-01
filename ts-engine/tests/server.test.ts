import { describe, expect, test } from "bun:test";
import { createServerFetchHandler } from "../src/server.js";
import { State } from "../src/state.js";
import type { Issue } from "../src/types.js";

type StateBody = {
  counts: {
    running: number;
    retrying: number;
  };
  codex_totals: {
    total_tokens: number;
  };
};

type DetailBody = {
  status: "running" | "retrying";
  issue_id: string;
  issue_identifier: string;
  workspace: { path: string; host: string | null } | null;
};

type RefreshBody = {
  queued: boolean;
  operations: string[];
};

type ErrorBody = {
  error: string;
  key: string;
};

describe("server fetch handler", () => {
  test("serves dashboard HTML through the modular renderer", async () => {
    const { handler } = makeHandler();
    const response = await handler(new Request("http://localhost/"));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html).toContain("Symphony TS");
    expect(html).toContain("No active agents");
    expect(html).toContain("No retries queued");
  });

  test("preserves the state API contract", async () => {
    const { handler, state } = makeHandler();
    state.startAgent(issue("issue-1", "SYM-1", "In Progress"), "/tmp/sym-1");

    const response = await handler(new Request("http://localhost/api/v1/state"));
    const body = await response.json() as StateBody;

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(body.counts.running).toBe(1);
    expect(body.counts.retrying).toBe(0);
    expect(body.codex_totals.total_tokens).toBe(0);
  });

  test("preserves issue detail and not-found behavior", async () => {
    const { handler, state } = makeHandler();
    state.startAgent(issue("issue-1", "SYM-1", "Review"), "/tmp/sym-1");

    const found = await handler(new Request("http://localhost/api/v1/SYM-1"));
    const foundBody = await found.json() as DetailBody;
    const missing = await handler(new Request("http://localhost/api/v1/missing"));
    const missingBody = await missing.json() as ErrorBody;

    expect(found.status).toBe(200);
    expect(foundBody.status).toBe("running");
    expect(foundBody.issue_id).toBe("issue-1");
    expect(foundBody.issue_identifier).toBe("SYM-1");
    expect(foundBody.workspace).toEqual({ path: "/tmp/sym-1", host: null });
    expect(missing.status).toBe(404);
    expect(missingBody).toEqual({ error: "not_found", key: "missing" });
  });

  test("preserves refresh API behavior", async () => {
    const { handler, refreshCalls } = makeHandler();

    const response = await handler(new Request("http://localhost/api/v1/refresh", { method: "POST" }));
    const body = await response.json() as RefreshBody;

    expect(response.status).toBe(202);
    expect(refreshCalls()).toBe(1);
    expect(body.queued).toBe(true);
    expect(body.operations).toEqual(["poll", "reconcile"]);
  });
});

function makeHandler(): {
  handler: ReturnType<typeof createServerFetchHandler>;
  state: State;
  refreshCalls: () => number;
} {
  const state = new State();
  let calls = 0;
  const handler = createServerFetchHandler({
    state,
    orchestrator: {
      refresh: () => {
        calls += 1;
      },
    },
  });

  return {
    handler,
    state,
    refreshCalls: () => calls,
  };
}

function issue(id: string, identifier: string, state: string): Issue {
  return {
    id,
    identifier,
    title: null,
    description: null,
    state,
    priority: null,
    url: null,
    branchName: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}
