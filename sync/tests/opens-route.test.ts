import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRouter } from '../src/api/routes';
import { AUTH as auth, TOKEN, makeFakeDb, makeFakePool, readJson } from './helpers/api-fakes.ts';
import type { TrackingConfig } from '../src/config';

/**
 * Route-level coverage for GET /api/opens: the HTTP contract the amendment
 * cares about most — the *route* must always answer 200, even when the
 * tracking service is down, and must carry an explicit `available` flag
 * that Task 5's rail branches on. fetchOpens's own unit tests (in
 * opens-proxy.test.ts) cover the OpensResult shape; these tests cover what
 * createRouter does with that result, using an injected fetchImpl so
 * nothing here makes a real network call.
 */

const FAKE_DB = makeFakeDb();
const FAKE_POOL = makeFakePool().pool;
const TRACKING: TrackingConfig = { baseUrl: 'https://t.example', readToken: 'r'.repeat(32) };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/opens', () => {
  it('rejects without a token, same as every other /api/* route', async () => {
    const router = createRouter(FAKE_DB, FAKE_POOL, TOKEN, TRACKING);
    const response = await router(new Request('http://x/api/opens'));
    expect(response.status).toBe(401);
  });

  it('returns 200 with available:false and opens:[] when tracking config is absent', async () => {
    // Amendment: missing TRACKING_BASE_URL/TRACKING_READ_TOKEN must not
    // fail closed — the route degrades instead of erroring.
    const router = createRouter(FAKE_DB, FAKE_POOL, TOKEN, null);
    const response = await router(new Request('http://x/api/opens', { headers: auth }));
    expect(response.status).toBe(200);
    const body = await readJson<{ opens: unknown[]; available: boolean }>(response);
    expect(body).toEqual({ opens: [], available: false });
  });

  it('returns 200 with available:false when the tracking service is unreachable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const router = createRouter(FAKE_DB, FAKE_POOL, TOKEN, TRACKING, fetchImpl);
    const response = await router(new Request('http://x/api/opens', { headers: auth }));
    // This is the assertion the amendment calls out by name: a test that
    // only checked `opens: []` would still pass under the broken design
    // where fetchOpens returns [] for both "no opens yet" and "unreachable".
    expect(response.status).toBe(200);
    const body = await readJson<{ opens: unknown[]; available: boolean }>(response);
    expect(body.available).toBe(false);
    expect(body.opens).toEqual([]);
  });

  it('returns 200 with available:false when tracking responds with a 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    const router = createRouter(FAKE_DB, FAKE_POOL, TOKEN, TRACKING, fetchImpl);
    const response = await router(new Request('http://x/api/opens', { headers: auth }));
    expect(response.status).toBe(200);
    const body = await readJson<{ opens: unknown[]; available: boolean }>(response);
    expect(body.available).toBe(false);
    expect(body.opens).toEqual([]);
  });

  it('returns 200 with available:true and the opens payload on success', async () => {
    const event = {
      token: 'abc',
      recipientEmail: 'x@example.com',
      subject: null,
      sentAt: 1,
      occurredAt: 2,
      classification: 'open',
      deviceClass: null,
      os: null,
      // Required since the mint contract widened: every token carries the
      // sending account and the real RFC Message-ID of the mail it rode in,
      // which is what lets the client resolve an open back to its message.
      // isValidOpenEvent drops an event missing either, so a fixture without
      // them is silently filtered and this route returns [].
      accountId: 'primary',
      messageId: '<abc@postbox.test>',
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ opens: [event] }), { status: 200 }),
    );
    const router = createRouter(FAKE_DB, FAKE_POOL, TOKEN, TRACKING, fetchImpl);
    const response = await router(new Request('http://x/api/opens', { headers: auth }));
    expect(response.status).toBe(200);
    const body = await readJson<{ opens: unknown[]; available: boolean }>(response);
    // This is the inverse mutation check: a route that always returned
    // available:false would fail this assertion.
    expect(body.available).toBe(true);
    expect(body.opens).toEqual([event]);
  });

  it('sends the tracking token as a bearer header, never in the outgoing request URL', async () => {
    // Fix 4 (fix round 1 review): absence-only ("not in the URL") also
    // passes against a build that never sends the token anywhere at all.
    // The positive assertion on the authorization header is what makes
    // this load-bearing — it would fail if the header were dropped,
    // renamed, or malformed, not just if the token leaked into the URL.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ opens: [] }), { status: 200 }),
    );
    const router = createRouter(FAKE_DB, FAKE_POOL, TOKEN, TRACKING, fetchImpl);
    await router(new Request('http://x/api/opens', { headers: auth }));
    expect(fetchImpl).toHaveBeenCalled();
    const [calledUrl, init] = fetchImpl.mock.calls[0]!;
    expect(String(calledUrl)).not.toContain(TRACKING.readToken);
    expect((init as { headers: { authorization: string } }).headers.authorization).toBe(
      `Bearer ${TRACKING.readToken}`,
    );
  });

  it('forwards a clamped limit from the query string', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ opens: [] }), { status: 200 }),
    );
    const router = createRouter(FAKE_DB, FAKE_POOL, TOKEN, TRACKING, fetchImpl);
    await router(new Request('http://x/api/opens?limit=999999', { headers: auth }));
    const calledUrl = String(fetchImpl.mock.calls[0]![0]);
    expect(calledUrl).toContain('limit=200');
  });
});
