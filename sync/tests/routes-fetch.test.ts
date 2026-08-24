import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRouter } from '../src/api/routes';
import { BodyPartTooLargeError, MAX_BODY_PART_BYTES } from '../src/imap/fetch';
import {
  AUTH as auth,
  TOKEN,
  makeFakeConnection,
  makeFakeDb,
  makeFakePool,
  type FakeDownloadCall,
} from './helpers/api-fakes.ts';

/**
 * The two routes that pull bytes off a live IMAP connection: the raw
 * message body and a single attachment part. Covers the 2026-08-24 fix
 * wave's F3 (size cap and byte-budget accounting), F5's RFC 6266
 * Content-Disposition encoding, F8's per-account lock, and the
 * case-insensitive bearer scheme. Fakes are shared with routes.test.ts from
 * ./helpers/api-fakes.ts.
 */

const FAKE_DB = makeFakeDb();
const FAKE_POOL = makeFakePool().pool;
const router = createRouter(FAKE_DB, FAKE_POOL, TOKEN);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('router / bearer scheme matching', () => {
  // RFC 7235 makes the auth-scheme case-insensitive. A case-sensitive
  // startsWith('Bearer ') rejected conforming clients with a 401 that is
  // indistinguishable from a wrong token.
  it.each(['bearer', 'BEARER', 'BeArEr'])('accepts the %s scheme spelling', async (scheme) => {
    const response = await router(new Request('http://x/api/inbox', {
      headers: { authorization: `${scheme} ${TOKEN}` },
    }));
    expect(response.status).toBe(200);
  });

  it('accepts extra whitespace between the scheme and the credential', async () => {
    const response = await router(new Request('http://x/api/inbox', {
      headers: { authorization: `Bearer   ${TOKEN}` },
    }));
    expect(response.status).toBe(200);
  });

  it('still rejects a different scheme entirely', async () => {
    const response = await router(new Request('http://x/api/inbox', {
      headers: { authorization: `Basic ${TOKEN}` },
    }));
    expect(response.status).toBe(401);
  });

  it('still rejects a bare token with no scheme', async () => {
    const response = await router(new Request('http://x/api/inbox', {
      headers: { authorization: TOKEN },
    }));
    expect(response.status).toBe(401);
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
    const { pool } = makeFakePool({
      statuses: [['acct1', 'connected']],
      connections: { acct1: connection },
    });
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
    const { pool } = makeFakePool({
      statuses: [['acct1', 'reconnecting']],
      connections: { acct1: connection },
    });
    const r = createRouter(FAKE_DB, pool, TOKEN);

    const response = await r(new Request('http://x/api/message/acct1/INBOX/1/body', { headers: auth }));
    expect(response.status).toBe(503);
  });

  it('502s and logs with context when the IMAP fetch itself fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const connection = makeFakeConnection({ downloadError: new Error('socket reset') });
    const { pool } = makeFakePool({
      statuses: [['acct1', 'connected']],
      connections: { acct1: connection },
    });
    const r = createRouter(FAKE_DB, pool, TOKEN);

    const response = await r(new Request('http://x/api/message/acct1/INBOX/1/body', { headers: auth }));

    expect(response.status).toBe(502);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message] = errorSpy.mock.calls[0]!;
    expect(String(message)).toContain('acct1');
  });
});

describe('router / on-demand fetch budgeting and bounds (F3, F8, spec L6)', () => {
  it('holds the account lock for the whole fetch (F8)', async () => {
    // The API and the IDLE loop drive the same imapflow client. Without
    // this key, a download breaks IDLE, idleLoop's NOOP liveness probe
    // queues behind the download, and a download longer than the probe's
    // 15s timeout gets its own healthy connection torn down.
    const connection = makeFakeConnection({ chunks: [Buffer.from('bytes')] });
    const { pool, lockKeys } = makeFakePool({
      statuses: [['acct1', 'connected']],
      connections: { acct1: connection },
    });
    const r = createRouter(FAKE_DB, pool, TOKEN);

    await r(new Request('http://x/api/message/acct1/INBOX/1/body', { headers: auth }));
    await r(new Request('http://x/api/attachment/acct1/INBOX/1/2.1', { headers: auth }));

    expect(lockKeys).toEqual(['acct1', 'acct1']);
  });

  it('charges the bytes it actually downloaded against the daily budget (spec L6)', async () => {
    // The sync loop meticulously charges a 2 KB estimate per header fetch.
    // An API that could pull tens of megabytes down the same connection
    // without recording anything would make that accounting fiction.
    const payload = Buffer.from('0123456789');
    const connection = makeFakeConnection({ chunks: [payload] });
    const { pool, reserved, recorded } = makeFakePool({
      statuses: [['acct1', 'connected']],
      connections: { acct1: connection },
    });
    const r = createRouter(FAKE_DB, pool, TOKEN);

    const response = await r(new Request('http://x/api/message/acct1/INBOX/7/body', { headers: auth }));

    expect(response.status).toBe(200);
    // Reservation is the worst case, because the size is unknown up front.
    expect(reserved).toEqual([{ accountId: 'acct1', bytes: MAX_BODY_PART_BYTES }]);
    // What is recorded is the measured truth.
    expect(recorded).toEqual([{ accountId: 'acct1', bytes: payload.length }]);
  });

  it('charges the attachment route the same way', async () => {
    const payload = Buffer.from('%PDF-1.4 fake bytes');
    const connection = makeFakeConnection({ chunks: [payload] });
    const { pool, recorded } = makeFakePool({
      statuses: [['acct1', 'connected']],
      connections: { acct1: connection },
    });
    const r = createRouter(FAKE_DB, pool, TOKEN);

    await r(new Request('http://x/api/attachment/acct1/INBOX/7/2.1', { headers: auth }));
    expect(recorded).toEqual([{ accountId: 'acct1', bytes: payload.length }]);
  });

  it('429s and does not touch IMAP once the account\'s daily budget is exhausted', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let downloads = 0;
    const connection = makeFakeConnection({ onDownload: () => { downloads += 1; } });
    const { pool, recorded } = makeFakePool({
      statuses: [['acct1', 'connected']],
      connections: { acct1: connection },
      budgetAllowed: false,
      remaining: 0,
    });
    const r = createRouter(FAKE_DB, pool, TOKEN);

    const response = await r(new Request('http://x/api/message/acct1/INBOX/7/body', { headers: auth }));

    expect(response.status).toBe(429);
    expect(downloads).toBe(0);
    expect(recorded).toEqual([]);
    const loggedAccount = errorSpy.mock.calls.some((call) =>
      call.some((arg) => typeof arg === 'string' && arg.includes('acct1') && arg.includes('budget')),
    );
    expect(loggedAccount).toBe(true);
  });

  it('413s an oversized part rather than serving it, and still charges the bytes', async () => {
    // A 25 MB message buffered here and again on the way out is ~50 MB of
    // transient heap on a 1 GB box that also runs Postgres and up to ten
    // IMAP connections; Gmail's own 50 MB ceiling doubles that. Refusing is
    // strictly better than an OOM-kill that takes all ten accounts down.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const connection = makeFakeConnection({
      downloadError: new BodyPartTooLargeError(MAX_BODY_PART_BYTES),
    });
    const { pool, recorded } = makeFakePool({
      statuses: [['acct1', 'connected']],
      connections: { acct1: connection },
    });
    const r = createRouter(FAKE_DB, pool, TOKEN);

    const response = await r(new Request('http://x/api/message/acct1/INBOX/7/body', { headers: auth }));

    expect(response.status).toBe(413);
    // Distinct from the 502 a genuine IMAP failure gets, so a client can
    // tell "too big" from "broken".
    expect(recorded).toEqual([{ accountId: 'acct1', bytes: MAX_BODY_PART_BYTES }]);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('413s an oversized attachment on the attachment route too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const connection = makeFakeConnection({
      downloadError: new BodyPartTooLargeError(MAX_BODY_PART_BYTES),
    });
    const { pool } = makeFakePool({
      statuses: [['acct1', 'connected']],
      connections: { acct1: connection },
    });
    const r = createRouter(FAKE_DB, pool, TOKEN);

    const response = await r(new Request('http://x/api/attachment/acct1/INBOX/7/2.1', { headers: auth }));
    expect(response.status).toBe(413);
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
    const { pool } = makeFakePool({
      statuses: [['acct1', 'connected']],
      connections: { acct1: connection },
    });
    const r = createRouter(db, pool, TOKEN);

    const response = await r(new Request('http://x/api/attachment/acct1/INBOX/42/2.1', { headers: auth }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    // RFC 6266: the quoted-string half must stay Latin-1, and the
    // filename* half carries the real name. Both are always emitted, even
    // for a plain ASCII name, so the format is one thing rather than two
    // conditional ones.
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="invoice.pdf"; filename*=UTF-8''invoice.pdf`,
    );
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
    const { pool } = makeFakePool({
      statuses: [['acct1', 'connected']],
      connections: { acct1: connection },
    });
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
    const { pool } = makeFakePool({
      statuses: [['acct1', 'connected']],
      connections: { acct1: connection },
    });
    const r = createRouter(db, pool, TOKEN);

    const response = await r(new Request('http://x/api/attachment/acct1/INBOX/42/2.1', { headers: auth }));

    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="evil_.pdf"; filename*=UTF-8''evil%22.pdf`,
    );
  });

  it('strips CRLF from a filename so it cannot inject a header', async () => {
    const db = makeFakeDb({
      query: async () => [{ filename: 'a\r\nX-Evil: 1.pdf', mime_type: 'application/pdf' }],
    });
    const connection = makeFakeConnection({ chunks: [Buffer.from('bytes')] });
    const { pool } = makeFakePool({
      statuses: [['acct1', 'connected']],
      connections: { acct1: connection },
    });
    const r = createRouter(db, pool, TOKEN);

    const response = await r(new Request('http://x/api/attachment/acct1/INBOX/42/2.1', { headers: auth }));
    const disposition = response.headers.get('content-disposition')!;
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).toContain('filename="a__X-Evil: 1.pdf"');
  });

  it.each([
    ['発表資料.pdf', '%E7%99%BA%E8%A1%A8%E8%B3%87%E6%96%99.pdf'],
    ['résumé.pdf', 'r%C3%A9sum%C3%A9.pdf'],
  ])('serves a non-ASCII filename (%s) instead of throwing ERR_INVALID_CHAR', async (filename, encoded) => {
    // Before RFC 6266 encoding, sanitizeFilename stripped only \r \n and ",
    // so a perfectly ordinary Japanese or accented filename produced a
    // header value outside Latin-1. Both the Response constructor
    // (ByteString conversion) and Node's ServerResponse.writeHead
    // (ERR_INVALID_CHAR) throw on that — the attachment came back as a 502.
    // This was latent only because the attachments table was always empty
    // (F5); populating it makes it reachable.
    const db = makeFakeDb({
      query: async () => [{ filename, mime_type: 'application/pdf' }],
    });
    const connection = makeFakeConnection({ chunks: [Buffer.from('bytes')] });
    const { pool } = makeFakePool({
      statuses: [['acct1', 'connected']],
      connections: { acct1: connection },
    });
    const r = createRouter(db, pool, TOKEN);

    const response = await r(new Request('http://x/api/attachment/acct1/INBOX/42/2.1', { headers: auth }));

    expect(response.status).toBe(200);
    const disposition = response.headers.get('content-disposition')!;
    // Every byte must be Latin-1-representable or Node's HTTP layer throws
    // on the way out, which is the actual failure this guards.
    expect(/^[\x20-\x7e]*$/.test(disposition)).toBe(true);
    expect(disposition).toContain(`filename*=UTF-8''${encoded}`);
  });

  it("percent-encodes the characters encodeURIComponent leaves but RFC 5987 forbids", async () => {
    const db = makeFakeDb({
      query: async () => [{ filename: "a'b(c)d!e*f.pdf", mime_type: 'application/pdf' }],
    });
    const connection = makeFakeConnection({ chunks: [Buffer.from('bytes')] });
    const { pool } = makeFakePool({
      statuses: [['acct1', 'connected']],
      connections: { acct1: connection },
    });
    const r = createRouter(db, pool, TOKEN);

    const response = await r(new Request('http://x/api/attachment/acct1/INBOX/42/2.1', { headers: auth }));
    const disposition = response.headers.get('content-disposition')!;
    const extValue = disposition.split("filename*=UTF-8''")[1]!;
    // attr-char excludes ' ( ) ! * — none may survive unescaped.
    expect(extValue).not.toMatch(/['()!*]/);
    expect(extValue).toBe('a%27b%28c%29d%21e%2Af.pdf');
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
