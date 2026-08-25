import { describe, it, expect, vi, afterAll } from 'vitest';

/**
 * `src/db.ts`'s Postgres client is constructed lazily and cached at module
 * scope (see the comment on `sql_()` there), so — same as
 * tests/endpoint.test.ts and tests/opens-endpoint.test.ts — every test here
 * imports the module fresh after setting `DATABASE_URL`, rather than
 * relying on a static top-level import that could reuse a client built for
 * an earlier test's value.
 */
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

async function freshImport() {
  vi.resetModules();
  return import('../src/db');
}

afterAll(() => {
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  vi.resetModules();
});

describe('sql_() connection-string error sanitization', () => {
  /**
   * neon() throws "Database connection string provided to `neon()` is not
   * a valid URL. Connection string: " + String(r) when the value isn't
   * parseable as a URL at all (confirmed against
   * node_modules/@neondatabase/serverless/index.mjs) — the raw
   * DATABASE_URL, password included, interpolated straight into the
   * message. sql_() catches that specific construction failure and
   * rethrows a fixed message with no interpolated value, so this string
   * (not URL-shaped, not empty) is what actually exercises that path,
   * rather than the two other neon() throws for a missing or
   * wrong-protocol value, which are static strings with nothing to leak
   * in the first place.
   */
  const SECRET = 'hunter2-do-not-leak-this-password';
  const MALFORMED_URL = `not-a-url-at-all-${SECRET}`;

  it('rejects rather than connecting', async () => {
    process.env.DATABASE_URL = MALFORMED_URL;
    const { lookupToken } = await freshImport();

    await expect(lookupToken('a'.repeat(32))).rejects.toThrow();
  });

  it('never lets the raw connection string reach the caller, secret included', async () => {
    process.env.DATABASE_URL = MALFORMED_URL;
    const { lookupToken } = await freshImport();

    // A real assertion that this rejects — not just a manual try/catch —
    // so this test cannot pass by accident if a regression made
    // lookupToken resolve instead of reject (the try/catch below only
    // inspects error *content*, so on its own it wouldn't fail if there
    // were nothing thrown to catch).
    await expect(lookupToken('a'.repeat(32))).rejects.toThrow();

    try {
      await lookupToken('a'.repeat(32));
    } catch (error) {
      // Assert on absence of the secret itself, not just the new message
      // text — a test that only checked for the new string would still
      // pass if someone later re-added the original neon() error as a
      // `cause`. Most log serializers walk and print `cause`, which would
      // carry the credential right back in through that side door, so
      // `cause` is checked explicitly too, not just the message and the
      // stringified form.
      expect(String(error)).not.toContain(SECRET);
      expect((error as Error).message).not.toContain(SECRET);
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
      return;
    }
    throw new Error('unreachable: rejects.toThrow() above already proved this call rejects');
  });
});
