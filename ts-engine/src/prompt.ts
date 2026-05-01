// Liquid prompt renderer (uses liquidjs).
// Critical contract: rendered output MUST preserve multi-byte UTF-8 verbatim.
// Test in tests/prompt-utf8.test.ts.

import { Liquid } from "liquidjs";
import type { Issue } from "./types.js";

const LIQUID_OPTS = {
  strictVariables: true,
  strictFilters: true,
  cache: false,
};

export type PromptContext = {
  issue: IssueLiquidShape;
  attempt: number | null;
};

// What the Liquid template sees as `issue.*`. Snake_case to match
// existing WORKFLOW.md templates and the public SPEC shape.
type IssueLiquidShape = {
  id: string;
  identifier: string;
  title: string | null;
  description: string | null;
  state: string;
  priority: number | null;
  url: string | null;
  branch_name: string | null;
  labels: string[];
  blocked_by: { id: string; identifier: string; state: string }[];
  created_at: string | null;
  updated_at: string | null;
};

export class PromptBuilder {
  private engine = new Liquid(LIQUID_OPTS);
  private parsed: ReturnType<Liquid["parse"]>;

  constructor(template: string) {
    this.parsed = this.engine.parse(template);
  }

  build(issue: Issue, attempt: number | null = null): string {
    const ctx: PromptContext = {
      issue: this.shapeIssue(issue),
      attempt,
    };
    // renderSync is synchronous; returns the rendered string.
    return this.engine.renderSync(this.parsed, ctx);
  }

  private shapeIssue(issue: Issue): IssueLiquidShape {
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      state: issue.state,
      priority: issue.priority,
      url: issue.url,
      branch_name: issue.branchName,
      labels: issue.labels,
      blocked_by: issue.blockedBy,
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
    };
  }
}

// ---- standalone CLI smoke test --------------------------------------------

if (import.meta.main) {
  const template = `Ticket: {{ issue.identifier }}
State: {{ issue.state }}
Title: {{ issue.title }}
URL: {{ issue.url }}
{% if attempt %}
Continuation attempt #{{ attempt }}.
{% endif %}
END.`;

  const issue: Issue = {
    id: "uuid-test",
    identifier: "ZII-9",
    title: "Symphony 是什么？给非技术读者的科普讲解(v3 onyx)",
    description: "目标读者：对 AI 工具感兴趣的非技术人员",
    state: "Publishing",
    priority: null,
    url: "https://linear.app/ziikoo/issue/ZII-9/symphony-是什么给非技术读者的科普讲解v3-onyx",
    branchName: null,
    labels: ["科普"],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };

  const pb = new PromptBuilder(template);
  const out = pb.build(issue, 7);
  console.log("---rendered---");
  console.log(out);
  console.log("---byte check---");
  const buf = Buffer.from(out, "utf8");
  // chars containing 0x85: 公 (E5 85 AC), 者 (E8 80 85), 内 (E5 86 85), 配 (E9 85 8D)
  // expected in our test data: 者 in URL slug, 普 (no 0x85) in label
  const has85 = buf.includes(0x85);
  const has0a = buf.includes(0x0a);
  console.log(`bytes total: ${buf.length}`);
  console.log(`contains 0x85 byte: ${has85}`);
  console.log(`contains 0x0a (LF, expected): ${has0a}`);

  // Find 者 (E8 80 85) in the output
  const target = Buffer.from([0xe8, 0x80, 0x85]);
  const idx = buf.indexOf(target);
  if (idx >= 0) {
    console.log(`✓ 者 (E8 80 85) preserved at byte offset ${idx}`);
  } else {
    console.error("✗ 者 not found verbatim — possible encoding corruption!");
    process.exit(1);
  }

  // round-trip JSON to mirror what Symphony does before sending to Codex
  const wrapped = { method: "turn/start", params: { input: [{ type: "text", text: out }] } };
  const json = JSON.stringify(wrapped);
  const reparsed = JSON.parse(json);
  if (reparsed.params.input[0].text !== out) {
    console.error("✗ JSON round-trip altered the text!");
    process.exit(1);
  }
  console.log("✓ JSON.stringify + JSON.parse round-trip is byte-identical");
}
