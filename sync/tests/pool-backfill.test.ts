import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConnectionPool } from '../src/imap/pool';
import { ImapConnection } from '../src/imap/connection';
import { BACKFILL_BYTE_LIMIT } from '../src/imap/backfill';
import { ESTIMATED_BYTES_PER_HEADER_FETCH } from '../src/imap/fetch';
import {
  ACCOUNT_A,
  createFakeClient,
  createFakeDb,
  createPoolHarness,
  wait,
  type FakeFetchMessage,
} from './helpers/pool-fakes.ts';

/**
 * Plan 8 Task 1 — historical backfill, at the level where it is actually
 * wired: inside ConnectionPool's existing per-account cycle, on the
 * existing connection, after live sync.
 *
 * Four things here could each regress silently, and each has its own test:
 *
 *  - BACKFILLED MAIL MUST NOT NOTIFY. This is the load-bearing one.
 *    Pulling a year of history must not produce a year of phone buzzes,
 *    and the failure would only ever be discovered by the person holding
 *    the phone. The test asserts the exact ARGUMENTS of every dispatch,
 *    not merely a call count, so a leak of 200 old messages into a call
 *    that was going to happen anyway cannot hide inside "called once".
 *  - THE HIGH-WATER MARK MUST NOT MOVE BACKWARDS. A backfill page of low
 *    UIDs that reset NewMailMarks would re-notify everything above it on
 *    the next cycle.
 *  - THE BUDGET SHARE MUST STARVE BACKFILL, NEVER LIVE SYNC.
 *  - THE WALK MUST RESUME AND MUST TERMINATE.
 *
 * Nothing here opens a socket or touches a live Gmail account. The fake db
 * defaults every folder to "already backfilled" (see createFakeDb), so
 * each test below opts in explicitly — which is also what keeps every
 * other pool suite describing the server it always described.
 */

const ACCOUNT = ACCOUNT_A.id;
const PLAIN_TEXT_STRUCTURE = { type: 'text/plain', encoding: '7bit', size: 200 };

/** A mailbox holding uids 1..count, oldest first — the shape of a real
 *  mailbox with more history than the newest-50 poll can reach. */
function mailbox(count: number): FakeFetchMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    uid: index + 1,
    envelope: { messageId: `<m${index + 1}@x>`, subject: `subject ${index + 1}` },
  }));
}

function launchPool(
  fake: ReturnType<typeof createFakeClient>,
  db: ReturnType<typeof createFakeDb>,
  onNewMessages?: (accountId: string, messages: readonly { uid: number }[]) => void,
) {
  return new ConnectionPool(
    [ACCOUNT_A],
    db,
    () => new ImapConnection(ACCOUNT_A, () => fake.client),
    onNewMessages,
  );
}

/** The UID ranges the pool actually asked the server for, header fetches
 *  only — the record of which spans a cycle paged. */
/**
 * Every header fetch's UID range, in order — which is also how these suites
 * tell live sync apart from a backfill page.
 *
 * A range ending in `*` is the LIVE poll: its ceiling is the server's
 * newest message, because imapflow's cached `mailbox.uidNext` is not
 * refreshed by the untagged EXISTS that IDLE delivers and would otherwise
 * stop one UID short of the message that just woke the pool (see
 * fetch.ts's `uidRangeString`). A range with two numbers is a backfill
 * page: a deliberate, bounded window walking backwards through history,
 * where `*` would mean "everything from here to the newest message".
 */
function headerRanges(fake: ReturnType<typeof createFakeClient>): string[] {
  return fake.fetchCalls
    .filter((call) => call.query?.bodyParts === undefined)
    .map((call) => String(call.range));
}

function uidsUpserted(db: ReturnType<typeof createFakeDb>): number[] {
  return db.upserts.map((message) => message.uid).sort((a, b) => a - b);
}

describe('ConnectionPool — historical backfill', () => {
  const harness = createPoolHarness();

  afterEach(async () => {
    await harness.stop();
  });

  it('dispatches nothing for a backfilled page while still notifying genuinely new mail', async () => {
    // THE SUPPRESSION TEST. A 260-message mailbox: live sync owns the
    // newest 50 (211-260) and backfill walks 11-210 on the first cycle and
    // 1-10 on the second. On that SECOND cycle the high-water mark is
    // already established, so a genuinely new message (261) legitimately
    // notifies — which is exactly what makes this non-vacuous. If the
    // backfilled UIDs could reach the dispatch hook, this call would carry
    // 11 messages instead of 1, or there would be a second call.
    const messages = mailbox(260);
    const fake = createFakeClient({ messages });
    const db = createFakeDb();
    db.seedBackfillPending(ACCOUNT, 'INBOX');
    const onNewMessages = vi.fn();

    harness.launch(launchPool(fake, db, onNewMessages));
    await wait(80);

    // Cycle 1 established the baseline and paged 11-210. Nothing notified.
    expect(onNewMessages).not.toHaveBeenCalled();
    expect(uidsUpserted(db)).toContain(11);

    messages.push({ uid: 261, envelope: { messageId: '<m261@x>', subject: 'genuinely new' } });
    fake.triggerExists();
    await wait(60);

    // Backfill really did run this cycle — otherwise "zero backfill
    // dispatches" would be true because there was no page at all.
    expect(headerRanges(fake)).toContain('1:10');
    expect(uidsUpserted(db)).toContain(1);

    expect(onNewMessages).toHaveBeenCalledTimes(1);
    const [accountId, dispatched] = onNewMessages.mock.calls[0]!;
    expect(accountId).toBe(ACCOUNT);
    expect(dispatched.map((message: { uid: number }) => message.uid)).toEqual([261]);
  });

  it('never moves the new-mail high-water mark backwards over a backfilled page', async () => {
    // A page of low UIDs that re-baselined NewMailMarks would make the
    // NEXT cycle report every message above it as new. Three cycles is the
    // shortest arrangement that can see that: baseline, then new mail
    // either side of a backfill page, then new mail again.
    const messages = mailbox(260);
    const fake = createFakeClient({ messages });
    const db = createFakeDb();
    db.seedBackfillPending(ACCOUNT, 'INBOX');
    const onNewMessages = vi.fn();

    harness.launch(launchPool(fake, db, onNewMessages));
    await wait(80);

    messages.push({ uid: 261, envelope: { messageId: '<m261@x>' } });
    fake.triggerExists();
    await wait(60);

    messages.push({ uid: 262, envelope: { messageId: '<m262@x>' } });
    fake.triggerExists();
    await wait(60);

    // If the mark had regressed to a backfilled UID, this last cycle's
    // newest-50 poll (213-262) would report ~50 messages as new rather
    // than the one that actually arrived.
    expect(onNewMessages).toHaveBeenCalledTimes(2);
    const lastCall = onNewMessages.mock.calls[1]!;
    expect(lastCall[1].map((message: { uid: number }) => message.uid)).toEqual([262]);
  });

  it('stops paging when the backfill share is exhausted, and lets live sync keep running', async () => {
    // The arithmetic is the point. Seed the account at exactly
    // BACKFILL_BYTE_LIMIT: the backfill reservation is measured against
    // that ceiling and has nothing left, while live sync reserves against
    // the FULL DAILY_BYTE_LIMIT and still has the remaining 30% of the
    // day. Backfill starves; new mail does not.
    const fake = createFakeClient({ messages: mailbox(60) });
    const db = createFakeDb();
    db.seedBackfillPending(ACCOUNT, 'INBOX');
    db.seedBytesUsedToday(ACCOUNT, BACKFILL_BYTE_LIMIT);

    harness.launch(launchPool(fake, db));
    await wait(80);

    // Live sync ran in full: the newest 50 of a 60-message mailbox.
    expect(uidsUpserted(db)).toEqual(Array.from({ length: 50 }, (_, i) => i + 11));
    expect(headerRanges(fake)).toEqual(['11:*']);
    // Backfill fetched nothing and, crucially, advanced no watermark — a
    // refused page must not look like a completed one.
    expect(headerRanges(fake)).not.toContain('1:10');
    expect(db.syncState(ACCOUNT, 'INBOX')).toBeUndefined();
  });

  it('resumes from the persisted watermark after a restart instead of re-paging', async () => {
    // A process that died mid-walk left last_seen_uid at 311. The next
    // cycle must page 111-310 — NOT 151-350, which is what deriving the
    // floor from the oldest synced row (351) would produce, and not
    // 311-510, which is what restarting from the top would.
    const fake = createFakeClient({ messages: mailbox(400) });
    const db = createFakeDb();
    db.seedSyncState(ACCOUNT, 'INBOX', { uidValidity: 1n, lastSeenUid: 311n, backfillDone: false });

    harness.launch(launchPool(fake, db));
    await wait(100);

    expect(headerRanges(fake)).toEqual(['351:*', '111:310']);
    // The band the dead process had already covered is not re-fetched.
    expect(uidsUpserted(db).filter((uid) => uid >= 311 && uid <= 350)).toEqual([]);
    expect(db.syncState(ACCOUNT, 'INBOX')).toEqual({
      uidValidity: 1n,
      lastSeenUid: 111n,
      backfillDone: false,
    });
  });

  it('marks backfill_done on reaching UID 1 and never pages that folder again', async () => {
    // Termination, and that termination is REMEMBERED. A folder that has
    // reached the bottom must cost nothing at all on every later cycle,
    // for the rest of the deployment's life.
    const messages = mailbox(60);
    const fake = createFakeClient({ messages });
    const db = createFakeDb();
    db.seedBackfillPending(ACCOUNT, 'INBOX');

    harness.launch(launchPool(fake, db));
    await wait(80);

    expect(headerRanges(fake)).toEqual(['11:*', '1:10']);
    expect(db.syncState(ACCOUNT, 'INBOX')).toMatchObject({ lastSeenUid: 1n, backfillDone: true });

    messages.push({ uid: 61, envelope: { messageId: '<m61@x>' } });
    fake.triggerExists();
    await wait(60);

    // The second cycle polled live mail and asked for no backfill page.
    expect(headerRanges(fake)).toEqual(['11:*', '1:10', '12:*']);
  });

  it('charges the daily byte budget for the backfilled headers, on top of live sync', async () => {
    // Under-charging is the one direction that risks Gmail's 24-hour IMAP
    // suspension, so a backfill that downloaded 200 headers for free on
    // paper must be impossible to ship silently.
    const fake = createFakeClient({ messages: mailbox(60) });
    const db = createFakeDb();
    db.seedBackfillPending(ACCOUNT, 'INBOX');

    harness.launch(launchPool(fake, db));
    await wait(80);

    expect(db.budgetRecordCalls).toEqual([
      50 * ESTIMATED_BYTES_PER_HEADER_FETCH, // live sync's newest 50
      10 * ESTIMATED_BYTES_PER_HEADER_FETCH, // the backfilled page 1-10
    ]);
  });

  it('gives backfilled messages previews too, so old mail is searchable', async () => {
    // Search matches on `snippet`. A backfill that skipped previews would
    // fill the mailbox with history that browse can show and search can
    // never find.
    const messages = mailbox(60).map((message) => ({
      ...message,
      bodyStructure: PLAIN_TEXT_STRUCTURE,
      previewBytes: Buffer.from(`body of ${message.uid}`, 'utf8'),
    }));
    const fake = createFakeClient({ messages });
    const db = createFakeDb();
    db.seedBackfillPending(ACCOUNT, 'INBOX');

    harness.launch(launchPool(fake, db));
    await wait(80);

    const backfilled = db.upserts.filter((message) => message.uid <= 10);
    expect(backfilled).toHaveLength(10);
    expect(backfilled.every((message) => message.snippet !== null)).toBe(true);
    expect(backfilled[0]!.snippet).toBe('body of 1');
  });

  it('backfills every discovered folder on the one connection, and still ends on INBOX', async () => {
    // The one-connection constraint, observed rather than asserted about:
    // four folders are paged in the same cycle, through the same fake
    // client, with no second connect() — and the cycle still leaves INBOX
    // selected, or IDLE would re-arm against Trash and the account would
    // simply stop waking on new mail.
    const fake = createFakeClient({
      folders: [
        { path: 'INBOX', specialUse: '\\Inbox', messages: mailbox(60) },
        { path: '[Gmail]/Sent Mail', specialUse: '\\Sent', messages: mailbox(60) },
        { path: '[Gmail]/Spam', specialUse: '\\Junk', messages: mailbox(60) },
        { path: '[Gmail]/Trash', specialUse: '\\Trash', messages: mailbox(60) },
      ],
    });
    const db = createFakeDb();
    const paths = ['INBOX', '[Gmail]/Sent Mail', '[Gmail]/Spam', '[Gmail]/Trash'];
    for (const path of paths) db.seedBackfillPending(ACCOUNT, path);

    harness.launch(launchPool(fake, db));
    await wait(100);

    // Live sync's four spans first, then backfill's four — the pass runs
    // AFTER live sync, never interleaved with it.
    expect(headerRanges(fake)).toEqual(['11:*', '11:*', '11:*', '11:*', '1:10', '1:10', '1:10', '1:10']);
    for (const path of paths) {
      expect(db.syncState(ACCOUNT, path), path).toMatchObject({ lastSeenUid: 1n, backfillDone: true });
    }
    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(fake.selectedMailbox()).toBe('INBOX');
  });

  it('stays done, and fetches nothing, while the mailbox UIDVALIDITY is unchanged', async () => {
    // The inverse of the re-walk below, and the one that matters more: a
    // finished folder must cost one indexed lookup per cycle and nothing
    // else. An implementation that re-walked on every cycle would pass the
    // renumbering test and fail this one.
    const fake = createFakeClient({ messages: mailbox(60), uidValidity: 4n });
    const db = createFakeDb();
    db.seedSyncState(ACCOUNT, 'INBOX', { uidValidity: 4n, lastSeenUid: 1n, backfillDone: true });

    harness.launch(launchPool(fake, db));
    await wait(80);

    expect(headerRanges(fake)).toEqual(['11:*']);
    expect(db.syncState(ACCOUNT, 'INBOX')).toEqual({
      uidValidity: 4n,
      lastSeenUid: 1n,
      backfillDone: true,
    });
  });

  it('re-walks a folder already marked done once the server renumbers the mailbox', async () => {
    // backfill_done is TERMINAL and live sync only polls the newest 50, so
    // without this the entire renumbered history below that window is
    // permanently unreachable and nothing detects it. Every folder reaches
    // the flag within about a day, so this is armed for the life of the
    // deployment.
    const fake = createFakeClient({ messages: mailbox(60), uidValidity: 4n });
    const db = createFakeDb();
    db.seedSyncState(ACCOUNT, 'INBOX', { uidValidity: 4n, lastSeenUid: 1n, backfillDone: true });

    harness.launch(launchPool(fake, db));
    await wait(80);
    expect(headerRanges(fake)).toEqual(['11:*']);

    // The server renumbers the mailbox mid-session, exactly as a real
    // UIDVALIDITY change presents.
    fake.setUidValidity(9n);
    fake.triggerExists();
    await wait(60);

    // The folder pages again rather than staying terminal, and the row now
    // records the numbering it was actually computed against.
    expect(headerRanges(fake)).toEqual(['11:*', '11:*', '1:10']);
    expect(db.syncState(ACCOUNT, 'INBOX')).toEqual({
      uidValidity: 9n,
      lastSeenUid: 1n,
      backfillDone: true,
    });
  });

  it('pages nothing for a folder live sync has not landed anything in yet', async () => {
    // An empty mailbox has no oldest UID to walk backwards from. Backfill
    // must decline rather than invent a floor — and must NOT record a
    // watermark, or an account whose first cycle raced an empty mailbox
    // would be permanently mis-anchored.
    const fake = createFakeClient({ messages: [] });
    const db = createFakeDb();
    db.seedBackfillPending(ACCOUNT, 'INBOX');

    harness.launch(launchPool(fake, db));
    await wait(80);

    expect(db.upserts).toEqual([]);
    expect(fake.fetchCalls).toEqual([]);
    expect(db.syncState(ACCOUNT, 'INBOX')).toBeUndefined();
  });
});
