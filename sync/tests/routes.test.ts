import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRouter } from '../src/api/routes';
import {
  AUTH as auth,
  TOKEN,
  makeFakeDb,
  makeFakePool,
  readJson,
} from './helpers/api-fakes.ts';

/**
 * Auth gating, health, thread, inbox limit/cursor parsing, and malformed
 * path segments. The body/attachment routes and their budgeting, size cap
 * and Content-Disposition encoding live in routes-fetch.test.ts. Fakes are
 * shared from ./helpers/api-fakes.ts; nothing here opens a socket or
 * touches Postgres.
 */

const FAKE_DB = makeFakeDb();
const FAKE_POOL = makeFakePool().pool;
const router = createRouter(FAKE_DB, FAKE_POOL, TOKEN);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('router', () => {
  it('serves health without a token', async () => {
    const response = await router(new Request('http://x/api/health'));
    expect(response.status).toBe(200);
    const body = await readJson<{ accounts: Array<{ id: string; status: string }> }>(response);
    expect(body.accounts).toEqual([{ id: 'primary', status: 'connected' }]);
  });

  it('health never leaks anything beyond account id and status', async () => {
    // Guards Resolution 1 directly: adding an email/count field to the
    // health payload would fail this test even though the two fields above
    // would still look correct.
    const response = await router(new Request('http://x/api/health'));
    const body = await readJson<Record<string, unknown>>(response);
    expect(Object.keys(body).sort()).toEqual(['accounts', 'ok']);
    const accounts = body.accounts as Array<Record<string, unknown>>;
    expect(Object.keys(accounts[0]!).sort()).toEqual(['id', 'status']);
  });

  it('gates health on GET like every other route, instead of answering any method', async () => {
    // Finding 2: health used to be matched by path alone, before the
    // method check, so POST/DELETE/etc. all got a 200 with health data.
    // It must now fall through into the ordinary auth-then-404 pipeline
    // like any other route for any method other than GET.
    const response = await router(new Request('http://x/api/health', {
      method: 'POST',
      headers: auth,
    }));
    expect(response.status).toBe(404);
  });

  it('rejects the inbox without a token', async () => {
    const response = await router(new Request('http://x/api/inbox'));
    expect(response.status).toBe(401);
  });

  it('rejects a wrong token', async () => {
    const response = await router(new Request('http://x/api/inbox', {
      headers: { authorization: `Bearer ${'y'.repeat(32)}` },
    }));
    expect(response.status).toBe(401);
  });

  it('rejects an unknown route without a token the same as a real one (no route-existence oracle)', async () => {
    const response = await router(new Request('http://x/api/nope'));
    expect(response.status).toBe(401);
  });

  it('serves the inbox with a valid token', async () => {
    const response = await router(new Request('http://x/api/inbox', { headers: auth }));
    expect(response.status).toBe(200);
    const body = await readJson<{ messages: unknown[] }>(response);
    expect(body.messages).toHaveLength(1);
  });

  it('returns an empty array for an unknown thread rather than 404', async () => {
    const response = await router(new Request('http://x/api/thread/nope', { headers: auth }));
    expect(response.status).toBe(200);
    const body = await readJson<{ messages: unknown[] }>(response);
    expect(body.messages).toEqual([]);
  });

  it('404s an unknown route', async () => {
    const response = await router(new Request('http://x/api/nope', { headers: auth }));
    expect(response.status).toBe(404);
  });

  it('clamps an absurd limit rather than trusting the client', async () => {
    const response = await router(new Request('http://x/api/inbox?limit=999999', { headers: auth }));
    expect(response.status).toBe(200);
  });
});

describe('router / inbox limit and cursor parsing', () => {
  it('actually clamps the limit passed to the db, not just the response status', async () => {
    // The base "clamps an absurd limit" test above only proves the request
    // doesn't throw — FAKE_DB.getUnifiedInbox ignores its arguments
    // entirely, so it would pass even if clamping were deleted. This test
    // inspects what the db actually received.
    const seen: Array<{ limit: number }> = [];
    const db = makeFakeDb({
      getUnifiedInbox: async (options: { limit: number }) => {
        seen.push(options);
        return [];
      },
    });
    const r = createRouter(db, FAKE_POOL, TOKEN);

    await r(new Request('http://x/api/inbox?limit=999999', { headers: auth }));
    expect(seen[0]?.limit).toBe(200);
  });

  it('falls back to the default limit for a non-numeric value instead of throwing', async () => {
    const seen: Array<{ limit: number }> = [];
    const db = makeFakeDb({
      getUnifiedInbox: async (options: { limit: number }) => {
        seen.push(options);
        return [];
      },
    });
    const r = createRouter(db, FAKE_POOL, TOKEN);

    const response = await r(new Request('http://x/api/inbox?limit=banana', { headers: auth }));
    expect(response.status).toBe(200);
    expect(seen[0]?.limit).toBe(50);
  });

  it('clamps a negative limit up to 1 instead of throwing', async () => {
    const seen: Array<{ limit: number }> = [];
    const db = makeFakeDb({
      getUnifiedInbox: async (options: { limit: number }) => {
        seen.push(options);
        return [];
      },
    });
    const r = createRouter(db, FAKE_POOL, TOKEN);

    const response = await r(new Request('http://x/api/inbox?limit=-5', { headers: auth }));
    expect(response.status).toBe(200);
    expect(seen[0]?.limit).toBe(1);
  });

  it('ignores an unparsable before value rather than throwing', async () => {
    const seen: Array<{ cursor: unknown }> = [];
    const db = makeFakeDb({
      getUnifiedInbox: async (options: { cursor: unknown }) => {
        seen.push(options);
        return [];
      },
    });
    const r = createRouter(db, FAKE_POOL, TOKEN);

    const response = await r(new Request('http://x/api/inbox?before=not-a-date', { headers: auth }));
    expect(response.status).toBe(200);
    expect(seen[0]?.cursor).toBeNull();
  });

  it('passes a bare before timestamp through as a date-only cursor (backward tolerance)', async () => {
    const seen: Array<{ cursor: { date: Date | null; accountId: string | null; uid: number | null } | null }> = [];
    const db = makeFakeDb({
      getUnifiedInbox: async (options: never) => {
        seen.push(options);
        return [];
      },
    });
    const r = createRouter(db, FAKE_POOL, TOKEN);

    await r(new Request('http://x/api/inbox?before=2026-08-01T00:00:00.000Z', { headers: auth }));
    expect(seen[0]?.cursor).toEqual({
      date: new Date('2026-08-01T00:00:00.000Z'),
      accountId: null,
      uid: null,
    });
  });

  it('builds the full compound cursor when the client sends all three parts', async () => {
    // Without account_id and uid the cursor is a bare timestamp, and every
    // row tying with the previous page's last row is silently skipped —
    // Gmail timestamps are second-resolution and bulk deliveries share one.
    const seen: Array<{ cursor: unknown }> = [];
    const db = makeFakeDb({
      getUnifiedInbox: async (options: never) => {
        seen.push(options);
        return [];
      },
    });
    const r = createRouter(db, FAKE_POOL, TOKEN);

    await r(new Request(
      'http://x/api/inbox?before=2026-08-01T00:00:00.000Z&beforeAccount=work&beforeUid=42',
      { headers: auth },
    ));
    expect(seen[0]?.cursor).toEqual({
      date: new Date('2026-08-01T00:00:00.000Z'),
      accountId: 'work',
      uid: 42,
    });
  });

  it('accepts a cursor into the NULL-date tail (no before, but account and uid)', async () => {
    const seen: Array<{ cursor: unknown }> = [];
    const db = makeFakeDb({
      getUnifiedInbox: async (options: never) => {
        seen.push(options);
        return [];
      },
    });
    const r = createRouter(db, FAKE_POOL, TOKEN);

    await r(new Request('http://x/api/inbox?beforeAccount=work&beforeUid=42', { headers: auth }));
    expect(seen[0]?.cursor).toEqual({ date: null, accountId: 'work', uid: 42 });
  });

  it('ignores a non-numeric beforeUid rather than throwing', async () => {
    const seen: Array<{ cursor: unknown }> = [];
    const db = makeFakeDb({
      getUnifiedInbox: async (options: never) => {
        seen.push(options);
        return [];
      },
    });
    const r = createRouter(db, FAKE_POOL, TOKEN);

    const response = await r(new Request(
      'http://x/api/inbox?beforeAccount=work&beforeUid=banana',
      { headers: auth },
    ));
    expect(response.status).toBe(200);
    expect(seen[0]?.cursor).toBeNull();
  });

  it('emits a nextCursor a client can page with when the page is full', async () => {
    const db = makeFakeDb({
      getUnifiedInbox: async () => [
        { account_id: 'work', uid: '41', date: new Date('2026-08-02T00:00:00.000Z') },
        { account_id: 'work', uid: '40', date: new Date('2026-08-01T00:00:00.000Z') },
      ],
    });
    const r = createRouter(db, FAKE_POOL, TOKEN);

    const response = await r(new Request('http://x/api/inbox?limit=2', { headers: auth }));
    const body = await readJson<{ nextCursor: unknown }>(response);
    expect(body.nextCursor).toEqual({
      before: '2026-08-01T00:00:00.000Z',
      beforeAccount: 'work',
      beforeUid: '40',
    });
  });

  it('emits a null-dated nextCursor for the NULL-date tail', async () => {
    const db = makeFakeDb({
      getUnifiedInbox: async () => [{ account_id: 'work', uid: '9', date: null }],
    });
    const r = createRouter(db, FAKE_POOL, TOKEN);

    const response = await r(new Request('http://x/api/inbox?limit=1', { headers: auth }));
    const body = await readJson<{ nextCursor: { before: string | null } }>(response);
    expect(body.nextCursor).toEqual({ before: null, beforeAccount: 'work', beforeUid: '9' });
  });

  it('emits no nextCursor on a short (final) page', async () => {
    const response = await router(new Request('http://x/api/inbox?limit=50', { headers: auth }));
    const body = await readJson<{ nextCursor: unknown }>(response);
    expect(body.nextCursor).toBeNull();
  });
});

describe('router / malformed path segments', () => {
  // Finding 1: decodeURIComponent throws a URIError on malformed
  // percent-encoding (e.g. a lone "%", or "%zz"). Before the
  // decodeSegment/decodeSegments guard, that throw escaped the route
  // handler entirely — violating createRouter's "always resolves to a
  // Response" contract for any caller that doesn't happen to wrap it in
  // its own try/catch. These assert 400, the correct response to
  // malformed client input, not a crash.
  //
  // Mutation check performed by hand (see task-8-report.md addendum):
  // temporarily reverting decodeSegment to call decodeURIComponent
  // directly (no try/catch) makes every test in this block fail with an
  // unhandled URIError rather than a clean 400 assertion failure,
  // confirming these tests are causally tied to the guard.

  it('400s a malformed percent-encoding in the thread id', async () => {
    const response = await router(new Request('http://x/api/thread/%', { headers: auth }));
    expect(response.status).toBe(400);
  });

  it('400s a malformed percent-encoding in the message-body account id', async () => {
    const response = await router(new Request('http://x/api/message/%/INBOX/1/body', { headers: auth }));
    expect(response.status).toBe(400);
  });

  it('400s a malformed percent-encoding in the message-body folder', async () => {
    const response = await router(new Request('http://x/api/message/acct1/%/1/body', { headers: auth }));
    expect(response.status).toBe(400);
  });

  it('400s a malformed percent-encoding in the attachment account id', async () => {
    const response = await router(new Request('http://x/api/attachment/%/INBOX/1/2.1', { headers: auth }));
    expect(response.status).toBe(400);
  });

  it('400s a malformed percent-encoding in the attachment folder', async () => {
    const response = await router(new Request('http://x/api/attachment/acct1/%/1/2.1', { headers: auth }));
    expect(response.status).toBe(400);
  });

  it('400s a malformed percent-encoding in the attachment part id', async () => {
    const response = await router(new Request('http://x/api/attachment/acct1/INBOX/1/%', { headers: auth }));
    expect(response.status).toBe(400);
  });
});
