// Operator CLI: import a v1 profile bundle into the Cloudflare control-plane D1.
//
// Usage:
//   bun run scripts/import-profile.ts \
//     --profile ../profiles/content-wechat \
//     [--tenant personal] \
//     [--remote|--local]
//
// Behavior:
//   1. Reads <profile>/profile.yaml and <profile>/WORKFLOW.md.
//   2. Calls upgradeV1ToV2() to produce the v2 normalized config + import
//      bookkeeping (defaults_applied, warnings).
//   3. Generates an INSERT-OR-IGNORE for tenants and an INSERT-OR-REPLACE
//      for profiles, written to a temp .sql file.
//   4. Shells out to `wrangler d1 execute symphony-control-plane --file=<tmp>`
//      with --local (default) or --remote. The wrangler binding name `DB`
//      from wrangler.toml is what the future Worker uses.
//   5. Prints the import-record summary so the operator can see which
//      fields were defaulted and which warnings fired.
//
// R2 source-bundle/normalized-config persistence is intentionally NOT done
// in this commit. source_bundle_ref and normalized_config_ref columns are
// left NULL and the README's "Phase 2 readiness mapping" is updated when
// the R2 bucket is provisioned.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import {
  upgradeV1ToV2,
  type V1ProfileYaml,
  type V1WorkflowFrontMatter,
} from "./v1_to_v2.ts";

type Args = {
  profilePath: string;
  tenant: string;
  target: "local" | "remote";
};

function parseArgs(argv: string[]): Args {
  const args: Args = { profilePath: "", tenant: "personal", target: "local" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") args.profilePath = argv[++i] ?? "";
    else if (a === "--tenant") args.tenant = argv[++i] ?? args.tenant;
    else if (a === "--remote") args.target = "remote";
    else if (a === "--local") args.target = "local";
    else if (a === "--help" || a === "-h") {
      console.error("Usage: bun run scripts/import-profile.ts --profile <path> [--tenant <id>] [--remote|--local]");
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!args.profilePath) {
    console.error("missing --profile <path>");
    process.exit(2);
  }
  return args;
}

function loadProfileYaml(path: string): V1ProfileYaml {
  const raw = readFileSync(path, "utf8");
  return parseYaml(raw) as V1ProfileYaml;
}

function loadWorkflowFrontMatter(path: string): V1WorkflowFrontMatter {
  const raw = readFileSync(path, "utf8");
  // Front matter is fenced by --- ... --- at the file head.
  if (!raw.startsWith("---")) {
    throw new Error(`WORKFLOW.md does not start with YAML front matter at ${path}`);
  }
  const closing = raw.indexOf("\n---", 3);
  if (closing < 0) throw new Error(`WORKFLOW.md front matter not closed at ${path}`);
  const yaml = raw.slice(3, closing).trim();
  return parseYaml(yaml) as V1WorkflowFrontMatter;
}

function escapeSqlText(s: string): string {
  return s.replace(/'/g, "''");
}

function sqlString(s: string): string {
  return `'${escapeSqlText(s)}'`;
}

function sqlJson(value: unknown): string {
  return sqlString(JSON.stringify(value));
}

function nowIso(): string {
  return new Date().toISOString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profileDir = resolve(args.profilePath);
  const profileYamlPath = join(profileDir, "profile.yaml");
  const workflowPath = join(profileDir, "WORKFLOW.md");

  const profileYaml = loadProfileYaml(profileYamlPath);
  const workflowFrontMatter = loadWorkflowFrontMatter(workflowPath);

  const slug = String(profileYaml.name ?? basename(profileDir));
  const version = String(profileYaml.version ?? "0.0.0");

  const record = upgradeV1ToV2({
    tenant: args.tenant,
    profile: slug,
    profileYaml,
    workflowFrontMatter,
  });

  const tenantId = args.tenant;
  const profileId = `${tenantId}/${slug}@${version}`;
  const now = nowIso();

  const trackerKind = record.v2.tracker.kind;
  const runtimeKind = record.v2.runtime.kind;

  const tenantPolicy = {
    maxProjects: 10,
    maxRunningIssues: 4,
    requireHumanApprovalFor: [],
    allowedTrackerKinds: ["linear", "cloudflare"],
    allowedToolNames: [],
  };

  const sql = [
    `INSERT OR IGNORE INTO tenants (id, name, status, policy_json, created_at, updated_at) VALUES (`,
    `  ${sqlString(tenantId)},`,
    `  ${sqlString(tenantId)},`,
    `  'active',`,
    `  ${sqlJson(tenantPolicy)},`,
    `  ${sqlString(now)},`,
    `  ${sqlString(now)}`,
    `);`,
    `INSERT OR REPLACE INTO profiles (`,
    `  id, tenant_id, slug, active_version, tracker_kind, runtime_kind, status,`,
    `  config_json, source_schema_version, imported_schema_version,`,
    `  defaults_applied, warnings, source_bundle_ref, normalized_config_ref,`,
    `  imported_at, created_at, updated_at`,
    `) VALUES (`,
    `  ${sqlString(profileId)},`,
    `  ${sqlString(tenantId)},`,
    `  ${sqlString(slug)},`,
    `  ${sqlString(version)},`,
    `  ${sqlString(trackerKind)},`,
    `  ${sqlString(runtimeKind)},`,
    `  'active',`,
    `  ${sqlJson(record.v2)},`,
    `  ${record.source_schema_version},`,
    `  ${record.imported_schema_version},`,
    `  ${sqlJson(record.defaults_applied)},`,
    `  ${sqlJson(record.warnings)},`,
    `  NULL,`,
    `  NULL,`,
    `  ${sqlString(now)},`,
    `  ${sqlString(now)},`,
    `  ${sqlString(now)}`,
    `);`,
  ].join("\n");

  const tmpDir = mkdtempSync(join(tmpdir(), "symphony-import-"));
  const tmpFile = join(tmpDir, "insert.sql");
  writeFileSync(tmpFile, sql, "utf8");

  console.error(`[import] tenant=${tenantId} slug=${slug} version=${version} target=${args.target}`);
  console.error(`[import] defaults_applied=${JSON.stringify(record.defaults_applied)}`);
  console.error(`[import] warnings=${JSON.stringify(record.warnings)}`);

  const targetFlag = args.target === "remote" ? "--remote" : "--local";
  const result = spawnSync(
    "wrangler",
    ["d1", "execute", "symphony-control-plane", targetFlag, "--file", tmpFile],
    { stdio: "inherit" },
  );

  rmSync(tmpDir, { recursive: true, force: true });

  if (result.status !== 0) {
    console.error(`[import] wrangler d1 execute failed with exit ${result.status}`);
    process.exit(result.status ?? 1);
  }

  console.error(`[import] OK; profile_id=${profileId}`);
}

main().catch((err) => {
  console.error(`[import] fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
