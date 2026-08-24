import { describe, it, expect, vi, afterAll } from 'vitest';
import { PIXEL_BYTES } from '../src/pixel';
import { isValidToken, generateToken } from '../src/token';

/**
 * `api/o/[token].ts` imports `src/db.ts`, which calls
 * `neon(process.env.DATABASE_URL ?? '')` at module load time and throws if
 * the string is empty. Every test here therefore needs a non-empty
 * DATABASE_URL in place *before* the module loads — and because ESM imports
 * are hoisted above ordinary statements, that means importing dynamically
 * after setting `process.env`, never via a static top-level `import` of the
 * handler module. (`src/pixel.ts` and `src/token.ts` above have no such
 * dependency, so they're imported normally.)
 */
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

/**
 * Syntactically valid but never actually dialled by these tests — the
 * null-token and malformed-token paths return out of `record()` before any
 * database call is made, so this connection string is never used to
 * connect.
 */
const INERT_DATABASE_URL = 'postgresql://user:pass@127.0.0.1:1/db';

/**
 * A hostname that fails DNS resolution immediately (observed <50ms), used to
 * force a real, unmocked database failure so the always-200 guarantee can be
 * checked against a genuine thrown error rather than a simulated one.
 */
const UNREACHABLE_DATABASE_URL =
  'postgresql://user:pass@nonexistent-host-xyz123.invalid/db?sslmode=require';

async function freshImport(databaseUrl: string) {
  process.env.DATABASE_URL = databaseUrl;
  vi.resetModules();
  return import('../api/o/[token]');
}

afterAll(() => {
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  vi.resetModules();
});

/**
 * Asserts a Response matches the exact standard-pixel contract: 200 status,
 * the four cache-defeating headers `pixelResponse()` sets, and a body
 * byte-for-byte equal to `PIXEL_BYTES`. Shared by every always-200 test
 * below so the assertion block lives in exactly one place.
 */
function expectStandardPixel(response: Response, body: Uint8Array): void {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('image/png');
  expect(response.headers.get('cache-control'))
    .toBe('no-store, no-cache, must-revalidate, max-age=0');
  expect(response.headers.get('pragma')).toBe('no-cache');
  expect(response.headers.get('expires')).toBe('0');
  expect(body).toEqual(PIXEL_BYTES);
}

describe('extractToken', () => {
  it('extracts the token from the original /o/<token>.png shape', async () => {
    const { extractToken } = await freshImport(INERT_DATABASE_URL);
    const token = 'a'.repeat(32);
    expect(extractToken(`https://x.vercel.app/o/${token}.png`)).toBe(token);
  });

  it('extracts the same token from the rewritten /api/o/<token> shape (no extension)', async () => {
    const { extractToken } = await freshImport(INERT_DATABASE_URL);
    const token = 'b'.repeat(32);
    expect(extractToken(`https://x.vercel.app/api/o/${token}`)).toBe(token);
  });

  it('returns null when the path has no /o/ segment', async () => {
    const { extractToken } = await freshImport(INERT_DATABASE_URL);
    expect(extractToken('https://x.vercel.app/favicon.ico')).toBeNull();
  });

  it('extracts correctly when a query string is present, without capturing it', async () => {
    const { extractToken } = await freshImport(INERT_DATABASE_URL);
    const token = 'c'.repeat(32);
    const url = `https://x.vercel.app/o/${token}.png?utm_source=newsletter&x=1`;
    expect(extractToken(url)).toBe(token);
  });

  it('extracts a path-traversal payload verbatim, and isValidToken rejects it', async () => {
    const { extractToken } = await freshImport(INERT_DATABASE_URL);
    // A literal "../" is normalised away by URL parsing before it ever
    // reaches our regex. The realistic attack surface is percent-encoded
    // slashes, which URL parsers preserve verbatim inside a path segment.
    const extracted = extractToken('https://x.vercel.app/o/..%2f..%2fetc%2fpasswd.png');
    expect(isValidToken(extracted ?? '')).toBe(false);
  });
});

describe('handler always-200 guarantee', () => {
  /**
   * Coverage boundary — read this before assuming the always-200 guarantee
   * is fully proven by this file alone.
   *
   * The brief names four scenarios the handler must return an identical 200
   * pixel for: valid token, unknown token, malformed token, and a thrown
   * database error. This file's tests below cover three of them:
   *   - no token in the path   ("no token present" test)
   *   - malformed token        ("token is malformed" test)
   *   - thrown database error  ("real thrown database error" test, against
   *                             a genuinely unreachable host — not mocked)
   *
   * It does NOT cover:
   *   - valid token   (successful classify + write to the database)
   *   - unknown token (well-formed 32-hex token, not present in `tokens`)
   *
   * Both are unreachable as unit tests under this task's constraints: with
   * an inert/bogus DATABASE_URL, the unknown-token path and the
   * thrown-database-error path are indistinguishable (both are a rejected
   * `lookupToken()` call caught by the same try/catch), and proving them
   * apart requires either a live Postgres connection — network-dependent,
   * and for the valid-token case, writes a real row — or a mocking library,
   * which this task explicitly forbade adding. Both paths were instead
   * verified live in production by the controller; see the "Live production
   * verification" section of task-6-report.md for the exact results.
   */
  it('returns 200 with the standard pixel when no token is present in the path', async () => {
    const { default: handler } = await freshImport(INERT_DATABASE_URL);
    const request = new Request('https://x.vercel.app/favicon.ico');

    const response = await handler(request);
    const body = new Uint8Array(await response.arrayBuffer());

    expectStandardPixel(response, body);
  });

  it('returns 200 with the standard pixel when the token is malformed', async () => {
    const { default: handler } = await freshImport(INERT_DATABASE_URL);
    const request = new Request('https://x.vercel.app/o/not-a-valid-token.png');

    const response = await handler(request);
    const body = new Uint8Array(await response.arrayBuffer());

    expectStandardPixel(response, body);
  });

  it('returns 200 with the standard pixel, and logs but does not surface, a real thrown database error', async () => {
    const { default: handler } = await freshImport(UNREACHABLE_DATABASE_URL);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // A well-formed token clears the isValidToken guard in record(), so
    // execution reaches the real (and here, unreachable) lookupToken call.
    const request = new Request(`https://x.vercel.app/o/${generateToken()}.png`);
    const response = await handler(request);
    const body = new Uint8Array(await response.arrayBuffer());

    expectStandardPixel(response, body);
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
