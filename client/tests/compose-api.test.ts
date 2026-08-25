import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api';
import { SendRejection, getIdentities, primaryIdentityId, sendMail } from '../src/composeApi';

/**
 * The two calls the composer makes. Same rules as every other request
 * this client sends (src/api.ts's header): a relative path so it resolves
 * against whatever origin served the bundle, `credentials: 'same-origin'`
 * so the HttpOnly session cookie rides along, and never an Authorization
 * header — a bearer token in shipped JavaScript is readable by anyone
 * with devtools, and this API fronts four real mailboxes.
 */

const JSON_HEADERS = { 'content-type': 'application/json' };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getIdentities', () => {
  it('returns the identities the sync service reported, in order', async () => {
    const f = vi.fn().mockResolvedValue(
      jsonResponse({
        identities: [
          { id: 'primary', email: 'me@gmail.com', isPrimary: true },
          { id: 'harvard', email: 'me@college.harvard.edu', isPrimary: false },
        ],
      }),
    );
    await expect(getIdentities(f)).resolves.toEqual([
      { id: 'primary', email: 'me@gmail.com', isPrimary: true },
      { id: 'harvard', email: 'me@college.harvard.edu', isPrimary: false },
    ]);
    expect(f.mock.calls[0]?.[0]).toBe('/api/identities');
  });

  it('sends the session cookie and never a bearer token', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ identities: [] }));
    await getIdentities(f);
    const init = f.mock.calls[0]?.[1] ?? {};
    expect(new Headers(init.headers ?? {}).get('authorization')).toBeNull();
    expect(init.credentials).toBe('same-origin');
  });

  it('throws ApiError carrying the status on a non-2xx', async () => {
    const f = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(getIdentities(f)).rejects.toBeInstanceOf(ApiError);
  });

  it('drops an identity missing the fields the picker depends on, keeping its siblings', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = vi.fn().mockResolvedValue(
      jsonResponse({
        identities: [
          { id: 'primary', email: 'me@gmail.com', isPrimary: true },
          { id: 'broken' },
          { email: 'no-id@gmail.com', isPrimary: false },
        ],
      }),
    );
    await expect(getIdentities(f)).resolves.toEqual([
      { id: 'primary', email: 'me@gmail.com', isPrimary: true },
    ]);
  });

  it('treats a non-boolean isPrimary as "not primary" rather than trusting it', async () => {
    const f = vi.fn().mockResolvedValue(
      jsonResponse({ identities: [{ id: 'a', email: 'a@x.com', isPrimary: 'yes' }] }),
    );
    await expect(getIdentities(f)).resolves.toEqual([
      { id: 'a', email: 'a@x.com', isPrimary: false },
    ]);
  });

  it('returns an empty list when the body carries no identities array', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ nope: true }));
    await expect(getIdentities(f)).resolves.toEqual([]);
  });
});

const REQUEST = {
  identityId: 'primary',
  to: ['a@x.com'],
  cc: [],
  subject: 'Hello',
  textBody: 'Hi.',
} as const;

describe('sendMail', () => {
  it('POSTs the draft as JSON to /api/send', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    await sendMail(REQUEST, f);
    const [path, init] = f.mock.calls[0] ?? [];
    expect(path).toBe('/api/send');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers ?? {}).get('content-type')).toBe('application/json');
    expect(init.credentials).toBe('same-origin');
    expect(new Headers(init.headers ?? {}).get('authorization')).toBeNull();
  });

  it('carries every field the route validates, cc included when empty', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    await sendMail({ ...REQUEST, cc: ['c@z.com'] }, f);
    const body = JSON.parse(String(f.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({
      identityId: 'primary',
      to: ['a@x.com'],
      cc: ['c@z.com'],
      subject: 'Hello',
      textBody: 'Hi.',
    });
  });

  it('returns the per-recipient results from a 200', async () => {
    const f = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [
          { recipientEmail: 'a@x.com', ok: true },
          { recipientEmail: 'b@y.com', ok: false },
        ],
      }),
    );
    await expect(sendMail(REQUEST, f)).resolves.toEqual([
      { recipientEmail: 'a@x.com', ok: true },
      { recipientEmail: 'b@y.com', ok: false },
    ]);
  });

  it('treats a missing ok field as a failure rather than as success', async () => {
    // A result the client cannot read as a success must never be counted
    // as one — that is the direction the uncertainty has to fall.
    const f = vi.fn().mockResolvedValue(jsonResponse({ results: [{ recipientEmail: 'a@x.com' }] }));
    await expect(sendMail(REQUEST, f)).resolves.toEqual([{ recipientEmail: 'a@x.com', ok: false }]);
  });

  it('drops a result with no recipient address at all, keeping its siblings', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = vi.fn().mockResolvedValue(
      jsonResponse({ results: [{ ok: true }, { recipientEmail: 'a@x.com', ok: true }] }),
    );
    await expect(sendMail(REQUEST, f)).resolves.toEqual([{ recipientEmail: 'a@x.com', ok: true }]);
  });

  it('returns an empty list when a 200 body carries no results array', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({}));
    await expect(sendMail(REQUEST, f)).resolves.toEqual([]);
  });

  it('throws SendRejection carrying the status on a 502', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ error: 'tracking unavailable' }, 502));
    await expect(sendMail(REQUEST, f)).rejects.toBeInstanceOf(SendRejection);
    await expect(sendMail(REQUEST, f)).rejects.toMatchObject({ status: 502 });
  });

  it('is still an ApiError, so existing status handling keeps working', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, 401));
    await expect(sendMail(REQUEST, f)).rejects.toBeInstanceOf(ApiError);
  });

  it('reads Retry-After off a 429 so the composer can say when to try again', async () => {
    const f = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'too many sends' }, 429, { 'retry-after': '600' }));
    await expect(sendMail(REQUEST, f)).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 600,
    });
  });

  it('leaves retryAfterSeconds null when Retry-After is absent', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ error: 'too many sends' }, 429));
    await expect(sendMail(REQUEST, f)).rejects.toMatchObject({ retryAfterSeconds: null });
  });

  it('leaves retryAfterSeconds null for an HTTP-date Retry-After it cannot read as seconds', async () => {
    const f = vi.fn().mockResolvedValue(
      jsonResponse({}, 429, { 'retry-after': 'Wed, 25 Aug 2026 10:00:00 GMT' }),
    );
    await expect(sendMail(REQUEST, f)).rejects.toMatchObject({ retryAfterSeconds: null });
  });

  it('never puts the subject or a recipient into the thrown message', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, 500));
    await expect(sendMail({ ...REQUEST, subject: 'SECRET-SUBJECT' }, f)).rejects.toMatchObject({
      message: '/api/send returned 500',
    });
  });
});

describe('primaryIdentityId — the account the composer opens on', () => {
  it('picks the identity flagged isPrimary, wherever it sits in the list', () => {
    expect(
      primaryIdentityId([
        { id: 'harvard', email: 'a@college.harvard.edu', isPrimary: false },
        { id: 'primary', email: 'me@gmail.com', isPrimary: true },
      ]),
    ).toBe('primary');
  });

  it('falls back to the first identity when none is flagged', () => {
    expect(
      primaryIdentityId([
        { id: 'a', email: 'a@x.com', isPrimary: false },
        { id: 'b', email: 'b@y.com', isPrimary: false },
      ]),
    ).toBe('a');
  });

  it('returns an empty id when there are no identities at all', () => {
    expect(primaryIdentityId([])).toBe('');
  });
});
