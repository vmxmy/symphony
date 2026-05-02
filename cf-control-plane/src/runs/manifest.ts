// R2 manifest writer for Phase 5 ExecutionWorkflow.
//
// Manifest path: runs/{tenant}/{profile}/{issue}/{attempt}/manifest.json.
// Written by step 11 (persistRunArtifacts) of ExecutionWorkflow.
// Deterministic key per run so replay re-writes the same key (R2 1/sec
// per-key cap is irrelevant when key+content are stable). Step input/output
// payloads per step go to runs/.../steps/{seq}.{stepName}.{in|out}.json
// in a future PR; PR-C only writes the run-level manifest.

export type ManifestStepEntry = {
  step_sequence: number;
  step_name: string;
  status: "completed" | "failed" | "skipped" | "running" | "pending";
  duration_ms: number;
};

export type ManifestPayload = {
  schema: "v1";
  run_id: string;
  tenant_id: string;
  slug: string;
  issue_external_id: string;
  attempt: number;
  steps: ManifestStepEntry[];
  started_at: string;
  finished_at: string;
  token_usage: { totalTokens: number; inputTokens: number; outputTokens: number };
  events_count: number;
};

export type ManifestKeyParams = {
  tenant_id: string;
  slug: string;
  external_id: string;
  attempt: number;
};

export function manifestKey(params: ManifestKeyParams): string {
  return `runs/${params.tenant_id}/${params.slug}/${params.external_id}/${params.attempt}/manifest.json`;
}

export async function writeManifest(
  artifacts: R2Bucket,
  params: ManifestKeyParams,
  manifest: ManifestPayload,
): Promise<{ key: string }> {
  const key = manifestKey(params);
  await artifacts.put(key, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
  return { key };
}
