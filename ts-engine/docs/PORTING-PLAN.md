# Symphony TypeScript port · Module-by-Module Plan

This is a working document. Each module section lists: purpose, dependencies on
other modules, key types/functions, and what `done` looks like.

Built up in order: foundation → IO → orchestration → presentation.

---

## Tier 0 · Foundation

### `src/types.ts` (✅ done in this PR)

Shared types reflecting Symphony's domain.

```ts
type Issue = {
  id: string;
  identifier: string;        // e.g., "ZII-9"
  title: string | null;
  description: string | null;
  state: string;             // e.g., "Drafting"
  priority: number | null;
  url: string | null;
  branchName: string | null;
  labels: string[];
  blockedBy: BlockedRef[];
  createdAt: string | null;
  updatedAt: string | null;
};

type WorkflowConfig = {
  tracker: { kind: "linear"; projectSlug: string;
             activeStates: string[]; terminalStates: string[];
             apiKey: string; endpoint: string };
  polling: { intervalMs: number };
  workspace: { root: string };
  hooks: { afterCreate?: string; beforeRun?: string;
           afterRun?: string; beforeRemove?: string; timeoutMs: number };
  agent: { maxConcurrentAgents: number; maxTurns: number;
           maxRetryBackoffMs: number;
           maxConcurrentAgentsByState: Record<string, number> };
  codex: { command: string; approvalPolicy: string | object;
           threadSandbox: string;
           turnSandboxPolicy: string | object;
           turnTimeoutMs: number; readTimeoutMs: number; stallTimeoutMs: number };
};

type RuntimeState = {
  running: Map<string, AgentSession>;
  retrying: Map<string, RetryEntry>;
  codexTotals: TokenUsage;
};
```

### `src/workflow.ts` (✅ done — workflow loader)

Reads `WORKFLOW.md`, splits frontmatter + body, applies defaults, returns
`WorkflowConfig` + raw `promptTemplate` string.

`done` when:
- Loads `profiles/content-wechat/WORKFLOW.md` without error
- Frontmatter parses into typed `WorkflowConfig`
- Defaults applied per SPEC §6
- Body returned as opaque string (Liquid render is later)

---

## Tier 1 · IO

### `src/linear.ts` (TODO)

Linear GraphQL client. Wraps `fetch`.

API surface:
```ts
class LinearClient {
  constructor(opts: { apiKey: string; endpoint: string });
  fetchActiveIssues(slug: string, activeStates: string[]): Promise<Issue[]>;
  fetchIssue(id: string): Promise<Issue | null>;
  fetchTerminalIssues(slug: string, terminalStates: string[]): Promise<Issue[]>;
  // Note: state-changing queries are agent-side via linear_graphql tool, not here.
}
```

`done` when:
- Same query shapes as `elixir/lib/symphony_elixir/linear/client.ex`
- Returns issues that match Symphony's filter rules
- Backoff/retry on transient errors

### `src/codex.ts` (CRITICAL — most complex module)

JSON-RPC 2.0 client over child_process stdio for Codex App Server.

API:
```ts
class CodexAppServer {
  constructor(opts: { command: string; cwd: string;
                      approvalPolicy: any; threadSandbox: string;
                      turnSandboxPolicy: any; turnTimeoutMs: number });
  start(): Promise<void>;                        // initialize handshake
  startThread(): Promise<{ threadId: string }>;
  startTurn(threadId: string, prompt: string): Promise<{ turnId: string }>;
  awaitTurn(handlers: TurnHandlers): Promise<TurnResult>;
  stop(): Promise<void>;
}

type TurnHandlers = {
  onItem?: (item: Item) => void;
  onAgentMessageDelta?: (text: string) => void;
  onApprovalRequest?: (req: ApprovalRequest) => Promise<ApprovalResponse>;
  onToolCall?: (call: ToolCall) => Promise<ToolResult>;
};
```

Implementation notes:
- Use `Bun.spawn` or `node:child_process` with `stdio: ['pipe', 'pipe', 'pipe']`
- Newline-delimited JSON-RPC 2.0 messages
- See `elixir/lib/symphony_elixir/codex/app_server.ex` for protocol details
- Inject `linear_graphql` dynamic tool definition
- Auto-approve when `auto_approve_requests=true`

`done` when:
- Initialize → thread/start → turn/start → turn/completed flow works
- `linear_graphql` tool calls round-trip
- Sandbox approvals (workspace-write, danger-full-access) accepted

### `src/workspace.ts` (TODO)

Per-issue workspace lifecycle.

```ts
class WorkspaceManager {
  constructor(opts: { root: string; hooks: WorkflowConfig["hooks"] });
  ensure(issue: Issue): Promise<string>;        // returns absolute path
  remove(issue: Issue): Promise<void>;          // runs before_remove hook then rm
  runHook(name: HookName, cwd: string): Promise<void>;
}
```

`done` when:
- Creates `<root>/<sanitized-identifier>/` per SPEC §9
- Runs `after_create` / `before_run` / `after_run` / `before_remove` via shell
- Sanitizes identifier to filesystem-safe name

---

## Tier 2 · Orchestration

### `src/state.ts` (TODO)

Pure in-memory runtime state, no IO.

```ts
class State {
  running = new Map<string, AgentSession>();
  retrying = new Map<string, RetryEntry>();
  codexTotals = { totalTokens: 0, inputTokens: 0, outputTokens: 0, secondsRunning: 0 };
  countByState(): Record<string, number>;
  canDispatch(issue: Issue, config: WorkflowConfig): boolean;
}
```

### `src/orchestrator.ts` (CRITICAL)

The poll loop + dispatch + retry queue. Heart of Symphony.

```ts
class Orchestrator {
  constructor(deps: {
    linear: LinearClient;
    state: State;
    workspace: WorkspaceManager;
    codex: CodexAppServerFactory;     // factory because we spawn one per issue
    promptBuilder: PromptBuilder;
    config: () => WorkflowConfig;     // function for hot-reload friendliness
    log: Logger;
  });
  start(): Promise<void>;             // launches the poll loop
  refresh(): void;                    // manual trigger (HTTP /refresh)
  stop(): Promise<void>;
}
```

Logic per tick:
1. Fetch active issues from Linear
2. Reconcile against state (terminal states → kill agent + cleanup; non-active+non-terminal → kill agent, keep workspace)
3. For each unclaimed candidate:
   - Check global concurrency
   - Check per-state concurrency  
   - Check retry backoff
4. If dispatchable → spawn agent (workspace + codex + first turn)
5. On turn completion → check issue state (still active? → continuation)

`done` when:
- ZII-9 type lifecycle works end-to-end (Todo→...→Publishing→Done)
- Retry backoff matches SPEC §11
- max_concurrent_agents and max_concurrent_agents_by_state both honored

### `src/prompt.ts` (TODO)

Liquid template render using `liquidjs`. **Crucial**: must NOT corrupt
multi-byte UTF-8. Test with `公` `者` `配` chars before declaring done.

```ts
class PromptBuilder {
  constructor(template: string);
  build(issue: Issue, opts: { attempt?: number }): string;
}
```

`done` when:
- Renders `{{ issue.identifier }}` `{{ issue.state }}` `{{ attempt }}` correctly
- Renders Chinese strings byte-perfect (run smoke test: render with `者`, hash output, compare to expected)
- `{% if attempt %}` block conditional works

### `src/agent_runner.ex` equivalent · `src/agent.ts`

Per-issue agent execution loop. Spawns one CodexAppServer per dispatch.

```ts
class AgentRunner {
  constructor(deps: { codex: CodexAppServerFactory; promptBuilder: PromptBuilder;
                      linear: LinearClient; workspace: WorkspaceManager;
                      log: Logger });
  run(issue: Issue, opts: { attempt: number }): Promise<RunResult>;
}
```

---

## Tier 3 · Presentation

### `src/server.ts` + `src/dashboard/*` (partial)

Bun.serve HTTP API. Endpoints per SPEC §15:

- `GET /api/v1/state` — snapshot of `RuntimeState`
- `GET /api/v1/<issue-identifier>` — single-issue detail
- `POST /api/v1/refresh` — trigger immediate poll
- `GET /` — modular server-rendered HTML dashboard (no LiveView)

```ts
function startServer(opts: { port: number; orchestrator: Orchestrator;
                              state: State }): { stop: () => Promise<void> };
```

Current dashboard boundary:

- `src/server.ts` owns server startup, route registration, and dependency wiring.
- `src/dashboard/view_model.ts` adapts `State.snapshot()` into display-oriented rows and summary data.
- `src/dashboard/render.ts` renders dashboard HTML and centralizes escaping.
- `src/dashboard/styles.ts` keeps the dependency-free CSS module outside route handlers.

Compatibility expectations: preserve `/api/v1/state`,
`/api/v1/<issue-id-or-identifier>`, `POST /api/v1/refresh`, and CLI `--port`
behavior. Future UI work should add compatible fields/endpoints only.

### `src/log.ts` (TODO)

Structured logger writing to `<logs-root>/symphony.log` (compatible format with
Elixir's logger so launcher can tail-aggregate).

### `src/main.ts` (TODO — wires everything)

CLI parser + dependency injection root. Reads CLI args, builds modules, starts
orchestrator + server.

---

## Tier 4 · Polish (post-MVP)

- Hot reload of WORKFLOW.md (`fs.watch`)
- SSH worker support (already handled via shell-out from agent prompt — may not need engine support)
- Phoenix LiveView replacement (not needed; modular plain HTML+JSON is the current path)
- Tests
- Bun.compile single-binary build

---

## Critical decisions for the porter (Codex agent or human)

1. **Don't try 1:1 LOC parity.** SPEC.md is the contract. Elixir reference may
   have idiosyncrasies (the 0x85 bug being one). Match SPEC, not Elixir.
2. **Keep WORKFLOW.md compatibility absolute.** Same YAML schema, same Liquid
   syntax, same hook semantics. Profiles must work unchanged.
3. **Keep CLI contract absolute.** `<binary> <workflow.md> --port N --logs-root DIR
   [--i-understand-...]`.
4. **Profile config compatibility.** `profiles/<name>/profile.yaml`'s
   `symphony.port`, `symphony.workspace_root`, `symphony.bypass_guardrails`
   must produce identical CLI args.
5. **Multi-byte UTF-8 safety.** Liquid render output must preserve bytes
   verbatim. Test with `公` `者` `配` (E5 85 AC, E8 80 85, E9 85 8D) at
   minimum.
