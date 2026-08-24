import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openDb, type Db } from '../src/db';

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
    const inbox = await db.getUnifiedInbox({ limit: 10, before: null });
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
});
