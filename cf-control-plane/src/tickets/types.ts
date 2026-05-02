export type TicketStatus =
  | "CREATED"
  | "TRIAGING"
  | "NEEDS_INFO"
  | "PLANNING"
  | "PLAN_REVIEW"
  | "RUNNING"
  | "WAITING_HUMAN"
  | "WAITING_EXTERNAL"
  | "VALIDATING"
  | "REWORK"
  | "FINAL_REVIEW"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "EXPIRED";

export type TicketPriority = "low" | "normal" | "high" | "urgent";

export type Ticket = {
  id: string;
  tenantId: string;
  key: string;
  type: string;
  title: string;
  description: string | null;
  requester: string | null;
  owner: string | null;
  priority: TicketPriority;
  status: TicketStatus;
  workflowKey: string;
  workflowVersion: number | null;
  inputJson: string | null;
  tagsJson: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type TicketSource = {
  id: string;
  tenantId: string;
  ticketId: string;
  sourceKind: string;
  externalId: string | null;
  externalKey: string | null;
  externalUrl: string | null;
  syncStatus: string;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TicketSourceResult = {
  ticket: Ticket;
  source: TicketSource;
  createdTicket: boolean;
  createdSource: boolean;
};
