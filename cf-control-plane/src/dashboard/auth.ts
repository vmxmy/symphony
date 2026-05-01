export {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_TTL_SECONDS,
  authenticateOperator,
  authorize,
  requireCapability,
  sessionCookieHeader,
  sessionClearCookieHeader,
} from "../auth/operator.js";
export type { AuthResult, Capability, Principal } from "../auth/operator.js";
