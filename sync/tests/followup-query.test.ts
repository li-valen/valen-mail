import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openDb, type Db, type InboxFolderFilter } from '../src/db';
import type { OpenEvent } from '../src/api/opens';
import type { OpensResult } from '../src/api/opens';
import { bareMessageId, queryFollowup, tallyOpens, opensEvidenceFrom } from '../src/followup/query';

/**
 * Plan 10 Task 2 — the join, and the two rules that are the easiest ways
 * to get this feature wrong.
 *
 * Two layers of coverage, deliberately, because they close different
 * risks:
 *
 *  - The DECISION tests below run against a fake `Db` that simply hands
 *    back rows. They run on every `npm test`, with no database, which is
 *    what makes them able to fail when the rule they cover is deleted —
 *    the whole point of a mutation check. Every rule this feature could
 *    silently get wrong (a later message from myself, own-pixel opens,
 *    angle brackets, bigint-as-string) is asserted here.
 *  - The SQL tests at the bottom run against a real scratch Postgres and
 *    skip without TEST_DATABASE_URL, matching tests/db.test.ts's own
 *    precedent. They prove the statement this module builds is valid SQL
 *    that returns the shape the decisions above are made from — which a
 *    fake `Db` structurally cannot.
 */

const SENT_FOLDER: InboxFolderFilter = {
  kind: 'pairs',
  pairs: [{ accountId: 'test-fu-a', folder: '[Gmail]/Sent Mail' }],
};

const NOW_MS = 48 * 60 * 60 * 1000;
const OPENS_LIMIT = 200;

/** No opens at all, and the tracking service answered — the neutral
 *  baseline for a test that is about replies rather than opens. */
const NO_OPENS: OpensResult = { ok: true, opens: [] };

interface FakeQueryCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

/**
 * A `Db` that records the statement it was handed and answers with fixed
 * rows. Columns are spelled exactly as the pg driver returns them,
 * including `uid` as a STRING — the driver renders bigint that way, and a
 * row shaper that forgets it puts a string on the wire where the client's
 * types promise a number.
 */
function fakeDb(rows: readonly Record<string, unknown>[]): {
  readonly db: Db;
  readonly calls: readonly FakeQueryCall[];
} {
  const calls: FakeQueryCall[] = [];
  const db = {
    async query(text: string, values: readonly unknown[] = []) {
      calls.push({ text, values });
      return rows as unknown[];
    },
  } as unknown as Db;
  return { db, calls };
}

function sentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account_id: 'test-fu-a',
    uid: '7',
    folder: '[Gmail]/Sent Mail',
    message_id: '<abc@x.com>',
    subject: 'hello',
    to_emails: ['ada@x.com'],
    cc_emails: [],
    date: new Date(1_000),
    later_senders: [],
    ...overrides,
  };
}

function openEvent(overrides: Partial<OpenEvent> = {}): OpenEvent {
  return {
    token: 't1',
    accountId: 'test-fu-a',
    messageId: 'abc@x.com',
    recipientEmail: 'ada@x.com',
    subject: 'hello',
    sentAt: 1_000,
    occurredAt: 2_000,
    classification: 'open',
    deviceClass: 'unknown',
    os: null,
    ...overrides,
  };
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    ownAddresses: ['me@example.com'],
    limit: 50,
    cursor: null,
    folder: SENT_FOLDER,
    accountId: null,
    opens: NO_OPENS,
    opensLimit: OPENS_LIMIT,
    nowMs: NOW_MS,
    ...overrides,
  } as Parameters<typeof queryFollowup>[1];
}

describe('what "has a reply" means', () => {
  it('a later message from ME in the thread does NOT count as a reply', async () => {
    // A follow-up nudge to my own thread is not an answer, and it must
    // not clear the queue. This is the single easiest way to get this
    // feature wrong.
    const { db } = fakeDb([sentRow({ later_senders: ['me@example.com'] })]);
    const page = await queryFollowup(db, options());
    expect(page.rows[0]?.hasReply).toBe(false);
  });

  it('a later message from THEM does count', async () => {
    const { db } = fakeDb([sentRow({ later_senders: ['ada@x.com'] })]);
    const page = await queryFollowup(db, options());
    expect(page.rows[0]?.hasReply).toBe(true);
  });

  it('a thread carrying both my nudge and their answer counts as replied', async () => {
    const { db } = fakeDb([sentRow({ later_senders: ['me@example.com', 'ada@x.com'] })]);
    const page = await queryFollowup(db, options());
    expect(page.rows[0]?.hasReply).toBe(true);
  });

  it('matches my own address case-insensitively and past surrounding spaces', async () => {
    const { db } = fakeDb([sentRow({ later_senders: ['  ME@Example.COM '] })]);
    const page = await queryFollowup(db, options());
    expect(page.rows[0]?.hasReply).toBe(false);
  });

  it('a replied thread is ranked out of the queue, not merely flagged', async () => {
    const { db } = fakeDb([sentRow({ later_senders: ['ada@x.com'] })]);
    const page = await queryFollowup(db, options());
    expect(page.rows[0]?.state).toBe('opened-replied');
  });
});

describe('the wire shape', () => {
  it('sentAtMs is an epoch-ms NUMBER on the wire, not a string', async () => {
    const { db } = fakeDb([sentRow()]);
    const page = await queryFollowup(db, options());
    expect(typeof page.rows[0]?.sentAtMs).toBe('number');
    expect(page.rows[0]?.sentAtMs).toBe(1_000);
  });

  it('uid is a NUMBER even though the driver renders bigint as a string', async () => {
    const { db } = fakeDb([sentRow({ uid: '7' })]);
    const page = await queryFollowup(db, options());
    expect(page.rows[0]?.uid).toBe(7);
  });

  it('folds to and cc into one recipients list and never emits a null entry', async () => {
    const { db } = fakeDb([sentRow({ to_emails: ['ada@x.com'], cc_emails: null })]);
    const page = await queryFollowup(db, options());
    expect(page.rows[0]?.recipients).toEqual(['ada@x.com']);
  });

  it('never puts a device class on the wire — attribution is impossible', async () => {
    const { db } = fakeDb([sentRow()]);
    const page = await queryFollowup(db, options({ opens: { ok: true, opens: [openEvent()] } }));
    expect(JSON.stringify(page.rows[0])).not.toContain('device');
  });
});

describe('matching opens to sends', () => {
  it('message_id angle brackets are normalised before matching opens', async () => {
    // synced message_id has <>, tracking's does not. Unnormalised, this
    // returns 0 opens — verified against live data, 11 of 11 events.
    const { db } = fakeDb([sentRow({ message_id: '<abc@x.com>' })]);
    const page = await queryFollowup(
      db,
      options({ opens: { ok: true, opens: [openEvent({ messageId: 'abc@x.com' })] } }),
    );
    expect(page.rows[0]?.openCount).toBe(1);
  });

  it('matches when BOTH sides carry the brackets', async () => {
    const { db } = fakeDb([sentRow({ message_id: '<abc@x.com>' })]);
    const page = await queryFollowup(
      db,
      options({ opens: { ok: true, opens: [openEvent({ messageId: '<abc@x.com>' })] } }),
    );
    expect(page.rows[0]?.openCount).toBe(1);
  });

  it('counts repeat opens and reports the newest one', async () => {
    const { db } = fakeDb([sentRow()]);
    const page = await queryFollowup(
      db,
      options({
        opens: {
          ok: true,
          opens: [
            openEvent({ token: 't1', occurredAt: 2_000 }),
            openEvent({ token: 't2', occurredAt: 5_000 }),
          ],
        },
      }),
    );
    expect(page.rows[0]?.openCount).toBe(2);
    expect(page.rows[0]?.lastOpenAtMs).toBe(5_000);
    expect(page.rows[0]?.state).toBe('opened-repeatedly');
  });

  it('counts distinct recipients separately from raw opens', async () => {
    const { db } = fakeDb([sentRow()]);
    const page = await queryFollowup(
      db,
      options({
        opens: {
          ok: true,
          opens: [
            openEvent({ token: 't1', recipientEmail: 'ada@x.com' }),
            openEvent({ token: 't2', recipientEmail: 'ada@x.com' }),
            openEvent({ token: 't3', recipientEmail: 'bo@x.com' }),
          ],
        },
      }),
    );
    expect(page.rows[0]?.openCount).toBe(3);
    expect(page.rows[0]?.distinctRecipientOpens).toBe(2);
  });

  it('does not count an open attributed to one of my OWN addresses', async () => {
    // Spec 5.6: our own Sent copy used to fire the recipient's pixel.
    // Commit d056622 strips the pixel at render, but rows recorded before
    // that fix are still in the tracking database.
    const { db } = fakeDb([sentRow()]);
    const page = await queryFollowup(
      db,
      options({ opens: { ok: true, opens: [openEvent({ recipientEmail: 'me@example.com' })] } }),
    );
    expect(page.rows[0]?.openCount).toBe(0);
  });

  it('does not count a machine fetch as a read', async () => {
    const { db } = fakeDb([sentRow()]);
    const page = await queryFollowup(
      db,
      options({
        opens: {
          ok: true,
          opens: [
            openEvent({ token: 't1', classification: 'mpp' }),
            openEvent({ token: 't2', classification: 'prefetch' }),
            openEvent({ token: 't3', classification: 'scanner' }),
            openEvent({ token: 't4', classification: 'self' }),
            openEvent({ token: 't5', classification: 'something-new' }),
          ],
        },
      }),
    );
    expect(page.rows[0]?.openCount).toBe(0);
  });

  it('says unverifiable, never never-opened, when the tracking service is down', async () => {
    const { db } = fakeDb([sentRow()]);
    const page = await queryFollowup(db, options({ opens: { ok: false, reason: 'unreachable' } }));
    expect(page.rows[0]?.state).toBe('unverifiable');
  });

  it('reports whether the opens evidence was available at all', async () => {
    const { db } = fakeDb([sentRow()]);
    const down = await queryFollowup(db, options({ opens: { ok: false, reason: 'unreachable' } }));
    const up = await queryFollowup(db, options());
    expect(down.opensAvailable).toBe(false);
    expect(up.opensAvailable).toBe(true);
  });
});

describe('the SQL this module builds', () => {
  it('binds every caller-supplied value as a parameter, never into the text', async () => {
    const { db, calls } = fakeDb([]);
    await queryFollowup(
      db,
      options({
        accountId: "robert'); drop table messages;--",
        folder: { kind: 'pairs', pairs: [{ accountId: 'a', folder: "'; drop table messages;--" }] },
      }),
    );
    const [call] = calls;
    expect(call?.text).not.toContain('drop table');
    expect(JSON.stringify(call?.values)).toContain('drop table');
  });

  it('always bounds the page with a limit', async () => {
    const { db, calls } = fakeDb([]);
    await queryFollowup(db, options({ limit: 25 }));
    expect(calls[0]?.text).toMatch(/limit \$\d+/);
    expect(calls[0]?.values).toContain(25);
  });

  it('emits a next cursor for a full page and none for a short one', async () => {
    const full = fakeDb([sentRow({ uid: '7' }), sentRow({ uid: '8' })]);
    const short = fakeDb([sentRow({ uid: '7' })]);
    const fullPage = await queryFollowup(full.db, options({ limit: 2 }));
    const shortPage = await queryFollowup(short.db, options({ limit: 2 }));
    expect(fullPage.nextCursor?.beforeUid).toBe('8');
    expect(shortPage.nextCursor).toBeNull();
  });

  it('excludes messages with no Date header, which have no age to reason about', async () => {
    const { db, calls } = fakeDb([]);
    await queryFollowup(db, options());
    expect(calls[0]?.text).toContain('m.date is not null');
  });
});

describe('bareMessageId', () => {
  it('strips the RFC 5322 delimiters from either spelling', () => {
    expect(bareMessageId('<abc@x.com>')).toBe('abc@x.com');
    expect(bareMessageId('abc@x.com')).toBe('abc@x.com');
  });

  it('leaves an inner angle bracket alone', () => {
    expect(bareMessageId('<a<b@x.com>')).toBe('a<b@x.com');
  });
});

describe('opensEvidenceFrom', () => {
  it('is unavailable when the tracking service could not be read', () => {
    expect(opensEvidenceFrom({ ok: false, reason: 'unreachable' }, 200)).toEqual({
      available: false,
      visibleSinceMs: null,
    });
  });

  it('covers all of history when the page came back short', () => {
    const result: OpensResult = { ok: true, opens: [openEvent({ occurredAt: 9_000 })] };
    expect(opensEvidenceFrom(result, 200)).toEqual({ available: true, visibleSinceMs: null });
  });

  it('reports a horizon when the page came back full', () => {
    const result: OpensResult = {
      ok: true,
      opens: [openEvent({ token: 'a', occurredAt: 9_000 }), openEvent({ token: 'b', occurredAt: 4_000 })],
    };
    expect(opensEvidenceFrom(result, 2)).toEqual({ available: true, visibleSinceMs: 4_000 });
  });
});

describe('tallyOpens', () => {
  it('returns an empty tally rather than throwing on no events', () => {
    expect(tallyOpens([], ['me@example.com']).size).toBe(0);
  });

  it('keys by the bare message id so either spelling resolves', () => {
    const tally = tallyOpens([openEvent({ messageId: '<abc@x.com>' })], []);
    expect(tally.get('abc@x.com')?.openCount).toBe(1);
  });
});

/**
 * The real-Postgres half. Skipped without TEST_DATABASE_URL, exactly like
 * tests/db.test.ts — see this file's header for why both halves exist.
 */
const URL = process.env.TEST_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

maybe('queryFollowup against a real Postgres', () => {
  let db: Db;
  const SENT = '[Gmail]/Sent Mail';

  async function seedMessage(fields: {
    uid: number;
    folder: string;
    threadId: string;
    dateMs: number;
    fromEmail: string;
    messageId?: string;
    toEmails?: readonly string[];
  }): Promise<void> {
    await db.upsertMessage({
      accountId: 'test-fu-a',
      uid: fields.uid,
      folder: fields.folder,
      messageId: fields.messageId ?? `<m${fields.uid}@x.com>`,
      threadId: fields.threadId,
      subject: `subject ${fields.uid}`,
      fromName: null,
      fromEmail: fields.fromEmail,
      toEmails: fields.toEmails ?? ['ada@x.com'],
      ccEmails: [],
      date: new Date(fields.dateMs),
      snippet: null,
      flags: [],
      labels: [],
      hasAttach: false,
      sizeBytes: 1,
    });
  }

  beforeAll(async () => {
    db = openDb(URL!);
    await db.applySchema();
    await db.query('delete from accounts where id like $1', ['test-fu-%']);
    await db.query('insert into accounts (id, email) values ($1, $2)', [
      'test-fu-a',
      'me@example.com',
    ]);
  });

  afterAll(async () => {
    await db.query('delete from accounts where id like $1', ['test-fu-%']);
    await db.close();
  });

  async function run(overrides: Record<string, unknown> = {}) {
    return queryFollowup(db, options(overrides));
  }

  it('returns only messages in the resolved Sent folders', async () => {
    await seedMessage({ uid: 1, folder: SENT, threadId: 't1', dateMs: 1_000, fromEmail: 'me@example.com' });
    await seedMessage({ uid: 2, folder: 'INBOX', threadId: 't9', dateMs: 1_000, fromEmail: 'ada@x.com' });
    const page = await run();
    expect(page.rows.map((row) => row.uid)).toContain(1);
    expect(page.rows.map((row) => row.uid)).not.toContain(2);
  });

  it('a later message from ME in the thread does NOT count as a reply', async () => {
    await seedMessage({ uid: 10, folder: SENT, threadId: 'tme', dateMs: 1_000, fromEmail: 'me@example.com' });
    await seedMessage({ uid: 11, folder: SENT, threadId: 'tme', dateMs: 2_000, fromEmail: 'me@example.com' });
    const page = await run();
    expect(page.rows.find((row) => row.uid === 10)?.hasReply).toBe(false);
  });

  it('a later message from THEM does count', async () => {
    await seedMessage({ uid: 20, folder: SENT, threadId: 'tthem', dateMs: 1_000, fromEmail: 'me@example.com' });
    await seedMessage({ uid: 21, folder: 'INBOX', threadId: 'tthem', dateMs: 2_000, fromEmail: 'ada@x.com' });
    const page = await run();
    expect(page.rows.find((row) => row.uid === 20)?.hasReply).toBe(true);
  });

  it('an EARLIER message from them is not a reply to this one', async () => {
    await seedMessage({ uid: 30, folder: 'INBOX', threadId: 'tearly', dateMs: 1_000, fromEmail: 'ada@x.com' });
    await seedMessage({ uid: 31, folder: SENT, threadId: 'tearly', dateMs: 2_000, fromEmail: 'me@example.com' });
    const page = await run();
    expect(page.rows.find((row) => row.uid === 31)?.hasReply).toBe(false);
  });

  it('sentAtMs is an epoch-ms NUMBER on the wire, not a string', async () => {
    await seedMessage({ uid: 40, folder: SENT, threadId: 't40', dateMs: 7_000, fromEmail: 'me@example.com' });
    const page = await run();
    const row = page.rows.find((candidate) => candidate.uid === 40);
    expect(typeof row?.sentAtMs).toBe('number');
    expect(row?.sentAtMs).toBe(7_000);
  });

  it('message_id angle brackets are normalised before matching opens', async () => {
    await seedMessage({
      uid: 50,
      folder: SENT,
      threadId: 't50',
      dateMs: 1_000,
      fromEmail: 'me@example.com',
      messageId: '<abc50@x.com>',
    });
    const page = await run({
      opens: { ok: true, opens: [openEvent({ messageId: 'abc50@x.com' })] },
    });
    expect(page.rows.find((row) => row.uid === 50)?.openCount).toBe(1);
  });

  it('paginates: a limit of one returns one row and a usable cursor', async () => {
    const first = await run({ limit: 1 });
    expect(first.rows).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await run({
      limit: 1,
      cursor: {
        date: new Date(first.nextCursor!.before!),
        accountId: first.nextCursor!.beforeAccount,
        uid: Number(first.nextCursor!.beforeUid),
      },
    });
    expect(second.rows[0]?.uid).not.toBe(first.rows[0]?.uid);
  });
});
