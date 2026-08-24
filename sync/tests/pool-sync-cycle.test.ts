import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConnectionPool } from '../src/imap/pool';
import { ImapConnection } from '../src/imap/connection';
import type { Db } from '../src/db';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  createFakeClient,
  createFakeDb,
  createPoolHarness,
  wait,
} from './helpers/pool-fakes.ts';

/**
 * The pool's sync-cycle behaviour, from the 2026-08-24 fix wave:
 *  - F1: the reconnect ladder must survive a failure that happens AFTER a
 *    successful IMAP handshake, not reset on the handshake itself.
 *  - F5: attachment metadata from the BODYSTRUCTURE walk must be persisted
 *    rather than discarded.
 *  - F8: an on-demand API fetch and the account's own sync cycle drive the
 *    same imapflow client and must not interleave.
 *
 * Fakes are shared with pool.test.ts from ./helpers/pool-fakes.ts. Nothing
 * here opens a socket or touches a live Gmail account.
 */

describe('ConnectionPool sync cycle', () => {
  const harness = createPoolHarness();
  const launch = harness.launch;

  afterEach(async () => {
    await harness.stop();
  });

  // -------------------------------------------------------------------------
  // F1: backoff must survive a post-handshake failure
  // -------------------------------------------------------------------------

  it('keeps reconnects bounded when every sync cycle fails after a successful connect (F1)', async () => {
    // The regression: `attempt = 0` used to run immediately after
    // connect() resolved. Anything that failed AFTER the handshake — a
    // Postgres restart or OOM-kill (budget.reserve queries the db), a
    // mailbox that fails to open, an account already IMAP-suspended where
    // AUTH succeeds but SELECT INBOX does not — therefore reset the ladder
    // on every pass, and the catch block slept only computeBackoffMs(1)
    // (500-1000ms) forever, however permanent the fault.
    //
    // Measured against the real pool with this exact fake db: 8 connect
    // attempts in 6 seconds, sustained indefinitely — roughly 1.3 auth
    // handshakes per second per account, which is precisely the behaviour
    // that provokes the Gmail lockout this subsystem exists to avoid.
    //
    // The existing "reconnects with backoff" test above passes with or
    // without the reset, so it is not protection. This one is: over 60
    // simulated seconds the exponential ladder (1s, 2s, 4s, 8s, 16s, 32s
    // before jitter) permits at most a handful of attempts, while a ladder
    // pinned at attempt 1 permits 60 or more.
    vi.useFakeTimers();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const fakeA = createFakeClient();
      const db = createFakeDb();
      // Every query throws: this is a Postgres outage as ByteBudget.reserve
      // sees it, which makes syncOnce throw on every cycle while connect()
      // keeps succeeding.
      const brokenDb: Db = {
        ...db,
        async query() {
          throw new Error('postgres is down');
        },
      };
      const pool = new ConnectionPool([ACCOUNT_A], brokenDb, () =>
        new ImapConnection(ACCOUNT_A, () => fakeA.client),
      );

      const started = pool.start();
      await vi.advanceTimersByTimeAsync(60_000);

      const connectsInOneMinute = fakeA.connect.mock.calls.length;
      // Exponential from attempt 1: worst case (every jitter draw at its
      // floor) is 0.5 + 1 + 2 + 4 + 8 + 16 = 31.5s of sleeping for 7
      // connects, so 10 is comfortable headroom that still fails loudly
      // against the ~60-120 the un-fixed reset produces.
      expect(connectsInOneMinute).toBeLessThanOrEqual(10);
      expect(connectsInOneMinute).toBeGreaterThan(1); // it must still be retrying

      // ...and the ladder must keep growing, not plateau: five more minutes
      // of simulated time adds only a few more attempts once the delay has
      // climbed toward MAX_BACKOFF_MS.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(fakeA.connect.mock.calls.length).toBeLessThanOrEqual(connectsInOneMinute + 8);

      await pool.stop();
      await started;
    } finally {
      consoleErrorSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does reset the backoff ladder once a sync cycle actually completes (F1)', async () => {
    // The complement to the test above: the fix must not turn into "never
    // reset", or a connection that drops after weeks of healthy operation
    // would come back with a five-minute delay.
    const fakeA = createFakeClient();
    const db = createFakeDb();
    const pool = new ConnectionPool([ACCOUNT_A], db, () =>
      new ImapConnection(ACCOUNT_A, () => fakeA.client),
    );

    launch(pool);
    await wait(50);

    // A completed cycle: reserve -> fetch -> record all succeeded.
    expect(db.budgetRecordCalls.length).toBe(1);
    expect(pool.status.get('a')).toBe('connected');
  });

  // -------------------------------------------------------------------------
  // F5: attachment metadata must be persisted, not discarded
  // -------------------------------------------------------------------------

  it('persists attachment metadata found by the BODYSTRUCTURE walk (F5)', async () => {
    // syncOnce used to loop result.messages and drop result.attachments
    // entirely, so the attachments table was permanently empty: every
    // attachment served as application/octet-stream with no filename, and
    // a client had no way to discover a partId at all, which made
    // /api/attachment/:account/:folder/:uid/:partId unreachable.
    const fakeA = createFakeClient({
      messages: [
        {
          uid: 7,
          size: 4096,
          envelope: { messageId: '<m7@x>', subject: 'invoice' },
          bodyStructure: {
            part: '',
            type: 'multipart/mixed',
            childNodes: [
              { part: '1', type: 'text/plain' },
              {
                part: '2',
                type: 'application/pdf',
                size: 51_200,
                disposition: 'attachment',
                dispositionParameters: { filename: 'invoice.pdf' },
              },
            ],
          },
        },
      ],
    });
    const db = createFakeDb();
    const pool = new ConnectionPool([ACCOUNT_A], db, () =>
      new ImapConnection(ACCOUNT_A, () => fakeA.client),
    );

    launch(pool);
    await wait(50);

    expect(db.upserts.map((m) => m.uid)).toEqual([7]);
    expect(db.upserts[0]?.hasAttach).toBe(true);
    expect(db.attachmentUpserts).toEqual([
      {
        accountId: 'a',
        folder: 'INBOX',
        uid: 7,
        partId: '2',
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 51_200,
      },
    ]);
  });

  it('writes the message row before its attachment rows (F5: the FK requires it)', async () => {
    // attachments has a foreign key onto messages(account_id, folder, uid),
    // so the reverse order fails outright on a message being seen for the
    // first time. The fake db does not enforce the constraint, so assert
    // the ordering directly.
    const order: string[] = [];
    const fakeA = createFakeClient({
      messages: [
        {
          uid: 9,
          envelope: { messageId: '<m9@x>' },
          bodyStructure: {
            part: '1',
            type: 'application/pdf',
            disposition: 'attachment',
            dispositionParameters: { filename: 'a.pdf' },
          },
        },
      ],
    });
    const base = createFakeDb();
    const db: Db = {
      ...base,
      async upsertMessage(message) {
        order.push(`message:${message.uid}`);
        await base.upsertMessage(message);
      },
      async upsertAttachment(attachment) {
        order.push(`attachment:${attachment.uid}:${attachment.partId}`);
        await base.upsertAttachment(attachment);
      },
    };
    const pool = new ConnectionPool([ACCOUNT_A], db, () =>
      new ImapConnection(ACCOUNT_A, () => fakeA.client),
    );

    launch(pool);
    await wait(50);

    expect(order).toEqual(['message:9', 'attachment:9:1']);
  });

  it('writes no attachment rows for a message with no attachments (F5)', async () => {
    const fakeA = createFakeClient({
      messages: [{ uid: 3, envelope: { messageId: '<m3@x>' }, bodyStructure: { part: '1', type: 'text/plain' } }],
    });
    const db = createFakeDb();
    const pool = new ConnectionPool([ACCOUNT_A], db, () =>
      new ImapConnection(ACCOUNT_A, () => fakeA.client),
    );

    launch(pool);
    await wait(50);

    expect(db.upserts).toHaveLength(1);
    expect(db.attachmentUpserts).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // F8: the API and the sync loop share one client and must not interleave
  // -------------------------------------------------------------------------

  it('serialises an on-demand API fetch against the account sync cycle (F8)', async () => {
    // The API and the IDLE loop drive the SAME imapflow client. An
    // uncoordinated download breaks IDLE, idleLoop runs its NOOP liveness
    // probe, imapflow queues that NOOP behind the in-flight download, and a
    // download longer than LIVENESS_PROBE_TIMEOUT_MS tears down a perfectly
    // healthy connection mid-transfer. Sharing the per-account key is what
    // makes that interleaving impossible.
    const fakeA = createFakeClient();
    const db = createFakeDb();
    const pool = new ConnectionPool([ACCOUNT_A], db, () =>
      new ImapConnection(ACCOUNT_A, () => fakeA.client),
    );

    launch(pool);
    await wait(50);
    expect(db.budgetRecordCalls.length).toBe(1); // the initial connect-time sync

    let releaseFetch!: () => void;
    const heldFetch = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const inFlight = pool.withAccountLock('a', async () => {
      await heldFetch;
      return 'downloaded';
    });

    // New mail arrives while the "download" is still running. syncOnce
    // takes the same key, so it must queue rather than issue a second
    // command on the same client.
    fakeA.triggerExists();
    await wait(50);
    expect(db.budgetRecordCalls.length).toBe(1);

    releaseFetch();
    await expect(inFlight).resolves.toBe('downloaded');
    await wait(50);
    expect(db.budgetRecordCalls.length).toBe(2);
  });

  it('withAccountLock leaves different accounts fully concurrent (F8)', async () => {
    // Serialising the API against sync must not serialise ten accounts
    // against each other — that is the whole reason the mutex is keyed.
    const fakeA = createFakeClient();
    const fakeB = createFakeClient();
    const db = createFakeDb();
    const pool = new ConnectionPool([ACCOUNT_A, ACCOUNT_B], db, (account) =>
      new ImapConnection(account, () => (account.id === 'a' ? fakeA.client : fakeB.client)),
    );

    launch(pool);
    await wait(50);

    let releaseA!: () => void;
    const heldA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const aLock = pool.withAccountLock('a', () => heldA);
    // b's lock must resolve while a's is still held.
    await expect(pool.withAccountLock('b', async () => 'b-done')).resolves.toBe('b-done');
    releaseA();
    await aLock;
  });

  it('exposes the same ByteBudget instance the sync loop charges (F3/L6)', async () => {
    // The API records its on-demand body/attachment bytes through this
    // accessor. If it handed back a fresh ByteBudget the two would keep
    // separate running totals and the daily ceiling would be enforced
    // against neither.
    // One real message so the header fetch actually charges something —
    // an empty mailbox records a zero and would make this assertion
    // vacuous.
    const fakeA = createFakeClient({ messages: [{ uid: 1, envelope: { messageId: '<m1@x>' } }] });
    const db = createFakeDb();
    const pool = new ConnectionPool([ACCOUNT_A], db, () =>
      new ImapConnection(ACCOUNT_A, () => fakeA.client),
    );

    launch(pool);
    await wait(50);

    const usedAfterSync = await pool.byteBudget.used('a');
    expect(usedAfterSync).toBe(db.budgetRecordCalls.reduce((sum, n) => sum + n, 0));
    expect(usedAfterSync).toBeGreaterThan(0);
  });
});
