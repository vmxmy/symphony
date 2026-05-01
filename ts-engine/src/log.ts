// Minimal structured logger.
// Writes line-delimited entries to <logs-root>/symphony.log and stderr.

import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { EventSink } from "./contracts/events.js";

export type LogLevel = "debug" | "info" | "warning" | "error";

export class Logger implements EventSink {
  private filePath: string;

  constructor(opts: { logsRoot: string; filename?: string }) {
    mkdirSync(opts.logsRoot, { recursive: true });
    this.filePath = join(opts.logsRoot, opts.filename ?? "symphony.log");
  }

  log(level: LogLevel, message: string, meta: Record<string, unknown> = {}): void {
    const entry = `${new Date().toISOString()} ${level}: ${message}${
      Object.keys(meta).length ? " " + JSON.stringify(meta) : ""
    }\n`;
    try {
      appendFileSync(this.filePath, entry);
    } catch {
      // ignore disk errors; still emit on stderr
    }
    if (level === "error" || level === "warning") {
      process.stderr.write(entry);
    } else if (process.env.SYMPHONY_DEBUG) {
      process.stderr.write(entry);
    }
  }

  debug(m: string, meta?: Record<string, unknown>): void { this.log("debug", m, meta); }
  info(m: string, meta?: Record<string, unknown>): void { this.log("info", m, meta); }
  warn(m: string, meta?: Record<string, unknown>): void { this.log("warning", m, meta); }
  error(m: string, meta?: Record<string, unknown>): void { this.log("error", m, meta); }
}
