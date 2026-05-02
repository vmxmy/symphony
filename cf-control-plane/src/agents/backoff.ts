/**
 * Exponential backoff with cap, per SPEC §11.
 * delay = min(maxBackoffMs, base * 2^(attempt-1))
 *
 * Phase 4 sub-cut 3: extracted to its own module so it is unit-testable
 * independent of DurableObject context. Math, base, and cap MUST match
 * ts-engine/src/state.ts:nextBackoffMs byte-for-byte (parity test in
 * tests/backoff.test.ts).
 */
export function nextBackoffMs(attempt: number, maxBackoffMs: number, baseMs = 1000): number {
  const exp = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(maxBackoffMs, exp);
}
