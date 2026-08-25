import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiError } from '../src/api';
import { createSession, endSession, getSessionStatus, withSession } from '../src/session';

/**
 * The browser half of the hybrid credential. The client never holds the
 * API token: it posts it once to POST /api/session, the sync service
 * answers with an HttpOnly cookie, and every later request rides on
 * `credentials: 'same-origin'` alone.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function noContent(): Response {
  return new Response(null, { status: 204 });
}

describe('createSession', () => {
  it('posts the token to /api/session as JSON with same-origin credentials', async () => {
    const f = vi.fn().mockResolvedValue(noContent());
    await createSession('the-token', f);

    const [path, init] = f.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/session');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(String(init.body))).toEqual({ token: 'the-token' });
  });

  it('throws ApiError 401 on a wrong token so the login view can show an error', async () => {
    const f = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(createSession('wrong', f)).rejects.toBeInstanceOf(ApiError);
    await expect(createSession('wrong', f)).rejects.toMatchObject({ status: 401 });
  });

  it('never writes the submitted token into an error message', async () => {
    const secret = 'super-secret-token-value';
    const f = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    const error = await createSession(secret, f).catch((caught: unknown) => caught);
    expect(String((error as Error).message)).not.toContain(secret);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(secret);
  });

  it('never logs the submitted token', async () => {
    const secret = 'another-secret-token';
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    await createSession(secret, f).catch(() => {});
    const said = [...errors.mock.calls, ...logs.mock.calls].flat().map(String).join('\n');
    expect(said).not.toContain(secret);
  });
});

describe('endSession', () => {
  it('sends DELETE /api/session', async () => {
    const f = vi.fn().mockResolvedValue(noContent());
    await endSession(f);
    const [path, init] = f.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/session');
    expect(init.method).toBe('DELETE');
    expect(init.credentials).toBe('same-origin');
  });

  it('throws ApiError on a failure rather than pretending the sign-out worked', async () => {
    const f = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
    await expect(endSession(f)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('getSessionStatus', () => {
  it('resolves when the session is good', async () => {
    const f = vi.fn().mockResolvedValue(noContent());
    await expect(getSessionStatus(f)).resolves.toBeUndefined();
  });

  it('throws ApiError 401 when there is no usable credential', async () => {
    const f = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(getSessionStatus(f)).rejects.toMatchObject({ status: 401 });
  });

  it('never sends an Authorization header from the browser', async () => {
    const f = vi.fn().mockResolvedValue(noContent());
    await getSessionStatus(f);
    const init = (f.mock.calls[0] as [string, RequestInit])[1];
    expect(new Headers(init.headers ?? {}).get('authorization')).toBeNull();
  });
});

describe('withSession', () => {
  it('runs the request once and returns its value when nothing 401s', async () => {
    const run = vi.fn().mockResolvedValue('inbox');
    const onUnauthorized = vi.fn();
    await expect(withSession(run, onUnauthorized)).resolves.toBe('inbox');
    expect(run).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('signs in and retries the ORIGINAL request exactly once after a 401', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(401, 'unauthorized'))
      .mockResolvedValueOnce('inbox');
    const onUnauthorized = vi.fn().mockResolvedValue(undefined);

    await expect(withSession(run, onUnauthorized)).resolves.toBe('inbox');
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not sign in for a non-401 failure', async () => {
    const run = vi.fn().mockRejectedValue(new ApiError(503, 'unavailable'));
    const onUnauthorized = vi.fn();
    await expect(withSession(run, onUnauthorized)).rejects.toMatchObject({ status: 503 });
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not sign in for a network error', async () => {
    const run = vi.fn().mockRejectedValue(new TypeError('network error'));
    const onUnauthorized = vi.fn();
    await expect(withSession(run, onUnauthorized)).rejects.toBeInstanceOf(TypeError);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('propagates a second 401 rather than looping forever', async () => {
    const run = vi.fn().mockRejectedValue(new ApiError(401, 'unauthorized'));
    const onUnauthorized = vi.fn().mockResolvedValue(undefined);
    await expect(withSession(run, onUnauthorized)).rejects.toMatchObject({ status: 401 });
    expect(run).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
