// EventSink contract.
//
// Decouples local file logging from future D1 / R2 / Analytics Engine sinks.
// Phase 1 keeps the synchronous local Logger; the union return type lets a
// Cloudflare implementation be async without forcing every caller to await.
// See phase1-plan §5.5.

export type EventLevel = "debug" | "info" | "warning" | "error";

export interface EventSink {
  log(
    level: EventLevel,
    message: string,
    meta?: Record<string, unknown>,
  ): void | Promise<void>;
  debug(message: string, meta?: Record<string, unknown>): void | Promise<void>;
  info(message: string, meta?: Record<string, unknown>): void | Promise<void>;
  warn(message: string, meta?: Record<string, unknown>): void | Promise<void>;
  error(message: string, meta?: Record<string, unknown>): void | Promise<void>;
}
