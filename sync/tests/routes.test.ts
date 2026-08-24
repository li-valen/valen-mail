import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRouter } from '../src/api/routes';

/**
 * Every test in this file drives createRouter() against fake Db and
 * ConnectionPool objects — never a real Postgres connection or IMAP
 * socket. The body/attachment routes' fake "connection" objects mimic only
 * the two ImapFlow methods fetchBodyPart actually calls
 * (getMailboxLock/download), which is enough to prove the routing,
 * validation, and error-handling logic without ever dialing Gmail.
 */

function bufferStream(chunks: readonly Buffer[]): AsyncIterable<Buffer> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

interface FakeDownloadCall {
  readonly uid: string;
  readonly partId: string | undefined;
}

function makeFakeConnection(options: {
  chunks?: readonly Buffer[];
  onDownload?: (call: FakeDownloadCall) => void;
  downloadError?: Error;
}) {
  return {
    rawClient: () => ({
      getMailboxLock: async () => ({ release: () => {} }),
      download: async (uid: string, partId: string | undefined) => {
        options.onDownload?.({ uid, partId });
        if (options.downloadError) throw options.downloadError;
        return { content: bufferStream(options.chunks ?? [Buffer.from('bytes')]) };
      },
    }),
  } as never;
}

/** `Response.json()` is typed `Promise<unknown>` under this project's
 *  fetch types (no DOM lib); this narrows it at the one place each test
 *  needs a concrete shape, rather than sprinkling `as` casts inline. */
async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function makeFakeDb(overrides: Record<string, unknown> = {}) {
  return {
    getUnifiedInbox: async () => [{ subject: 'a', date: new Date('2026-08-01') }],
    getThread: async (id: string) => (id === 't1' ? [{ subject: 'x' }] : []),
    query: async () => [],
    upsertMessage: async () => {},
    getSyncState: async () => null,
    setSyncState: async () => {},
    applySchema: async () => {},
    close: async () => {},
    ...overrides,
  } as never;
}

const FAKE_DB = makeFakeDb();
const FAKE_POOL = { status: new Map([['primary', 'connected']]), getConnection: () => undefined } as never;

const TOKEN = 'x'.repeat(32);
const router = createRouter(FAKE_DB, FAKE_POOL, TOKEN);
const auth = { authorization: `Bearer ${TOKEN}` };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('router', () => {
  it('serves health without a token', async () => {
    const response = await router(new Request('http://x/api/health'));
    expect(response.status).toBe(200);
    const body = await readJson<{ accounts: Array<{ id: string; status: string }> }>(response);
    expect(body.accounts).toEqual([{ id: 'primary', status: 'connected' }]);
  });

  it('health never leaks anything beyond account id and status', async () => {
    // Guards Resolution 1 directly: adding an email/count field to the
    // health payload would fail this test even though the two fields above
    // would still look correct.
    const response = await router(new Request('http://x/api/health'));
    const body = await readJson<Record<string, unknown>>(response);
    expect(Object.keys(body).sort()).toEqual(['accounts', 'ok']);
    const accounts = body.accounts as Array<Record<string, unknown>>;
    expect(Object.keys(accounts[0]!).sort()).toEqual(['id', 'status']);
  });

  it('rejects the inbox without a token', async () => {
    const response = await router(new Request('http://x/api/inbox'));
    expect(response.status).toBe(401);
  });

  it('rejects a wrong token', async () => {
    const response = await router(new Request('http://x/api/inbox', {
      headers: { authorization: `Bearer ${'y'.repeat(32)}` },
    }));
    expect(response.status).toBe(401);
  });

  it('rejects an unknown route without a token the same as a real one (no route-existence oracle)', async () => {
    const response = await router(new Request('http://x/api/nope'));
    expect(response.status).toBe(401);
  });

  it('serves the inbox with a valid token', async () => {
    const response = await router(new Request('http://x/api/inbox', { headers: auth }));
    expect(response.status).toBe(200);
    const body = await readJson<{ messages: unknown[] }>(response);
    expect(body.messages).toHaveLength(1);
  });

  it('returns an empty array for an unknown thread rather than 404', async () => {
    const response = await router(new Request('http://x/api/thread/nope', { headers: auth }));
    expect(response.status).toBe(200);
    const body = await readJson<{ messages: unknown[] }>(response);
    expect(body.messages).toEqual([]);
  });

  it('404s an unknown route', async () => {
    const response = await router(new Request('http://x/api/nope', { headers: auth }));
    expect(response.status).toBe(404);
  });

  it('clamps an absurd limit rather than trusting the client', async () => {
    const response = await router(new Request('http://x/api/inbox?limit=999999', { headers: auth }));
    expect(response.status).toBe(200);
  });
});

describe('router / inbox limit and before parsing', () => {
  it('actually clamps the limit passed to the db, not just the response status', async () => {
    // The base "clamps an absurd limit" test above only proves the request
    // doesn't throw — FAKE_DB.getUnifiedInbox ignores its arguments
    // entirely, so it would pass even if clamping were deleted. This test
    // inspects what the db actually received.
    const seen: Array<{ limit: number; before: Date | null }> = [];
    const db = makeFakeDb({
      getUnifiedInbox: async (options: { limit: number; before: Date | null }) => {
        seen.push(options);
        return [];
      },
    });
    const r = createRouter(db, FAKE_POOL, TOKEN);

    await r(new Request('http://x/api/inbox?limit=999999', { headers: auth }));
    expect(seen[0]?.limit).toBe(200);
  });

  it('falls back to the default limit for a non-numeric value instead of throwing', async () => {
    const seen: Array<{ limit: number }> = [];
    const db = makeFakeDb({
      getUnifiedInbox: async (options: { limit: number }) => {
        seen.push(options);
        return [];
      },
    });
    const r = createRouter(db, FAKE_POOL, TOKEN);

    const response = await r(new Request('http://x/api/inbox?limit=banana', { headers: auth }));
    expect(response.status).toBe(200);
    expect(seen[0]?.limit).toBe(50);
  });

  it('clamps a negative limit up to 1 instead of throwing', async () => {
    const seen: Array<{ limit: number }> = [];
    const db = makeFakeDb({
      getUnifiedInbox: async (options: { limit: number }) => {
        seen.push(options);
        return [];
      },
    });
    const r = createRouter(db, FAKE_POOL, TOKEN);

    const response = await r(new Request('http://x/api/inbox?limit=-5', { headers: auth }));
    expect(response.status).toBe(200);
    expect(seen[0]?.limit).toBe(1);
  });

  it('ignores an unparsable before value rather than throwing', async () => {
    const seen: Array<{ before: Date | null }> = [];
    const db = makeFakeDb({
      getUnifiedInbox: async (options: { before: Date | null }) => {
        seen.push(options);
        return [];
      },
    });
    const r = createRouter(db, FAKE_POOL, TOKEN);

    const response = await r(new Request('http://x/api/inbox?before=not-a-date', { headers: auth }));
    expect(response.status).toBe(200);
    expect(seen[0]?.before).toBeNull();
  });
});

describe('router / message body route', () => {
  it('rejects the body route without a token', async () => {
    const response = await router(new Request('http://x/api/message/acct1/INBOX/42/body'));
    expect(response.status).toBe(401);
  });

  it('fetches the full raw message with no partId when the account is connected', async () => {
    let captured: FakeDownloadCall | null = null;
    const connection = makeFakeConnection({
      chunks: [Buffer.from('raw message bytes')],
      onDownload: (call) => { captured = call; },
    });
    const pool = {
      status: new Map([['acct1', 'connected']]),
      getConnection: (id: string) => (id === 'acct1' ? connection : undefined),
    } as never;
    const r = createRouter(FAKE_DB, pool, TOKEN);

    const response = await r(new Request('http://x/api/message/acct1/INBOX/42/body', { headers: auth }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('message/rfc822');
    expect(await response.text()).toBe('raw message bytes');
    // The whole point of the /body route: fetchBodyPart is called with no
    // partId, which is what makes imapflow return the whole raw message
    // instead of a single part.
    expect(captured!.partId).toBeUndefined();
    expect(captured!.uid).toBe('42');
  });

  it('400s a non-numeric uid rather than passing it through to IMAP', async () => {
    const response = await router(new Request('http://x/api/message/acct1/INBOX/notanumber/body', { headers: auth }));
    expect(response.status).toBe(400);
  });

  it('400s a negative uid', async () => {
    const response = await router(new Request('http://x/api/message/acct1/INBOX/-1/body', { headers: auth }));
    expect(response.status).toBe(400);
  });

  it('404s an unknown account rather than hanging or crashing', async () => {
    const response = await router(new Request('http://x/api/message/ghost/INBOX/1/body', { headers: auth }));
    expect(response.status).toBe(404);
  });

  it('503s when the account is known but not currently connected', async () => {
    const connection = makeFakeConnection({});
    const pool = {
      status: new Map([['acct1', 'reconnecting']]),
      getConnection: (id: string) => (id === 'acct1' ? connection : undefined),
    } as never;
    const r = createRouter(FAKE_DB, pool, TOKEN);

    const response = await r(new Request('http://x/api/message/acct1/INBOX/1/body', { headers: auth }));
    expect(response.status).toBe(503);
  });

  it('502s and logs with context when the IMAP fetch itself fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const connection = makeFakeConnection({ downloadError: new Error('socket reset') });
    const pool = {
      status: new Map([['acct1', 'connected']]),
      getConnection: (id: string) => (id === 'acct1' ? connection : undefined),
    } as never;
    const r = createRouter(FAKE_DB, pool, TOKEN);

    const response = await r(new Request('http://x/api/message/acct1/INBOX/1/body', { headers: auth }));

    expect(response.status).toBe(502);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message] = errorSpy.mock.calls[0]!;
    expect(String(message)).toContain('acct1');
  });
});

describe('router / attachment route', () => {
  it('rejects the attachment route without a token', async () => {
    const response = await router(new Request('http://x/api/attachment/acct1/INBOX/42/2.1'));
    expect(response.status).toBe(401);
  });

  it('streams an attachment and sets content-type/filename from db metadata, using parameterised SQL', async () => {
    const queryCalls: Array<{ text: string; values: unknown[] }> = [];
    const db = makeFakeDb({
      query: async (text: string, values: unknown[] = []) => {
        queryCalls.push({ text, values });
        return [{ filename: 'invoice.pdf', mime_type: 'application/pdf' }];
      },
    });
    let captured: FakeDownloadCall | null = null;
    const connection = makeFakeConnection({
      chunks: [Buffer.from('%PDF-1.4 fake bytes')],
      onDownload: (call) => { captured = call; },
    });
    const pool = {
      status: new Map([['acct1', 'connected']]),
      getConnection: (id: string) => (id === 'acct1' ? connection : undefined),
    } as never;
    const r = createRouter(db, pool, TOKEN);

    const response = await r(new Request('http://x/api/attachment/acct1/INBOX/42/2.1', { headers: auth }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="invoice.pdf"');
    expect(captured!.uid).toBe('42');
    expect(captured!.partId).toBe('2.1');

    // Resolution 4: never build SQL from route parameters. The query text
    // must use placeholders, and the route values (account id, folder,
    // the *converted* numeric uid, part id) must travel as bound values,
    // never interpolated into the SQL string itself.
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]!.text).toContain('$1');
    expect(queryCalls[0]!.text).toContain('$4');
    expect(queryCalls[0]!.text).not.toContain('acct1');
    expect(queryCalls[0]!.values).toEqual(['acct1', 'INBOX', 42, '2.1']);
    // Amendment 2: the uid bound to the query is a number, not the raw
    // string that came off the URL path.
    expect(typeof queryCalls[0]!.values[2]).toBe('number');
  });

  it('falls back to octet-stream with no content-disposition when no metadata row exists', async () => {
    const connection = makeFakeConnection({ chunks: [Buffer.from('bytes')] });
    const pool = {
      status: new Map([['acct1', 'connected']]),
      getConnection: (id: string) => (id === 'acct1' ? connection : undefined),
    } as never;
    const r = createRouter(FAKE_DB, pool, TOKEN); // FAKE_DB.query() -> []

    const response = await r(new Request('http://x/api/attachment/acct1/INBOX/42/2.1', { headers: auth }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toBeNull();
  });

  it('sanitises a filename that could otherwise break out of the quoted header', async () => {
    const db = makeFakeDb({
      query: async () => [{ filename: 'evil".pdf', mime_type: 'application/pdf' }],
    });
    const connection = makeFakeConnection({ chunks: [Buffer.from('bytes')] });
    const pool = {
      status: new Map([['acct1', 'connected']]),
      getConnection: (id: string) => (id === 'acct1' ? connection : undefined),
    } as never;
    const r = createRouter(db, pool, TOKEN);

    const response = await r(new Request('http://x/api/attachment/acct1/INBOX/42/2.1', { headers: auth }));

    expect(response.headers.get('content-disposition')).toBe('attachment; filename="evil_.pdf"');
  });

  it('400s a non-numeric uid on the attachment route', async () => {
    const response = await router(new Request('http://x/api/attachment/acct1/INBOX/notanumber/2.1', { headers: auth }));
    expect(response.status).toBe(400);
  });

  it('404s an unknown account on the attachment route', async () => {
    const response = await router(new Request('http://x/api/attachment/ghost/INBOX/1/2.1', { headers: auth }));
    expect(response.status).toBe(404);
  });
});
