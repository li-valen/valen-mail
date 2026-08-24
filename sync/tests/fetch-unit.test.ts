import { describe, it, expect } from 'vitest';
import {
  HEADER_FETCH_OPTIONS,
  MAX_BODY_PART_BYTES,
  BodyPartTooLargeError,
  applyAttachmentFlag,
  fetchBodyPart,
  resolveUidSpan,
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
