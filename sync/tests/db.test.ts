import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openDb, type Db, type InboxFolderFilter } from '../src/db';
import { registerAccounts } from '../src/api/server';

const URL = process.env.TEST_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

/** No folder restriction at all — what every test below Plan 5 Task 2
 *  relied on implicitly before `folder` became a required argument. Named
 *  rather than inlined eight times so the intent ("this test does not care
 *  about folders") reads the same way everywhere it appears. */
const ALL_FOLDERS: InboxFolderFilter = { kind: 'all' };

maybe('db', () => {
  let db: Db;
  beforeAll(async () => {
    db = openDb(URL!);
    await db.applySchema();
    await db.query('delete from accounts where id like $1', ['test-%']);
    await db.query(
      'insert into accounts (id, email) values ($1, $2) on conflict do nothing',
      ['test-a', 'test-a@gmail.com'],
    );
    await db.query(
      'insert into accounts (id, email) values ($1, $2) on conflict do nothing',
      ['test-b', 'test-b@gmail.com'],
    );
  });
  afterAll(async () => {
    await db.query('delete from accounts where id like $1', ['test-%']);
    await db.close();
  });

  it('upserts a message and reads it back in the unified inbox', async () => {
    await db.upsertMessage({
      accountId: 'test-a', uid: 1, folder: 'INBOX', messageId: '<m1@x>', threadId: 't1',
      subject: 'hello', fromName: 'A', fromEmail: 'a@x.com', toEmails: ['b@x.com'],
      ccEmails: [], date: new Date('2026-08-01T00:00:00Z'), snippet: 'hi there',
      flags: ['\\Seen'], labels: ['INBOX'], hasAttach: false, sizeBytes: 1024,
    });
    const inbox = await db.getUnifiedInbox({ limit: 10, cursor: null, folder: ALL_FOLDERS, accountId: null });
    expect(inbox.some((m) => m.subject === 'hello')).toBe(true);
  });

  it('upsert is idempotent on (account, folder, uid)', async () => {
    const base = {
      accountId: 'test-a', uid: 2, folder: 'INBOX', messageId: '<m2@x>', threadId: 't2',
      fromName: 'A', fromEmail: 'a@x.com', toEmails: [], ccEmails: [],
      date: new Date('2026-08-02T00:00:00Z'), snippet: 's', flags: [], labels: [],
      hasAttach: false, sizeBytes: 1,
    };
    await db.upsertMessage({ ...base, subject: 'first' });
    await db.upsertMessage({ ...base, subject: 'second' });
    const rows = await db.query(
      'select subject from messages where account_id=$1 and folder=$2 and uid=$3',
      ['test-a', 'INBOX', 2],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).toBe('second');
  });

  it('round-trips sync state including uidValidity and backfillDone=false', async () => {
    await db.setSyncState('test-a', 'INBOX', { uidValidity: 99n, lastSeenUid: 42n, backfillDone: false });
    const state = await db.getSyncState('test-a', 'INBOX');
    expect(state?.uidValidity).toBe(99n);
    expect(state?.lastSeenUid).toBe(42n);
    expect(state?.backfillDone).toBe(false);
  });

  it('round-trips backfillDone=true after it was previously false', async () => {
    await db.setSyncState('test-a', 'INBOX', { uidValidity: 99n, lastSeenUid: 42n, backfillDone: true });
    const state = await db.getSyncState('test-a', 'INBOX');
    expect(state?.backfillDone).toBe(true);
  });

  it('preserves a null uidValidity as null, not 0n and not the string "null"', async () => {
    await db.setSyncState('test-a', 'DRAFTS', { uidValidity: null, lastSeenUid: 5n, backfillDone: false });
    const state = await db.getSyncState('test-a', 'DRAFTS');
    expect(state?.uidValidity).toBeNull();
  });

  it('returns null sync state for an unknown folder', async () => {
    expect(await db.getSyncState('test-a', 'NOPE')).toBeNull();
  });

  it('reports the oldest synced UID per (account, folder), and null when there is none', async () => {
    // The backfill's first-page anchor (Plan 8 Task 1). min() over zero
    // rows is SQL NULL, and the driver hands bigint back as a string —
    // both are only observable against a real Postgres, which is exactly
    // what this suite is for.
    expect(await db.getOldestSyncedUid('test-a', 'NO-SUCH-FOLDER')).toBeNull();

    const base = {
      accountId: 'test-a', folder: 'BACKFILL-PROBE', messageId: null, threadId: null,
      subject: 'probe', fromName: null, fromEmail: null, toEmails: [], ccEmails: [],
      date: null, snippet: null, flags: [], labels: [], hasAttach: false, sizeBytes: null,
    };
    await db.upsertMessage({ ...base, uid: 900 });
    await db.upsertMessage({ ...base, uid: 400 });
    await db.upsertMessage({ ...base, uid: 650 });

    const oldest = await db.getOldestSyncedUid('test-a', 'BACKFILL-PROBE');
    expect(oldest).toBe(400);
    // A number, not the string pg returns for a bigint column — the whole
    // point of the conversion at this boundary.
    expect(typeof oldest).toBe('number');
    // Scoped to the folder, not the account: another folder's lower UID
    // must not drag this answer down and make backfill re-page a span it
    // has already covered.
    expect(await db.getOldestSyncedUid('test-b', 'BACKFILL-PROBE')).toBeNull();
  });

  it('truncates an oversized snippet to 500 characters rather than storing it in full', async () => {
    const oversizedSnippet = 'x'.repeat(2000);
    await db.upsertMessage({
      accountId: 'test-a', uid: 3, folder: 'INBOX', messageId: '<m3@x>', threadId: 't3',
      subject: 'long snippet', fromName: 'A', fromEmail: 'a@x.com', toEmails: [], ccEmails: [],
      date: new Date('2026-08-03T00:00:00Z'), snippet: oversizedSnippet,
      flags: [], labels: [], hasAttach: false, sizeBytes: 1,
    });
    const rows = await db.query(
      'select snippet from messages where account_id=$1 and folder=$2 and uid=$3',
      ['test-a', 'INBOX', 3],
    );
    expect(rows[0].snippet).toHaveLength(500);
    expect(rows[0].snippet).toBe('x'.repeat(500));
  });

  // ---------------------------------------------------------------------------
  // F5: attachment metadata round trip
  // ---------------------------------------------------------------------------

  it('upserts attachment metadata idempotently on the composite key', async () => {
    await db.upsertMessage({
      accountId: 'test-a', uid: 10, folder: 'INBOX', messageId: '<m10@x>', threadId: 't10',
      subject: 'with attachment', fromName: 'A', fromEmail: 'a@x.com', toEmails: [], ccEmails: [],
      date: new Date('2026-08-10T00:00:00Z'), snippet: null,
      flags: [], labels: [], hasAttach: true, sizeBytes: 90_000,
    });

    await db.upsertAttachment({
      accountId: 'test-a', folder: 'INBOX', uid: 10, partId: '2',
      filename: 'first.pdf', mimeType: 'application/pdf', sizeBytes: 51_200,
    });
    await db.upsertAttachment({
      accountId: 'test-a', folder: 'INBOX', uid: 10, partId: '2',
      filename: 'renamed.pdf', mimeType: 'application/pdf', sizeBytes: 51_201,
    });

    const rows = await db.query(
      'select part_id, filename, size_bytes from attachments where account_id=$1 and folder=$2 and uid=$3',
      ['test-a', 'INBOX', 10],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].filename).toBe('renamed.pdf');
    expect(Number(rows[0].size_bytes)).toBe(51_201);
  });

  it('returns attachment metadata alongside the message in the unified inbox', async () => {
    // Without this a client has no way to learn a partId, which makes
    // /api/attachment/:account/:folder/:uid/:partId unreachable.
    const inbox = await db.getUnifiedInbox({ limit: 200, cursor: null, folder: ALL_FOLDERS, accountId: null });
    const row = inbox.find((m) => m.uid === '10' || m.uid === 10);
    expect(row).toBeDefined();
    expect(row.attachments).toEqual([
      { partId: '2', filename: 'renamed.pdf', mimeType: 'application/pdf', sizeBytes: 51_201 },
    ]);
  });

  it('returns an empty array, not null, for a message with no attachments', async () => {
    const inbox = await db.getUnifiedInbox({ limit: 200, cursor: null, folder: ALL_FOLDERS, accountId: null });
    const row = inbox.find((m) => m.uid === '1' || m.uid === 1);
    expect(row).toBeDefined();
    expect(row.attachments).toEqual([]);
  });

  it('returns attachment metadata on the thread route too', async () => {
    const thread = await db.getThread('test-a', 't10');
    expect(thread).toHaveLength(1);
    expect(thread[0].attachments).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Conversation grouping and thread pagination (getConversationPage)
  // ---------------------------------------------------------------------------

  describe('conversation pages', () => {
    /** One message, with only the fields these cases actually read. */
    async function put(row: {
      accountId: string;
      uid: number;
      threadId: string | null;
      date: Date | null;
      folder?: string;
      subject?: string;
      flags?: readonly string[];
    }) {
      await db.upsertMessage({
        accountId: row.accountId,
        uid: row.uid,
        folder: row.folder ?? 'INBOX',
        messageId: `<c${row.uid}@x>`,
        threadId: row.threadId,
        subject: row.subject ?? `c${row.uid}`,
        fromName: 'C',
        fromEmail: 'c@x.com',
        toEmails: [],
        ccEmails: [],
        date: row.date,
        snippet: null,
        flags: [...(row.flags ?? [])],
        labels: [],
        hasAttach: false,
        sizeBytes: 1,
      });
    }

    const INBOX = { kind: 'literal', folder: 'INBOX' } as const;

    beforeAll(async () => {
      await db.query('delete from messages where account_id like $1', ['test-%']);
      // A four-message conversation on test-a, spread out in time...
      await put({ accountId: 'test-a', uid: 10, threadId: 'T1', date: new Date('2026-05-01T00:00:00Z') });
      await put({ accountId: 'test-a', uid: 11, threadId: 'T1', date: new Date('2026-05-09T00:00:00Z') });
      await put({ accountId: 'test-a', uid: 12, threadId: 'T1', date: new Date('2026-05-20T00:00:00Z') });
      await put({ accountId: 'test-a', uid: 13, threadId: 'T1', date: new Date('2026-06-01T00:00:00Z') });
      // ...with unrelated singletons interleaved through the same span, so
      // a page of conversations is genuinely not a page of messages.
      await put({ accountId: 'test-a', uid: 20, threadId: 'T2', date: new Date('2026-05-05T00:00:00Z') });
      await put({ accountId: 'test-a', uid: 21, threadId: 'T3', date: new Date('2026-05-15T00:00:00Z') });
      // The SAME thread id on a DIFFERENT account. Gmail allocates
      // X-GM-THRID per mailbox, so this is an ordinary collision, not a
      // contrived one.
      await put({ accountId: 'test-b', uid: 10, threadId: 'T1', date: new Date('2026-04-01T00:00:00Z') });
      await put({ accountId: 'test-b', uid: 11, threadId: 'T1', date: new Date('2026-04-02T00:00:00Z') });
      // A thread whose NEWEST message is in Sent, not INBOX.
      await put({ accountId: 'test-a', uid: 30, threadId: 'T4', date: new Date('2026-03-01T00:00:00Z') });
      await put({
        accountId: 'test-a', uid: 31, threadId: 'T4', folder: '[Gmail]/Sent Mail',
        date: new Date('2026-03-05T00:00:00Z'),
      });
      // Two messages with NO thread id at all.
      await put({ accountId: 'test-a', uid: 40, threadId: null, date: new Date('2026-02-01T00:00:00Z') });
      await put({ accountId: 'test-a', uid: 41, threadId: null, date: new Date('2026-02-02T00:00:00Z') });
    });

    it('returns one representative per conversation, newest message first', async () => {
      const page = await db.getConversationPage({
        limit: 100, cursor: null, folder: INBOX, accountId: 'test-a',
      });
      // T1 (4 msgs), T2, T3, T4-in-inbox, and the two unthreaded rows.
      expect(page.representatives.map((r: any) => Number(r.uid))).toEqual([13, 21, 20, 30, 41, 40]);
    });

    it('brings back EVERY message of the conversations on the page', async () => {
      const page = await db.getConversationPage({
        limit: 1, cursor: null, folder: INBOX, accountId: 'test-a',
      });
      expect(page.representatives).toHaveLength(1);
      // One conversation asked for, four messages delivered — the whole
      // point of the route.
      expect(page.messages.map((m: any) => Number(m.uid))).toEqual([13, 12, 11, 10]);
    });

    it('never merges two accounts’ threads that share a Gmail thread id', async () => {
      // THE COLLISION. test-a and test-b both hold thread "T1". Keyed on
      // thread_id alone this is one conversation of six messages, and
      // archiving the row the user sees would archive mail from an account
      // they were not even looking at.
      const page = await db.getConversationPage({
        limit: 100, cursor: null, folder: INBOX, accountId: null,
      });
      const t1 = page.representatives.filter((r: any) => r.thread_id === 'T1');
      expect(t1.map((r: any) => r.account_id).sort()).toEqual(['test-a', 'test-b']);

      const aMembers = page.messages.filter(
        (m: any) => m.thread_id === 'T1' && m.account_id === 'test-a',
      );
      expect(aMembers).toHaveLength(4);
    });

    it('keeps the member lookup keyed by account as well as thread', async () => {
      // The half of the collision the representative test above cannot
      // see. Ask for ONE conversation across ALL accounts: the newest is
      // test-a's T1. Its members must be test-a's four messages and
      // nothing else — with the account dropped from the member key,
      // test-b's two unrelated "T1" messages ride along, get counted in
      // the row's badge, and get archived when the user archives the row.
      const page = await db.getConversationPage({
        limit: 1, cursor: null, folder: INBOX, accountId: null,
      });
      expect(page.messages.map((m: any) => `${m.account_id}:${m.uid}`)).toEqual([
        'test-a:13', 'test-a:12', 'test-a:11', 'test-a:10',
      ]);
    });

    it('reads a thread scoped to ONE account, never a colliding sibling', async () => {
      // The same collision, one surface further along. The reader opens a
      // test-a message whose thread is "T1" and asks for the rest of the
      // conversation; test-b holds a completely unrelated "T1" because
      // Gmail allocates X-GM-THRID per mailbox. Keyed on thread_id alone
      // the reader lists two accounts' mail under one subject — and every
      // row is clickable, so the user can open another account's message
      // from inside this one.
      const thread = await db.getThread('test-a', 'T1');
      expect(thread.map((m: any) => `${m.account_id}:${m.uid}`)).toEqual([
        'test-a:10', 'test-a:11', 'test-a:12', 'test-a:13',
      ]);
      expect(thread.some((m: any) => m.account_id === 'test-b')).toBe(false);
    });

    it('reads the OTHER account’s thread of the same id independently', async () => {
      // The mirror image, so the test cannot pass by accidentally
      // hard-narrowing to test-a. Same thread id, different account, its
      // own two messages and neither of test-a's four.
      const thread = await db.getThread('test-b', 'T1');
      expect(thread.map((m: any) => `${m.account_id}:${m.uid}`)).toEqual([
        'test-b:10', 'test-b:11',
      ]);
    });

    it('scopes a conversation to the FILTER, not to the whole mailbox', async () => {
      // T4's newest message is in Sent. Under folder=inbox the
      // conversation is its INBOX message alone — and it must still
      // appear. Omitting the folder narrowing from the sibling probe makes
      // uid 30 look like it has a newer sibling and drops the whole
      // conversation out of the inbox silently.
      const page = await db.getConversationPage({
        limit: 100, cursor: null, folder: INBOX, accountId: 'test-a',
      });
      const t4 = page.messages.filter((m: any) => m.thread_id === 'T4');
      expect(t4.map((m: any) => Number(m.uid))).toEqual([30]);
    });

    it('treats every message with no thread id as its own conversation', async () => {
      // Not one giant null bucket: two unthreaded messages are two rows.
      const page = await db.getConversationPage({
        limit: 100, cursor: null, folder: INBOX, accountId: 'test-a',
      });
      const unthreaded = page.representatives.filter((r: any) => r.thread_id === null);
      expect(unthreaded.map((r: any) => Number(r.uid)).sort((a, b) => a - b)).toEqual([40, 41]);
    });

    it('pages by conversation: the next page resumes AFTER the whole thread', async () => {
      const first = await db.getConversationPage({
        limit: 2, cursor: null, folder: INBOX, accountId: 'test-a',
      });
      const last: any = first.representatives[first.representatives.length - 1];
      const second = await db.getConversationPage({
        limit: 100,
        cursor: { date: last.date, accountId: last.account_id, uid: Number(last.uid) },
        folder: INBOX,
        accountId: 'test-a',
      });
      // Nothing from the first page reappears — in particular none of T1's
      // three older messages, which is exactly what a message-paginated
      // cursor would have handed back.
      const firstUids = new Set(first.messages.map((m: any) => String(m.uid)));
      for (const message of second.messages as any[]) {
        expect(firstUids.has(String(message.uid))).toBe(false);
      }
      expect(second.representatives.map((r: any) => Number(r.uid))).toEqual([20, 30, 41, 40]);
    });

    it('narrows a conversation to the MATCHING messages under a search', async () => {
      await put({
        accountId: 'test-a', uid: 12, threadId: 'T1',
        date: new Date('2026-05-20T00:00:00Z'), subject: 'quarterly numbers',
      });
      const page = await db.getConversationPage({
        limit: 100, cursor: null, folder: INBOX, accountId: 'test-a', search: 'quarterly',
      });
      expect(page.representatives.map((r: any) => Number(r.uid))).toEqual([12]);
      expect(page.messages.map((m: any) => Number(m.uid))).toEqual([12]);
      // Put the fixture back for any case that runs after this one.
      await put({ accountId: 'test-a', uid: 12, threadId: 'T1', date: new Date('2026-05-20T00:00:00Z') });
    });

    it('carries attachment metadata on every member, like the other read paths', async () => {
      const page = await db.getConversationPage({
        limit: 100, cursor: null, folder: INBOX, accountId: 'test-a',
      });
      for (const message of page.messages as any[]) {
        expect(Array.isArray(message.attachments)).toBe(true);
      }
    });

    it('answers an empty page without a second query', async () => {
      const page = await db.getConversationPage({
        limit: 10, cursor: null, folder: INBOX, accountId: 'test-b', search: 'nothing matches this',
      });
      expect(page).toEqual({ messages: [], representatives: [] });
    });
  });

  // ---------------------------------------------------------------------------
  // F7: unified inbox ordering and keyset pagination
  // ---------------------------------------------------------------------------

  describe('unified inbox ordering and pagination', () => {
    const TIE = new Date('2026-07-15T12:00:00Z');

    beforeAll(async () => {
      await db.query('delete from messages where account_id like $1', ['test-%']);
      // Three messages sharing one second-resolution timestamp — exactly
      // what a bulk Gmail delivery produces — across two accounts, plus one
      // with no parseable Date: header at all.
      const rows = [
        { accountId: 'test-a', uid: 100, date: TIE, subject: 'tie-a-100' },
        { accountId: 'test-a', uid: 101, date: TIE, subject: 'tie-a-101' },
        { accountId: 'test-b', uid: 100, date: TIE, subject: 'tie-b-100' },
        { accountId: 'test-a', uid: 200, date: new Date('2026-07-16T00:00:00Z'), subject: 'newer' },
        { accountId: 'test-a', uid: 300, date: null, subject: 'no-date' },
      ];
      for (const row of rows) {
        await db.upsertMessage({
          accountId: row.accountId, uid: row.uid, folder: 'INBOX',
          messageId: `<${row.subject}@x>`, threadId: 'paging', subject: row.subject,
          fromName: null, fromEmail: null, toEmails: [], ccEmails: [],
          date: row.date, snippet: null, flags: [], labels: [],
          hasAttach: false, sizeBytes: 1,
        });
      }
    });

    it('sorts NULL-date messages LAST, not first', async () => {
      // Postgres defaults `order by date desc` to NULLS FIRST, so a single
      // message with an unparseable Date: header used to sit above all real
      // mail permanently — and was then excluded from every paginated page,
      // because `date < $1` is never true for NULL.
      const page = await db.getUnifiedInbox({ limit: 200, cursor: null, folder: ALL_FOLDERS, accountId: null });
      const subjects = page.map((m) => m.subject);
      expect(subjects[0]).toBe('newer');
      expect(subjects[subjects.length - 1]).toBe('no-date');
    });

    it('paginates across a tied timestamp without dropping a row', async () => {
      // The regression: with `date < $1` and a page boundary inside a group
      // of rows sharing one timestamp, every remaining tied row was skipped.
      const seen: string[] = [];
      let cursor: { date: Date | null; accountId: string | null; uid: number | null } | null = null;

      for (let page = 0; page < 10; page++) {
        const rows = await db.getUnifiedInbox({ limit: 2, cursor, folder: ALL_FOLDERS, accountId: null });
        if (rows.length === 0) break;
        for (const row of rows) seen.push(row.subject);
        const last = rows[rows.length - 1];
        cursor = { date: last.date, accountId: last.account_id, uid: Number(last.uid) };
      }

      expect(seen).toEqual(['newer', 'tie-b-100', 'tie-a-101', 'tie-a-100', 'no-date']);
      expect(new Set(seen).size).toBe(seen.length); // no duplicates either
    });

    it('reaches the NULL-date tail through the cursor', async () => {
      // A bare-timestamp cursor can never address a NULL date at all; the
      // compound cursor carries a null date plus the tiebreaker instead.
      const page = await db.getUnifiedInbox({
        limit: 10,
        cursor: { date: null, accountId: 'test-a', uid: 400 },
        folder: ALL_FOLDERS,
        accountId: null,
      });
      expect(page.map((m) => m.subject)).toEqual(['no-date']);
    });

    it('still accepts a bare timestamp cursor from an older client', async () => {
      const page = await db.getUnifiedInbox({
        limit: 10,
        cursor: { date: new Date('2026-07-16T00:00:00Z'), accountId: null, uid: null },
        folder: ALL_FOLDERS,
        accountId: null,
      });
      // Strictly before the newest message: the three tied rows and the
      // NULL-date tail, in the same total order.
      expect(page.map((m) => m.subject)).toEqual(['tie-b-100', 'tie-a-101', 'tie-a-100', 'no-date']);
    });

    it('orders ties deterministically by (account_id, uid) descending', async () => {
      const page = await db.getUnifiedInbox({ limit: 200, cursor: null, folder: ALL_FOLDERS, accountId: null });
      const tied = page.filter((m) => m.subject.startsWith('tie-')).map((m) => m.subject);
      expect(tied).toEqual(['tie-b-100', 'tie-a-101', 'tie-a-100']);
    });
  });

  // ---------------------------------------------------------------------------
  // Plan 5 Task 2: folder and account filters on the unified inbox query.
  //
  // Ground truth: `messages.folder` holds whatever an account's own IMAP
  // LIST discovered (server-NATIVE names), never the API's logical folder
  // name. "test-a" below is fixtured Gmail-English-shaped
  // ("[Gmail]/Sent Mail"); "test-b" deliberately is NOT — no "[Gmail]/"
  // prefix at all — so a test passing for "test-a" and failing for
  // "test-b" would be the signature of a hardcoded pattern rather than a
  // real per-account mapping. db.ts itself never resolves the mapping (that
  // is ../src/api/inbox.ts's job, reading ConnectionPool.getDiscoveredFolders
  // — see tests/inbox.test.ts and tests/routes.test.ts for that half); this
  // suite only proves the SQL is correct once already-resolved pairs are
  // handed to it.
  // ---------------------------------------------------------------------------

  describe('folder and account filtering (Plan 5 Task 2)', () => {
    const D1 = new Date('2026-07-20T10:00:00Z');
    const D2 = new Date('2026-07-21T10:00:00Z');

    const SENT_PAIRS: InboxFolderFilter = {
      kind: 'pairs',
      pairs: [
        { accountId: 'test-a', folder: '[Gmail]/Sent Mail' },
        { accountId: 'test-b', folder: 'Envoyés' },
      ],
    };
    const SPAM_PAIRS: InboxFolderFilter = {
      kind: 'pairs',
      pairs: [
        { accountId: 'test-a', folder: '[Gmail]/Spam' },
        { accountId: 'test-b', folder: 'Indésirables' },
      ],
    };
    const INBOX_LITERAL: InboxFolderFilter = { kind: 'literal', folder: 'INBOX' };
    const STARRED: InboxFolderFilter = { kind: 'starred' };

    beforeAll(async () => {
      await db.query('delete from messages where account_id like $1', ['test-%']);
      const rows = [
        { accountId: 'test-a', folder: 'INBOX', uid: 5000, date: D1, subject: 'a-inbox', flags: [] },
        { accountId: 'test-a', folder: '[Gmail]/Sent Mail', uid: 5001, date: D1, subject: 'a-sent', flags: [] },
        { accountId: 'test-a', folder: '[Gmail]/Spam', uid: 5002, date: D1, subject: 'a-spam', flags: [] },
        { accountId: 'test-b', folder: 'INBOX', uid: 5000, date: D1, subject: 'b-inbox', flags: [] },
        // Flagged: this is the "starred" fixture — deliberately in a
        // non-INBOX, non-Gmail-shaped folder.
        { accountId: 'test-b', folder: 'Envoyés', uid: 5001, date: D1, subject: 'b-sent', flags: ['\\Flagged'] },
        { accountId: 'test-b', folder: 'Indésirables', uid: 5002, date: D1, subject: 'b-spam', flags: [] },
        // Flagged, in a THIRD folder and a different date — proves starred
        // crosses folders (Envoyés vs Corbeille) rather than just "the one
        // folder that happens to be flagged".
        { accountId: 'test-b', folder: 'Corbeille', uid: 5003, date: D2, subject: 'b-trash', flags: ['\\Flagged'] },
      ];
      for (const row of rows) {
        await db.upsertMessage({
          accountId: row.accountId, uid: row.uid, folder: row.folder,
          messageId: `<${row.subject}@x>`, threadId: 'filters', subject: row.subject,
          fromName: null, fromEmail: null, toEmails: [], ccEmails: [],
          date: row.date, snippet: null, flags: row.flags, labels: [],
          hasAttach: false, sizeBytes: 1,
        });
      }
    });

    it('a literal filter (folder=inbox) returns only INBOX rows, across every account', async () => {
      const rows = await db.getUnifiedInbox({ limit: 50, cursor: null, folder: INBOX_LITERAL, accountId: null });
      expect(rows.map((m) => m.subject).sort()).toEqual(['a-inbox', 'b-inbox']);
    });

    it('a pairs filter (folder=sent) matches each account\'s own native folder, including a non-Gmail-shaped one', async () => {
      // "test-b"'s row only comes back if 'Envoyés' — not some hardcoded
      // '[Gmail]/…' guess — was actually matched against messages.folder.
      const rows = await db.getUnifiedInbox({ limit: 50, cursor: null, folder: SENT_PAIRS, accountId: null });
      expect(rows.map((m) => m.subject).sort()).toEqual(['a-sent', 'b-sent']);
    });

    it('a pairs filter (folder=spam) likewise resolves per account', async () => {
      const rows = await db.getUnifiedInbox({ limit: 50, cursor: null, folder: SPAM_PAIRS, accountId: null });
      expect(rows.map((m) => m.subject).sort()).toEqual(['a-spam', 'b-spam']);
    });

    it('an account filter alone restricts to one account across every folder', async () => {
      const rows = await db.getUnifiedInbox({ limit: 50, cursor: null, folder: ALL_FOLDERS, accountId: 'test-a' });
      const subjects = rows.map((m) => m.subject);
      expect(subjects.sort()).toEqual(['a-inbox', 'a-spam', 'a-sent'].sort());
      expect(subjects).not.toContain('b-inbox');
    });

    it('account and folder filters compose: only the named account\'s messages in the named folder', async () => {
      const rows = await db.getUnifiedInbox({
        limit: 50, cursor: null,
        folder: { kind: 'pairs', pairs: [{ accountId: 'test-b', folder: 'Envoyés' }] },
        accountId: 'test-b',
      });
      expect(rows.map((m) => m.subject)).toEqual(['b-sent']);
    });

    it('starred returns flagged rows from more than one folder', async () => {
      const rows = await db.getUnifiedInbox({ limit: 50, cursor: null, folder: STARRED, accountId: null });
      const bySubjectAndFolder = rows.map((m) => [m.subject, m.folder]).sort();
      expect(bySubjectAndFolder).toEqual([
        ['b-sent', 'Envoyés'],
        ['b-trash', 'Corbeille'],
      ]);
    });

    it('starred composes with an account filter', async () => {
      const rows = await db.getUnifiedInbox({ limit: 50, cursor: null, folder: STARRED, accountId: 'test-b' });
      expect(rows.map((m) => m.subject).sort()).toEqual(['b-sent', 'b-trash']);

      const none = await db.getUnifiedInbox({ limit: 50, cursor: null, folder: STARRED, accountId: 'test-a' });
      expect(none).toEqual([]);
    });

    it('an empty pairs list (an account whose folder was never discovered) matches zero rows, not an error', async () => {
      // What resolveFolderFilter (../src/api/inbox.ts) produces for an
      // account whose Trash the server never flagged, or whose discovery
      // simply has not run yet — this proves the SQL side of that contract:
      // a 200 with an empty array, never a thrown error, even though the
      // table plainly has OTHER rows it could have matched.
      const rows = await db.getUnifiedInbox({
        limit: 50, cursor: null, folder: { kind: 'pairs', pairs: [] }, accountId: null,
      });
      expect(rows).toEqual([]);
    });
  });

  describe('folder-filtered keyset cursor stays lossless at a shared timestamp (Plan 5 Task 2)', () => {
    // The project's own prior pagination bug (see the sibling
    // "unified inbox ordering and pagination" describe above) was exactly
    // this shape without a filter; Plan 5 Task 2's contract requires the
    // same guarantee to survive a folder filter's WHERE clause, so this
    // gets its own dedicated fixture and test rather than a comment
    // asserting it by inspection.
    const TIE = new Date('2026-07-22T09:00:00Z');
    const SENT_PAIRS: InboxFolderFilter = {
      kind: 'pairs',
      pairs: [
        { accountId: 'test-a', folder: '[Gmail]/Sent Mail' },
        { accountId: 'test-b', folder: 'Envoyés' },
      ],
    };

    beforeAll(async () => {
      await db.query('delete from messages where account_id like $1', ['test-%']);
      const rows = [
        // Three SENT messages sharing one second-resolution timestamp,
        // across two accounts — the exact shape a bulk delivery produces.
        { accountId: 'test-a', folder: '[Gmail]/Sent Mail', uid: 6010, subject: 'tie-sent-a-6010' },
        { accountId: 'test-a', folder: '[Gmail]/Sent Mail', uid: 6011, subject: 'tie-sent-a-6011' },
        { accountId: 'test-b', folder: 'Envoyés', uid: 6010, subject: 'tie-sent-b-6010' },
        // A DECOY sharing the exact same timestamp, in the exact same
        // account, but NOT in a folder the filter matches — proves the
        // filter is still being applied at every page of the walk, not
        // only evaluated once up front.
        { accountId: 'test-a', folder: 'INBOX', uid: 6010, subject: 'tie-inbox-a-6010' },
      ];
      for (const row of rows) {
        await db.upsertMessage({
          accountId: row.accountId, uid: row.uid, folder: row.folder,
          messageId: `<${row.subject}@x>`, threadId: 'filtered-paging', subject: row.subject,
          fromName: null, fromEmail: null, toEmails: [], ccEmails: [],
          date: TIE, snippet: null, flags: [], labels: [],
          hasAttach: false, sizeBytes: 1,
        });
      }
    });

    it('pages across the tie boundary under a folder filter without skipping or duplicating a row', async () => {
      const seen: string[] = [];
      let cursor: { date: Date | null; accountId: string | null; uid: number | null } | null = null;

      for (let page = 0; page < 10; page++) {
        const rows = await db.getUnifiedInbox({ limit: 2, cursor, folder: SENT_PAIRS, accountId: null });
        if (rows.length === 0) break;
        for (const row of rows) seen.push(row.subject);
        const last = rows[rows.length - 1];
        cursor = { date: last.date, accountId: last.account_id, uid: Number(last.uid) };
      }

      // Deterministic (account_id, uid) DESC tiebreak among the three tied
      // SENT rows: 'test-b' sorts after 'test-a' lexicographically, so it
      // comes first descending; test-a's own two rows then order by uid.
      expect(seen).toEqual(['tie-sent-b-6010', 'tie-sent-a-6011', 'tie-sent-a-6010']);
      expect(new Set(seen).size).toBe(seen.length); // no duplicates
      expect(seen).not.toContain('tie-inbox-a-6010'); // the decoy never leaks through
    });
  });

  // ---------------------------------------------------------------------------
  // Plan 7 Task 1: previews and search, against a real Postgres
  // ---------------------------------------------------------------------------
  //
  // The generated SQL — parameterization, wildcard escaping, placeholder
  // numbering — is asserted without a database in tests/db-filter.test.ts,
  // which is what covers those properties on a checkout with no
  // TEST_DATABASE_URL. What only Postgres can answer is whether the clauses
  // actually select the rows they claim to, and that is this describe's job.

  describe('snippet preservation across a re-poll (Plan 7 Task 1)', () => {
    const base = {
      accountId: 'test-a', folder: 'INBOX', messageId: '<snip@x>', threadId: 'snip',
      subject: 'preview subject', fromName: 'A', fromEmail: 'a@x.com',
      toEmails: [], ccEmails: [], date: new Date('2026-08-15T00:00:00Z'),
      flags: [], labels: [], hasAttach: false, sizeBytes: 1,
    };

    it('a later upsert carrying snippet=null keeps the snippet already stored', async () => {
      // The sync loop re-polls the newest 50 UIDs every cycle and only asks
      // for a preview for a message that has none — so every one of those
      // re-polls arrives carrying snippet=NULL. A plain excluded.snippet
      // would wipe the preview on the very next cycle, forever.
      await db.upsertMessage({ ...base, uid: 7000, snippet: 'the stored preview' });
      await db.upsertMessage({ ...base, uid: 7000, snippet: null });

      const rows = await db.query(
        'select snippet from messages where account_id=$1 and folder=$2 and uid=$3',
        ['test-a', 'INBOX', 7000],
      );
      expect(rows[0].snippet).toBe('the stored preview');
    });

    it('a later upsert carrying a NEW snippet still replaces the old one', async () => {
      await db.upsertMessage({ ...base, uid: 7001, snippet: 'first' });
      await db.upsertMessage({ ...base, uid: 7001, snippet: 'second' });

      const rows = await db.query(
        'select snippet from messages where account_id=$1 and folder=$2 and uid=$3',
        ['test-a', 'INBOX', 7001],
      );
      expect(rows[0].snippet).toBe('second');
    });

    it('findUidsWithSnippet returns only the UIDs that already have one', async () => {
      await db.upsertMessage({ ...base, uid: 7002, snippet: 'has one' });
      await db.upsertMessage({ ...base, uid: 7003, snippet: null });

      const found = await db.findUidsWithSnippet('test-a', 'INBOX', [7002, 7003]);
      expect([...found]).toEqual([7002]);
    });

    it('findUidsWithSnippet is scoped to the account and folder it was asked about', async () => {
      await db.upsertMessage({ ...base, uid: 7004, snippet: 'inbox copy' });
      const found = await db.findUidsWithSnippet('test-b', 'INBOX', [7004]);
      expect(found.size).toBe(0);
    });

    it('findUidsWithSnippet asks nothing of the database for an empty UID list', async () => {
      const found = await db.findUidsWithSnippet('test-a', 'INBOX', []);
      expect(found.size).toBe(0);
    });
  });

  describe('search (Plan 7 Task 1)', () => {
    const SEARCH_DATE = new Date('2026-08-16T00:00:00Z');

    beforeAll(async () => {
      const rows = [
        { uid: 8000, folder: 'INBOX', subject: 'Quarterly numbers', fromName: 'Sarah Chen', fromEmail: 'sarah@example.com', snippet: 'the figures are attached' },
        { uid: 8001, folder: 'INBOX', subject: 'Lunch?', fromName: 'Ravi Patel', fromEmail: 'ravi@example.org', snippet: 'thursday works for me' },
        { uid: 8002, folder: '[Gmail]/Sent Mail', subject: 'Re: Quarterly numbers', fromName: null, fromEmail: 'me@example.com', snippet: null },
        // The wildcard fixtures: literal % and _ in real content.
        { uid: 8003, folder: 'INBOX', subject: 'Growth hit 100% this year', fromName: null, fromEmail: 'growth@example.com', snippet: null },
        { uid: 8004, folder: 'INBOX', subject: 'file a_b renamed', fromName: null, fromEmail: 'ops@example.com', snippet: null },
        { uid: 8005, folder: 'INBOX', subject: 'file axb renamed', fromName: null, fromEmail: 'ops@example.com', snippet: null },
        // The decoy that makes the "100%" case non-vacuous: it contains
        // "100" but no percent sign, so an UNESCAPED `%100%%` matches it
        // and an escaped `%100\\%%` does not.
        { uid: 8006, folder: 'INBOX', subject: 'Invoice 1000 attached', fromName: null, fromEmail: 'billing@example.com', snippet: null },
      ];
      for (const row of rows) {
        await db.upsertMessage({
          accountId: 'test-a', uid: row.uid, folder: row.folder,
          messageId: `<s${row.uid}@x>`, threadId: `search-${row.uid}`, subject: row.subject,
          fromName: row.fromName, fromEmail: row.fromEmail, toEmails: [], ccEmails: [],
          date: SEARCH_DATE, snippet: row.snippet, flags: [], labels: [],
          hasAttach: false, sizeBytes: 1,
        });
      }
      // A second account, to prove the account filter composes with search.
      await db.upsertMessage({
        accountId: 'test-b', uid: 8000, folder: 'INBOX',
        messageId: '<sb8000@x>', threadId: 'search-b', subject: 'Quarterly numbers (b)',
        fromName: null, fromEmail: 'b@example.com', toEmails: [], ccEmails: [],
        date: SEARCH_DATE, snippet: null, flags: [], labels: [], hasAttach: false, sizeBytes: 1,
      });
    });

    const search = (query: string, extra: Record<string, unknown> = {}) =>
      db.getUnifiedInbox({
        limit: 50, cursor: null, folder: ALL_FOLDERS, accountId: null, search: query, ...extra,
      });

    it('matches on subject', async () => {
      const subjects = (await search('quarterly')).map((m) => m.subject);
      expect(subjects).toContain('Quarterly numbers');
      expect(subjects).not.toContain('Lunch?');
    });

    it('matches on from_name', async () => {
      expect((await search('ravi patel')).map((m) => m.uid.toString())).toContain('8001');
    });

    it('matches on from_email', async () => {
      expect((await search('example.org')).map((m) => m.uid.toString())).toContain('8001');
    });

    it('matches on snippet, which is what makes previews searchable', async () => {
      const rows = await search('figures are attached');
      expect(rows.map((m) => m.uid.toString())).toEqual(['8000']);
    });

    it('is case-insensitive in both directions', async () => {
      expect((await search('QUARTERLY')).length).toBeGreaterThan(0);
      expect((await search('sarah chen')).length).toBeGreaterThan(0);
    });

    it('treats a literal % as text: searching "100%" does not match everything', async () => {
      // Unescaped, the pattern would be `%100%%`, whose trailing wildcard
      // matches every row containing "100" — including the "Invoice 1000"
      // decoy seeded above, which is what keeps this assertion from
      // passing for the wrong reason.
      const rows = await search('100%');
      expect(rows.map((m) => m.uid.toString())).toEqual(['8003']);

      // And the decoy really is reachable, so the assertion above is a
      // narrowing rather than an empty set.
      expect((await search('100')).map((m) => m.uid.toString()).sort()).toEqual(['8003', '8006']);
    });

    it('a bare % matches nothing, because no message contains a literal percent sign except one', async () => {
      const rows = await search('%');
      expect(rows.map((m) => m.uid.toString())).toEqual(['8003']);
    });

    it('treats a literal _ as text: "a_b" does not also match "axb"', async () => {
      const rows = await search('a_b');
      expect(rows.map((m) => m.uid.toString())).toEqual(['8004']);
    });

    it('composes with a folder filter', async () => {
      const rows = await search('quarterly', {
        folder: { kind: 'pairs', pairs: [{ accountId: 'test-a', folder: '[Gmail]/Sent Mail' }] },
      });
      expect(rows.map((m) => m.uid.toString())).toEqual(['8002']);
    });

    it('composes with an account filter', async () => {
      const rows = await search('quarterly', { accountId: 'test-b' });
      expect(rows.map((m) => m.subject)).toEqual(['Quarterly numbers (b)']);
    });

    it('composes with folder AND account together', async () => {
      const rows = await search('quarterly', {
        accountId: 'test-a',
        folder: { kind: 'literal', folder: 'INBOX' },
      });
      expect(rows.map((m) => m.uid.toString())).toEqual(['8000']);
    });

    it('returns an empty array, not an error, for a query nothing matches', async () => {
      expect(await search('zzzz-no-such-text')).toEqual([]);
    });

    it('is not fooled by SQL metacharacters in the query', async () => {
      await expect(search("'; drop table messages; --")).resolves.toEqual([]);
      const survived = await db.query('select count(*)::int as n from messages', []);
      expect(survived[0].n).toBeGreaterThan(0);
    });
  });

  /**
   * SEARCH OPERATORS — the half of the grammar only a real database can
   * decide.
   *
   * tests/search-terms.test.ts proves what a query MEANS and
   * tests/search-clause.test.ts proves what SQL that meaning becomes.
   * Neither can prove the SQL selects the right rows: an `is:unread` that
   * matched read mail too, an AND that is silently an OR, a `to:` written
   * against `cc_emails` — all three generate a statement that runs, and
   * all three are only visible against stored rows.
   *
   * Its own fixture set (uid 9000+) with its own account, so nothing here
   * can be satisfied by a row another describe seeded.
   */
  describe('search operators', () => {
    const DAY = (iso: string) => new Date(`${iso}T12:00:00Z`);

    beforeAll(async () => {
      await db.query(
        'insert into accounts (id, email) values ($1, $2) on conflict do nothing',
        ['test-ops', 'test-ops@gmail.com'],
      );

      const rows = [
        {
          uid: 9000, subject: 'Invoice 42', fromName: 'Ada Lovelace', fromEmail: 'ada@analytical.example',
          to: ['bob@example.com'], cc: ['eve@example.com'], date: DAY('2026-03-01'),
          flags: [], hasAttach: true, size: 12 * 1024 * 1024, snippet: 'please review',
        },
        {
          uid: 9001, subject: 'Lunch', fromName: 'Bob Barker', fromEmail: 'bob@example.com',
          to: ['ada@analytical.example'], cc: [], date: DAY('2026-03-02'),
          flags: ['\\Seen'], hasAttach: false, size: 2048, snippet: 'thursday?',
        },
        {
          uid: 9002, subject: 'Invoice 43', fromName: 'Ada Lovelace', fromEmail: 'ada@analytical.example',
          to: [], cc: [], date: DAY('2025-06-01'),
          flags: ['\\Seen', '\\Flagged'], hasAttach: false, size: 512 * 1024, snippet: 'paid',
        },
      ] as const;

      for (const row of rows) {
        await db.upsertMessage({
          accountId: 'test-ops', uid: row.uid, folder: 'INBOX',
          messageId: `<o${row.uid}@x>`, threadId: `ops-${row.uid}`,
          subject: row.subject, fromName: row.fromName, fromEmail: row.fromEmail,
          toEmails: row.to, ccEmails: row.cc,
          date: row.date, snippet: row.snippet, flags: row.flags,
          labels: [], hasAttach: row.hasAttach, sizeBytes: row.size,
        });
      }

      // uid 9003 — THE NULL-EVERYTHING ROW, and it goes in as raw SQL
      // because upsertMessage cannot express it: `MessageInput` types
      // `flags`/`toEmails` as non-nullable arrays, so the only rows in
      // this database with NULL there are ones the current write path did
      // not produce. That is exactly the population these clauses have to
      // be right about — a mailbox synced before a column existed — so the
      // fixture has to reach past the writer to create one.
      await db.query(
        `insert into messages
           (account_id, uid, folder, message_id, thread_id, subject, from_name, from_email,
            to_emails, cc_emails, date, snippet, flags, labels, has_attach, size_bytes)
         values ($1, $2, 'INBOX', '<o9003@x>', 'ops-9003', null, null, null,
            null, null, $3::timestamptz, null, null, null, false, null)
         on conflict (account_id, folder, uid) do nothing`,
        ['test-ops', 9003, DAY('2026-03-03').toISOString()],
      );
    });

    afterAll(async () => {
      await db.query('delete from accounts where id = $1', ['test-ops']);
    });

    /** Every query below is scoped to the fixture account, so the real
     *  mailbox this may be pointed at cannot make an assertion pass or
     *  fail for reasons that have nothing to do with the operator. */
    const uids = async (query: string): Promise<readonly string[]> => {
      const rows = await db.getUnifiedInbox({
        limit: 50, cursor: null, folder: ALL_FOLDERS, accountId: 'test-ops', search: query,
      });
      return rows.map((m) => m.uid.toString()).sort();
    };

    it('from: matches the display name and the address alike', async () => {
      expect(await uids('from:lovelace')).toEqual(['9000', '9002']);
      expect(await uids('from:analytical')).toEqual(['9000', '9002']);
    });

    it('to: matches an element of to_emails and NOT the sender of the same address', async () => {
      // uid 9001 is FROM bob and TO ada; uid 9000 is TO bob. A `to:`
      // written against the wrong column would return 9001 here.
      expect(await uids('to:bob')).toEqual(['9000']);
    });

    it('cc: matches cc_emails only', async () => {
      expect(await uids('cc:eve')).toEqual(['9000']);
      expect(await uids('cc:bob')).toEqual([]);
    });

    it('subject: does not match a sender who happens to contain the word', async () => {
      expect(await uids('subject:invoice')).toEqual(['9000', '9002']);
      expect(await uids('subject:ada')).toEqual([]);
    });

    it('is:unread excludes READ mail, and counts a NULL-flags row as unread', async () => {
      // THE MUTATION THIS EXISTS FOR. 9001 and 9002 carry \\Seen; an
      // is:unread that also matched them would look entirely plausible.
      // 9003 has NULL flags, which `any(NULL)` makes NULL — without the
      // coalesce it would fall out of BOTH is:read and is:unread.
      expect(await uids('is:unread')).toEqual(['9000', '9003']);
      expect(await uids('is:read')).toEqual(['9001', '9002']);
    });

    it('is:starred matches the \\Flagged row only', async () => {
      expect(await uids('is:starred')).toEqual(['9002']);
    });

    it('has:attachment matches the has_attach row only', async () => {
      expect(await uids('has:attachment')).toEqual(['9000']);
    });

    it('before: is exclusive and after: is inclusive at the same instant', async () => {
      // The partition property: every fixture is on exactly one side.
      const before = await uids('before:2026-03-02');
      const after = await uids('after:2026-03-02');
      // 9000 is dated 2026-03-01T12:00Z, so it is on the `before` side of
      // the 2026-03-02T00:00Z boundary — the day is a boundary, not a
      // bucket.
      expect(before).toEqual(['9000', '9002']);
      expect(after).toEqual(['9001', '9003']);
      expect(before.filter((uid) => after.includes(uid))).toEqual([]);
    });

    it('composes two date bounds into a window', async () => {
      expect(await uids('after:2026-03-01 before:2026-03-03')).toEqual(['9000', '9001']);
    });

    it('larger: and smaller: bound size_bytes, excluding a NULL size from both', async () => {
      expect(await uids('larger:10mb')).toEqual(['9000']);
      expect(await uids('smaller:1mb')).toEqual(['9001', '9002']);
      // 9003 has a NULL size and appears in neither — a message whose
      // size was never recorded is not known to be large or small.
      expect(await uids('larger:1')).not.toContain('9003');
      expect(await uids('smaller:99gb')).not.toContain('9003');
    });

    it('ANDs two terms — it does not OR them', async () => {
      // THE SECOND MUTATION. Under an OR this returns all of Ada's mail
      // PLUS every unread message, which is a bigger, plausible-looking
      // result set that nobody would question.
      expect(await uids('from:ada is:unread')).toEqual(['9000']);
      expect(await uids('from:ada')).toEqual(['9000', '9002']);
      expect(await uids('is:unread')).toEqual(['9000', '9003']);
    });

    it('ANDs four terms of four different kinds', async () => {
      expect(await uids('from:ada subject:invoice has:attachment after:2026-01-01')).toEqual(['9000']);
    });

    it('SEARCHES LITERALLY for an unknown operator rather than dropping it', async () => {
      // THE THIRD MUTATION. Dropped, `foo:bar from:ada` would return both
      // of Ada's messages — the search silently answering a different,
      // broader question. Searched literally, no message contains the
      // text "foo:bar", so the AND is empty.
      expect(await uids('foo:bar')).toEqual([]);
      expect(await uids('foo:bar from:ada')).toEqual([]);
      // And the literal really is what is being searched for: a message
      // whose subject contains the unknown-operator text matches it.
      await db.upsertMessage({
        accountId: 'test-ops', uid: 9004, folder: 'INBOX',
        messageId: '<o9004@x>', threadId: 'ops-9004', subject: 'about foo:bar',
        fromName: null, fromEmail: null, toEmails: [], ccEmails: [],
        date: DAY('2026-03-04'), snippet: null, flags: [], labels: [],
        hasAttach: false, sizeBytes: 1,
      });
      expect(await uids('foo:bar')).toEqual(['9004']);
      await db.query('delete from messages where account_id=$1 and uid=$2', ['test-ops', 9004]);
    });

    it('searches literally for an empty operator value, and never for everything', async () => {
      expect(await uids('from:')).toEqual([]);
    });

    it('negation keeps rows whose column is NULL', async () => {
      // `-from:ada` must KEEP 9003, whose sender is unknown: it is
      // certainly not from Ada. Bare `not (…)` yields NULL there and
      // silently drops it.
      expect(await uids('-from:ada')).toEqual(['9001', '9003']);
      expect(await uids('-is:unread')).toEqual(['9001', '9002']);
    });

    it('treats a quoted phrase as one term and an unquoted pair as two', async () => {
      // "Ada Lovelace" as a phrase needs the two words adjacent in one
      // column; unquoted they only have to appear somewhere each.
      expect(await uids('from:"ada lovelace"')).toEqual(['9000', '9002']);
      expect(await uids('"invoice 42"')).toEqual(['9000']);
      expect(await uids('invoice 42')).toEqual(['9000']);
      // The superset property: an unquoted pair can match where the
      // phrase cannot.
      expect(await uids('"lovelace ada"')).toEqual([]);
      expect(await uids('lovelace ada')).toEqual(['9000', '9002']);
    });

    it('is not fooled by an operator-shaped SQL payload', async () => {
      await expect(uids("from:'; drop table messages; --")).resolves.toEqual([]);
      const survived = await db.query('select count(*)::int as n from messages', []);
      expect(survived[0].n).toBeGreaterThan(0);
    });

    it('runs a 500-term query without erroring', async () => {
      const many = Array.from({ length: 500 }, (_unused, index) => `w${index}`).join(' ');
      await expect(uids(many)).resolves.toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // F2: exactly one primary account (spec 7B.1)
  // ---------------------------------------------------------------------------

  it('rejects a second primary account at the database level (spec 7B.1)', async () => {
    await db.query(
      `insert into accounts (id, email, is_primary) values ($1,$2,true)
       on conflict (id) do update set is_primary = true`,
      ['test-p1', 'test-p1@gmail.com'],
    );
    await expect(
      db.query('insert into accounts (id, email, is_primary) values ($1,$2,true)',
        ['test-p2', 'test-p2@gmail.com']),
    ).rejects.toThrow(/accounts_one_primary|duplicate key/i);

    // Demoted, the same second account inserts fine — the index constrains
    // only the true side.
    await db.query('insert into accounts (id, email, is_primary) values ($1,$2,false)',
      ['test-p2', 'test-p2@gmail.com']);
    await db.query('update accounts set is_primary = false where id = $1', ['test-p1']);
  });

  it('moves the primary flag between accounts without violating the unique index', async () => {
    // registerAccounts runs on every startup. With accounts_one_primary in
    // place, upserting a new primary before the old one has been demoted is
    // a constraint violation whose likelihood depends purely on the order of
    // the accounts array — which is why the flag is cleared across the board
    // first. Ordered here so the NEW primary is written before the old one.
    await registerAccounts(db, [
      { id: 'test-r1', email: 'test-r1@gmail.com', appPassword: 'x'.repeat(16), isPrimary: true },
      { id: 'test-r2', email: 'test-r2@gmail.com', appPassword: 'y'.repeat(16), isPrimary: false },
    ]);

    await expect(registerAccounts(db, [
      { id: 'test-r2', email: 'test-r2@gmail.com', appPassword: 'y'.repeat(16), isPrimary: true },
      { id: 'test-r1', email: 'test-r1@gmail.com', appPassword: 'x'.repeat(16), isPrimary: false },
    ])).resolves.toBeUndefined();

    const rows = await db.query(
      'select id from accounts where is_primary order by id',
      [],
    );
    expect(rows.map((r) => r.id)).toEqual(['test-r2']);
  });

  it('is a no-op on an unchanged accounts file', async () => {
    const accounts = [
      { id: 'test-r1', email: 'test-r1@gmail.com', appPassword: 'x'.repeat(16), isPrimary: true },
    ];
    await registerAccounts(db, accounts);
    await registerAccounts(db, accounts);
    const rows = await db.query('select id, is_primary from accounts where id = $1', ['test-r1']);
    expect(rows).toHaveLength(1);
    expect(rows[0].is_primary).toBe(true);
  });
});