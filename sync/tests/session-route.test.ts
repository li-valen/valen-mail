import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRouter } from '../src/api/routes';
import { SESSION_COOKIE_NAME, mintSessionValue, SESSION_TTL_MS } from '../src/api/session';
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
    const response = await router(new Request('http://x/api/session', {
      method: 'POST',
      body: JSON.stringify({ token: TOKEN }),
    }));
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
    const response = await router(new Request('http://x/api/session', {
      method: 'POST',
      body: JSON.stringify({ token: TOKEN }),
    }));
    expect(response.headers.get('set-cookie') ?? '').not.toContain(TOKEN);
  });

  it('issues a cookie that actually authenticates a subsequent request', async () => {
    const login = await router(new Request('http://x/api/session', {
      method: 'POST',
      body: JSON.stringify({ token: TOKEN }),
    }));
    const value = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const response = await router(new Request('http://x/api/inbox', { headers: { cookie: value } }));
    expect(response.status).toBe(200);
  });

  it('401s a wrong token without logging the submitted value', async () => {
    const wrong = 'hunter2-hunter2-hunter2-hunter2-hunter2';
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});

    const response = await router(new Request('http://x/api/session', {
      method: 'POST',
      body: JSON.stringify({ token: wrong }),
    }));

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
    const response = await router(new Request('http://x/api/session', {
      method: 'POST',
      body: JSON.stringify({ token: wrong }),
    }));
    expect(await response.text()).not.toContain(wrong);
  });

  it('400s a body that is not JSON', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await router(new Request('http://x/api/session', { method: 'POST', body: 'not json' }));
    expect(response.status).toBe(400);
  });

  it('400s a JSON body with no string token', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await router(new Request('http://x/api/session', {
      method: 'POST',
      body: JSON.stringify({ token: 42 }),
    }));
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
