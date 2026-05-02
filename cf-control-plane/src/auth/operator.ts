export type Capability =
  | "read:state"
  | "read:dashboard"
  | "write:tenant.transition"
  | "write:project.transition"
  | "write:project.refresh"
  | "write:issue.transition"
  | "write:run.mock"
  | "write:run.cancel";

export type Principal = {
  kind: "operator";
  subject: string;
  capabilities: Capability[];
  sessionSource: "header" | "cookie" | "query";
};

export type AuthResult =
  | { ok: true; principal: Principal }
  | { ok: false; response: Response };

export const SESSION_COOKIE_NAME = "symphony_session";
export const SESSION_COOKIE_TTL_SECONDS = 60 * 60 * 24;

const ALL_CAPABILITIES: Capability[] = [
  "read:state",
  "read:dashboard",
  "write:tenant.transition",
  "write:project.transition",
  "write:project.refresh",
  "write:issue.transition",
  "write:run.mock",
  "write:run.cancel",
];

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  return header.split(";").reduce<Record<string, string>>((acc, raw) => {
    const trimmed = raw.trim();
    if (!trimmed) return acc;
    const eq = trimmed.indexOf("=");
    if (eq < 0) return acc;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) acc[key] = value;
    return acc;
  }, {});
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

async function cookieValueForToken(token: string): Promise<string> {
  const expiresAt = Date.now() + SESSION_COOKIE_TTL_SECONDS * 1000;
  const message = `symphony-session:${expiresAt}`;
  return `v1.${expiresAt}.${await hmacHex(token, message)}`;
}

async function verifyCookieValue(cookie: string, token: string): Promise<boolean> {
  const parts = cookie.split(".");
  if (parts.length !== 3) return false;
  const [version, rawExpiresAt, signature] = parts;
  if (version !== "v1" || !rawExpiresAt || !signature) return false;
  const expiresAt = Number(rawExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
  const expected = await hmacHex(token, `symphony-session:${rawExpiresAt}`);
  return signature === expected;
}

function operatorPrincipal(sessionSource: Principal["sessionSource"]): Principal {
  return {
    kind: "operator",
    subject: "operator-token",
    capabilities: ALL_CAPABILITIES,
    sessionSource,
  };
}

export async function authenticateOperator(
  req: Request,
  expectedToken: string | undefined,
  options: { allowCookie?: boolean; allowQuery?: boolean; jsonErrors?: boolean } = {},
): Promise<AuthResult> {
  const jsonErrors = options.jsonErrors ?? true;
  const deny = (status: number, error: string, reason: string) => {
    if (jsonErrors) return jsonResponse({ error, reason }, { status });
    return new Response(`${status} ${error}: ${reason}`, {
      status,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  };

  if (!expectedToken) {
    return { ok: false, response: deny(503, "service_unavailable", "OPERATOR_TOKEN is not configured") };
  }

  const auth = req.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer?.[1] === expectedToken) {
    return { ok: true, principal: operatorPrincipal("header") };
  }

  if (options.allowCookie) {
    const cookie = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE_NAME];
    if (cookie && (await verifyCookieValue(cookie, expectedToken))) {
      return { ok: true, principal: operatorPrincipal("cookie") };
    }
  }

  if (options.allowQuery) {
    const queryToken = new URL(req.url).searchParams.get("token");
    if (queryToken === expectedToken) {
      return { ok: true, principal: operatorPrincipal("query") };
    }
  }

  return { ok: false, response: deny(401, "unauthorized", "missing or invalid operator credentials") };
}

export function authorize(principal: Principal, capability: Capability): boolean {
  return principal.capabilities.includes(capability);
}

export function requireCapability(principal: Principal, capability: Capability): Response | null {
  if (authorize(principal, capability)) return null;
  return jsonResponse({ error: "forbidden", capability }, { status: 403 });
}

export async function sessionCookieHeader(token: string): Promise<string> {
  return [
    `${SESSION_COOKIE_NAME}=${await cookieValueForToken(token)}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${SESSION_COOKIE_TTL_SECONDS}`,
  ].join("; ");
}

export function sessionClearCookieHeader(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/",
    "Max-Age=0",
  ].join("; ");
}
