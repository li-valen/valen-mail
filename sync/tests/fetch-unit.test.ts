import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  ESTIMATED_BYTES_PER_PREVIEW_FETCH,
  HEADER_FETCH_OPTIONS,
  MAX_BODY_PART_BYTES,
  PREVIEW_PART_BYTES,
  BodyPartTooLargeError,
  applyAttachmentFlag,
  fetchBodyPart,
  fetchHeaders,
  fetchPreviews,
  previewFetchOptions,
  resolveUidSpan,
  uidRangeString,
} from '../src/imap/fetch';
import type { ImapConnection } from '../src/imap/connection';
import { normalizeMessage } from '../src/normalize';
import type { AttachmentMeta } from '../src/attachments';

/**
 * Pure unit tests — no network, no live Gmail account, no database. These
 * exist specifically because the live suite (tests/fetch.test.ts) cannot
 * causally prove "we never fetch BODY[]" (bytesDownloaded is a fixed
 * estimate, not a wire measurement — see ESTIMATED_BYTES_PER_HEADER_FETCH's
 * comment in src/imap/fetch.ts), cannot deterministically exercise
 * hasAttach: true against a shared mailbox that may or may not contain an
 * attachment on any given run, and cannot safely exercise a huge sinceUid
 * backlog without actually pulling thousands of messages from the one
 * shared live test account.
 */

describe('HEADER_FETCH_OPTIONS', () => {
  it('requests exactly the header-safe fields, each set to fetch — nothing more, nothing less, no value flipped', () => {
    // Asserts the full object (keys AND values), not just the key set: a
    // regression that flips e.g. `bodyStructure: true` to `false` while
    // keeping the key would pass a keys-only check but break attachment
    // detection silently. toEqual catches both a missing/extra key and a
    // wrong value in one assertion.
    expect(HEADER_FETCH_OPTIONS).toEqual({
      uid: true,
      envelope: true,
      flags: true,
      size: true,
      bodyStructure: true,
      labels: true,
      threadId: true,
    });
  });

  it('never requests a body-bearing field', () => {
    // If any of these were added, fetchHeaders() would start pulling BODY[]
    // content during sync — the exact regression this module exists to
    // prevent. This is the causal guard: unlike the live byte-magnitude
    // check, it fails immediately and deterministically the moment a
    // body-bearing key is added, independent of mailbox contents.
    const bodyBearingKeys = ['source', 'bodyParts', 'body'] as const;
    for (const key of bodyBearingKeys) {
      expect(HEADER_FETCH_OPTIONS).not.toHaveProperty(key);
    }
  });
});

describe('resolveUidSpan', () => {
  it('caps a sinceUid fetch to at most `limit` messages when the backlog is far larger', () => {
    // A caller resuming after a long gap (large mailbox, old sinceUid) must
    // get one bounded page, not a single fetch covering the entire backlog.
    const span = resolveUidSpan({ limit: 50, sinceUid: 1 }, 10_000);
    expect(span).not.toBeNull();
    expect(span!.lowestUid).toBe(1);
    expect(span!.highestUid).toBe(50);
    expect(span!.highestUid - span!.lowestUid + 1).toBe(50);
  });

  it('returns null when sinceUid is above the mailbox\'s current highest UID', () => {
    const span = resolveUidSpan({ limit: 50, sinceUid: 500 }, 100);
    expect(span).toBeNull();
  });

  it('returns exactly `limit` UIDs when sinceUid is combined with a small limit', () => {
    const span = resolveUidSpan({ limit: 3, sinceUid: 10 }, 1000);
    expect(span).toEqual({ lowestUid: 10, highestUid: 12 });
  });

  it('returns fewer than `limit` UIDs when sinceUid plus limit would overrun the mailbox top', () => {
    // The cap is min(mailbox top, sinceUid + limit - 1) — it must not
    // request UIDs that cannot exist yet.
    const span = resolveUidSpan({ limit: 50, sinceUid: 90 }, 100);
    expect(span).toEqual({ lowestUid: 90, highestUid: 100 });
  });

  it('without sinceUid, fetches the most recent `limit` messages from the mailbox top', () => {
    const span = resolveUidSpan({ limit: 20 }, 100);
    expect(span).toEqual({ lowestUid: 81, highestUid: 100 });
  });

  it('without sinceUid, bounds the tail fetch to UID 1 when the mailbox has fewer than `limit` messages', () => {
    const span = resolveUidSpan({ limit: 20 }, 5);
    expect(span).toEqual({ lowestUid: 1, highestUid: 5 });
  });

  it('returns null for a non-positive limit', () => {
    expect(resolveUidSpan({ limit: 0 }, 100)).toBeNull();
    expect(resolveUidSpan({ limit: -5 }, 100)).toBeNull();
  });

  it('returns null for an empty mailbox (uidNext of 1, nothing ever delivered)', () => {
    // highestUidInMailbox = uidNext - 1 = 0 for a freshly created mailbox.
    expect(resolveUidSpan({ limit: 20 }, 0)).toBeNull();
  });
});

describe('applyAttachmentFlag', () => {
  const normalized = normalizeMessage(
    {
      uid: 7,
      size: 4096,
      flags: new Set(['\\Seen']),
      labels: new Set(['\\Inbox']),
      envelope: { messageId: '<x@mail.gmail.com>', subject: 'hi' },
    },
    'primary',
    'INBOX',
  );

  const attachmentParts: readonly AttachmentMeta[] = [
    { partId: '2', filename: 'invoice.pdf', mimeType: 'application/pdf', sizeBytes: 51200 },
  ];

  it('sets hasAttach: true when extractAttachments found at least one part', () => {
    const result = applyAttachmentFlag(normalized, attachmentParts);
    expect(result.hasAttach).toBe(true);
  });

  it('sets hasAttach: false when extractAttachments found no parts', () => {
    const result = applyAttachmentFlag(normalized, []);
    expect(result.hasAttach).toBe(false);
  });

  it('does not mutate the normalized input it was given', () => {
    applyAttachmentFlag(normalized, attachmentParts);
    expect(normalized.hasAttach).toBe(false);
  });

  it('preserves every other field unchanged', () => {
    const result = applyAttachmentFlag(normalized, attachmentParts);
    expect(result.uid).toBe(normalized.uid);
    expect(result.subject).toBe(normalized.subject);
    expect(result.accountId).toBe(normalized.accountId);
    expect(result.folder).toBe(normalized.folder);
  });
});

// ---------------------------------------------------------------------------
// fetchBodyPart's size cap (F3)
// ---------------------------------------------------------------------------

interface FakeDownloadHandle {
  readonly connection: ImapConnection;
  /** How many chunks the stream was actually asked for. */
  readonly consumed: () => number;
  readonly locksReleased: () => number;
}

function makeFakeConnection(chunks: readonly Buffer[]): FakeDownloadHandle {
  let consumed = 0;
  let locksReleased = 0;
  const connection = {
    accountId: 'test',
    rawClient: () => ({
      getMailboxLock: async () => ({ release: () => { locksReleased += 1; } }),
      download: async () => ({
        content: {
          async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) {
              consumed += 1;
              yield chunk;
            }
          },
        },
      }),
    }),
  } as unknown as ImapConnection;
  return { connection, consumed: () => consumed, locksReleased: () => locksReleased };
}

describe('fetchBodyPart size cap', () => {
  it('returns the concatenated part when it fits under the cap', async () => {
    const fake = makeFakeConnection([Buffer.from('abc'), Buffer.from('def')]);
    const bytes = await fetchBodyPart(fake.connection, 'INBOX', 1, '2', 100);
    expect(bytes.toString()).toBe('abcdef');
  });

  it('throws BodyPartTooLargeError once the running total exceeds the cap', async () => {
    // Not "buffer it all, then check": a 50 MB message must never be fully
    // accumulated on a 1 GB box just to be rejected afterwards.
    const fake = makeFakeConnection([Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)]);
    await expect(fetchBodyPart(fake.connection, 'INBOX', 1, '2', 10))
      .rejects.toThrow(BodyPartTooLargeError);
  });

  it('stops consuming the stream at the chunk that crosses the cap', async () => {
    const fake = makeFakeConnection([Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)]);
    await expect(fetchBodyPart(fake.connection, 'INBOX', 1, '2', 10)).rejects.toThrow();
    // Chunk 1 (8 bytes) fits; chunk 2 takes the total to 16 and aborts.
    // Chunk 3 must never be pulled.
    expect(fake.consumed()).toBe(2);
  });

  it('carries the limit on the error so the API can report it', async () => {
    const fake = makeFakeConnection([Buffer.alloc(40)]);
    await expect(fetchBodyPart(fake.connection, 'INBOX', 1, '2', 10)).rejects.toMatchObject({
      name: 'BodyPartTooLargeError',
      limitBytes: 10,
    });
  });

  it('releases the mailbox lock even when the cap aborts the fetch', async () => {
    // A lock leaked here wedges every later operation on this connection —
    // these are process-lifetime connections, not per-request ones.
    const fake = makeFakeConnection([Buffer.alloc(40)]);
    await expect(fetchBodyPart(fake.connection, 'INBOX', 1, '2', 10)).rejects.toThrow();
    expect(fake.locksReleased()).toBe(1);
  });

  it('defaults to MAX_BODY_PART_BYTES, which is below Gmail\'s 50 MB message ceiling', async () => {
    // The cap has to be reachable to be a cap: above Gmail's own ceiling it
    // would be dead code that never fires.
    expect(MAX_BODY_PART_BYTES).toBe(32 * 1024 * 1024);
    expect(MAX_BODY_PART_BYTES).toBeLessThan(50 * 1024 * 1024);

    const fake = makeFakeConnection([Buffer.from('small')]);
    await expect(fetchBodyPart(fake.connection, 'INBOX', 1, '2')).resolves.toBeInstanceOf(Buffer);
  });
});

// ---------------------------------------------------------------------------
// Message previews (Plan 7 Task 1)
// ---------------------------------------------------------------------------

describe('previewFetchOptions', () => {
  it('requests exactly a bounded partial of one body part — nothing more, nothing less', () => {
    // The same exact-shape assertion HEADER_FETCH_OPTIONS gets above, and
    // for the same reason: a regression that drops `maxLength` turns a
    // 512-byte preview into a full-part download, and
    // ESTIMATED_BYTES_PER_PREVIEW_FETCH stops being an estimate of
    // anything. toEqual catches an added key, a removed key and a changed
    // value in one assertion.
    expect(previewFetchOptions('1.1')).toEqual({
      uid: true,
      bodyParts: [{ key: '1.1', start: 0, maxLength: 512 }],
    });
  });

  it('never requests a field that would pull the whole message', () => {
    for (const key of ['source', 'envelope', 'bodyStructure', 'flags'] as const) {
      expect(previewFetchOptions('1')).not.toHaveProperty(key);
    }
  });

  it('bounds the fetch at PREVIEW_PART_BYTES, which is what makes a 4 MB mail cost 512 bytes', () => {
    expect(PREVIEW_PART_BYTES).toBe(512);
    const options = previewFetchOptions('1') as { bodyParts: Array<{ maxLength: number }> };
    expect(options.bodyParts[0]!.maxLength).toBe(PREVIEW_PART_BYTES);
  });
});

/**
 * THE PEEK GUARD.
 *
 * PEEK is not a field in imapflow's query object — it is a property of the
 * IMAP command imapflow COMPILES that object into. So asserting the object
 * alone cannot prove it; the only honest proof is to run our options
 * through imapflow's own command builder and read the wire command.
 *
 * That is what this does. It deep-imports two internal modules (resolved
 * from imapflow's own main entry, so the package's location is never
 * assumed) rather than dialing Gmail. If a future rewrite reaches for
 * `query.source`, `client.download()`, a raw FETCH, or anything else that
 * emits a bare `BODY[...]`, this test fails immediately — which matters
 * because the symptom in production would be silent: every previewed
 * message quietly marked `\Seen`, the owner's unread mail marked read,
 * with no error anywhere.
 */
describe('the preview fetch as IMAP actually sees it', () => {
  async function compilePreviewCommand(partId: string, range: string): Promise<string> {
    const require = createRequire(import.meta.url);
    const imapflowLib = path.dirname(require.resolve('imapflow'));
    const fetchCommand = require(path.join(imapflowLib, 'commands', 'fetch.js'));
    const { compiler } = require(path.join(imapflowLib, 'handler', 'imap-handler.js'));

    let captured: { command: string; attributes: unknown } | null = null;
    const connection = {
      states: { SELECTED: 'selected' },
      state: 'selected',
      mailbox: { path: 'INBOX', uidNext: 100, uidValidity: 1n },
      capabilities: new Set<string>(),
      enabled: new Set<string>(),
      disableBinary: false,
      async exec(command: string, attributes: unknown) {
        captured = { command, attributes };
        return { next: () => {} };
      },
    };

    await fetchCommand(connection, range, previewFetchOptions(partId), { uid: true });
    const compiled = await compiler({
      tag: 'A1',
      command: captured!.command,
      attributes: captured!.attributes,
    });
    return compiled.toString();
  }

  it('compiles to BODY.PEEK, never a bare BODY — fetching a preview must not set \\Seen', async () => {
    const command = await compilePreviewCommand('1', '7,9');
    // THE EXACT-STRING ASSERTION ABOVE IS THE GUARD. The two below are
    // documentation of what it is standing in for, and neither is capable
    // of catching a regression on its own: imapflow hardcodes `.PEEK` for
    // every rendering it emits, so no change to the query object can
    // produce a bare `BODY[` — a `source: true` mutant compiles to
    // `BODY.PEEK[]`, which satisfies both of them and fails only the
    // toBe(). Read them as a note to whoever next edits the expected
    // string, not as a second line of defence.
    expect(command).toContain('BODY.PEEK[');
    expect(command).not.toMatch(/[^.]BODY\[/);
  });

  it('carries the <0.512> partial, so the cost does not scale with message size', async () => {
    expect(await compilePreviewCommand('1.1', '42')).toContain('BODY.PEEK[1.1]<0.512>');
  });
});

/**
 * fetchPreviews' own behaviour, against a fake imapflow client. Grouping,
 * byte accounting and failure containment are all things the pool depends
 * on and none of them need a live mailbox.
 */
interface FakePreviewCall {
  readonly range: unknown;
  readonly query: Record<string, unknown>;
}

function makeFakePreviewConnection(options: {
  bodies?: Readonly<Record<number, Buffer>>;
  fetchError?: Error;
  lockError?: Error;
}) {
  const calls: FakePreviewCall[] = [];
  let locksReleased = 0;

  const connection = {
    accountId: 'primary',
    rawClient: () => ({
      getMailboxLock: async () => {
        if (options.lockError) throw options.lockError;
        return { release: () => { locksReleased += 1; } };
      },
      fetch: function* (range: unknown, query: Record<string, unknown>) {
        calls.push({ range, query });
        if (options.fetchError) throw options.fetchError;
        const bodyParts = query.bodyParts as ReadonlyArray<{ key: string }>;
        const partId = bodyParts[0]!.key;
        for (const uid of String(range).split(',').map(Number)) {
          const body = options.bodies?.[uid];
          if (body === undefined) continue;
          yield { uid, bodyParts: new Map([[partId, body]]) };
        }
      },
    }),
  } as unknown as ImapConnection;

  return { connection, calls, locksReleased: () => locksReleased };
}

const PLAIN_PART = { partId: '1', mimeType: 'text/plain', encoding: null } as const;

describe('fetchPreviews', () => {
  it('returns the stripped preview text for each message', async () => {
    const fake = makeFakePreviewConnection({
      bodies: { 7: Buffer.from('Quarterly numbers attached.\n-- \nSarah') },
    });
    const result = await fetchPreviews(fake.connection, 'INBOX', [{ uid: 7, part: PLAIN_PART }]);
    expect(result.previews.get(7)).toBe('Quarterly numbers attached.');
  });

  it('stores nothing at all — not an empty string — for a fragment that strips to nothing', async () => {
    // The client has to be able to tell "no preview" from "empty preview":
    // one renders no second line, the other would reserve a blank one.
    const fake = makeFakePreviewConnection({ bodies: { 7: Buffer.from('> all quoted\n') } });
    const result = await fetchPreviews(fake.connection, 'INBOX', [{ uid: 7, part: PLAIN_PART }]);
    expect(result.previews.has(7)).toBe(false);
  });

  it('issues ONE fetch per distinct part number, not one per message', async () => {
    const fake = makeFakePreviewConnection({
      bodies: { 1: Buffer.from('a'), 2: Buffer.from('b'), 3: Buffer.from('c') },
    });
    await fetchPreviews(fake.connection, 'INBOX', [
      { uid: 1, part: PLAIN_PART },
      { uid: 2, part: { partId: '1.1', mimeType: 'text/plain', encoding: null } },
      { uid: 3, part: PLAIN_PART },
    ]);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls.map((call) => call.range).sort()).toEqual(['1,3', '2']);
  });

  it('charges ESTIMATED_BYTES_PER_PREVIEW_FETCH for every message it asks about', async () => {
    // The number the pool records against the daily budget. Zeroing this
    // accounting makes previews free on paper while still costing real
    // Gmail bandwidth — which is exactly how an account earns a 24-hour
    // IMAP suspension.
    const fake = makeFakePreviewConnection({ bodies: { 1: Buffer.from('a'), 2: Buffer.from('b') } });
    const result = await fetchPreviews(fake.connection, 'INBOX', [
      { uid: 1, part: PLAIN_PART },
      { uid: 2, part: PLAIN_PART },
    ]);
    expect(result.bytesDownloaded).toBe(2 * ESTIMATED_BYTES_PER_PREVIEW_FETCH);
    expect(ESTIMATED_BYTES_PER_PREVIEW_FETCH).toBeGreaterThan(PREVIEW_PART_BYTES);
  });

  it('still charges for a part group whose fetch threw', async () => {
    // A throw does not prove nothing crossed the wire, and under-charging
    // is the one direction that risks a lockout.
    const fake = makeFakePreviewConnection({ fetchError: new Error('connection reset') });
    const result = await fetchPreviews(fake.connection, 'INBOX', [{ uid: 1, part: PLAIN_PART }]);
    expect(result.bytesDownloaded).toBe(ESTIMATED_BYTES_PER_PREVIEW_FETCH);
    expect(result.previews.size).toBe(0);
  });

  it('does not throw when a part group fails, and keeps the OTHER groups\' previews', async () => {
    // One malformed part must not cost 49 other messages their previews.
    const failing = new Error('NO [CANNOT] part unavailable');
    const calls: string[] = [];
    const connection = {
      accountId: 'primary',
      rawClient: () => ({
        getMailboxLock: async () => ({ release: () => {} }),
        fetch: function* (range: unknown, query: Record<string, unknown>) {
          const partId = (query.bodyParts as ReadonlyArray<{ key: string }>)[0]!.key;
          calls.push(partId);
          if (partId === '9') throw failing;
          yield { uid: Number(range), bodyParts: new Map([[partId, Buffer.from('kept')]]) };
        },
      }),
    } as unknown as ImapConnection;

    const result = await fetchPreviews(connection, 'INBOX', [
      { uid: 1, part: { partId: '9', mimeType: 'text/plain', encoding: null } },
      { uid: 2, part: PLAIN_PART },
    ]);

    expect(calls).toEqual(['9', '1']);
    expect(result.previews.get(2)).toBe('kept');
    expect(result.previews.has(1)).toBe(false);
  });

  it('does no work and opens no mailbox when there is nothing to preview', async () => {
    // The steady state: every one of the newest 50 UIDs already has a
    // snippet, so a cycle must cost zero extra round trips and zero bytes.
    const fake = makeFakePreviewConnection({});
    const result = await fetchPreviews(fake.connection, 'INBOX', []);
    expect(fake.calls).toHaveLength(0);
    expect(fake.locksReleased()).toBe(0);
    expect(result.bytesDownloaded).toBe(0);
  });

  it('releases the mailbox lock even when every part group fails', async () => {
    const fake = makeFakePreviewConnection({ fetchError: new Error('boom') });
    await fetchPreviews(fake.connection, 'INBOX', [{ uid: 1, part: PLAIN_PART }]);
    expect(fake.locksReleased()).toBe(1);
  });

  it('logs the failure with ids and a count, and never the body it did fetch', async () => {
    // The absence half is the point and needs a fixture where a body
    // genuinely EXISTS to leak: uid 1's part fetches fine, uid 2's part
    // group throws. A test that only ever threw before any body existed
    // would assert the absence of something that was never there.
    const secret = 'CONFIDENTIAL-BODY-TEXT-DO-NOT-LOG';
    const logged: unknown[][] = [];
    const connection = {
      accountId: 'primary',
      rawClient: () => ({
        getMailboxLock: async () => ({ release: () => {} }),
        fetch: function* (range: unknown, query: Record<string, unknown>) {
          const partId = (query.bodyParts as ReadonlyArray<{ key: string }>)[0]!.key;
          if (partId === '9') throw new Error(`connection reset while reading ${secret}`);
          yield { uid: Number(range), bodyParts: new Map([[partId, Buffer.from(secret)]]) };
        },
      }),
    } as unknown as ImapConnection;

    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => { logged.push(args); });
    const result = await fetchPreviews(connection, 'INBOX', [
      { uid: 1, part: PLAIN_PART },
      { uid: 2, part: { partId: '9', mimeType: 'text/plain', encoding: null } },
    ]);
    spy.mockRestore();

    // The body really was fetched, so there was something to leak.
    expect(result.previews.get(1)).toBe(secret);

    expect(logged).toHaveLength(1);
    const message = String(logged[0]![0]);
    expect(message).toContain('primary');
    expect(message).toContain('INBOX');
    expect(message).toContain('1 message(s)');
    // The absence assertion the old name promised and did not make. Note
    // this covers OUR log line only: the caught Error is passed to
    // console.error as a separate argument, and what a server puts in its
    // own error text is not ours to sanitize.
    expect(message).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------
// The push-latency bug: a live poll capped by imapflow's STALE mailbox cache
// ---------------------------------------------------------------------------

/**
 * A connection whose `mailbox.uidNext` is FROZEN, exactly as a real imapflow
 * client's is between SELECTs, while the mailbox itself holds newer
 * messages.
 *
 * This is the situation every new message creates. imapflow writes
 * `mailbox.uidNext` only from a SELECT/EXAMINE response or a STATUS; the
 * untagged EXISTS the server pushes during IDLE updates `mailbox.exists`
 * and nothing else; and `getMailboxLock()` issues no SELECT at all when the
 * mailbox is already selected. So the sync cycle woken BY a new message
 * sees a `uidNext` captured before that message existed.
 *
 * `uidNext` and the messages present are therefore SEPARATE inputs here, not
 * derived from one another — a fake that computed one from the other could
 * not express this state at all, which is precisely why the pool suites
 * (tests/helpers/pool-fakes.ts) never caught this.
 */
function makeStaleCacheConnection(options: {
  /** What the last SELECT reported. */
  readonly cachedUidNext: number;
  /** What the SERVER actually holds right now, newer arrivals included. */
  readonly uidsPresent: readonly number[];
}) {
  const ranges: string[] = [];

  const connection = {
    accountId: 'primary',
    rawClient: () => ({
      getMailboxLock: async () => ({ release: () => {} }),
      mailbox: { path: 'INBOX', uidNext: options.cachedUidNext, uidValidity: 1n },
      fetch: function* (range: unknown) {
        ranges.push(String(range));
        const [low, high] = String(range).split(':');
        const lowestUid = Number(low);
        // `*` is resolved by the SERVER to the newest message present — the
        // whole point of asking for it.
        const highestUid = high === '*' ? Number.POSITIVE_INFINITY : Number(high);
        for (const uid of options.uidsPresent) {
          if (uid < lowestUid || uid > highestUid) continue;
          yield { uid, envelope: { messageId: `<m${uid}@x>` }, flags: new Set<string>() };
        }
      },
    }),
  } as unknown as ImapConnection;

  return { connection, ranges };
}

describe('uidRangeString', () => {
  it('gives the live poll an open ceiling, so the SERVER decides what the newest message is', () => {
    // The ceiling is not ours to know: our only source for it is a cache
    // that IDLE never refreshes.
    expect(uidRangeString({ limit: 50 }, { lowestUid: 33076, highestUid: 33125 })).toBe('33076:*');
  });

  it('keeps a sinceUid page numeric on BOTH ends — backfill walks a bounded window backwards', () => {
    // `*` here would fetch from the watermark to the newest message in the
    // mailbox in one round trip: the unbounded fetch resolveUidSpan's
    // `limit` exists to prevent.
    expect(uidRangeString({ limit: 200, sinceUid: 111 }, { lowestUid: 111, highestUid: 310 }))
      .toBe('111:310');
  });
});

describe('fetchHeaders against a stale mailbox.uidNext (the push-latency bug)', () => {
  it('still returns a message that arrived after the last SELECT', async () => {
    // uid 33126 arrived while the connection sat in IDLE, so the cache
    // still says the next UID will be 33126. Capping the fetch at
    // `uidNext - 1` stops one UID short of it — which is what delayed every
    // message by a full IDLE_LIVENESS_CHECK_INTERVAL_MS in production.
    const fake = makeStaleCacheConnection({
      cachedUidNext: 33126,
      uidsPresent: [33124, 33125, 33126],
    });

    const result = await fetchHeaders(fake.connection, 'INBOX', { limit: 50 });

    expect(result.messages.map((message) => message.uid)).toContain(33126);
  });

  it('asks for that message by emitting an open-ended UID range, not a computed ceiling', async () => {
    // The causal assertion. The test above could in principle be satisfied
    // by a fake that was too generous; this pins what actually goes on the
    // wire, which is the thing that was wrong.
    const fake = makeStaleCacheConnection({
      cachedUidNext: 33126,
      uidsPresent: [33124, 33125, 33126],
    });

    await fetchHeaders(fake.connection, 'INBOX', { limit: 50 });

    expect(fake.ranges).toEqual(['33076:*']);
  });

  it('does NOT open the ceiling for a backfill page, however stale the cache is', async () => {
    // The counter-case that keeps the fix honest: `*` on the historical
    // walk would turn one bounded page into "everything from here to now".
    const fake = makeStaleCacheConnection({
      cachedUidNext: 33126,
      uidsPresent: [50, 60, 70, 33126],
    });

    const result = await fetchHeaders(fake.connection, 'INBOX', { limit: 20, sinceUid: 50 });

    expect(fake.ranges).toEqual(['50:69']);
    expect(result.messages.map((message) => message.uid)).toEqual([50, 60]);
  });
});
