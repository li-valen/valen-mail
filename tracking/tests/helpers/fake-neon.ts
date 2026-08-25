import { vi } from 'vitest';

/** One `(text, params)` call captured from a faked neon "ordinary function" invocation. */
export interface CapturedQuery {
  readonly text: string;
  readonly params: readonly unknown[];
}

/**
 * A minimal stand-in for the object `@neondatabase/serverless`'s `neon()`
 * returns, supporting only the "ordinary function" call form —
 * `fakeSql(text, params)` — because that's the only form `insertTokens`
 * uses (see `src/db.ts`; every other function in that file uses the
 * tagged-template form instead, which this fake does not need to support).
 *
 * Every call is recorded so a test can assert on the exact SQL text and
 * bound parameters a route or db function produced — proof a live database
 * would otherwise hide behind its network boundary. Consumers register the
 * mock themselves (`vi.mock('@neondatabase/serverless', () => ({ neon:
 * vi.fn() }))` must be a literal, hoisted call in the test file itself —
 * vitest cannot hoist it out of a shared helper), then wire this fake in
 * via `vi.mocked(neon).mockReturnValue(fakeSql)` before importing the
 * module under test.
 */
export function createFakeSql(): {
  fakeSql: (text: string, params?: unknown[]) => Promise<unknown[]>;
  calls: CapturedQuery[];
} {
  const calls: CapturedQuery[] = [];
  const fakeSql = vi.fn(async (text: string, params: unknown[] = []) => {
    calls.push({ text, params });
    return [];
  });
  return { fakeSql, calls };
}
