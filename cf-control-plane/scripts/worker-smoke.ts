// Smoke for the deployed control-plane Worker.
//
// Probes:
//   GET /                   - public banner (200 plain text)
//   GET /api/v1/healthz     - public, must be 200 with db ok
//   GET /api/v1/state       - no token (expect 401)
//   GET /api/v1/state       - with bearer token (expect 200 + tenants/profiles)
//   GET /api/v1/tenants     - with bearer token
//   GET /api/v1/profiles    - with bearer token
//
// Usage:
//   WORKER_URL="https://symphony-control-plane.<sub>.workers.dev" \
//   OPERATOR_TOKEN="<token from wrangler secret>" \
//     bun run scripts/worker-smoke.ts

const WORKER_URL = process.env.WORKER_URL;
const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN;

if (!WORKER_URL) {
  console.error("Set WORKER_URL=https://...workers.dev");
  process.exit(2);
}
if (!OPERATOR_TOKEN) {
  console.error("Set OPERATOR_TOKEN=<token> (must match the wrangler secret)");
  process.exit(2);
}

let failures = 0;
const stamp = () => new Date().toISOString().slice(11, 23);

async function probe(label: string, expect: number, fetcher: () => Promise<Response>) {
  const t0 = Date.now();
  try {
    const r = await fetcher();
    const ms = Date.now() - t0;
    const body = await r.text();
    const ok = r.status === expect;
    console.error(
      `${stamp()} [${ok ? "PASS" : "FAIL"}] ${label.padEnd(36)} ${r.status} (expected ${expect}) ${ms}ms`,
    );
    if (!ok) {
      failures++;
      console.error(`  body: ${body.slice(0, 240)}`);
    }
    return { ok, status: r.status, body };
  } catch (e) {
    failures++;
    console.error(
      `${stamp()} [FAIL] ${label.padEnd(36)} threw after ${Date.now() - t0}ms: ${e}`,
    );
    return { ok: false, status: 0, body: "" };
  }
}

const auth = { authorization: `Bearer ${OPERATOR_TOKEN}` };

await probe("GET / (banner, no auth)", 200, () => fetch(`${WORKER_URL}/`));
await probe("GET /api/v1/healthz (no auth)", 200, () => fetch(`${WORKER_URL}/api/v1/healthz`));
await probe("GET /api/v1/state (no token, expect 401)", 401, () =>
  fetch(`${WORKER_URL}/api/v1/state`),
);
await probe("GET /api/v1/state (wrong token, expect 401)", 401, () =>
  fetch(`${WORKER_URL}/api/v1/state`, { headers: { authorization: "Bearer not-the-token" } }),
);

const stateRes = await probe("GET /api/v1/state (auth)", 200, () =>
  fetch(`${WORKER_URL}/api/v1/state`, { headers: auth }),
);
await probe("GET /api/v1/tenants (auth)", 200, () =>
  fetch(`${WORKER_URL}/api/v1/tenants`, { headers: auth }),
);
await probe("GET /api/v1/profiles (auth)", 200, () =>
  fetch(`${WORKER_URL}/api/v1/profiles`, { headers: auth }),
);

if (stateRes.ok) {
  try {
    const json = JSON.parse(stateRes.body) as {
      tenants: Array<{ id: string }>;
      profiles: Array<{ id: string; defaults_applied: string[]; warnings: string[] }>;
    };
    const tenants = json.tenants?.length ?? 0;
    const profiles = json.profiles?.length ?? 0;
    const sample = json.profiles?.[0];
    console.error(
      `\n[summary] /api/v1/state -> tenants=${tenants} profiles=${profiles} ` +
        `sample=${sample?.id ?? "(none)"} ` +
        `defaults_applied=${sample?.defaults_applied?.length ?? 0} ` +
        `warnings=${sample?.warnings?.length ?? 0}`,
    );
  } catch (e) {
    failures++;
    console.error(`[summary] state body parse failed: ${e}`);
  }
}

if (failures > 0) {
  console.error(`\nFAIL: ${failures} probe(s) failed`);
  process.exit(1);
}
console.error(`\nOK: all probes passed`);
