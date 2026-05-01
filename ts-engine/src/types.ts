// Shared domain types for symphony-ts engine.
// Mirrors SPEC.md §3.2 normalized issue model and §6 WORKFLOW.md schema.

export type BlockedRef = {
  id: string;
  identifier: string;
  state: string;
};

export type Issue = {
  id: string;
  identifier: string;
  title: string | null;
  description: string | null;
  state: string;
  priority: number | null;
  url: string | null;
  branchName: string | null;
  labels: string[];
  blockedBy: BlockedRef[];
  createdAt: string | null;
  updatedAt: string | null;
};

export type TrackerConfig = {
  kind: "linear";
  endpoint: string;
  apiKey: string;
  projectSlug: string;
  assignee: string | null;
  activeStates: string[];
  terminalStates: string[];
};

export type PollingConfig = {
  intervalMs: number;
};

export type WorkspaceConfig = {
  root: string;
};

export type HooksConfig = {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
};

export type AgentConfig = {
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
  maxConcurrentAgentsByState: Record<string, number>; // keys lowercased
};

export type CodexConfig = {
  command: string;
  approvalPolicy: string | Record<string, unknown>;
  threadSandbox: string;
  turnSandboxPolicy: string | Record<string, unknown>;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
};

export type WorkflowConfig = {
  schemaVersion: number;
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  codex: CodexConfig;
};

export type LoadedWorkflow = {
  config: WorkflowConfig;
  promptTemplate: string; // Liquid template, body of WORKFLOW.md
  rawPath: string; // absolute path to source file
};

// ---- Runtime state ---------------------------------------------------------

export type TokenUsage = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  secondsRunning: number;
};

export type AgentSession = {
  issueId: string;
  issueIdentifier: string;
  state: string;
  workspacePath: string;
  startedAt: string; // ISO
  sessionId: string | null;
  workerHost: string | null;
  turnCount: number;
  tokens: TokenUsage;
  lastEvent: string | null;
  lastEventAt: string | null;
  lastMessage: string | null;
};

export type RetryEntry = {
  issueId: string;
  issueIdentifier: string;
  attempt: number;
  dueAt: string; // ISO
  error: string;
  workspacePath: string | null;
  workerHost: string | null;
};
