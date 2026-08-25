import { describe, it, expect, vi, afterAll } from 'vitest';
import { createFakeSql } from './helpers/fake-neon';

/**
 * Same freshImport reasoning as tests/opens-endpoint.test.ts: api/tokens.ts
 * pulls in src/db.ts, whose Postgres client is built lazily and cached at
 * module scope, so every test imports fresh after setting env vars.
 *
 * Unlike opens-endpoint.test.ts, several tests here need insertTokens to
 * actually *succeed* (cap boundary, token shape, ordering) rather than
 * tolerating a [200, 500] ambiguity from an unreachable real database —
 * "25 ok, 26 rejected" is not a meaningful assertion if 25 could 500. So
 * `@neondatabase/serverless` is mocked for this whole file and each
 * success-path test wires in a fake sql function via freshHandlerWithSql.
 * Auth and malformed-body tests never reach the database at all, so they
 * use the plain freshHandler() and don't need the fake wired up.
 */
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_READ_API_TOKEN = process.env.READ_API_TOKEN;

const TOKEN = 'r'.repeat(32);
const WRONG_TOKEN_SAME_LENGTH = 'q'.repeat(32);
const AUTH = { authorization: `Bearer ${TOKEN}` };
const INERT_DATABASE_URL = 'postgresql://user:pass@127.0.0.1/db';

vi.mock('@neondatabase/serverless', () => ({ neon: vi.fn() }));

async function freshHandler() {
  vi.resetModules();
  const { default: handler } = await import('../api/tokens');
  return handler;
}

/**
 * Same resetModules-then-configure-then-import ordering as
 * tests/insert-tokens.test.ts's freshDbWithFakeSql — see that comment for
 * why the order matters.
 */
async function freshHandlerWithSql(sqlFn: (text: string, params?: unknown[]) => Promise<unknown[]>) {
  vi.resetModules();
  process.env.DATABASE_URL = INERT_DATABASE_URL;
  const { neon } = await import('@neondatabase/serverless');
  vi.mocked(neon).mockReturnValue(sqlFn as never);
  const { default: handler } = await import('../api/tokens');
  return handler;
}

async function freshHandlerWithFakeDb() {
  const { fakeSql, calls } = createFakeSql();
  const handler = await freshHandlerWithSql(fakeSql);
  return { handler, calls };
}

function postBody(body: unknown, headers: Record<string, string> = AUTH): Request {
  return new Request('https://x/api/tokens', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function rawBody(text: string, headers: Record<string, string> = AUTH): Request {
  return new Request('https://x/api/tokens', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: text,
  });
}

function sendsOfLength(n: number) {
  return Array.from({ length: n }, (_, i) => ({ recipientEmail: `r${i}@x.com`, subject: 'hi' }));
}

afterAll(() => {
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  process.env.READ_API_TOKEN = ORIGINAL_READ_API_TOKEN;
  vi.resetModules();
});

describe('tokens endpoint auth: fail closed on the token itself', () => {
  it('returns 503 when READ_API_TOKEN is not set', async () => {
    delete process.env.READ_API_TOKEN;
    const handler = await freshHandler();

    const res = await handler(postBody({ sends: [] }));

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).not.toHaveProperty('tokens');
  });

  it('returns 503 when READ_API_TOKEN is set but under 32 characters', async () => {
    process.env.READ_API_TOKEN = 'r'.repeat(31);
    const handler = await freshHandler();

    const res = await handler(postBody({ sends: [] }));

    expect(res.status).toBe(503);
  });
});

describe('tokens endpoint auth: bearer token check', () => {
  it('rejects a request with no bearer token', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const handler = await freshHandler();

    const res = await handler(postBody({ sends: [] }, {}));

    expect(res.status).toBe(401);
  });

  it('rejects a wrong token of the same length', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const handler = await freshHandler();

    const res = await handler(
      postBody({ sends: [] }, { authorization: `Bearer ${WRONG_TOKEN_SAME_LENGTH}` }),
    );

    expect(res.status).toBe(401);
  });

  it('rejects an unauthenticated request before ever reaching the database', async () => {
    // DATABASE_URL is deliberately left unset. If auth were ever checked
    // after parsing/inserting (or skipped), insertTokens() would throw
    // "DATABASE_URL is not set" and the caught result would be 500, not
    // 401 — this pins the ordering, not just the outcome (same technique
    // as tests/opens-endpoint.test.ts's identical-purpose test).
    process.env.READ_API_TOKEN = TOKEN;
    delete process.env.DATABASE_URL;
    const handler = await freshHandler();

    const res = await handler(postBody({ sends: [{ recipientEmail: 'a@x.com', subject: 'hi' }] }, {}));

    expect(res.status).toBe(401);
  });
});

describe('malformed body: fixed 400', () => {
  it('rejects a body that is not valid JSON', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { handler } = await freshHandlerWithFakeDb();

    const res = await handler(rawBody('{not valid json'));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request body' });
  });

  it('rejects a body with no sends array', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { handler } = await freshHandlerWithFakeDb();

    const res = await handler(postBody({}));

    expect(res.status).toBe(400);
  });

  it('rejects a send item missing recipientEmail', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { handler } = await freshHandlerWithFakeDb();

    const res = await handler(postBody({ sends: [{ subject: 'hi' }] }));

    expect(res.status).toBe(400);
  });

  it('rejects a send item whose recipientEmail is an empty string', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { handler } = await freshHandlerWithFakeDb();

    const res = await handler(postBody({ sends: [{ recipientEmail: '', subject: 'hi' }] }));

    expect(res.status).toBe(400);
  });

  it('rejects a send item with a non-string subject', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { handler } = await freshHandlerWithFakeDb();

    const res = await handler(postBody({ sends: [{ recipientEmail: 'a@x.com', subject: 42 }] }));

    expect(res.status).toBe(400);
  });

  it('uses the identical fixed error string across every malformed-body case', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { handler } = await freshHandlerWithFakeDb();

    const notJson = await handler(rawBody('nope'));
    const noSends = await handler(postBody({}));

    expect(await notJson.json()).toEqual(await noSends.json());
  });
});

describe('cap: at most 25 sends', () => {
  it('accepts exactly 25 sends', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { handler } = await freshHandlerWithFakeDb();

    const res = await handler(postBody({ sends: sendsOfLength(25) }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tokens).toHaveLength(25);
  });

  it('rejects 26 sends with 413, not 400', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { handler } = await freshHandlerWithFakeDb();

    const res = await handler(postBody({ sends: sendsOfLength(26) }));

    expect(res.status).toBe(413);
  });
});

describe('token shape and ordering', () => {
  it('returns tokens matching the 32-lowercase-hex TOKEN_PATTERN shape', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { handler } = await freshHandlerWithFakeDb();

    const res = await handler(
      postBody({
        sends: [
          { recipientEmail: 'a@x.com', subject: 'hi' },
          { recipientEmail: 'b@x.com', subject: 'yo' },
        ],
      }),
    );
    const body = await res.json();

    expect(body.tokens.length).toBeGreaterThan(0);
    for (const t of body.tokens) {
      expect(t.token).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('mints a distinct token per send, not one token reused', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { handler } = await freshHandlerWithFakeDb();

    const res = await handler(postBody({ sends: sendsOfLength(5) }));
    const body = await res.json();

    const distinctTokens = new Set(body.tokens.map((t: { token: string }) => t.token));
    expect(distinctTokens.size).toBe(5);
  });

  it('preserves send order in the response, keyed by distinct recipients', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { handler } = await freshHandlerWithFakeDb();
    const order = ['zed@x.com', 'amy@x.com', 'mel@x.com'];

    const res = await handler(
      postBody({ sends: order.map((recipientEmail) => ({ recipientEmail, subject: 'hi' })) }),
    );
    const body = await res.json();

    expect(body.tokens.map((t: { recipientEmail: string }) => t.recipientEmail)).toEqual(order);
  });

  it('response items carry only token and recipientEmail — subject never echoed back', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { handler } = await freshHandlerWithFakeDb();

    const res = await handler(
      postBody({ sends: [{ recipientEmail: 'a@x.com', subject: 'a secret-ish subject' }] }),
    );
    const body = await res.json();

    expect(Object.keys(body.tokens[0])).toEqual(['token', 'recipientEmail']);
  });
});

describe('database failure', () => {
  it('returns 500 when the insert throws, and does not report success', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const handler = await freshHandlerWithSql(async () => {
      throw new Error('boom');
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await handler(postBody({ sends: [{ recipientEmail: 'a@x.com', subject: 'hi' }] }));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).not.toHaveProperty('tokens');
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
