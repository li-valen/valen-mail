import { describe, it, expect, afterEach } from 'vitest';
import { ConnectionPool } from '../src/imap/pool';
import { ImapConnection } from '../src/imap/connection';
import {
  ESTIMATED_BYTES_PER_HEADER_FETCH,
  ESTIMATED_BYTES_PER_PREVIEW_FETCH,
} from '../src/imap/fetch';
import {
  ACCOUNT_A,
  createFakeClient,
  createFakeDb,
  createPoolHarness,
  wait,
  type FakeFetchMessage,
} from './helpers/pool-fakes.ts';

/**
 * Plan 7 Task 1 — message previews, at the level where they are actually
 * wired: the sync cycle.
 *
 * What is genuinely new here and could each regress silently:
 *   - the preview bytes are CHARGED against the same daily byte budget as
 *     the header fetch (zeroing that accounting makes previews free on
 *     paper while still costing real Gmail bandwidth);
 *   - a message that already has a preview stored is never re-fetched, so
 *     the re-poll of the newest 50 UIDs does not pay for previews forever;
 *   - a preview fetch that fails does not fail the MESSAGE — it still
 *     upserts, with `snippet` null.
 *
 * Nothing here opens a socket or touches a live Gmail account.
 */

const PLAIN_TEXT_STRUCTURE = { type: 'text/plain', encoding: '7bit', size: 200 };

function message(uid: number, body: string): FakeFetchMessage {
  return {
    uid,
    envelope: { messageId: `<m${uid}@x>`, subject: `subject ${uid}` },
    bodyStructure: PLAIN_TEXT_STRUCTURE,
    previewBytes: Buffer.from(body, 'utf8'),
  };
}

function launchPool(client: ReturnType<typeof createFakeClient>, db: ReturnType<typeof createFakeDb>) {
  return new ConnectionPool([ACCOUNT_A], db, () => new ImapConnection(ACCOUNT_A, () => client.client));
}

describe('ConnectionPool — message previews', () => {
  const harness = createPoolHarness();

  afterEach(async () => {
    await harness.stop();
  });

  it('stores a stripped preview alongside the message', async () => {
    const fake = createFakeClient({
      messages: [message(10, 'Numbers are attached.\n-- \nSarah')],
    });
    const db = createFakeDb();

    harness.launch(launchPool(fake, db));
    await wait(50);

    expect(db.upserts.map((m) => [m.uid, m.snippet])).toEqual([[10, 'Numbers are attached.']]);
  });

  it('fetches the preview with a PEEK\'d partial of the resolved text part', async () => {
    // The wire shape is guarded exactly in tests/fetch-unit.test.ts; what
    // this proves is that the SYNC LOOP is what emits it — that previews
    // travel through client.fetch's bodyParts path and not, say, a
    // download() that would set \Seen.
    const fake = createFakeClient({ messages: [message(10, 'Body text')] });
    const db = createFakeDb();

    harness.launch(launchPool(fake, db));
    await wait(50);

    const previewCalls = fake.previewFetchCalls();
    expect(previewCalls).toHaveLength(1);
    expect(previewCalls[0]!.query).toEqual({
      uid: true,
      bodyParts: [{ key: '1', start: 0, maxLength: 512 }],
    });
  });

  it('charges the daily byte budget for the preview bytes, on top of the header bytes', async () => {
    // THE ACCOUNTING GUARD. Two messages fetched means two header charges
    // and two preview charges; zeroing either side of that arithmetic
    // fails here. Under-charging is the direction that risks Gmail's
    // 24-hour IMAP suspension, so it must be impossible to do silently.
    const fake = createFakeClient({
      messages: [message(10, 'first body'), message(11, 'second body')],
    });
    const db = createFakeDb();

    harness.launch(launchPool(fake, db));
    await wait(50);

    expect(db.budgetRecordCalls).toContain(2 * ESTIMATED_BYTES_PER_PREVIEW_FETCH);
    expect(db.budgetRecordCalls).toContain(2 * ESTIMATED_BYTES_PER_HEADER_FETCH);
  });

  it('does not re-fetch a preview for a message that already has one', async () => {
    // The sync loop re-polls the same newest 50 UIDs every cycle. Without
    // this filter that is 50 preview fetches per folder forever instead of
    // a one-time cost per message.
    const fake = createFakeClient({ messages: [message(10, 'already previewed')] });
    const db = createFakeDb();
    db.seedSnippet(ACCOUNT_A.id, 'INBOX', 10);

    harness.launch(launchPool(fake, db));
    await wait(50);

    expect(fake.previewFetchCalls()).toHaveLength(0);
    expect(db.snippetLookups[0]).toMatchObject({
      accountId: ACCOUNT_A.id,
      folder: 'INBOX',
      uids: [10],
    });
    // Charged for the headers, never for a preview it did not fetch.
    expect(db.budgetRecordCalls).not.toContain(ESTIMATED_BYTES_PER_PREVIEW_FETCH);
    // And the message still syncs — with a null snippet, which
    // upsertMessage's `coalesce(excluded.snippet, messages.snippet)`
    // turns into "keep the one already stored".
    expect(db.upserts.map((m) => [m.uid, m.snippet])).toEqual([[10, null]]);
  });

  it('still upserts the message when the preview fetch throws', async () => {
    // The contract that matters most: a failed preview must cost a
    // preview, never a message. Losing mail from the inbox because a body
    // part would not fetch is not an acceptable trade.
    const fake = createFakeClient({
      messages: [message(10, 'never arrives')],
      previewError: new Error('NO [CANNOT] part unavailable'),
    });
    const db = createFakeDb();

    harness.launch(launchPool(fake, db));
    await wait(50);

    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0]!.uid).toBe(10);
    expect(db.upserts[0]!.snippet).toBeNull();
    expect(db.upserts[0]!.subject).toBe('subject 10');
  });

  it('charges for a preview fetch that threw rather than pretending it was free', async () => {
    const fake = createFakeClient({
      messages: [message(10, 'never arrives')],
      previewError: new Error('connection reset'),
    });
    const db = createFakeDb();

    harness.launch(launchPool(fake, db));
    await wait(50);

    expect(db.budgetRecordCalls).toContain(ESTIMATED_BYTES_PER_PREVIEW_FETCH);
  });

  it('skips the preview fetch entirely for a message with no text part', async () => {
    // A bare image: nothing to preview, so nothing to pay for.
    const fake = createFakeClient({
      messages: [
        {
          uid: 10,
          envelope: { messageId: '<m10@x>', subject: 'photo' },
          bodyStructure: { type: 'image/jpeg', encoding: 'base64' },
        },
      ],
    });
    const db = createFakeDb();

    harness.launch(launchPool(fake, db));
    await wait(50);

    expect(fake.previewFetchCalls()).toHaveLength(0);
    expect(db.snippetLookups).toHaveLength(0);
    expect(db.upserts[0]!.snippet).toBeNull();
  });

  it('skips previews, but not the sync, when the daily byte budget is exhausted mid-cycle', async () => {
    // The one arrangement that reaches this branch, and the arithmetic is
    // the point: seed the account with exactly the header reservation left
    // (50 x ESTIMATED_BYTES_PER_HEADER_FETCH), then deliver a FULL page of
    // 50 messages. The header reservation is granted, syncFolder records
    // all 50 messages' header bytes — spending the whole remainder — and
    // collectPreviews' own reservation is then refused against a genuinely
    // empty allowance. Every message still syncs; only the previews are
    // skipped.
    //
    // This is also why syncFolder records the header bytes BEFORE asking
    // for previews: with the record left until after the upserts, the
    // preview reservation would be measured against a stale snapshot and
    // this branch could never fire at all.
    const messages = Array.from({ length: 50 }, (_, index) => message(index + 1, `body ${index}`));
    const fake = createFakeClient({ messages });
    const db = createFakeDb();
    const DAILY_LIMIT = 2 * 1024 * 1024 * 1024;
    db.seedBytesUsedToday(ACCOUNT_A.id, DAILY_LIMIT - 50 * ESTIMATED_BYTES_PER_HEADER_FETCH);

    harness.launch(launchPool(fake, db));
    await wait(50);

    expect(fake.previewFetchCalls()).toHaveLength(0);
    expect(db.upserts).toHaveLength(50);
    expect(db.upserts.every((m) => m.snippet === null)).toBe(true);
    // Charged for the headers it did fetch, never for previews it refused.
    expect(db.budgetRecordCalls).toEqual([50 * ESTIMATED_BYTES_PER_HEADER_FETCH]);
  });

  it('stores no snippet at all for a fragment that strips down to nothing', async () => {
    // A bottom-posted reply whose first bytes are entirely quoted. Null,
    // not '': the client renders no second line for one and would reserve
    // a blank one for the other.
    const fake = createFakeClient({
      messages: [message(10, '> everything here is quoted\n> and so is this')],
    });
    const db = createFakeDb();

    harness.launch(launchPool(fake, db));
    await wait(50);

    expect(db.upserts[0]!.snippet).toBeNull();
  });
});
