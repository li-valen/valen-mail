import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRouter } from '../src/api/routes';
import { SESSION_COOKIE_NAME, mintSessionValue, SESSION_TTL_MS } from '../src/api/session';
import {
  SESSION_RATE_LIMIT_MAX_FAILURES,
  SESSION_RATE_LIMIT_WINDOW_MS,
} from '../src/api/rate-limit';
import { AUTH as auth, TOKEN, makeFakeDb, makeFakePool, readJson } from './helpers/api-fakes.ts';

/**
 * The router half of the hybrid credential: /api/* must accept EITHER the
 * unchanged `Authorization: Bearer <API_TOKEN>` or a session cookie, and
 * POST/GET/DELETE /api/session must behave. The credential primitive
 * itself is proved in session.test.ts.
 *
 * Cookies here are minted against the real clock rather than an injected
 * one: an "expired" fixture is simply minted far enough in the past that
 * it has already lapsed by the time the router reads it, which keeps the
 * router free of a test-only clock argument.
 */

const FAKE_DB = makeFakeDb();
const FAKE_POOL = makeFakePool().pool;
const router = createRouter(FAKE_DB, FAKE_POOL, TOKEN);

function cookieHeader(value: string): Record<string, string> {
  return { cookie: `${SESSION_COOKIE_NAME}=${value}` };
}

function validCookieValue(): string {
  return mintSessionValue(TOKEN, Date.now());
}

/**
 * A router with its own rate-limit window. Every POST /api/session test
 * builds one: the limiter is per-router by design, so sharing the
 * module-level `router` above would let one test's failed attempts consume
 * another's budget and make the file order-dependent.
 */
function freshRouter(): (request: Request) => Promise<Response> {
  return createRouter(makeFakeDb(), makeFakePool().pool, TOKEN);
}

function login(body: string): Request {
  return new Request('http://x/api/session', { method: 'POST', body });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bearer auth is unchanged', () => {
  it('still serves the inbox for a valid bearer token', async () => {
    const response = await router(new Request('http://x/api/inbox', { headers: auth }));
    expect(response.status).toBe(200);
  });

  it('still rejects a request with neither credential', async () => {
    expect((await router(new Request('http://x/api/inbox'))).status).toBe(401);
  });

  it('still rejects a wrong bearer token even when no cookie is present', async () => {
    const response = await router(new Request('http://x/api/inbox', {
      headers: { authorization: `Bearer ${'z'.repeat(64)}` },
    }));
    expect(response.status).toBe(401);
  });

  it('still 404s a non-GET request to a real route that is not /api/session', async () => {
    const response = await router(new Request('http://x/api/health', { method: 'POST', headers: auth }));
    expect(response.status).toBe(404);
  });
});

describe('session cookie auth', () => {
  it('authenticates the inbox with a valid session cookie and no Authorization header', async () => {
    const response = await router(new Request('http://x/api/inbox', {
      headers: cookieHeader(validCookieValue()),
    }));
    expect(response.status).toBe(200);
    const body = await readJson<{ messages: unknown[] }>(response);
    expect(body.messages).toHaveLength(1);
  });

  it('rejects a tampered cookie while the untampered original is accepted', async () => {
    // Positive control in the same test: if `tampered` were refused for
    // any reason other than the flipped signature byte, `original` would
    // be refused too and this would prove nothing about tampering.
    const original = validCookieValue();
    const [version, expiresAt, signature] = original.split('.') as [string, string, string];
    const tampered = `${version}.${expiresAt}.${(signature[0] === 'A' ? 'B' : 'A') + signature.slice(1)}`;

    const ok = await router(new Request('http://x/api/inbox', { headers: cookieHeader(original) }));
    const bad = await router(new Request('http://x/api/inbox', { headers: cookieHeader(tampered) }));
    expect(ok.status).toBe(200);
    expect(bad.status).toBe(401);
  });

  it('rejects an expired cookie whose signature is genuinely valid', async () => {
    // Minted far enough in the past to have lapsed against the real clock.
    // The control is a cookie minted NOW with the same key and code path:
    // it is accepted, so the 401 below is the clock talking, not the HMAC.
    const expired = mintSessionValue(TOKEN, Date.now() - SESSION_TTL_MS - 60_000);
    const fresh = validCookieValue();

    expect((await router(new Request('http://x/api/inbox', { headers: cookieHeader(fresh) }))).status).toBe(200);
    expect((await router(new Request('http://x/api/inbox', { headers: cookieHeader(expired) }))).status).toBe(401);
  });

  it('rejects a cookie signed with a different key', async () => {
    const foreign = mintSessionValue('q'.repeat(64), Date.now());
    const response = await router(new Request('http://x/api/inbox', { headers: cookieHeader(foreign) }));
    expect(response.status).toBe(401);
  });

  it('finds the session cookie alongside unrelated cookies', async () => {
    const response = await router(new Request('http://x/api/inbox', {
      headers: { cookie: `theme=dark; ${SESSION_COOKIE_NAME}=${validCookieValue()}; other=1` },
    }));
    expect(response.status).toBe(200);
  });

  it('does not accept the raw API token pasted into the cookie', async () => {
    const response = await router(new Request('http://x/api/inbox', { headers: cookieHeader(TOKEN) }));
    expect(response.status).toBe(401);
  });
});

describe('POST /api/session', () => {
  it('sets a session cookie for the correct token and returns no body', async () => {
    const response = await freshRouter()(login(JSON.stringify({ token: TOKEN })));
    expect(response.status).toBe(204);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=');
  });

  it('never returns the API token in the Set-Cookie header it issues', async () => {
    const response = await freshRouter()(login(JSON.stringify({ token: TOKEN })));
    expect(response.headers.get('set-cookie') ?? '').not.toContain(TOKEN);
  });

  it('issues a cookie that actually authenticates a subsequent request', async () => {
    const r = freshRouter();
    const signedIn = await r(login(JSON.stringify({ token: TOKEN })));
    const value = (signedIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const response = await r(new Request('http://x/api/inbox', { headers: { cookie: value } }));
    expect(response.status).toBe(200);
  });

  it('401s a wrong token without logging the submitted value', async () => {
    const wrong = 'hunter2-hunter2-hunter2-hunter2-hunter2';
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});

    const response = await freshRouter()(login(JSON.stringify({ token: wrong })));

    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
    const said = [...errors.mock.calls, ...warns.mock.calls, ...logs.mock.calls]
      .flat()
      .map((entry) => String(entry))
      .join('\n');
    expect(said).not.toContain(wrong);
    expect(said).not.toContain(TOKEN);
    // The failure must still be recorded — a silently swallowed auth
    // failure is exactly what this project's rules forbid.
    expect(errors).toHaveBeenCalled();
  });

  it('does not leak the token in the 401 response body either', async () => {
    const wrong = 'wrong-token-value-that-must-never-echo';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await freshRouter()(login(JSON.stringify({ token: wrong })));
    expect(await response.text()).not.toContain(wrong);
  });

  it('401s a wrong token of exactly the right LENGTH, reaching the constant-time compare', async () => {
    // Fix round 1, item 5. Both other wrong-token fixtures in this file
    // are 39 and 38 characters against a 32-character token, so
    // `tokenMatches` short-circuits on its length guard and its
    // `timingSafeEqual` branch is never executed. This fixture is the same
    // length as TOKEN and differs only in its bytes, so it can only be
    // rejected by the comparison itself.
    const sameLength = 'z'.repeat(TOKEN.length);
    expect(sameLength).toHaveLength(TOKEN.length);
    expect(sameLength).not.toBe(TOKEN);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await freshRouter()(login(JSON.stringify({ token: sameLength })));
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('400s a body that is not JSON', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await freshRouter()(login('not json'));
    expect(response.status).toBe(400);
  });

  it('400s a JSON body with no string token', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await freshRouter()(login(JSON.stringify({ token: 42 })));
    expect(response.status).toBe(400);
  });
});

describe('GET /api/session', () => {
  it('confirms an authenticated caller with 204', async () => {
    expect((await router(new Request('http://x/api/session', { headers: auth }))).status).toBe(204);
    expect((await router(new Request('http://x/api/session', {
      headers: cookieHeader(validCookieValue()),
    }))).status).toBe(204);
  });

  it('401s an unauthenticated caller', async () => {
    expect((await router(new Request('http://x/api/session'))).status).toBe(401);
  });
});

describe('DELETE /api/session', () => {
  it('clears the cookie for a bearer-authenticated caller', async () => {
    const response = await router(new Request('http://x/api/session', { method: 'DELETE', headers: auth }));
    expect(response.status).toBe(204);
    expect(response.headers.get('set-cookie') ?? '').toContain('Max-Age=0');
  });

  it('clears the cookie for a cookie-authenticated caller', async () => {
    const response = await router(new Request('http://x/api/session', {
      method: 'DELETE',
      headers: cookieHeader(validCookieValue()),
    }));
    expect(response.status).toBe(204);
    expect(response.headers.get('set-cookie') ?? '').toContain('Max-Age=0');
  });

  it('401s an unauthenticated caller rather than clearing anything', async () => {
    const response = await router(new Request('http://x/api/session', { method: 'DELETE' }));
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('actually invalidates the browser copy: the cleared header carries an empty value', async () => {
    const response = await router(new Request('http://x/api/session', { method: 'DELETE', headers: auth }));
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie.split(';')[0]).toBe(`${SESSION_COOKIE_NAME}=`);
  });
});

describe('POST /api/session is rate limited, and nothing else is', () => {
  const WRONG = 'z'.repeat(TOKEN.length);

  async function failOnce(r: (request: Request) => Promise<Response>): Promise<Response> {
    return r(login(JSON.stringify({ token: WRONG })));
  }

  it('refuses with 429 and a Retry-After once the failure budget is spent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = freshRouter();

    for (let attempt = 0; attempt < SESSION_RATE_LIMIT_MAX_FAILURES; attempt += 1) {
      expect((await failOnce(r)).status).toBe(401);
    }

    const refused = await failOnce(r);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('cache-control')).toBe('no-store');

    // Bounded, not merely present: the header must agree with the window
    // the limiter is actually configured with, so a `Retry-After` computed
    // from some other duration fails here.
    //
    // It does NOT pin the window's VALUE — the bound scales with the
    // constant, so lengthening the window would keep this green. That is
    // deliberate and it is why the value is pinned absolutely, once, in
    // rate-limit.test.ts. Mutation-checked: raising the window to 15
    // minutes fails there and only there.
    //
    // Floored at 1 because `Retry-After: 0` reads as "retry immediately",
    // which is the opposite of a refusal.
    const retryAfter = Number(refused.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(SESSION_RATE_LIMIT_WINDOW_MS / 1000);
  });

  it('refuses the CORRECT token too once the budget is spent — no bypass by finally guessing right', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = freshRouter();
    for (let attempt = 0; attempt < SESSION_RATE_LIMIT_MAX_FAILURES; attempt += 1) {
      await failOnce(r);
    }
    const response = await r(login(JSON.stringify({ token: TOKEN })));
    expect(response.status).toBe(429);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('never charges a successful sign-in, so setting up several devices cannot lock the user out', async () => {
    const r = freshRouter();
    for (let attempt = 0; attempt < SESSION_RATE_LIMIT_MAX_FAILURES * 3; attempt += 1) {
      expect((await r(login(JSON.stringify({ token: TOKEN })))).status).toBe(204);
    }
  });

  it('charges a malformed body too, so a 400 is not a free probing channel', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = freshRouter();
    for (let attempt = 0; attempt < SESSION_RATE_LIMIT_MAX_FAILURES; attempt += 1) {
      expect((await r(login('not json'))).status).toBe(400);
    }
    expect((await r(login('not json'))).status).toBe(429);
  });

  it('never leaks the submitted token through the 429 path', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = freshRouter();
    for (let attempt = 0; attempt < SESSION_RATE_LIMIT_MAX_FAILURES + 1; attempt += 1) {
      await failOnce(r);
    }
    const said = errors.mock.calls.flat().map(String).join('\n');
    expect(said).not.toContain(WRONG);
    expect(said).not.toContain(TOKEN);
  });

  it('does NOT throttle the authenticated routes — the single user polls their own inbox', async () => {
    // Scope guard. A limiter across /api/* would eventually 429 the owner's
    // own inbox refresh, which is a self-inflicted outage bought for no
    // security: a caller past the gate already holds the credential.
    const r = freshRouter();
    for (let attempt = 0; attempt < SESSION_RATE_LIMIT_MAX_FAILURES * 5; attempt += 1) {
      expect((await r(new Request('http://x/api/inbox', { headers: auth }))).status).toBe(200);
    }
    const viaCookie = await r(new Request('http://x/api/inbox', {
      headers: cookieHeader(validCookieValue()),
    }));
    expect(viaCookie.status).toBe(200);
  });

  it('does not let a spent session window block DELETE or GET /api/session', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = freshRouter();
    for (let attempt = 0; attempt < SESSION_RATE_LIMIT_MAX_FAILURES + 1; attempt += 1) {
      await failOnce(r);
    }
    expect((await r(new Request('http://x/api/session', { headers: auth }))).status).toBe(204);
    expect((await r(new Request('http://x/api/session', { method: 'DELETE', headers: auth }))).status).toBe(204);
  });
});

describe('path-scoped cookie shadowing (fix round 1, items 1 and 4)', () => {
  it('authenticates through a junk cookie sent ahead of the real one', async () => {
    // A same-origin script can set `<name>=junk; path=/api`, which RFC 6265
    // sends BEFORE the real Path=/ cookie. It cannot overwrite the HttpOnly
    // original, but a first-match read would pick the forgery and brick the
    // session with nothing server-side able to clear it. The __Host- prefix
    // forbids the Path that makes this possible; accepting any verifying
    // candidate closes it a second time, independently of the name.
    const response = await router(new Request('http://x/api/inbox', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=junk; ${SESSION_COOKIE_NAME}=${validCookieValue()}` },
    }));
    expect(response.status).toBe(200);
  });

  it('still 401s when every candidate cookie is junk', async () => {
    const response = await router(new Request('http://x/api/inbox', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=junk; ${SESSION_COOKIE_NAME}=alsojunk` },
    }));
    expect(response.status).toBe(401);
  });

  it('issues a cookie whose name carries the __Host- prefix', async () => {
    const response = await freshRouter()(login(JSON.stringify({ token: TOKEN })));
    expect(response.headers.get('set-cookie') ?? '').toMatch(/^__Host-/);
  });
});
