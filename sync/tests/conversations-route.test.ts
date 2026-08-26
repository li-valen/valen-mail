import { describe, it, expect } from 'vitest';
import { createRouter } from '../src/api/routes';
import type { AccountConfig } from '../src/config';
import { AUTH as auth, TOKEN, makeFakeDb, makeFakePool, readJson } from './helpers/api-fakes.ts';

/**
 * GET /api/conversations — the HTTP contract of the collapsed list.
 *
 * The SQL that decides what a conversation IS lives in ../src/db.ts and
 * is proven in tests/db-filter.test.ts (generated statement) and
 * tests/db.test.ts (against a real Postgres). What THIS suite proves is
 * the route: that the filters reach the query rather than being parsed
 * and dropped, that `q` switches it to the grouped view of /api/search
 * INCLUDING that route's different folder default, and — the one that
 * matters most — that the next cursor is derived from the conversations
 * and never from the messages.
 *
 * Nothing here opens a socket or touches Postgres.
 */

const ACCOUNTS: readonly AccountConfig[] = [
  { id: 'harvard', email: 'a@example.com', appPassword: 'x'.repeat(16), isPrimary: true },
  { id: 'personal', email: 'b@example.com', appPassword: 'y'.repeat(16), isPrimary: false },
];

interface SeenQuery {
  readonly search?: unknown;
  readonly folder?: unknown;
  readonly accountId?: unknown;
  readonly limit?: unknown;
  readonly cursor?: unknown;
}

function routerWith(
  page: { messages: readonly unknown[]; representatives: readonly unknown[] } = {
    messages: [],
    representatives: [],
  },
  discoveredFolders?: Record<string, unknown>,
) {
  const seen: SeenQuery[] = [];
  const db = makeFakeDb({
    getConversationPage: async (query: SeenQuery) => {
      seen.push(query);
      return { messages: [...page.messages], representatives: [...page.representatives] };
    },
  });
  const pool = makeFakePool({ discoveredFolders: discoveredFolders as never }).pool;
  const router = createRouter(db, pool, TOKEN, null, undefined, null, undefined, ACCOUNTS);
  return { router, seen };
}

/** One representative row, shaped the way nextCursorFrom reads it. */
function rep(accountId: string, uid: string, iso: string | null) {
  return { account_id: accountId, uid, date: iso === null ? null : new Date(iso) };
}

describe('GET /api/conversations — the gate and the shape', () => {
  it('refuses an unauthenticated request', async () => {
    const { router } = routerWith();
    const response = await router(new Request('http://x/api/conversations'));
    expect(response.status).toBe(401);
  });

  it('answers the same envelope as /api/inbox: messages plus a cursor', async () => {
    const { router } = routerWith({
      messages: [{ subject: 'newest' }, { subject: 'older' }],
      representatives: [rep('harvard', '9', '2026-08-01T00:00:00Z')],
    });
    const response = await router(new Request('http://x/api/conversations', { headers: auth }));
    expect(response.status).toBe(200);
    const body = await readJson<{ messages: unknown[]; nextCursor: unknown }>(response);
    expect(body.messages).toHaveLength(2);
    expect('nextCursor' in body).toBe(true);
  });

  it('never lets a shared cache keep a page of mail', async () => {
    const { router } = routerWith();
    const response = await router(new Request('http://x/api/conversations', { headers: auth }));
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
});

describe('GET /api/conversations — the cursor comes from the CONVERSATIONS', () => {
  /**
   * THE DEFECT THIS SUITE EXISTS FOR. `messages` ends with the OLDEST
   * message of the LAST conversation on the page; `representatives` ends
   * with that conversation's NEWEST. Building the cursor from `messages`
   * would resume paging inside a thread the client already holds whole,
   * and every later page would re-send its tail — with a perfectly
   * ordinary 200 and nothing anywhere reporting it.
   */
  it('emits the last REPRESENTATIVE, not the last message', async () => {
    const { router } = routerWith({
      // A page of two conversations; the second has three messages, so
      // the flat list ends far older than the conversation does.
      messages: [
        { account_id: 'harvard', uid: '9', date: new Date('2026-08-05T00:00:00Z') },
        { account_id: 'personal', uid: '7', date: new Date('2026-08-04T00:00:00Z') },
        { account_id: 'personal', uid: '5', date: new Date('2026-01-01T00:00:00Z') },
        { account_id: 'personal', uid: '2', date: new Date('2025-01-01T00:00:00Z') },
      ],
      representatives: [
        rep('harvard', '9', '2026-08-05T00:00:00Z'),
        rep('personal', '7', '2026-08-04T00:00:00Z'),
      ],
    });
    const response = await router(
      new Request('http://x/api/conversations?limit=2', { headers: auth }),
    );
    const body = await readJson<{ messages: unknown[]; nextCursor: unknown }>(response);
    expect(body.nextCursor).toEqual({
      before: '2026-08-04T00:00:00.000Z',
      beforeAccount: 'personal',
      beforeUid: '7',
    });
  });

  it('counts CONVERSATIONS against the limit, so a short page ends the list', async () => {
    // Four messages but only one conversation: against a limit of two
    // that is a short page and there is nothing after it. Counting
    // `messages` instead would emit a cursor and the client would page
    // forever over an exhausted list.
    const { router } = routerWith({
      messages: [{ account_id: 'harvard', uid: '9', date: new Date('2026-08-05T00:00:00Z') }],
      representatives: [rep('harvard', '9', '2026-08-05T00:00:00Z')],
    });
    const response = await router(new Request('http://x/api/conversations?limit=2', { headers: auth }));
    const body = await readJson<{ messages: unknown[]; nextCursor: unknown }>(response);
    expect(body.nextCursor).toBeNull();
  });
});

describe('GET /api/conversations — the filters actually reach the query', () => {
  it('defaults to the inbox when there is no q, exactly like /api/inbox', async () => {
    const { router, seen } = routerWith();
    await router(new Request('http://x/api/conversations', { headers: auth }));
    expect(seen[0]?.folder).toEqual({ kind: 'literal', folder: 'INBOX' });
    expect(seen[0]?.search).toBeNull();
  });

  it('passes the account filter through', async () => {
    const { router, seen } = routerWith();
    await router(new Request('http://x/api/conversations?account=personal', { headers: auth }));
    expect(seen[0]?.accountId).toBe('personal');
  });

  it('400s on an account that is not configured rather than answering an empty 200', async () => {
    const { router, seen } = routerWith();
    const response = await router(new Request('http://x/api/conversations?account=nope', { headers: auth }));
    expect(response.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('400s on a folder this API does not understand', async () => {
    const { router, seen } = routerWith();
    const response = await router(new Request('http://x/api/conversations?folder=drafts', { headers: auth }));
    expect(response.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('forwards the keyset cursor unchanged', async () => {
    const { router, seen } = routerWith();
    await router(
      new Request(
        'http://x/api/conversations?before=2026-08-01T00:00:00.000Z&beforeAccount=harvard&beforeUid=42',
        { headers: auth },
      ),
    );
    expect(seen[0]?.cursor).toEqual({
      date: new Date('2026-08-01T00:00:00.000Z'),
      accountId: 'harvard',
      uid: 42,
    });
  });
});

describe('GET /api/conversations — `q` makes it the grouped view of /api/search', () => {
  it('passes the trimmed query down', async () => {
    const { router, seen } = routerWith();
    await router(new Request('http://x/api/conversations?q=%20numbers%20', { headers: auth }));
    expect(seen[0]?.search).toBe('numbers');
  });

  it('adopts /api/search’s folder default — every synced folder, not INBOX', async () => {
    // The whole reason resolveSearchFolder is imported rather than
    // restated: `?q=x` here and `?q=x` on /api/search must answer from the
    // same result set, and /api/search's unscoped default is 'all'.
    const { router, seen } = routerWith();
    await router(new Request('http://x/api/conversations?q=numbers', { headers: auth }));
    expect(seen[0]?.folder).toEqual({ kind: 'all' });
  });

  it('still honours an explicit folder alongside a query', async () => {
    const { router, seen } = routerWith();
    await router(new Request('http://x/api/conversations?q=numbers&folder=inbox', { headers: auth }));
    expect(seen[0]?.folder).toEqual({ kind: 'literal', folder: 'INBOX' });
  });

  it('treats a cleared search box as no search rather than a 400', async () => {
    // The client debounces its box; a cleared query reaches this route as
    // `q=` and must be the ordinary inbox request, not one 400 per
    // keystroke of backspacing.
    const { router, seen } = routerWith();
    const response = await router(new Request('http://x/api/conversations?q=', { headers: auth }));
    expect(response.status).toBe(200);
    expect(seen[0]?.search).toBeNull();
    expect(seen[0]?.folder).toEqual({ kind: 'literal', folder: 'INBOX' });
  });

  it('treats a whitespace-only search the same way', async () => {
    const { router, seen } = routerWith();
    const response = await router(new Request('http://x/api/conversations?q=%20%20', { headers: auth }));
    expect(response.status).toBe(200);
    expect(seen[0]?.search).toBeNull();
  });

  it('still refuses an over-long query, because that is a bound on work', async () => {
    const { router, seen } = routerWith();
    const response = await router(
      new Request(`http://x/api/conversations?q=${'x'.repeat(201)}`, { headers: auth }),
    );
    expect(response.status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});
