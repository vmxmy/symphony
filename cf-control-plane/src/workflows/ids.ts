export const WORKFLOW_INSTANCE_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9-_]{0,99}$/;

export function executionRunId(
  tenantId: string,
  slug: string,
  externalId: string,
  attempt: number,
): string {
  return `run:${tenantId}:${slug}:${externalId}:${attempt}`;
}

export function executionWorkflowInstanceId(
  tenantId: string,
  slug: string,
  externalId: string,
  attempt: number,
): string {
  const candidate = ["run", tenantId, slug, externalId, String(attempt)]
    .map((part) => part.replace(/[^A-Za-z0-9_-]+/g, "-"))
    .join("-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "run-");

  if (candidate.length <= 100 && WORKFLOW_INSTANCE_ID_PATTERN.test(candidate)) {
    return candidate;
  }

  const hash = stableHashHex(`${tenantId}\0${slug}\0${externalId}\0${attempt}`);
  const prefix = candidate.slice(0, 100 - hash.length - 1).replace(/-+$/, "");
  const shortened = `${prefix || "run"}-${hash}`;
  return WORKFLOW_INSTANCE_ID_PATTERN.test(shortened) ? shortened : `run-${hash}`;
}

function stableHashHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
