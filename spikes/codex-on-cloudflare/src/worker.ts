// Cloudflare Worker entrypoint for the codex-on-cloudflare spike.
// Routes inbound HTTP/WebSocket traffic to a Container instance hosting
// `codex app-server`. The Worker itself does not run codex; the Container does.
//
// Routes:
//   GET /healthz     -> proxy to container /healthz
//   POST /run-turn   -> proxy to container /run-turn
//   GET /            -> banner

import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  CODEX_CONTAINER: DurableObjectNamespace<CodexContainer>;
  CODEX_AUTH_JSON?: string;
  OPENAI_API_KEY?: string;
}

export class CodexContainer extends Container<Env> {
  // Container exposes its bridge on 8080 (see container/server.mjs).
  defaultPort = 8080;
  // Reclaim idle instances quickly during a spike. Tune after first run.
  sleepAfter = "5m";

  override envVars(): Record<string, string> {
    return {
      CODEX_AUTH_JSON: this.env.CODEX_AUTH_JSON ?? "",
      OPENAI_API_KEY: this.env.OPENAI_API_KEY ?? "",
    };
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      return new Response(
        "symphony-codex-spike: POST /run-turn or GET /healthz",
        { status: 200, headers: { "content-type": "text/plain" } },
      );
    }
    const container = getContainer(env.CODEX_CONTAINER);
    return container.fetch(req);
  },
};
