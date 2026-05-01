export const CONTROL_PLANE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function assertControlPlaneId(kind: string, value: string): void {
  if (!value || !CONTROL_PLANE_ID_PATTERN.test(value)) {
    throw new Error(`${kind}_invalid: expected [A-Za-z0-9._-]+`);
  }
}

export function isControlPlaneId(value: string): boolean {
  return CONTROL_PLANE_ID_PATTERN.test(value);
}

export function durableObjectName(
  kind: "tenant" | "project" | "issue",
  ...parts: string[]
): string {
  for (const part of parts) assertControlPlaneId(kind, part);
  return [kind, ...parts.map(encodeURIComponent)].join(":");
}
