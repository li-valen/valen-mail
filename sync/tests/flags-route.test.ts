import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRouter } from '../src/api/routes';
import type { FlagUpdateResult } from '../src/api/flags.ts';
import { FlagWriteRefusedError, setMessageFlag, WRITABLE_FLAGS } from '../src/imap/flags.ts';
import {
  AUTH as auth,
  TOKEN,
  makeFakeConnection,
  makeFakeDb,
  makeFakePool,
  makeFlagRecordingDb,
  readJson,
  type FakeFlagCall,
  type FakeStoredFlagCall,
} from './helpers/api-fakes.ts';

/**
 * PATCH /api/message/{accountId}/{folder}/{uid}/flags — the first write
 * path this service has to Gmail.
 *
 * NOTHING here touches a real IMAP connection, and nothing here may. Gmail
 * throttles repeated fresh connections and this repo has a reconnect-storm
 * history, so every case drives a fake client injected exactly the way
 * helpers/pool-fakes.ts already does for the sync suites. What is asserted
 * is the SHAPE of what crossed the wire — which imapflow op, which flag,
 * which uid, which mailbox — not merely the status code, because a route
 * that skipped the additive op for a whole-flag-set write would still
 * return 200 without these.
 */

const SEEN = '\\Seen';
const FLAGGED = '\\Flagged';

interface Harness {
  readonly router: (request: Request) => Promise<Response>;
  readonly flagCalls: readonly FakeFlagCall[];
  readonly openedMailboxes: readonly string[];
  readonly storedFlagCalls: readonly FakeStoredFlagCall[];
  readonly lockKeys: readonly string[];
}

/** A router whose one connected account records every flag write and every
 *  mailbox it opened, plus a store that records every local row update. */
function harness(
  options: {
    flagError?: Error;
    flagResult?: boolean;
    storedMatched?: boolean;
    storedError?: Error;
    status?: string;
  } = {},
): Harness {
  const flagCalls: FakeFlagCall[] = [];
  const openedMailboxes: string[] = [];
  const connection = makeFakeConnection({
    accountId: 'acct1',
    onFlags: (call) => { flagCalls.push(call); },
    onMailboxOpen: (path) => { openedMailboxes.push(path); },
    flagError: options.flagError,
    flagResult: options.flagResult,
  });
  const { pool, lockKeys } = makeFakePool({
    statuses: [['acct1', options.status ?? 'connected']],
    connections: { acct1: connection },
  });
  const { db, storedFlagCalls } = makeFlagRecordingDb({
    matched: options.storedMatched,
    error: options.storedError,
  });
  return {
    router: createRouter(db, pool, TOKEN),
    flagCalls,
    openedMailboxes,
    storedFlagCalls,
    lockKeys,
  };
}

interface PatchOptions {
  uid?: string;
  folder?: string;
  headers?: Readonly<Record<string, string>>;
  /** Send `body` verbatim instead of JSON-encoding it — for the malformed
   *  bodies and the raw-JSON prototype cases. */
  raw?: boolean;
}

function patch(
  router: (request: Request) => Promise<Response>,
  body: unknown,
  { uid = '42', folder = 'INBOX', headers = auth, raw = false }: PatchOptions = {},
): Promise<Response> {
  return router(
    new Request(`http://x/api/message/acct1/${folder}/${uid}/flags`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: raw ? (body as string) : JSON.stringify(body),
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('flags route / setting \\Seen', () => {
  it('issues the ADDITIVE flag op with exactly that flag and uid, and updates the stored row', async () => {
    const h = harness();
    const response = await patch(h.router, { seen: true });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');

    // The op itself: additive, one flag, one uid, addressed BY uid.
    expect(h.flagCalls).toHaveLength(1);
    const call = h.flagCalls[0]!;
    expect(call.operation).toBe('add');
    expect(call.flags).toEqual([SEEN]);
    expect(call.range).toBe('42');
    expect(call.options).toEqual({ uid: true });
    // The STORE was issued against the folder from the path, not whatever
    // mailbox happened to be selected.
    expect(call.mailbox).toBe('INBOX');
    expect(h.openedMailboxes).toEqual(['INBOX']);

    // And the local row followed it, with the same flag and direction.
    expect(h.storedFlagCalls).toEqual([
      { accountId: 'acct1', folder: 'INBOX', uid: 42, flag: SEEN, value: true },
    ]);

    const body = await readJson<FlagUpdateResult>(response);
    expect(body).toEqual({ ok: true, uid: 42, flag: 'seen', value: true, stored: true });
  });

  it('runs the write inside the account lock, never on a bare connection', async () => {
    // Without this the STORE would break the active IDLE and could queue
    // ahead of the liveness probe, whose timeout tears the connection down.
    const h = harness();
    await patch(h.router, { seen: true });
    expect(h.lockKeys).toEqual(['acct1']);
  });

  it('uses the SUBTRACTIVE op to clear it — never a whole-flag-set write', async () => {
    // messageFlagsSet would replace every flag on the message from a stale
    // snapshot, silently undoing a star set from the Gmail app moments
    // earlier. Subtractive is what makes a concurrent change survive.
    const h = harness();
    const response = await patch(h.router, { seen: false });

    expect(response.status).toBe(200);
    expect(h.flagCalls).toHaveLength(1);
    expect(h.flagCalls[0]!.operation).toBe('remove');
    expect(h.flagCalls[0]!.flags).toEqual([SEEN]);
    expect(h.flagCalls[0]!.range).toBe('42');

    expect(h.storedFlagCalls).toEqual([
      { accountId: 'acct1', folder: 'INBOX', uid: 42, flag: SEEN, value: false },
    ]);
    expect(await readJson<FlagUpdateResult>(response)).toEqual({
      ok: true, uid: 42, flag: 'seen', value: false, stored: true,
    });
  });
});

describe('flags route / starring with \\Flagged', () => {
  it('adds \\Flagged through the same additive op', async () => {
    const h = harness();
    const response = await patch(h.router, { flagged: true });

    expect(response.status).toBe(200);
    expect(h.flagCalls).toHaveLength(1);
    expect(h.flagCalls[0]!.operation).toBe('add');
    expect(h.flagCalls[0]!.flags).toEqual([FLAGGED]);
    expect(h.flagCalls[0]!.range).toBe('42');
    expect(h.storedFlagCalls).toEqual([
      { accountId: 'acct1', folder: 'INBOX', uid: 42, flag: FLAGGED, value: true },
    ]);
    expect(await readJson<FlagUpdateResult>(response)).toEqual({
      ok: true, uid: 42, flag: 'flagged', value: true, stored: true,
    });
  });

  it('removes \\Flagged through the subtractive one', async () => {
    const h = harness();
    const response = await patch(h.router, { flagged: false });

    expect(response.status).toBe(200);
    expect(h.flagCalls).toHaveLength(1);
    expect(h.flagCalls[0]!.operation).toBe('remove');
    expect(h.flagCalls[0]!.flags).toEqual([FLAGGED]);
    expect(h.storedFlagCalls).toEqual([
      { accountId: 'acct1', folder: 'INBOX', uid: 42, flag: FLAGGED, value: false },
    ]);
    expect(await readJson<FlagUpdateResult>(response)).toEqual({
      ok: true, uid: 42, flag: 'flagged', value: false, stored: true,
    });
  });

  it('addresses the message in the folder the path names, not INBOX', async () => {
    const h = harness();
    const response = await patch(h.router, { flagged: true }, { folder: '[Gmail]%2FAll Mail' });
    expect(response.status).toBe(200);
    expect(h.openedMailboxes).toEqual(['[Gmail]/All Mail']);
    expect(h.flagCalls[0]!.mailbox).toBe('[Gmail]/All Mail');
  });
});

describe('flags route / refuses anything but the two supported flags', () => {
  // A 400 that still wrote to the mailbox would be the dangerous bug here,
  // so every one of these asserts the fake IMAP client was never called AND
  // that no mailbox was even opened.
  const rejected: ReadonlyArray<readonly [string, unknown]> = [
    ['an unsupported flag name', { deleted: true }],
    ['a Gmail label', { labels: ['Important'] }],
    ['the raw IMAP flag as a key', { '\\Seen': true }],
    ['two flags in one request', { seen: true, flagged: true }],
    ['an empty object', {}],
    ['a non-boolean value', { seen: 'yes' }],
    ['a numeric value', { seen: 1 }],
    ['a null value', { seen: null }],
    ['an array body', [{ seen: true }]],
    ['a bare boolean body', true],
    ['a null body', null],
    ['an inherited method name', { toString: true }],
  ];

  it.each(rejected)('rejects %s with 400 and no IMAP call', async (_label, body) => {
    const h = harness();
    const response = await patch(h.router, body);

    expect(response.status).toBe(400);
    expect(h.flagCalls).toEqual([]);
    expect(h.openedMailboxes).toEqual([]);
    expect(h.storedFlagCalls).toEqual([]);
  });

  // Written as RAW JSON rather than an object literal on purpose: in a
  // literal, `__proto__: true` is discarded by the engine and never becomes
  // a key at all, so the case would pass without proving anything.
  // `JSON.parse` instead materialises it as an ORDINARY OWN property, which
  // is what actually reaches the validator.
  it.each([
    ['a __proto__ key', '{"__proto__": true}'],
    ['a __proto__ key alongside a real one', '{"__proto__": {}, "seen": true}'],
    ['a constructor key', '{"constructor": true}'],
  ])('rejects %s with 400 and no IMAP call', async (_label, raw) => {
    const h = harness();
    const response = await patch(h.router, raw, { raw: true });

    expect(response.status).toBe(400);
    expect(h.flagCalls).toEqual([]);
    expect(h.openedMailboxes).toEqual([]);
    expect(h.storedFlagCalls).toEqual([]);
  });

  it('rejects a body that is not JSON at all, without reaching IMAP', async () => {
    const h = harness();
    const response = await patch(h.router, 'not json{', { raw: true });

    expect(response.status).toBe(400);
    expect(h.flagCalls).toEqual([]);
    expect(h.openedMailboxes).toEqual([]);
    expect(h.storedFlagCalls).toEqual([]);
  });

  it('rejects a non-numeric uid before touching the connection', async () => {
    const h = harness();
    const response = await patch(h.router, { seen: true }, { uid: 'abc' });

    expect(response.status).toBe(400);
    expect(await readJson<{ error: string }>(response)).toEqual({ error: 'invalid uid' });
    expect(h.flagCalls).toEqual([]);
    expect(h.openedMailboxes).toEqual([]);
  });

  it('never echoes the rejected key back to the caller', async () => {
    // A refused name is attacker-controlled text; reflecting it into the
    // error body buys nothing a static message does not already give.
    const h = harness();
    const response = await patch(h.router, { 'sentinel-key-9f3a': true });
    const body = await readJson<{ error: string }>(response);
    expect(body.error).not.toContain('sentinel-key-9f3a');
    expect(body.error).toContain('seen');
    expect(body.error).toContain('flagged');
  });
});

describe('flags route / a failed IMAP write never writes locally', () => {
  it('answers 502 and leaves the stored row alone when the STORE throws', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({ flagError: new Error('connection reset') });
    const response = await patch(h.router, { seen: true });

    expect(response.status).toBe(502);
    expect(await readJson<{ error: string }>(response)).toEqual({
      error: 'failed to update message flag',
    });
    // The whole point: the client un-bolds optimistically, so a 200 here
    // would leave a message rendered read that is not read.
    expect(h.storedFlagCalls).toEqual([]);
    expect(errors).toHaveBeenCalled();
  });

  it('answers 502 when imapflow RESOLVES false — a refused STORE, not a thrown one', async () => {
    // messageFlagsAdd resolves false (it does not reject) when the UID
    // resolves to nothing or the mailbox is read-only. A handler that only
    // caught thrown errors would return 200 for a write that never landed.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({ flagResult: false });
    const response = await patch(h.router, { flagged: true });

    expect(response.status).toBe(502);
    expect(h.flagCalls).toHaveLength(1);
    expect(h.storedFlagCalls).toEqual([]);
    expect(errors).toHaveBeenCalled();
  });

  it('answers 404 for an unknown account without opening anything', async () => {
    const h = harness();
    const response = await h.router(
      new Request('http://x/api/message/nope/INBOX/42/flags', {
        method: 'PATCH',
        headers: auth,
        body: JSON.stringify({ seen: true }),
      }),
    );
    expect(response.status).toBe(404);
    expect(h.flagCalls).toEqual([]);
  });

  it('answers 503 for an account that is not connected', async () => {
    const h = harness({ status: 'reconnecting' });
    const response = await patch(h.router, { seen: true });
    expect(response.status).toBe(503);
    expect(h.flagCalls).toEqual([]);
    expect(h.storedFlagCalls).toEqual([]);
  });
});

describe('flags route / partial failure is reported, not hidden', () => {
  it('still answers 200 with stored:false when the local row update throws', async () => {
    // The remote write COMMITTED. Reporting failure would tell the user a
    // lie about their own mailbox and (optimistic client) re-bold a message
    // that is genuinely read. The row simply renders stale until the next
    // sync cycle re-reads the real flags.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({ storedError: new Error('postgres down') });
    const response = await patch(h.router, { seen: true });

    expect(response.status).toBe(200);
    expect(h.flagCalls).toHaveLength(1);
    expect(await readJson<FlagUpdateResult>(response)).toEqual({
      ok: true, uid: 42, flag: 'seen', value: true, stored: false,
    });
    expect(errors).toHaveBeenCalled();
  });

  it('reports stored:false when no local row matched the uid', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({ storedMatched: false });
    const response = await patch(h.router, { seen: true });

    expect(response.status).toBe(200);
    expect((await readJson<FlagUpdateResult>(response)).stored).toBe(false);
    expect(errors).toHaveBeenCalled();
  });
});

describe('flags route / auth and method gating', () => {
  it('rejects an unauthenticated PATCH with 401 and no IMAP call', async () => {
    const h = harness();
    const response = await patch(h.router, { seen: true }, { headers: {} });

    expect(response.status).toBe(401);
    expect(h.flagCalls).toEqual([]);
    expect(h.openedMailboxes).toEqual([]);
    expect(h.storedFlagCalls).toEqual([]);
  });

  it('rejects a wrong bearer token with 401 and no IMAP call', async () => {
    const h = harness();
    const response = await patch(h.router, { seen: true }, {
      headers: { authorization: `Bearer ${'y'.repeat(32)}` },
    });

    expect(response.status).toBe(401);
    expect(h.flagCalls).toEqual([]);
  });

  it.each(['GET', 'POST', 'PUT', 'DELETE'])(
    'does not expose the flags path over %s',
    async (method) => {
      const h = harness();
      const response = await h.router(
        new Request('http://x/api/message/acct1/INBOX/42/flags', {
          method,
          headers: auth,
          ...(method === 'GET' ? {} : { body: JSON.stringify({ seen: true }) }),
        }),
      );
      expect(response.status).toBe(404);
      expect(h.flagCalls).toEqual([]);
    },
  );

  it('leaves the sibling parsed-message route matching exactly as before', async () => {
    // /flags is a fourth segment, so the 3-segment parsed-message pattern
    // must not swallow it and this must not swallow that.
    const { pool } = makeFakePool({
      statuses: [['acct1', 'connected']],
      connections: { acct1: makeFakeConnection({ chunks: [Buffer.from('Subject: hi\r\n\r\nbody')] }) },
    });
    const router = createRouter(makeFakeDb(), pool, TOKEN);
    const response = await router(
      new Request('http://x/api/message/acct1/INBOX/42', { headers: auth }),
    );
    expect(response.status).toBe(200);
  });
});

describe('flags route / idempotent from our side', () => {
  it('issues the op both times when the same flag is set twice, and both succeed', async () => {
    // We do NOT read the current flags and decide whether to act. There is
    // therefore no check-then-act window a concurrent change from the Gmail
    // app could fall into, and `STORE +FLAGS` on a message that already has
    // the flag is a no-op at the server.
    const h = harness();
    const first = await patch(h.router, { seen: true });
    const second = await patch(h.router, { seen: true });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(h.flagCalls).toHaveLength(2);
    expect(h.flagCalls.every((call) => call.operation === 'add')).toBe(true);
    expect(h.flagCalls.every((call) => call.range === '42')).toBe(true);
    expect(h.storedFlagCalls).toHaveLength(2);
    expect(await readJson<FlagUpdateResult>(second)).toEqual({
      ok: true, uid: 42, flag: 'seen', value: true, stored: true,
    });
  });

  it('is equally idempotent clearing a flag that is already absent', async () => {
    const h = harness();
    await patch(h.router, { flagged: false });
    const second = await patch(h.router, { flagged: false });

    expect(second.status).toBe(200);
    expect(h.flagCalls).toHaveLength(2);
    expect(h.flagCalls.every((call) => call.operation === 'remove')).toBe(true);
  });
});

describe('imap/flags setMessageFlag', () => {
  /** A connection whose lock records release, so the finally can be proven. */
  function connectionWith(options: Parameters<typeof makeFakeConnection>[0]) {
    return makeFakeConnection(options) as unknown as Parameters<typeof setMessageFlag>[0];
  }

  it('exposes exactly two writable flags and nothing else', () => {
    // The allowlist is the security boundary; \Deleted in particular must
    // never appear here, because this service has no expunge path.
    expect(WRITABLE_FLAGS).toEqual({ seen: SEEN, flagged: FLAGGED });
  });

  it('throws FlagWriteRefusedError — not a silent resolve — when the STORE is refused', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const connection = connectionWith({ flagResult: false });
    await expect(setMessageFlag(connection, 'INBOX', 7, SEEN, true)).rejects.toBeInstanceOf(
      FlagWriteRefusedError,
    );
  });

  it('releases the mailbox lock even when the STORE throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const opened: string[] = [];
    const flagCalls: FakeFlagCall[] = [];
    const connection = connectionWith({
      onMailboxOpen: (path) => { opened.push(path); },
      onFlags: (call) => { flagCalls.push(call); },
      flagError: new Error('connection reset'),
    });

    await expect(setMessageFlag(connection, 'INBOX', 7, FLAGGED, true)).rejects.toThrow(
      'connection reset',
    );
    expect(opened).toEqual(['INBOX']);
    // The fake clears its open mailbox on release; a leaked lock would wedge
    // every later operation on this connection.
    expect(flagCalls[0]!.mailbox).toBe('INBOX');
  });

  it('logs the operation to the operator channel with no message content', async () => {
    // stderr is this service's only operator channel, so the success line
    // goes there too — see logOutcome and backfill.ts's logPage.
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const connection = connectionWith({ accountId: 'acct1' });
    await setMessageFlag(connection, 'INBOX', 7, SEEN, true);

    expect(logs).toHaveBeenCalledTimes(1);
    const line = String(logs.mock.calls[0]![0]);
    expect(line).toContain('acct1');
    expect(line).toContain('INBOX');
    expect(line).toContain('7');
    expect(line).toContain(SEEN);
    expect(line).toContain('ok');
  });

  it('logs a refused write too, so a failed mutation is never silent', async () => {
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const connection = connectionWith({ accountId: 'acct1', flagResult: false });
    await expect(setMessageFlag(connection, 'INBOX', 7, FLAGGED, false)).rejects.toBeInstanceOf(
      FlagWriteRefusedError,
    );
    expect(logs).toHaveBeenCalledTimes(1);
    expect(String(logs.mock.calls[0]![0])).toContain('refused');
  });
});
