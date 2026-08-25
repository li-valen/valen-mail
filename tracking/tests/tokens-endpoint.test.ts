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

/**
 * Fix round 1: the wire contract widened to require accountId and
 * messageId per send (in addition to recipientEmail and subject). This
 * helper builds a fully-valid send with sensible defaults, overridable
 * per field, so every test below stays terse instead of repeating all
 * four fields inline — and so a future field addition has one place to
 * update rather than N call sites drifting apart.
 */
function validSend(overrides: Partial<{
  recipientEmail: string;
  subject: string;
  accountId: string;
  messageId: string;
}> = {}) {
  return {
    recipientEmail: 'a@x.com',
    subject: 'hi',
    accountId: 'acct-1',
    messageId: '<m@postbox.example>',
    ...overrides,
  };
}

function sendsOfLength(n: number) {
  return Array.from({ length: n }, (_, i) =>
    validSend({ recipientEmail: `r${i}@x.com`, messageId: `<m${i}@postbox.example>` }),
  );
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

    const res = await handler(postBody({ sends: [validSend()] }, {}));

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

    const res = await handler(postBody({ sends: [{ subject: 'hi', accountId: 'a', messageId: '<m@x>' }] }));

    expect(res.status).toBe(400);
  });

  it('rejects a send item whose recipientEmail is an empty string', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { handler } = await freshHandlerWithFakeDb();

    const res = await handler(postBody({ sends: [validSend({ recipientEmail: '' })] }));

    expect(res.status).toBe(400);
  });

  it('rejects a send item with a non-string subject', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { handler } = await freshHandlerWithFakeDb();

    const res = await handler(
      postBody({ sends: [{ recipientEmail: 'a@x.com', subject: 42, accountId: 'a', messageId: '<m@x>' }] }),
    );

    expect(res.status).toBe(400);
  });

  it('rejects a send item missing accountId', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { handler, calls } = await freshHandlerWithFakeDb();

    const res = await handler(
      postBody({ sends: [{ recipientEmail: 'a@x.com', subject: 'hi', messageId: '<m@postbox.example>' }] }),
    );

    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('rejects a send item whose accountId is an empty string', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { handler } = await freshHandlerWithFakeDb();

    const res = await handler(postBody({ sends: [validSend({ accountId: '' })] }));

    expect(res.status).toBe(400);
  });

  it('rejects a send item missing messageId', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { handler, calls } = await freshHandlerWithFakeDb();

    const res = await handler(
      postBody({ sends: [{ recipientEmail: 'a@x.com', subject: 'hi', accountId: 'acct-1' }] }),
    );

    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('rejects a send item whose messageId is an empty string', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { handler } = await freshHandlerWithFakeDb();

    const res = await handler(postBody({ sends: [validSend({ messageId: '' })] }));

    expect(res.status).toBe(400);
  });

  it('rejects an accountId longer than 64 characters', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { handler } = await freshHandlerWithFakeDb();

    const res = await handler(postBody({ sends: [validSend({ accountId: 'a'.repeat(65) })] }));

    expect(res.status).toBe(400);
  });

  it('rejects a messageId longer than 256 characters', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { handler } = await freshHandlerWithFakeDb();

    const res = await handler(postBody({ sends: [validSend({ messageId: 'm'.repeat(257) })] }));

    expect(res.status).toBe(400);
  });

  it('accepts accountId/messageId at exactly the length caps (64 / 256)', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { handler } = await freshHandlerWithFakeDb();

    const res = await handler(
      postBody({ sends: [validSend({ accountId: 'a'.repeat(64), messageId: 'm'.repeat(256) })] }),
    );

    expect(res.status).toBe(200);
  });

  it('rejects the whole batch when any single element is missing a required field — no partial mint', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { handler, calls } = await freshHandlerWithFakeDb();

    const res = await handler(
      postBody({
        sends: [
          validSend({ recipientEmail: 'good@x.com' }),
          { recipientEmail: 'bad@x.com', subject: 'hi' }, // missing accountId/messageId
        ],
      }),
    );

    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('uses the identical fixed error string across every malformed-body case', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { handler } = await freshHandlerWithFakeDb();

    const notJson = await handler(rawBody('nope'));
    const noSends = await handler(postBody({}));
    const missingAccountId = await handler(
      postBody({ sends: [{ recipientEmail: 'a@x.com', subject: 'hi', messageId: '<m@x>' }] }),
    );

    const bodies = await Promise.all([notJson.json(), noSends.json(), missingAccountId.json()]);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
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
          validSend({ recipientEmail: 'a@x.com' }),
          validSend({ recipientEmail: 'b@x.com', messageId: '<m2@postbox.example>' }),
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
      postBody({
        sends: order.map((recipientEmail, i) =>
          validSend({ recipientEmail, messageId: `<m${i}@postbox.example>` }),
        ),
      }),
    );
    const body = await res.json();

    expect(body.tokens.map((t: { recipientEmail: string }) => t.recipientEmail)).toEqual(order);
  });

  it('response items carry only token and recipientEmail — subject/accountId/messageId never echoed back', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { handler } = await freshHandlerWithFakeDb();

    const res = await handler(
      postBody({ sends: [validSend({ subject: 'a secret-ish subject', accountId: 'acct-secret' })] }),
    );
    const body = await res.json();

    expect(Object.keys(body.tokens[0])).toEqual(['token', 'recipientEmail']);
  });
});

describe('accountId / messageId carried through verbatim (fix round 1)', () => {
  it('binds accountId and messageId as parameters to the insert, unmodified', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { handler, calls } = await freshHandlerWithFakeDb();
    const accountId = 'sender-acct-1';
    const messageId = '<real-message-id@gmail.com>';

    const res = await handler(postBody({ sends: [validSend({ accountId, messageId })] }));

    expect(res.status).toBe(200);
    expect(calls[0]!.params).toContain(accountId);
    expect(calls[0]!.params).toContain(messageId);
  });

  it('never synthesizes the old sentinels — no "unattributed" account id, no @postbox.local placeholder', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const { handler, calls } = await freshHandlerWithFakeDb();

    const res = await handler(
      postBody({ sends: [validSend({ accountId: 'real-acct', messageId: '<real@gmail.com>' })] }),
    );

    expect(res.status).toBe(200);
    expect(calls[0]!.params).not.toContain('unattributed');
    expect(calls[0]!.params.some((p) => typeof p === 'string' && p.endsWith('@postbox.local'))).toBe(false);
  });
});

describe('database failure', () => {
  it('returns 500 when the insert throws, and does not report success', async () => {
    process.env.READ_API_TOKEN = TOKEN;
    const handler = await freshHandlerWithSql(async () => {
      throw new Error('boom');
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await handler(postBody({ sends: [validSend()] }));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).not.toHaveProperty('tokens');
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('never lets a planted recipient sentinel from the driver error reach the log line', async () => {
    // Simulates the risk named in review: this route inserts fresh
    // recipient/subject content on every request, and a future CHECK
    // constraint could echo a rejected value back in Postgres's error
    // DETAIL. Neon/pg errors carry a SQLSTATE `code` alongside `message` —
    // both are modelled here so the fix (errorCode() in api/tokens.ts) has
    // something real to prefer over the message.
    process.env.READ_API_TOKEN = TOKEN;
    const sentinelRecipient = 'sentinel-leak-4f8a@example.com';
    const handler = await freshHandlerWithSql(async () => {
      const dbError = new Error(
        `insert or update on table "tokens" violates check constraint "tokens_check" ` +
          `DETAIL: Failing row contains (..., ${sentinelRecipient}, ...).`,
      );
      (dbError as Error & { code: string }).code = '23514'; // Postgres check_violation
      throw dbError;
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await handler(
      postBody({ sends: [validSend({ recipientEmail: sentinelRecipient })] }),
    );

    expect(res.status).toBe(500);
    const loggedText = consoleErrorSpy.mock.calls
      .map((call) => call.map((arg) => String(arg)).join(' '))
      .join('\n');
    expect(loggedText).not.toContain(sentinelRecipient);
    // Non-vacuity: proves this isn't passing because nothing meaningful
    // was logged at all — the failure is still identified, just without
    // the sentinel content.
    expect(loggedText).toContain('insert failed');
    expect(loggedText).toContain('23514');

    consoleErrorSpy.mockRestore();
  });
});
