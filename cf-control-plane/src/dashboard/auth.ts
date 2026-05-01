// Dashboard auth: accept the operator token from any of three places, in
// priority order:
//   1. Authorization: Bearer <token>     (CLI / programmatic use)
//   2. Cookie: symphony_session=<token>  (browser, after first login)
//   3. ?token=<token> query param        (browser first-touch only;
//                                         redirected to clean URL with cookie)
//
// On a successful query-param hit, the Worker upgrades the response to a
// 302 with Set-Cookie so the operator can bookmark `/dashboard` cleanly.
// The cookie is HttpOnly + Secure + SameSite=Strict to keep the token out
// of JS-readable surfaces.

export const SESSION_COOKIE_NAME = "symphony_session";
export const SESSION_COOKIE_TTL_SECONDS = 60 * 60 * 24; // 24h

export type SessionSource = "header" | "cookie" | "query" | null;

export type Session = {
  token: string;
  source: Exclude<SessionSource, null>;
};

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  return header.split(";").reduce<Record<string, string>>((acc, raw) => {
    const trimmed = raw.trim();
    if (!trimmed) return acc;
    const eq = trimmed.indexOf("=");
    if (eq < 0) return acc;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    if (k) acc[k] = v;
    return acc;
  }, {});
}

export function getSession(
  req: Request,
  expectedToken: string | undefined,
): Session | null {
  if (!expectedToken) return null;

  const auth = req.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer && bearer[1] === expectedToken) {
    return { token: expectedToken, source: "header" };
  }

  const cookies = parseCookies(req.headers.get("cookie"));
  if (cookies[SESSION_COOKIE_NAME] === expectedToken) {
    return { token: expectedToken, source: "cookie" };
  }

  const url = new URL(req.url);
  const queryToken = url.searchParams.get("token");
  if (queryToken === expectedToken) {
    return { token: expectedToken, source: "query" };
  }

  return null;
}

export function sessionCookieHeader(token: string): string {
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
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
