// Phase 6 R6 default workspace snapshot redaction list.
//
// Plan ref: docs/cloudflare-agent-native-phase6-plan.md §3 R6.
// These globs match the ts-engine workflow-redact defaults; a future
// PR will let profiles override via runtime.snapshot.redact.
//
// The host adapters (MockWorkerHost, VpsDockerHost,
// CloudflareContainerHost) own actual archive creation + redaction
// enforcement. This module ships only the canonical list so it stays
// in one place and step 15 (archiveOrCleanupWorkspace in execution.ts)
// imports a single named export.

export const DEFAULT_REDACT_LIST: readonly string[] = [
  ".env",
  "**/.git/",
  "**/secret*",
  "**/*.key",
  "**/auth*.json",
  "runtime/log/",
];
