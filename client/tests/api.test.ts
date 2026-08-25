import { describe, it, expect, vi, afterEach } from 'vitest';
import { getInbox, getOpens, ApiError } from '../src/api';
import type { InboxCursor } from '../src/api';

describe('api wrapper', () => {
  it('throws ApiError with the status on a non-200', async () => {
    const f = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(getInbox({ limit: 50 }, f)).rejects.toBeInstanceOf(ApiError);
    await expect(getInbox({ limit: 50 }, f)).rejects.toMatchObject({ status: 401 });
  });

  it('never sends a bearer token from the browser', async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await getInbox({ limit: 50 }, f);
    const init = f.mock.calls[0]?.[1] ?? {};
    const headers = new Headers(init.headers ?? {});
    expect(headers.get('authorization')).toBeNull();
    expect(init.credentials).toBe('same-origin');
  });

  /**
   * Amendment 1 (task-4-brief.md): `getInbox`'s second parameter widened
   * from a bare `before` string to the full compound keyset cursor
   * (`{ before, beforeAccount, beforeUid }`), which is what
   * sync/src/api/routes.ts's `nextCursor` actually returns and what a
   * client must send back verbatim to page losslessly through messages
   * that share a timestamp. This test — and the two below it — replace
   * the task-3-brief.md-era "forwards the before cursor" test, which
   * passed a bare string.
   */
  it('forwards the full cursor — before, beforeAccount, and beforeUid — when given one', async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const cursor: InboxCursor = {
      before: '2026-08-24T00:00:00Z',
      beforeAccount: 'primary',
      beforeUid: '33097',
    };
    await getInbox({ limit: 25, cursor }, f);
    const url = String(f.mock.calls[0]?.[0]);
    expect(url).toContain('before=2026-08-24T00%3A00%3A00Z');
    expect(url).toContain('beforeAccount=primary');
    expect(url).toContain('beforeUid=33097');
  });

  it('forwards a NULL-date-tail cursor (beforeAccount/beforeUid with no before) unchanged', async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const cursor: InboxCursor = { before: null, beforeAccount: 'work', beforeUid: '9' };
    await getInbox({ limit: 25, cursor }, f);
    const url = String(f.mock.calls[0]?.[0]);
    expect(url).not.toContain('before=');
    expect(url).toContain('beforeAccount=work');
    expect(url).toContain('beforeUid=9');
  });

  it('omits every cursor param when none is given', async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await getInbox({ limit: 50 }, f);
    const url = String(f.mock.calls[0]?.[0]);
    expect(url).not.toContain('before=');
    expect(url).not.toContain('beforeAccount=');
    expect(url).not.toContain('beforeUid=');
  });

  /**
   * Plan 5 Task 3, TRAP 1 at the transport layer. `buildInboxParams` is
   * unit-tested on its own in tests/inbox-filters.test.ts; these two prove
   * `getInbox` actually routes through it, so a paged request under a
   * filter reaches the wire with the filter still attached. Without this,
   * page 2 of Sent is page 2 of Inbox with a 200 and no error anywhere.
   */
  it('sends folder and account on a first-page request', async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await getInbox({ limit: 50, folder: 'sent', account: 'harvard' }, f);
    const url = String(f.mock.calls[0]?.[0]);
    expect(url).toContain('folder=sent');
    expect(url).toContain('account=harvard');
  });

  it('keeps folder and account attached to a PAGED request, beside the cursor', async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const cursor: InboxCursor = {
      before: '2026-08-24T00:00:00Z',
      beforeAccount: 'harvard',
      beforeUid: '33097',
    };
    await getInbox({ limit: 50, folder: 'sent', account: 'harvard', cursor }, f);
    const url = String(f.mock.calls[0]?.[0]);
    expect(url).toContain('folder=sent');
    expect(url).toContain('account=harvard');
    expect(url).toContain('beforeUid=33097');
  });

  // TRAP 2: the default view must send NO account param at all — `?account=`
  // is a 400 from sync/src/api/inbox.ts's parseAccountParam.
  it('sends no account param at all for the default all-accounts view', async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await getInbox({ limit: 50, account: null }, f);
    expect(String(f.mock.calls[0]?.[0])).not.toContain('account');
  });

  it('resolves the page — messages plus nextCursor — on success', async () => {
    const message = { account_id: 'a', uid: '1', folder: 'INBOX' };
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [message] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(getInbox({ limit: 50 }, f)).resolves.toEqual({ messages: [message], nextCursor: null });
  });

  it('carries a well-formed nextCursor through verbatim', async () => {
    const nextCursor = { before: '2026-08-01T00:00:00.000Z', beforeAccount: 'primary', beforeUid: '10' };
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [], nextCursor }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(getInbox({ limit: 50 }, f)).resolves.toEqual({ messages: [], nextCursor });
  });

  it('carries the NULL-date-tail nextCursor shape (before: null, both ids set) through verbatim', async () => {
    const nextCursor = { before: null, beforeAccount: 'primary', beforeUid: '5' };
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [], nextCursor }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(getInbox({ limit: 50 }, f)).resolves.toEqual({ messages: [], nextCursor });
  });

  it('degrades a malformed nextCursor to null rather than forwarding a value it cannot trust', async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [], nextCursor: { before: '2026-08-01T00:00:00Z' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(getInbox({ limit: 50 }, f)).resolves.toEqual({ messages: [], nextCursor: null });
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
    await expect(getInbox({ limit: 50 }, f)).resolves.toEqual({ messages: [VALID_MESSAGE], nextCursor: null });
  });

  it('drops an inbox row whose date is the wrong type rather than rendering Invalid Date', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = vi.fn().mockResolvedValue(
      jsonResponse({ messages: [{ ...VALID_MESSAGE, date: 1_700_000_000_000 }] }),
    );
    await expect(getInbox({ limit: 50 }, f)).resolves.toEqual({ messages: [], nextCursor: null });
  });

  it('keeps an inbox row with a null date, which is a legitimate value', async () => {
    const row = { ...VALID_MESSAGE, date: null };
    const f = vi.fn().mockResolvedValue(jsonResponse({ messages: [row] }));
    await expect(getInbox({ limit: 50 }, f)).resolves.toEqual({ messages: [row], nextCursor: null });
  });

  it('logs once per response, not once per dropped row', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = vi.fn().mockResolvedValue(jsonResponse({ messages: [{}, {}, {}, VALID_MESSAGE] }));
    await getInbox({ limit: 50 }, f);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[0])).toContain('3');
  });

  it('does not log when every row is well formed', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = vi.fn().mockResolvedValue(jsonResponse({ messages: [VALID_MESSAGE] }));
    await getInbox({ limit: 50 }, f);
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
