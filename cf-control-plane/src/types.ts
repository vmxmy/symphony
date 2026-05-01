// Shared types reused across cf-control-plane modules. For now these are
// intentionally minimal duplicates of `ts-engine/src/types.ts` so the
// reconcile harness can be specified without depending on the engine
// package. When Phase 3 production code lands, we will likely promote a
// shared `ts-shared` package; until then keep the types tight.

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

export type WorkflowConfig = {
  tracker: {
    activeStates: string[];
    terminalStates: string[];
  };
  agent: {
    maxConcurrentAgents: number;
    maxConcurrentAgentsByState: Record<string, number>;
  };
};
