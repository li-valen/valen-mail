import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRouter } from '../src/api/routes.ts';
import { AUTH as auth, TOKEN, makeFakeDb, makeFakePool } from './helpers/api-fakes.ts';

/**
 * Router-level wiring for Task 8: proves that adding static/SPA serving to
 * createRouter's dispatcher does not change ANYTHING about how /api/* is
 * routed or authenticated, and that the static half behaves correctly when
 * reached through the real router rather than ./static.ts in isolation
 * (that finer-grained coverage — content types, cache policy, containment —
 * lives in tests/static.test.ts).
 *
 * Every router built here is pointed at a fixture tree under
 * tests/fixtures/static/, never the real sync/public, which two concurrent
 * agents can rewrite mid-build (see this task's brief).
 */

const FIXTURE_ROOT = path.resolve(import.meta.dirname, 'fixtures', 'static');

function fixtureRouter(): (request: Request) => Promise<Response> {
  return createRouter(makeFakeDb(), makeFakePool().pool, TOKEN, null, undefined, null, FIXTURE_ROOT);
}

describe('static serving never shadows /api/* (pre-flight FINDING 2, load-bearing)', () => {
  it('GET /api/inbox without credentials is still 401, not 200-with-index.html', async () => {
    // The router below is built against a fixture root that DOES have an
    // index.html — if the static/SPA fallback were ever reachable for an
    // /api/* path, this exact request is what would silently start
    // returning the app shell instead of a 401.
    const response = await fixtureRouter()(new Request('http://x/api/inbox'));
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe('application/json');
  });

  it('POST /api/session with a wrong token is still 401, not shadowed either', async () => {
    const response = await fixtureRouter()(
      new Request('http://x/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'y'.repeat(32) }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it('an unknown authenticated /api path is still 404 (JSON), not the SPA fallback', async () => {
    const response = await fixtureRouter()(new Request('http://x/api/nope', { headers: auth }));
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/json');
  });

  it('an unknown unauthenticated /api path is still 401, preserving the no-route-existence-oracle rule', async () => {
    const response = await fixtureRouter()(new Request('http://x/api/nope'));
    expect(response.status).toBe(401);
  });

  it('a real authenticated API route still serves real data with static installed', async () => {
    const response = await fixtureRouter()(new Request('http://x/api/inbox', { headers: auth }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
  });
});

describe('static and SPA fallback, reached through the real router', () => {
  it('serves the app shell at "/" with no credential required', async () => {
    const response = await fixtureRouter()(new Request('http://x/'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toContain('fixture index.html');
  });

  it('falls back to the app shell for a client-side route', async () => {
    const response = await fixtureRouter()(new Request('http://x/thread/abc123'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(await response.text()).toContain('fixture index.html');
  });

  it('serves a hashed asset with an immutable cache and no auth', async () => {
    const response = await fixtureRouter()(new Request('http://x/assets/app-Abc123.js'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  });

  it('serves sw.js with no-cache and no auth', async () => {
    const response = await fixtureRouter()(new Request('http://x/sw.js'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it('a missing non-HTML asset is a clean 404, not the app shell', async () => {
    const response = await fixtureRouter()(new Request('http://x/assets/gone.js'));
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).not.toContain('html');
  });

  it('answers HEAD with headers and no body', async () => {
    const response = await fixtureRouter()(new Request('http://x/', { method: 'HEAD' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toBe('');
  });

  it('a traversal attempt through the real router never escapes the fixture root', async () => {
    const response = await fixtureRouter()(
      new Request('http://x/%2e%2e/%2e%2e/%2e%2e/secrets'),
    );
    // Whichever way it fails closed (fallback or 404), it must never be a
    // 200 carrying anything other than the fixture's own index.html.
    if (response.status === 200) {
      expect(await response.text()).toContain('fixture index.html');
    } else {
      expect(response.status).toBe(404);
    }
  });
});

describe('static serving degrades instead of crashing when nothing is built yet', () => {
  function routerWithMissingRoot(): (request: Request) => Promise<Response> {
    return createRouter(
      makeFakeDb(),
      makeFakePool().pool,
      TOKEN,
      null,
      undefined,
      null,
      '/nonexistent-postbox-static-root-for-routing-tests',
    );
  }

  it('the API keeps working normally', async () => {
    const response = await routerWithMissingRoot()(new Request('http://x/api/health'));
    expect(response.status).toBe(200);
  });

  it('a non-API request 404s with a plain body instead of throwing', async () => {
    const response = await routerWithMissingRoot()(new Request('http://x/'));
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/plain');
  });
});
