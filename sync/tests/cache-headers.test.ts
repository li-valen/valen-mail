import { describe, it, expect } from 'vitest';
import { createRouter } from '../src/api/routes';
import {
  AUTH as auth,
  TOKEN,
  makeFakeConnection,
  makeFakeDb,
  makeFakePool,
} from './helpers/api-fakes.ts';

/**
 * Every route that returns mailbox data must forbid caching.
 *
 * This only became load-bearing when the session cookie shipped. While the
 * sole credential was an `Authorization` header, no cache treats the
 * response as shareable; an ambient cookie authorises the same bytes and
 * they were going out with no freshness directives at all. Task 6 adds a
 * service worker and Task 8 puts a static file server on this same origin,
 * either of which could persist four mailboxes to disk.
 */

const CACHE_CONTROL = 'private, no-store';

describe('cache headers on mailbox data', () => {
  const router = createRouter(makeFakeDb(), makeFakePool().pool, TOKEN);

  it('forbids caching the unified inbox', async () => {
    const response = await router(new Request('http://x/api/inbox', { headers: auth }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL);
  });

  it('forbids caching a thread', async () => {
    const response = await router(new Request('http://x/api/thread/t1', { headers: auth }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL);
  });

  it('forbids caching the opens rail, including its degraded answer', async () => {
    // Degraded (no tracking configured) still answers 200 with a body that
    // reflects live state, so it must not be cached either.
    const response = await router(new Request('http://x/api/opens', { headers: auth }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL);
  });

  it('forbids caching the opens rail when tracking IS configured and healthy', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ opens: [{ token: 't', occurredAt: 1 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const r = createRouter(
      makeFakeDb(),
      makeFakePool().pool,
      TOKEN,
      { baseUrl: 'https://tracking.invalid', readToken: 'read' },
      fetchImpl,
    );
    const response = await r(new Request('http://x/api/opens', { headers: auth }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL);
  });

  it('forbids caching a raw message body', async () => {
    const { pool } = makeFakePool({
      connections: { primary: makeFakeConnection({ chunks: [Buffer.from('raw')] }) },
    });
    const r = createRouter(makeFakeDb(), pool, TOKEN);
    const response = await r(
      new Request('http://x/api/message/primary/INBOX/12/body', { headers: auth }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('message/rfc822');
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL);
  });

  it('forbids caching an attachment without clobbering its content type', async () => {
    const { pool } = makeFakePool({
      connections: { primary: makeFakeConnection({ chunks: [Buffer.from('bytes')] }) },
    });
    const db = makeFakeDb({
      query: async () => [{ filename: 'notes.pdf', mime_type: 'application/pdf' }],
    });
    const r = createRouter(db, pool, TOKEN);
    const response = await r(
      new Request('http://x/api/attachment/primary/INBOX/12/2', { headers: auth }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toContain('notes.pdf');
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL);
  });

  it('leaves /api/health cacheable — it carries no mailbox data by construction', async () => {
    // Guards the scope of the change as much as the change itself: adding
    // no-store everywhere would be cargo cult, and health is the one route
    // Resolution 1 already proved incapable of leaking mailbox contents.
    const response = await router(new Request('http://x/api/health'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBeNull();
  });
});
