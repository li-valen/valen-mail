import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openDb, type Db } from '../src/db';
import { registerAccounts } from '../src/api/server';

const URL = process.env.TEST_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

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
    const inbox = await db.getUnifiedInbox({ limit: 10, cursor: null });
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
    const inbox = await db.getUnifiedInbox({ limit: 200, cursor: null });
    const row = inbox.find((m) => m.uid === '10' || m.uid === 10);
    expect(row).toBeDefined();
    expect(row.attachments).toEqual([
      { partId: '2', filename: 'renamed.pdf', mimeType: 'application/pdf', sizeBytes: 51_201 },
    ]);
  });

  it('returns an empty array, not null, for a message with no attachments', async () => {
    const inbox = await db.getUnifiedInbox({ limit: 200, cursor: null });
    const row = inbox.find((m) => m.uid === '1' || m.uid === 1);
    expect(row).toBeDefined();
    expect(row.attachments).toEqual([]);
  });

  it('returns attachment metadata on the thread route too', async () => {
    const thread = await db.getThread('t10');
    expect(thread).toHaveLength(1);
    expect(thread[0].attachments).toHaveLength(1);
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
      const page = await db.getUnifiedInbox({ limit: 200, cursor: null });
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
        const rows = await db.getUnifiedInbox({ limit: 2, cursor });
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
      });
      expect(page.map((m) => m.subject)).toEqual(['no-date']);
    });

    it('still accepts a bare timestamp cursor from an older client', async () => {
      const page = await db.getUnifiedInbox({
        limit: 10,
        cursor: { date: new Date('2026-07-16T00:00:00Z'), accountId: null, uid: null },
      });
      // Strictly before the newest message: the three tied rows and the
      // NULL-date tail, in the same total order.
      expect(page.map((m) => m.subject)).toEqual(['tie-b-100', 'tie-a-101', 'tie-a-100', 'no-date']);
    });

    it('orders ties deterministically by (account_id, uid) descending', async () => {
      const page = await db.getUnifiedInbox({ limit: 200, cursor: null });
      const tied = page.filter((m) => m.subject.startsWith('tie-')).map((m) => m.subject);
      expect(tied).toEqual(['tie-b-100', 'tie-a-101', 'tie-a-100']);
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