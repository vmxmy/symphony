// Linear GraphQL client. Mirrors elixir/lib/symphony_elixir/linear/client.ex
// query shapes so the engine fetches the same data.

import type { Issue, BlockedRef, TrackerConfig } from "./types.js";

const ISSUE_PAGE_SIZE = 50;
const RELATION_FIRST = 25;

// Same query as Elixir client
const POLL_QUERY = `
query SymphonyLinearPoll($projectSlug: String!, $stateNames: [String!]!, $first: Int!, $relationFirst: Int!, $after: String) {
  issues(filter: {project: {slugId: {eq: $projectSlug}}, state: {name: {in: $stateNames}}}, first: $first, after: $after) {
    nodes {
      id
      identifier
      title
      description
      priority
      state { name }
      branchName
      url
      assignee { id }
      labels { nodes { name } }
      inverseRelations(first: $relationFirst) {
        nodes {
          type
          issue { id identifier state { name } }
        }
      }
      createdAt
      updatedAt
    }
    pageInfo { hasNextPage endCursor }
  }
}
`;

const QUERY_BY_IDS = `
query SymphonyLinearIssuesById($ids: [ID!]!, $first: Int!, $relationFirst: Int!) {
  issues(filter: {id: {in: $ids}}, first: $first) {
    nodes {
      id
      identifier
      title
      description
      priority
      state { name }
      branchName
      url
      assignee { id }
      labels { nodes { name } }
      inverseRelations(first: $relationFirst) {
        nodes {
          type
          issue { id identifier state { name } }
        }
      }
      createdAt
      updatedAt
    }
  }
}
`;

type RawIssueNode = {
  id: string;
  identifier: string;
  title: string | null;
  description: string | null;
  priority: number | null;
  state: { name: string };
  branchName: string | null;
  url: string | null;
  assignee: { id: string } | null;
  labels: { nodes: { name: string }[] };
  inverseRelations: {
    nodes: { type: string; issue: { id: string; identifier: string; state: { name: string } } }[];
  };
  createdAt: string | null;
  updatedAt: string | null;
};

export class LinearClient {
  constructor(private cfg: TrackerConfig) {
    if (!cfg.apiKey) {
      throw new Error("linear_no_api_key: set LINEAR_API_KEY env or tracker.api_key");
    }
  }

  async fetchActiveIssues(): Promise<Issue[]> {
    return this.fetchByStates(this.cfg.activeStates);
  }

  async fetchTerminalIssues(): Promise<Issue[]> {
    return this.fetchByStates(this.cfg.terminalStates);
  }

  async fetchByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) return [];
    const out: Issue[] = [];
    let after: string | null = null;
    type PollResult = {
      issues: { nodes: RawIssueNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    };
    while (true) {
      const data: PollResult = await this.graphql<PollResult>(POLL_QUERY, {
        projectSlug: this.cfg.projectSlug,
        stateNames,
        first: ISSUE_PAGE_SIZE,
        relationFirst: RELATION_FIRST,
        after,
      });
      for (const node of data.issues.nodes) {
        if (this.cfg.assignee && node.assignee?.id !== this.cfg.assignee) continue;
        out.push(normalizeIssue(node));
      }
      if (!data.issues.pageInfo.hasNextPage) break;
      after = data.issues.pageInfo.endCursor;
      if (!after) break;
    }
    return out;
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    if (ids.length === 0) return [];
    const data = await this.graphql<{ issues: { nodes: RawIssueNode[] } }>(QUERY_BY_IDS, {
      ids,
      first: ids.length,
      relationFirst: RELATION_FIRST,
    });
    return data.issues.nodes
      .filter((n) => !this.cfg.assignee || n.assignee?.id === this.cfg.assignee)
      .map(normalizeIssue);
  }

  // ---- low-level GraphQL POST -----------------------------------------------

  async graphql<T>(query: string, variables: Record<string, unknown> = {}, operationName?: string): Promise<T> {
    const body: Record<string, unknown> = { query, variables };
    if (operationName) body.operationName = operationName;
    const res = await fetch(this.cfg.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.cfg.apiKey,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`linear_api_status:${res.status} ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as { data?: T; errors?: unknown[] };
    if (json.errors?.length) {
      throw new Error(`linear_api_errors: ${JSON.stringify(json.errors).slice(0, 800)}`);
    }
    if (!json.data) throw new Error("linear_api_empty_data");
    return json.data;
  }
}

function normalizeIssue(n: RawIssueNode): Issue {
  const labels = n.labels.nodes.map((l) => l.name);
  const blockedBy: BlockedRef[] = (n.inverseRelations?.nodes ?? [])
    .filter((r) => r.type === "blocks")
    .map((r) => ({ id: r.issue.id, identifier: r.issue.identifier, state: r.issue.state.name }));
  return {
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    description: n.description,
    priority: n.priority,
    state: n.state.name,
    branchName: n.branchName,
    url: n.url,
    labels,
    blockedBy,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  };
}

// ---- standalone CLI smoke test --------------------------------------------

if (import.meta.main) {
  const apiKey = process.env.LINEAR_API_KEY;
  const slug = process.argv[2] ?? "ziikoo-839b53546018";
  if (!apiKey) {
    console.error("Set LINEAR_API_KEY env first.");
    process.exit(1);
  }
  const c = new LinearClient({
    kind: "linear",
    endpoint: "https://api.linear.app/graphql",
    apiKey,
    projectSlug: slug,
    assignee: null,
    activeStates: ["Todo", "Drafting", "Researching", "Outlining", "Self-Editing", "Rendering", "Publishing"],
    terminalStates: ["Done", "Cancelled", "Canceled", "Closed"],
  });
  const issues = await c.fetchActiveIssues();
  console.log(`Fetched ${issues.length} active issues:`);
  for (const i of issues) {
    console.log(`  ${i.identifier} [${i.state}] ${i.title}`);
  }
}
