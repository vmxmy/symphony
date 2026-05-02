export {};

// check-phase6-invariants.ts — Phase 6 PR-A grep-gates enforcement (R16).
//
// Enforces two invariants from docs/cloudflare-agent-native-phase6-plan.md §3 R16:
//
// INVARIANT 1 — ADR-0001: no WorkerHostKind dispatch outside src/runtime/
//   Files under src/ that are NOT in src/runtime/ must not contain switch/if
//   trees branching on WorkerHostKind string literals.  The heuristic used:
//   any .ts file outside src/runtime/ that contains patterns of the form
//     case "vps_docker" | case "cloudflare_container" | case "mock"
//   or equality checks
//     === "vps_docker" | === "cloudflare_container" | === "mock"
//   is flagged as a violation.  False negatives (creative branching patterns)
//   are tolerable; false positives (legitimate adapter wiring inside runtime/)
//   are suppressed by the path exclusion.  Non-runtime test/mock files
//   containing the mock adapter name are also excluded to avoid flagging
//   mock_coding_adapter.ts which references the literal in a different context.
//
// INVARIANT 2 — 16 canonical step names
//   Verifies that execution.ts contains exactly the 16 expected recordStep
//   calls (sequence 1-16) with the canonical step names, in order.
//   Also verifies that target.md §8.4 contains all 16 descriptive step entries.
//
// Usage: bun run scripts/check-phase6-invariants.ts

import { readdir, readFile } from "fs/promises";
import { join, relative } from "path";

// ---------------------------------------------------------------------------
// Canonical step names — single source of truth.
// These must match the recordStep(env, runId, N, "NAME", ...) calls in
// src/workflows/execution.ts exactly.
// ---------------------------------------------------------------------------
const CANONICAL_STEPS = [
  "loadProfileAndIssue",
  "acquireLease",
  "prepareWorkspace",
  "materializeAssets",
  "afterCreateHook",
  "renderPrompt",
  "beforeRunHook",
  "runAgentTurnLoop",
  "handleToolCalls",
  "pollTrackerBetweenTurns",
  "persistRunArtifacts",
  "afterRunHook",
  "validateCompletion",
  "transitionIssueState",
  "archiveOrCleanupWorkspace",
  "releaseLeaseAndNotify",
] as const;

// ADR-0001 violation patterns: WorkerHostKind literals in switch/if context.
const CASE_PATTERNS = [
  /case\s+"vps_docker"/,
  /case\s+"cloudflare_container"/,
  /case\s+"mock"/,
];
const EQ_PATTERNS = [
  /===\s+"vps_docker"/,
  /===\s+"cloudflare_container"/,
  /===\s+"mock"/,
];

const REPO_ROOT = join(import.meta.dir, "..");
const SRC_DIR = join(REPO_ROOT, "src");
const RUNTIME_DIR = join(SRC_DIR, "runtime");
const EXECUTION_FILE = join(SRC_DIR, "workflows", "execution.ts");
const TARGET_MD = join(REPO_ROOT, "..", "docs", "cloudflare-agent-native-target.md");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectTsFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectTsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

function isRuntimeFile(filePath: string): boolean {
  return filePath.startsWith(RUNTIME_DIR + "/") || filePath === RUNTIME_DIR;
}

// Files that legitimately reference the "mock" literal in non-dispatch context.
const EXCLUDED_FROM_EQ_CHECK = new Set([
  "mock_coding_adapter.ts",
  "mock_run.ts",
]);

function isExcludedFromEqCheck(filePath: string): boolean {
  const base = filePath.split("/").at(-1) ?? "";
  return EXCLUDED_FROM_EQ_CHECK.has(base);
}

// ---------------------------------------------------------------------------
// Invariant 1: ADR-0001 enforcement
// ---------------------------------------------------------------------------

async function checkAdr0001(): Promise<string[]> {
  const violations: string[] = [];
  const allFiles = await collectTsFiles(SRC_DIR);

  for (const file of allFiles) {
    if (isRuntimeFile(file)) continue;

    const src = await readFile(file, "utf8");
    const rel = relative(REPO_ROOT, file);

    // Check case-style dispatch (always flagged outside runtime)
    for (const pat of CASE_PATTERNS) {
      if (pat.test(src)) {
        violations.push(
          `ADR-0001 violation: ${rel} — switch/case on WorkerHostKind literal (${pat.source})`,
        );
        break;
      }
    }

    // Check equality-style dispatch (skip known mock adapter files)
    if (!isExcludedFromEqCheck(file)) {
      for (const pat of EQ_PATTERNS) {
        if (pat.test(src)) {
          violations.push(
            `ADR-0001 violation: ${rel} — equality check on WorkerHostKind literal (${pat.source})`,
          );
          break;
        }
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Invariant 2: 16 canonical step names in execution.ts
// ---------------------------------------------------------------------------

async function checkCanonicalSteps(): Promise<string[]> {
  const errors: string[] = [];
  const src = await readFile(EXECUTION_FILE, "utf8");

  // Extract all recordStep(..., N, "NAME", ...) occurrences in source order.
  // Handles both inline and multi-line call forms.
  // Pattern: recordStep( <ws> env, <ws> runId, <ws> N, <ws> "NAME"
  const RE =
    /recordStep\s*\(\s*\S+\s*,\s*\S+\s*,\s*(\d+)\s*,\s*"([^"]+)"/g;

  const found: Array<{ seq: number; name: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = RE.exec(src)) !== null) {
    found.push({ seq: parseInt(m[1]!, 10), name: m[2]! });
  }

  if (found.length !== CANONICAL_STEPS.length) {
    errors.push(
      `execution.ts: expected ${CANONICAL_STEPS.length} recordStep calls, found ${found.length}`,
    );
    return errors;
  }

  for (let i = 0; i < CANONICAL_STEPS.length; i++) {
    const expected = { seq: i + 1, name: CANONICAL_STEPS[i] };
    const actual = found[i];
    if (actual === undefined) {
      errors.push(`step ${i + 1}: missing`);
    } else if (actual.seq !== expected.seq || actual.name !== expected.name) {
      errors.push(
        `step ${i + 1}: expected (${expected.seq}, "${expected.name}"), got (${actual.seq}, "${actual.name}")`,
      );
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Invariant 2b: target.md §8.4 contains all 16 step descriptions
// ---------------------------------------------------------------------------

async function checkTargetMd(): Promise<string[]> {
  const errors: string[] = [];
  const src = await readFile(TARGET_MD, "utf8");

  // §8.4 uses numbered prose descriptions, not code identifiers.
  // Verify the section exists and has at least 16 numbered items.
  const section84Start = src.indexOf("### 8.4 ExecutionWorkflow");
  if (section84Start === -1) {
    errors.push("target.md: section '### 8.4 ExecutionWorkflow' not found");
    return errors;
  }

  // Find the end of the section (next ###)
  const sectionEnd = src.indexOf("\n### ", section84Start + 1);
  const section = sectionEnd === -1 ? src.slice(section84Start) : src.slice(section84Start, sectionEnd);

  // Count numbered list items (lines starting with a digit followed by ".")
  const numberedItems = (section.match(/^\d+\./gm) ?? []).length;
  if (numberedItems < 16) {
    errors.push(
      `target.md §8.4: expected at least 16 numbered step entries, found ${numberedItems}`,
    );
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let anyFailure = false;

  // Invariant 1
  const adr0001Violations = await checkAdr0001();
  if (adr0001Violations.length > 0) {
    anyFailure = true;
    for (const v of adr0001Violations) {
      console.error(`FAIL: ${v}`);
    }
  }

  // Invariant 2
  const stepErrors = await checkCanonicalSteps();
  if (stepErrors.length > 0) {
    anyFailure = true;
    for (const e of stepErrors) {
      console.error(`FAIL: ${e}`);
    }
  }

  // Invariant 2b
  const mdErrors = await checkTargetMd();
  if (mdErrors.length > 0) {
    anyFailure = true;
    for (const e of mdErrors) {
      console.error(`FAIL: ${e}`);
    }
  }

  if (anyFailure) {
    process.exit(1);
  }

  console.log("phase6 invariants: OK");
}

await main();
