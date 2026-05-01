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

// ---- agent transition probes ---------------------------------------------
//
// Verify hot state agent merges and operator transition routes work
// end-to-end. Always restore to active state at the end so re-running is
// safe.

async function postAction(path: string) {
  return fetch(`${WORKER_URL}${path}`, {
    method: "POST",
    headers: { ...auth, "x-symphony-operator": "smoke", "x-symphony-reason": "smoke-test" },
  });
}

async function getStateJson() {
  const r = await fetch(`${WORKER_URL}/api/v1/state`, { headers: auth });
  return JSON.parse(await r.text()) as {
    tenants: Array<{ id: string; status: string; agent?: { status: string } }>;
    profiles: Array<{ tenant_id: string; slug: string; status: string; agent?: { status: string } }>;
  };
}

const tenantId = "personal";
const profileSlug = "content-wechat";

console.error("\n[transition probes]");

// 1. Tenant: pause -> verify both D1 status and agent hot state -> resume
await probe("POST tenant pause", 200, () =>
  postAction(`/api/v1/tenants/${tenantId}/actions/pause`),
);
{
  const s = await getStateJson();
  const t = s.tenants.find((x) => x.id === tenantId);
  const ok = t?.status === "paused" && t?.agent?.status === "paused";
  console.error(`${stamp()} [${ok ? "PASS" : "FAIL"}] tenant.status mirrored to D1+agent: D1=${t?.status} agent=${t?.agent?.status}`);
  if (!ok) failures++;
}
await probe("POST tenant resume", 200, () =>
  postAction(`/api/v1/tenants/${tenantId}/actions/resume`),
);
{
  const s = await getStateJson();
  const t = s.tenants.find((x) => x.id === tenantId);
  const ok = t?.status === "active" && t?.agent?.status === "active";
  console.error(`${stamp()} [${ok ? "PASS" : "FAIL"}] tenant returned to active: D1=${t?.status} agent=${t?.agent?.status}`);
  if (!ok) failures++;
}

// 2. Project: drain -> resume
await probe("POST project drain", 200, () =>
  postAction(`/api/v1/projects/${tenantId}/${profileSlug}/actions/drain`),
);
{
  const s = await getStateJson();
  const p = s.profiles.find((x) => x.tenant_id === tenantId && x.slug === profileSlug);
  const ok = p?.status === "draining" && p?.agent?.status === "draining";
  console.error(`${stamp()} [${ok ? "PASS" : "FAIL"}] project.status mirrored to D1+agent: D1=${p?.status} agent=${p?.agent?.status}`);
  if (!ok) failures++;
}
await probe("POST project resume", 200, () =>
  postAction(`/api/v1/projects/${tenantId}/${profileSlug}/actions/resume`),
);

// 3. Invalid transition: tenant suspend then drain (drain not allowed on tenant)
const invalidRes = await fetch(`${WORKER_URL}/api/v1/tenants/${tenantId}/actions/drain`, {
  method: "POST",
  headers: auth,
});
{
  const ok = invalidRes.status === 404;
  console.error(`${stamp()} [${ok ? "PASS" : "FAIL"}] tenant 'drain' route does not exist (404 expected, got ${invalidRes.status})`);
  if (!ok) failures++;
}

if (failures > 0) {
  console.error(`\nFAIL: ${failures} probe(s) failed`);
  process.exit(1);
}
console.error(`\nOK: all probes passed`);
