import { describe, expect, test } from "bun:test";
import { nextBackoffMs } from "../src/agents/backoff.js";

function expectedBackoffMs(attempt: number, maxBackoffMs: number): number {
  return Math.min(maxBackoffMs, 1000 * 2 ** Math.max(0, attempt - 1));
}

describe("nextBackoffMs", () => {
  test("matches ts-engine backoff math for attempts 1..10 across supported caps", () => {
    const maxBackoffValues = [30_000, 300_000] as const;

    for (const maxBackoffMs of maxBackoffValues) {
      for (let attempt = 1; attempt <= 10; attempt++) {
        expect(nextBackoffMs(attempt, maxBackoffMs)).toBe(expectedBackoffMs(attempt, maxBackoffMs));
      }
    }
  });

  test("clamps low attempts and large attempts exactly like ts-engine", () => {
    expect(nextBackoffMs(0, 30_000)).toBe(1_000);
    expect(nextBackoffMs(1, 30_000)).toBe(1_000);
    expect(nextBackoffMs(99, 30_000)).toBe(30_000);
  });
});
