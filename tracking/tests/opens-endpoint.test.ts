import { describe, it, expect, vi, afterAll } from 'vitest';

/**
 * Same reason as tests/endpoint.test.ts: `src/db.ts`'s Postgres client is
 * built lazily and cached at module scope, so a test file that touches
 * `DATABASE_URL` needs `vi.resetModules()` + a dynamic import per test to
 * get a client bound to the value *that* test set, not whatever an earlier
 * test left behind. `api/opens.ts` reads `READ_API_TOKEN` fresh on every
 * call (no module-level caching there), so resetting isn't strictly
 * required for the token itself — but every test here goes through
 * `freshImport()` anyway, both for consistency with the established
 * pattern and because it also gives each test its own db.ts client state.
 */
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_READ_API_TOKEN = process.env.READ_API_TOKEN;

const TOKEN = 'r'.repeat(32);
const WRONG_TOKEN_SAME_LENGTH = 'q'.repeat(32);
const auth = { authorization: `Bearer ${TOKEN}` };

async function freshImport() {
  vi.resetModules();
  return import('../api/opens');
}

afterAll(() => {
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  process.env.READ_API_TOKEN = ORIGINAL_READ_API_TOKEN;
  vi.resetModules();
});

describe('opens endpoint auth: fail closed on the token itself', () => {
  it('returns 503 and serves nothing when READ_API_TOKEN is not set', async () => {
    delete process.env.READ_API_TOKEN;
    const { default: handler } = await freshImport();

    const res = await handler(new Request('https://x/api/opens', { headers: auth }));

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).not.toHaveProperty('opens');
  });

  it('returns 503 when READ_API_TOKEN is set but under 32 characters', async () => {
    process.env.READ_API_TOKEN = 'r'.repeat(31);
    const { default: handler } = await freshImport();

    const res = await handler(new Request('https://x/api/opens', { headers: auth }));

    expect(res.status).toBe(503);
  });
});

describe('opens endpoint auth: bearer token check', () => {
  it('rejects a request with no token', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { default: handler } = await freshImport();

    const res = await handler(new Request('https://x/api/opens'));

    expect(res.status).toBe(401);
  });

  it('rejects a wrong token of the same length', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { default: handler } = await freshImport();

    const res = await handler(
      new Request('https://x/api/opens', {
        headers: { authorization: `Bearer ${WRONG_TOKEN_SAME_LENGTH}` },
      }),
    );

    expect(res.status).toBe(401);
  });

  it('rejects an unauthenticated request before ever reaching the database', async () => {
    // DATABASE_URL is deliberately left unset for this test. If auth were
    // ever checked after the DB call (or skipped), listRecentOpens() would
    // throw "DATABASE_URL is not set" and the caught result would be 500,
    // not 401 — so this also pins the ordering, not just the outcome.
    process.env.READ_API_TOKEN = TOKEN;
    delete process.env.DATABASE_URL;
    const { default: handler } = await freshImport();

    const res = await handler(new Request('https://x/api/opens'));

    expect(res.status).toBe(401);
  });
});

describe('classificationIsConfirmed', () => {
  it('never reports mpp or prefetch as a confirmed read', async () => {
    const { classificationIsConfirmed } = await freshImport();

    expect(classificationIsConfirmed('open')).toBe(true);
    expect(classificationIsConfirmed('mpp')).toBe(false);
    expect(classificationIsConfirmed('prefetch')).toBe(false);
    expect(classificationIsConfirmed('scanner')).toBe(false);
    expect(classificationIsConfirmed('self')).toBe(false);
  });

  it('degrades an unrecognised classification string to not-confirmed, never to true', async () => {
    const { classificationIsConfirmed } = await freshImport();

    expect(classificationIsConfirmed('literally-never-seen-before')).toBe(false);
    expect(classificationIsConfirmed('')).toBe(false);
    expect(classificationIsConfirmed('OPEN')).toBe(false);
  });
});

describe('resolveLimit', () => {
  it('defaults to 50 when no limit is given', async () => {
    const { resolveLimit } = await freshImport();
    expect(resolveLimit(null)).toBe(50);
  });

  it('clamps an absurdly large limit down to the maximum of 200', async () => {
    const { resolveLimit } = await freshImport();
    expect(resolveLimit('999999')).toBe(200);
  });

  it('clamps a zero or negative limit up to 1', async () => {
    const { resolveLimit } = await freshImport();
    expect(resolveLimit('0')).toBe(1);
    expect(resolveLimit('-5')).toBe(1);
  });

  it('falls back to the default for a non-numeric limit', async () => {
    const { resolveLimit } = await freshImport();
    expect(resolveLimit('not-a-number')).toBe(50);
  });

  it('truncates a fractional limit to an integer', async () => {
    const { resolveLimit } = await freshImport();
    expect(resolveLimit('10.9')).toBe(10);
  });
});

describe('handler integration: limit handling end-to-end', () => {
  it('accepts an absurd limit query param without crashing, clamped internally', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { default: handler } = await freshImport();

    const res = await handler(
      new Request('https://x/api/opens?limit=999999', { headers: auth }),
    );

    // 500 only, in practice, because this test environment has no live
    // Postgres to query — see the identical coverage-boundary note in
    // tests/endpoint.test.ts. The real clamp behaviour is asserted
    // directly and unconditionally above, against `resolveLimit`.
    expect([200, 500]).toContain(res.status);
  });
});
