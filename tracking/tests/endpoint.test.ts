import { describe, it, expect, vi, afterAll } from 'vitest';

/**
 * `api/o/[token].ts` imports `src/db.ts`, which calls
 * `neon(process.env.DATABASE_URL ?? '')` at module load time and throws if
 * the string is empty. Every test here therefore needs a non-empty
 * DATABASE_URL in place *before* the module loads — and because ESM imports
 * are hoisted above ordinary statements, that means importing dynamically
 * after setting `process.env`, never via a static top-level `import` of the
 * handler module.
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
    const { isValidToken } = await import('../src/token');
    // A literal "../" is normalised away by URL parsing before it ever
    // reaches our regex. The realistic attack surface is percent-encoded
    // slashes, which URL parsers preserve verbatim inside a path segment.
    const extracted = extractToken('https://x.vercel.app/o/..%2f..%2fetc%2fpasswd.png');
    expect(isValidToken(extracted ?? '')).toBe(false);
  });
});

describe('handler always-200 guarantee', () => {
  it('returns 200 with the standard pixel when no token is present in the path', async () => {
    const { default: handler } = await freshImport(INERT_DATABASE_URL);
    const { PIXEL_BYTES } = await import('../src/pixel');
    const request = new Request('https://x.vercel.app/favicon.ico');

    const response = await handler(request);
    const body = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control'))
      .toBe('no-store, no-cache, must-revalidate, max-age=0');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('expires')).toBe('0');
    expect(body).toEqual(PIXEL_BYTES);
  });

  it('returns 200 with the standard pixel when the token is malformed', async () => {
    const { default: handler } = await freshImport(INERT_DATABASE_URL);
    const { PIXEL_BYTES } = await import('../src/pixel');
    const request = new Request('https://x.vercel.app/o/not-a-valid-token.png');

    const response = await handler(request);
    const body = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control'))
      .toBe('no-store, no-cache, must-revalidate, max-age=0');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('expires')).toBe('0');
    expect(body).toEqual(PIXEL_BYTES);
  });

  it('returns 200 with the standard pixel, and logs but does not surface, a real thrown database error', async () => {
    const { default: handler } = await freshImport(UNREACHABLE_DATABASE_URL);
    const { PIXEL_BYTES } = await import('../src/pixel');
    const { generateToken } = await import('../src/token');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // A well-formed token clears the isValidToken guard in record(), so
    // execution reaches the real (and here, unreachable) lookupToken call.
    const request = new Request(`https://x.vercel.app/o/${generateToken()}.png`);
    const response = await handler(request);
    const body = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control'))
      .toBe('no-store, no-cache, must-revalidate, max-age=0');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('expires')).toBe('0');
    expect(body).toEqual(PIXEL_BYTES);
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
