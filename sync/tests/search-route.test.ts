import { describe, it, expect } from 'vitest';
import { createRouter } from '../src/api/routes';
import { MAX_QUERY_LENGTH, parseQueryParam } from '../src/api/search';
import type { AccountConfig } from '../src/config';
import {
  AUTH as auth,
  TOKEN,
  makeFakeDb,
  makeFakePool,
  readJson,
} from './helpers/api-fakes.ts';

/**
 * GET /api/search (Plan 7 Task 1) — the route behind the client's
 * Gmail-shaped search bar.
 *
 * The SQL itself (parameterization, wildcard escaping, how the search
 * clause composes with folder/account/cursor) is proven in
 * tests/db-filter.test.ts against the generated statement. What THIS suite
 * proves is the HTTP contract: the auth gate, the two 400s, the caching
 * header, and that the query and every filter actually reach the database
 * layer rather than being parsed and dropped.
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

function routerWith(options: {
  rows?: readonly unknown[];
  discoveredFolders?: Record<string, unknown>;
} = {}) {
  const seen: SeenQuery[] = [];
  const db = makeFakeDb({
    getUnifiedInbox: async (query: SeenQuery) => {
      seen.push(query);
      return [...(options.rows ?? [])];
    },
  });
  const pool = makeFakePool({ discoveredFolders: options.discoveredFolders as never }).pool;
  const router = createRouter(db, pool, TOKEN, null, undefined, null, undefined, ACCOUNTS);
  return { router, seen };
}

describe('parseQueryParam', () => {
  it('accepts an ordinary query, trimmed', () => {
    expect(parseQueryParam('  numbers  ')).toEqual({ kind: 'ok', query: 'numbers' });
  });

  it('rejects an absent query', () => {
    expect(parseQueryParam(null)).toEqual({ kind: 'empty' });
  });

  it('rejects a whitespace-only query rather than matching most of the mailbox', () => {
    // A debounced search-as-you-type box produces this constantly: one
    // space keystroke would otherwise become ILIKE '%   %'.
    expect(parseQueryParam('   ')).toEqual({ kind: 'empty' });
  });

  it('rejects a query past the cap instead of silently truncating it', () => {
    expect(parseQueryParam('x'.repeat(MAX_QUERY_LENGTH))).toEqual({
      kind: 'ok',
      query: 'x'.repeat(MAX_QUERY_LENGTH),
    });
    expect(parseQueryParam('x'.repeat(MAX_QUERY_LENGTH + 1))).toEqual({ kind: 'too-long' });
  });

  it('does not confuse a user searching for the word "empty" with the empty signal', () => {
    // Why this is a union and not a string sentinel: `q` is free-form text
    // and any sentinel string is something a user could genuinely search
    // for.
    expect(parseQueryParam('empty')).toEqual({ kind: 'ok', query: 'empty' });
    expect(parseQueryParam('invalid')).toEqual({ kind: 'ok', query: 'invalid' });
  });
});

describe('GET /api/search', () => {
  it('requires a credential, exactly like every other mailbox route', async () => {
    const { router } = routerWith();
    const response = await router(new Request('http://x/api/search?q=numbers'));
    expect(response.status).toBe(401);
  });

  it('passes the query through to the database layer', async () => {
    const { router, seen } = routerWith();
    const response = await router(new Request('http://x/api/search?q=numbers', { headers: auth }));

    expect(response.status).toBe(200);
    expect(seen[0]?.search).toBe('numbers');
  });

  it('hands the raw query down UNESCAPED — escaping belongs to the one place that builds the pattern', async () => {
    // If the route escaped as well, `100%` would arrive at buildInboxFilter
    // as `100\%` and be escaped a second time into `100\\%`: a literal
    // backslash followed by a live wildcard. Escaping exactly once, at the
    // point the LIKE pattern is built, is what makes that impossible.
    const { router, seen } = routerWith();
    await router(new Request('http://x/api/search?q=100%25', { headers: auth }));
    expect(seen[0]?.search).toBe('100%');
  });

  it('answers a missing query with a fixed 400 and never touches the database', async () => {
    const { router, seen } = routerWith();
    const response = await router(new Request('http://x/api/search', { headers: auth }));

    expect(response.status).toBe(400);
    expect(await readJson<{ error: string }>(response)).toEqual({ error: 'missing query' });
    expect(seen).toHaveLength(0);
  });

  it('answers an empty query with the same fixed 400', async () => {
    const { router } = routerWith();
    const response = await router(new Request('http://x/api/search?q=', { headers: auth }));
    expect(response.status).toBe(400);
    expect(await readJson<{ error: string }>(response)).toEqual({ error: 'missing query' });
  });

  it('answers a whitespace-only query with the same fixed 400', async () => {
    const { router } = routerWith();
    const response = await router(new Request('http://x/api/search?q=%20%20', { headers: auth }));
    expect(response.status).toBe(400);
  });

  it('answers an over-long query with a fixed 400 that does not echo it back', async () => {
    const { router, seen } = routerWith();
    const hostile = 'a'.repeat(MAX_QUERY_LENGTH + 1);
    const response = await router(
      new Request(`http://x/api/search?q=${hostile}`, { headers: auth }),
    );

    expect(response.status).toBe(400);
    const body = await readJson<{ error: string }>(response);
    expect(body).toEqual({ error: 'query too long' });
    expect(JSON.stringify(body)).not.toContain(hostile);
    expect(seen).toHaveLength(0);
  });

  it('searches EVERY folder by default, unlike /api/inbox which defaults to INBOX', async () => {
    // A search box that silently ignored Sent and Trash is wrong in the
    // way a user notices immediately ("I know I sent that").
    const { router, seen } = routerWith();
    await router(new Request('http://x/api/search?q=numbers', { headers: auth }));
    expect(seen[0]?.folder).toEqual({ kind: 'all' });
  });

  it('scopes to one folder when asked, resolving it exactly the way /api/inbox does', async () => {
    const { router, seen } = routerWith({
      discoveredFolders: {
        harvard: { inbox: 'INBOX', sent: '[Gmail]/Sent Mail', spam: null, trash: null },
        personal: { inbox: 'INBOX', sent: 'Envoyés', spam: null, trash: null },
      },
    });

    await router(new Request('http://x/api/search?q=invoice&folder=sent', { headers: auth }));

    expect(seen[0]?.folder).toEqual({
      kind: 'pairs',
      pairs: [
        { accountId: 'harvard', folder: '[Gmail]/Sent Mail' },
        { accountId: 'personal', folder: 'Envoyés' },
      ],
    });
  });

  it('composes the query with folder AND account together', async () => {
    const { router, seen } = routerWith({
      discoveredFolders: {
        harvard: { inbox: 'INBOX', sent: '[Gmail]/Sent Mail', spam: '[Gmail]/Spam', trash: null },
        personal: { inbox: 'INBOX', sent: 'Envoyés', spam: 'Indésirables', trash: null },
      },
    });

    const response = await router(
      new Request('http://x/api/search?q=invoice&folder=spam&account=personal', { headers: auth }),
    );

    expect(response.status).toBe(200);
    expect(seen[0]).toMatchObject({
      search: 'invoice',
      accountId: 'personal',
      folder: { kind: 'pairs', pairs: [{ accountId: 'personal', folder: 'Indésirables' }] },
    });
  });

  it('rejects an unknown folder with the same fixed 400 /api/inbox uses', async () => {
    const { router, seen } = routerWith();
    const response = await router(
      new Request('http://x/api/search?q=invoice&folder=archive', { headers: auth }),
    );
    expect(response.status).toBe(400);
    expect(await readJson<{ error: string }>(response)).toEqual({ error: 'invalid folder' });
    expect(seen).toHaveLength(0);
  });

  it('rejects an unknown account with a fixed 400 rather than an empty-looking 200', async () => {
    const { router, seen } = routerWith();
    const response = await router(
      new Request('http://x/api/search?q=invoice&account=nope', { headers: auth }),
    );
    expect(response.status).toBe(400);
    expect(await readJson<{ error: string }>(response)).toEqual({ error: 'invalid account' });
    expect(seen).toHaveLength(0);
  });

  it('clamps the limit through the same shared parser as every other paginated route', async () => {
    const { router, seen } = routerWith();
    await router(new Request('http://x/api/search?q=numbers&limit=999999', { headers: auth }));
    expect(seen[0]?.limit).toBe(200);
  });

  it('accepts and forwards the same keyset cursor /api/inbox emits', async () => {
    // The pagination decision, made visible: search reuses the inbox
    // cursor rather than inventing a scheme or refusing to page.
    const { router, seen } = routerWith();
    await router(
      new Request(
        'http://x/api/search?q=numbers&before=2026-08-01T00:00:00.000Z&beforeAccount=harvard&beforeUid=42',
        { headers: auth },
      ),
    );

    expect(seen[0]?.cursor).toEqual({
      date: new Date('2026-08-01T00:00:00.000Z'),
      accountId: 'harvard',
      uid: 42,
    });
  });

  it('emits a next cursor when the page is full, and none when it is short', async () => {
    const row = { account_id: 'harvard', uid: 42, date: new Date('2026-08-01T00:00:00.000Z') };
    const full = routerWith({ rows: [row] });
    const fullResponse = await full.router(
      new Request('http://x/api/search?q=numbers&limit=1', { headers: auth }),
    );
    const fullBody = await readJson<{ nextCursor: unknown }>(fullResponse);
    expect(fullBody.nextCursor).toEqual({
      before: '2026-08-01T00:00:00.000Z',
      beforeAccount: 'harvard',
      beforeUid: '42',
    });

    const short = routerWith({ rows: [row] });
    const shortResponse = await short.router(
      new Request('http://x/api/search?q=numbers&limit=50', { headers: auth }),
    );
    const shortBody = await readJson<{ nextCursor: unknown }>(shortResponse);
    expect(shortBody.nextCursor).toBeNull();
  });

  it('is never cached: a search result is mailbox content and the query is in the URL', async () => {
    const { router } = routerWith();
    const response = await router(new Request('http://x/api/search?q=numbers', { headers: auth }));
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('answers 404 for a non-GET, like every other read route', async () => {
    const { router } = routerWith();
    const response = await router(
      new Request('http://x/api/search?q=numbers', { method: 'POST', headers: auth }),
    );
    expect(response.status).toBe(404);
  });
});
