import { describe, expect, test } from "bun:test";
import {
  executionRunId,
  executionWorkflowInstanceId,
  WORKFLOW_INSTANCE_ID_PATTERN,
} from "../src/workflows/ids.js";

describe("execution workflow ids", () => {
  test("keeps D1 run id readable while making Workflow instance id Cloudflare-compatible", () => {
    expect(executionRunId("personal", "content-wechat", "f1-smoke-1", 1)).toBe(
      "run:personal:content-wechat:f1-smoke-1:1",
    );

    const workflowId = executionWorkflowInstanceId(
      "personal",
      "content-wechat",
      "f1-smoke-1",
      1,
    );

    expect(workflowId).toBe("run-personal-content-wechat-f1-smoke-1-1");
    expect(workflowId).toMatch(WORKFLOW_INSTANCE_ID_PATTERN);
    expect(workflowId.length).toBeLessThanOrEqual(100);
  });

  test("normalizes version punctuation and truncates long ids with a stable suffix", () => {
    const workflowId = executionWorkflowInstanceId(
      "tenant",
      "content.wechat@1.0.0",
      "issue-" + "x".repeat(140),
      12,
    );

    expect(workflowId).toMatch(WORKFLOW_INSTANCE_ID_PATTERN);
    expect(workflowId.length).toBeLessThanOrEqual(100);
    expect(workflowId).toBe(
      executionWorkflowInstanceId(
        "tenant",
        "content.wechat@1.0.0",
        "issue-" + "x".repeat(140),
        12,
      ),
    );
  });
});
