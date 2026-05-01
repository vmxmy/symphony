import { describe, expect, test } from "bun:test";
import {
  SESSION_COOKIE_NAME,
  authenticateOperator,
  sessionCookieHeader,
} from "../src/auth/operator.js";

describe("operator auth", () => {
  test("dashboard session cookie is signed and does not expose the raw operator token", async () => {
    const token = "super-secret-token";
    const cookieHeader = await sessionCookieHeader(token);

    expect(cookieHeader).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookieHeader).not.toContain(token);

    const req = new Request("https://example.test/dashboard", {
      headers: { cookie: cookieHeader },
    });
    const auth = await authenticateOperator(req, token, { allowCookie: true });

    expect(auth.ok).toBe(true);
    if (auth.ok) {
      expect(auth.principal.sessionSource).toBe("cookie");
      expect(auth.principal.capabilities).toContain("read:dashboard");
    }
  });

  test("rejects malformed session cookies with extra signature segments", async () => {
    const token = "super-secret-token";
    const cookieHeader = await sessionCookieHeader(token);
    const malformed = cookieHeader.replace(/(;|$)/, ".extra$1");

    const req = new Request("https://example.test/dashboard", {
      headers: { cookie: malformed },
    });
    const auth = await authenticateOperator(req, token, { allowCookie: true });

    expect(auth.ok).toBe(false);
  });
});
