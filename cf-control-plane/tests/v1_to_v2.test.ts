import { describe, expect, test } from "bun:test";
import { upgradeV1ToV2 } from "../scripts/v1_to_v2.js";

describe("upgradeV1ToV2", () => {
  test("rejects unsupported source schema versions", () => {
    expect(() =>
      upgradeV1ToV2({
        tenant: "personal",
        profile: "content-wechat",
        profileYaml: { schema_version: 99 },
        workflowFrontMatter: {},
      }),
    ).toThrow("unsupported source schema_version");
  });

  test("records defaults and compatibility warnings", () => {
    const record = upgradeV1ToV2({
      tenant: "personal",
      profile: "content-wechat",
      profileYaml: { preflight: { env: ["LINEAR_API_KEY"] }, symphony: { bypass_guardrails: true } },
      workflowFrontMatter: {
        hooks: { before_run: "echo hi" },
        codex: { thread_sandbox: "danger-full-access" },
      },
    });

    expect(record.source_schema_version).toBe(1);
    expect(record.imported_schema_version).toBe(2);
    expect(record.defaults_applied).toContain("runtime.kind");
    expect(record.defaults_applied).toContain("tools.gateway");
    expect(record.warnings).toContain("profile.yaml preflight.* is launcher-only; not represented in v2 control-plane config");
    expect(record.warnings.some((w) => w.includes("Cloudflare-native execution requires explicit WorkerHost substitutes"))).toBe(true);
    expect(record.warnings.some((w) => w.includes("danger/full-access"))).toBe(true);
  });
});
