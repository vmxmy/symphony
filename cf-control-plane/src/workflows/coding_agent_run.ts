import type { Ticket } from "../tickets/types.js";

export type CodingAgentRunAdapterKind = "mock" | "codex_compat";

export type CodingAgentRunReference = {
  kind: "coding_agent_run";
  tenantId: string;
  ticketId: string;
  workflowInstanceId: string;
  workflowStepId: string;
  runId: string;
  issueId: string;
  profileSlug: string;
  externalId: string;
  identifier: string;
  attempt: number;
  adapterKind: CodingAgentRunAdapterKind;
  status: "referenced";
};

export function buildCodingAgentRunReference(input: {
  ticket: Ticket;
  workflowInstanceId: string;
  workflowStepId: string;
  stepInput: Record<string, unknown>;
}): CodingAgentRunReference {
  const profileSlug = stringOption(input.stepInput, "profileSlug") ?? stringOption(input.stepInput, "profile_slug") ?? "generic";
  const externalId = stringOption(input.stepInput, "externalId") ?? stringOption(input.stepInput, "external_id") ?? input.ticket.id;
  const identifier = stringOption(input.stepInput, "identifier") ?? input.ticket.key;
  const attempt = integerOption(input.stepInput, "attempt") ?? 0;
  const runId = stringOption(input.stepInput, "runId") ?? stringOption(input.stepInput, "run_id") ?? `run:${input.ticket.tenantId}:${profileSlug}:${externalId}:${attempt}`;

  return {
    kind: "coding_agent_run",
    tenantId: input.ticket.tenantId,
    ticketId: input.ticket.id,
    workflowInstanceId: input.workflowInstanceId,
    workflowStepId: input.workflowStepId,
    runId,
    issueId: `${input.ticket.tenantId}/${profileSlug}:${externalId}`,
    profileSlug,
    externalId,
    identifier,
    attempt,
    adapterKind: codingAdapterKind(input.stepInput),
    status: "referenced",
  };
}

export function codingAgentRunOutputRef(reference: CodingAgentRunReference): string {
  return `coding-agent-run://${encodeURIComponent(reference.runId)}`;
}

function codingAdapterKind(input: Record<string, unknown>): CodingAgentRunAdapterKind {
  const value = stringOption(input, "adapterKind") ?? stringOption(input, "adapter_kind");
  return value === "codex_compat" ? "codex_compat" : "mock";
}

function stringOption(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integerOption(input: Record<string, unknown>, key: string): number | null {
  const value = input[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
