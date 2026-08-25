import { describe, it, expect, vi, afterEach } from 'vitest';
import { getInbox, getOpens, ApiError } from '../src/api';

describe('api wrapper', () => {
  it('throws ApiError with the status on a non-200', async () => {
    const f = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(getInbox(50, null, f)).rejects.toBeInstanceOf(ApiError);
    await expect(getInbox(50, null, f)).rejects.toMatchObject({ status: 401 });
  });

  it('never sends a bearer token from the browser', async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await getInbox(50, null, f);
    const init = f.mock.calls[0]?.[1] ?? {};
    const headers = new Headers(init.headers ?? {});
    expect(headers.get('authorization')).toBeNull();
    expect(init.credentials).toBe('same-origin');
  });

  it('forwards the before cursor when given one', async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await getInbox(25, '2026-08-24T00:00:00Z', f);
    expect(String(f.mock.calls[0]?.[0])).toContain('before=2026-08-24T00%3A00%3A00Z');
  });

  it('omits the before param when none is given', async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await getInbox(50, null, f);
    expect(String(f.mock.calls[0]?.[0])).not.toContain('before=');
  });

  it('resolves the messages array on success', async () => {
    const message = { account_id: 'a', uid: '1', folder: 'INBOX' };
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [message] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(getInbox(50, null, f)).resolves.toEqual([message]);
  });

  /**
   * Deviation from task-3-brief.md's sample test, which asserts
   * `getOpens(...)` resolves to a bare `[]`. client/DESIGN.md §7.3 requires
   * the rail to render "the tracking service is unreachable" visibly
   * differently from "nothing has come back yet" — both are an empty opens
   * list, and only an `available` flag distinguishes them (DESIGN.md §9's
   * own stated assumption: "if the wrapper differs, change the wrapper, not
   * the design"). A bare `[]` return erases that flag entirely, so this
   * test — and the getOpens implementation — carry `available` through
   * instead. See task-3-report.md for the full reasoning.
   */
  it('getOpens degrades to { opens: [], available: false } rather than throwing when the rail is unavailable', async () => {
    const f = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(getOpens(20, f)).resolves.toEqual({ opens: [], available: false });
  });

  it('getOpens degrades to unavailable on a network failure without throwing', async () => {
    const f = vi.fn().mockRejectedValue(new TypeError('network error'));
    await expect(getOpens(20, f)).resolves.toEqual({ opens: [], available: false });
  });

  it('getOpens carries available: false through even on a 200 response, when the sync service reports it', async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ opens: [], available: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(getOpens(20, f)).resolves.toEqual({ opens: [], available: false });
  });

  it('getOpens resolves the opens array and available: true on a healthy response', async () => {
    const open = {
      token: 't1',
      recipientEmail: 'kate@example.com',
      subject: null,
      sentAt: 1000,
      occurredAt: 2000,
      classification: 'open',
      deviceClass: null,
      os: null,
    };
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ opens: [open], available: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(getOpens(20, f)).resolves.toEqual({ opens: [open], available: true });
  });
});

/**
 * Runtime validation at the network boundary (Task 3.5, minor finding 1).
 * `response.json()` is `unknown`; casting it straight to a typed shape
 * means a malformed row surfaces as a blank row or an `Invalid Date` deep
 * in the UI instead of being refused here. Mirrors the narrow hand-written
 * predicate in sync/src/api/opens.ts — no schema library, only the fields
 * the rest of the system depends on structurally.
 */
describe('api response validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  const VALID_MESSAGE = {
    account_id: 'primary',
    uid: '42',
    folder: 'INBOX',
    date: '2026-08-01T00:00:00.000Z',
    subject: 'hello',
  };

  it('drops a malformed inbox row and keeps its valid siblings', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = vi.fn().mockResolvedValue(
      jsonResponse({ messages: [VALID_MESSAGE, { subject: 'no identity at all' }, null, 7] }),
    );
    await expect(getInbox(50, null, f)).resolves.toEqual([VALID_MESSAGE]);
  });

  it('drops an inbox row whose date is the wrong type rather than rendering Invalid Date', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = vi.fn().mockResolvedValue(
      jsonResponse({ messages: [{ ...VALID_MESSAGE, date: 1_700_000_000_000 }] }),
    );
    await expect(getInbox(50, null, f)).resolves.toEqual([]);
  });

  it('keeps an inbox row with a null date, which is a legitimate value', async () => {
    const row = { ...VALID_MESSAGE, date: null };
    const f = vi.fn().mockResolvedValue(jsonResponse({ messages: [row] }));
    await expect(getInbox(50, null, f)).resolves.toEqual([row]);
  });

  it('logs once per response, not once per dropped row', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = vi.fn().mockResolvedValue(jsonResponse({ messages: [{}, {}, {}, VALID_MESSAGE] }));
    await getInbox(50, null, f);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[0])).toContain('3');
  });

  it('does not log when every row is well formed', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = vi.fn().mockResolvedValue(jsonResponse({ messages: [VALID_MESSAGE] }));
    await getInbox(50, null, f);
    expect(errors).not.toHaveBeenCalled();
  });

  it('drops a malformed open event and keeps its valid siblings', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const open = {
      token: 't1',
      recipientEmail: 'kate@example.com',
      subject: null,
      sentAt: 1000,
      occurredAt: 2000,
      classification: 'open',
      deviceClass: null,
      os: null,
    };
    const f = vi.fn().mockResolvedValue(
      jsonResponse({ opens: [open, { token: 't2' }, { occurredAt: 5 }], available: true }),
    );
    await expect(getOpens(20, f)).resolves.toEqual({ opens: [open], available: true });
  });
});
