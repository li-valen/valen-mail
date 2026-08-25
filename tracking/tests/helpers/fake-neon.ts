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

/** One tagged-template call captured from a faked neon tag-function invocation. */
export interface CapturedTaggedQuery {
  /** The template's static strings joined with no separator — every
   *  interpolation collapses to nothing, so a literal column name that
   *  appears in the SQL text (never inside an interpolation, since values
   *  are always parameters, not text) survives intact and can be matched
   *  with a plain substring/regex check. */
  readonly text: string;
  readonly values: readonly unknown[];
}

/**
 * A minimal stand-in for the object `@neondatabase/serverless`'s `neon()`
 * returns, supporting the tagged-template call form — `` fakeSql`select
 * ...` `` — used by every function in `src/db.ts` except `insertTokens`
 * (which has its own fake, `createFakeSql` above, for the "ordinary
 * function" form it uses instead).
 *
 * Returns `rows` for every call, so a test can seed exactly the row shape
 * `listRecentOpens`'s mapping expects and assert the mapped result
 * round-trips it. Every call is also recorded — text and interpolated
 * values separately, mirroring `createFakeSql` — so a test can assert on
 * the literal column list a db.ts function issued without a live
 * database.
 */
export function createFakeTaggedSql(rows: readonly unknown[]): {
  fakeSql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<readonly unknown[]>;
  calls: CapturedTaggedQuery[];
} {
  const calls: CapturedTaggedQuery[] = [];
  const fakeSql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join(''), values });
    return rows;
  });
  return { fakeSql, calls };
}
