import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConnectionPool } from '../src/imap/pool';
import { ImapConnection } from '../src/imap/connection';
import type { Db, MessageInput } from '../src/db';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  createFakeClient,
  createFakeDb,
  createPoolHarness,
  wait,
  type FakeFetchMessage,
  type FakeFolder,
} from './helpers/pool-fakes.ts';

/**
 * Plan 5, Task 1 — multi-folder sync.
 *
 * The pool syncs Sent, Spam and Trash alongside INBOX, sequentially on the
 * SAME connection inside the SAME per-account critical section, and
 * notifies for INBOX ONLY. These suites cover the four properties that are
 * genuinely new and could each regress silently:
 *   - every discovered folder is synced, INBOX first, on one connection;
 *   - the cycle ENDS with INBOX selected, so IDLE re-arms on INBOX;
 *   - a Sent/Spam/Trash UID advance produces ZERO dispatch callbacks;
 *   - a non-INBOX folder failing does not kill the cycle, while INBOX
 *     failing still signals connection health.
 *
 * Nothing here opens a socket or touches a live Gmail account.
 */

/** A Gmail-shaped server: INBOX plus the three special-use folders. */
function gmailFolders(messages: {
  inbox?: FakeFetchMessage[];
  sent?: FakeFetchMessage[];
  spam?: FakeFetchMessage[];
  trash?: FakeFetchMessage[];
} = {}): readonly FakeFolder[] {
  return [
    { path: 'INBOX', specialUse: '\\Inbox', messages: messages.inbox ?? [] },
    { path: '[Gmail]/Sent Mail', specialUse: '\\Sent', messages: messages.sent ?? [] },
    { path: '[Gmail]/Spam', specialUse: '\\Junk', messages: messages.spam ?? [] },
    { path: '[Gmail]/Trash', specialUse: '\\Trash', messages: messages.trash ?? [] },
  ];
}

const envelope = (id: string) => ({ messageId: `<${id}@x>`, subject: id });

describe('ConnectionPool — multi-folder sync cycle', () => {
  const harness = createPoolHarness();
  const launch = harness.launch;

  afterEach(async () => {
    await harness.stop();
  });

  it('syncs every discovered folder in one cycle, INBOX first, on the one connection', async () => {
    const fakeA = createFakeClient({
      folders: gmailFolders({
        inbox: [{ uid: 10, envelope: envelope('inbox') }],
        sent: [{ uid: 20, envelope: envelope('sent') }],
        spam: [{ uid: 30, envelope: envelope('spam') }],
        trash: [{ uid: 40, envelope: envelope('trash') }],
      }),
    });
    const db = createFakeDb();
    const pool = new ConnectionPool([ACCOUNT_A], db, () =>
      new ImapConnection(ACCOUNT_A, () => fakeA.client),
    );

    launch(pool);
    await wait(50);

    // Every folder's mail landed, tagged with its OWN folder — not all
    // four under 'INBOX', which is what a loop that forgot to thread
    // `folder` through fetchHeaders would produce.
    expect(db.upserts.map((m) => [m.folder, m.uid])).toEqual([
      ['INBOX', 10],
      ['[Gmail]/Sent Mail', 20],
      ['[Gmail]/Spam', 30],
      ['[Gmail]/Trash', 40],
    ]);

    // INBOX is opened FIRST. It is the folder whose failure signals
    // connection health and the only one that notifies, so it must not sit
    // behind three other SELECTs.
    expect(fakeA.openedMailboxes[0]).toBe('INBOX');

    // One connection, not four: connect() ran exactly once. Gmail's ~15
    // concurrent-connection ceiling is why folders share a connection.
    expect(fakeA.connect).toHaveBeenCalledTimes(1);

    // One budget reserve+record per folder, all against the same account.
    expect(db.budgetRecordCalls).toHaveLength(4);
  });

  /**
   * MUTATION TARGET: delete `await connection.openMailbox(folders.inbox)`
   * at the end of syncOnce's folder loop and this fails — the fake reports
   * '[Gmail]/Trash' as the selected mailbox, because imapflow leaves the
   * last locked mailbox selected after release().
   */
  it('ends the cycle with INBOX selected, so IDLE re-arms on INBOX and not on Trash', async () => {
    const fakeA = createFakeClient({
      folders: gmailFolders({
        inbox: [{ uid: 1, envelope: envelope('i') }],
        sent: [{ uid: 2, envelope: envelope('s') }],
        spam: [{ uid: 3, envelope: envelope('j') }],
        trash: [{ uid: 4, envelope: envelope('t') }],
      }),
    });
    const db = createFakeDb();
    const pool = new ConnectionPool([ACCOUNT_A], db, () =>
      new ImapConnection(ACCOUNT_A, () => fakeA.client),
    );

    launch(pool);
    await wait(50);

    // Trash was genuinely visited last — otherwise "INBOX is selected"
    // would be true for the trivial reason that nothing else ever opened.
    expect(fakeA.openedMailboxes).toContain('[Gmail]/Trash');
    expect(fakeA.openedMailboxes.indexOf('[Gmail]/Trash')).toBeGreaterThan(
      fakeA.openedMailboxes.indexOf('INBOX'),
    );
    // ...and INBOX was re-opened after it, leaving IDLE armed on INBOX.
    expect(fakeA.selectedMailbox()).toBe('INBOX');
    expect(fakeA.openedMailboxes[fakeA.openedMailboxes.length - 1]).toBe('INBOX');
  });

  it('still ends on INBOX when a later folder fails to open', async () => {
    // The unconditional re-open also repairs state after a folder that
    // threw partway through its own SELECT.
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fakeA = createFakeClient({
      folders: [
        { path: 'INBOX', specialUse: '\\Inbox', messages: [{ uid: 1, envelope: envelope('i') }] },
        { path: '[Gmail]/Trash', specialUse: '\\Trash', openError: new Error('SELECT failed') },
      ],
    });
    const db = createFakeDb();
    const pool = new ConnectionPool([ACCOUNT_A], db, () =>
      new ImapConnection(ACCOUNT_A, () => fakeA.client),
    );

    launch(pool);
    await wait(50);

    expect(fakeA.selectedMailbox()).toBe('INBOX');
    expect(pool.status.get('a')).toBe('connected');
    consoleErrorSpy.mockRestore();
  });

  it('discovers folders once per connection rather than once per cycle', async () => {
    const inbox: FakeFetchMessage[] = [{ uid: 1, envelope: envelope('i') }];
    const fakeA = createFakeClient({ folders: gmailFolders({ inbox }) });
    const db = createFakeDb();
    const pool = new ConnectionPool([ACCOUNT_A], db, () =>
      new ImapConnection(ACCOUNT_A, () => fakeA.client),
    );

    launch(pool);
    await wait(50);
    expect(fakeA.list).toHaveBeenCalledTimes(1);

    // Three more wake-driven cycles must not re-LIST: discovery is cached
    // per connection, and a LIST on every IDLE wake would be a needless
    // round trip against Gmail every few minutes forever.
    for (let i = 0; i < 3; i++) {
      inbox.push({ uid: 2 + i, envelope: envelope(`i${i}`) });
      fakeA.triggerExists();
      await wait(30);
    }

    expect(db.budgetRecordCalls.length).toBeGreaterThan(4); // cycles really ran
    expect(fakeA.list).toHaveBeenCalledTimes(1);
  });

  it('syncs only INBOX, without failing, when the server flags no special-use folders', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fakeA = createFakeClient({
      // A server that reports its folders but flags none of them: the
      // names look right, but nothing may be inferred from a name.
      folders: [
        { path: 'INBOX', specialUse: '\\Inbox', messages: [{ uid: 1, envelope: envelope('i') }] },
        { path: '[Gmail]/Sent Mail', messages: [{ uid: 2, envelope: envelope('s') }] },
      ],
    });
    const db = createFakeDb();
    const pool = new ConnectionPool([ACCOUNT_A], db, () =>
      new ImapConnection(ACCOUNT_A, () => fakeA.client),
    );

    launch(pool);
    await wait(50);

    expect(db.upserts.map((m) => m.folder)).toEqual(['INBOX']);
    expect(pool.status.get('a')).toBe('connected');

    const loggedMissing = consoleErrorSpy.mock.calls.some((call) =>
      call.some(
        (arg) =>
          typeof arg === 'string' &&
          arg.includes('"a"') &&
          arg.includes('no special-use folder') &&
          arg.includes('sent'),
      ),
    );
    expect(loggedMissing).toBe(true);
    consoleErrorSpy.mockRestore();
  });

  it('writes each folder\'s attachment rows under that folder, not under INBOX', async () => {
    // attachments has a foreign key onto messages(account_id, folder, uid),
    // so a Sent attachment written under 'INBOX' would violate it outright
    // against a real Postgres.
    const attachmentBody = {
      part: '1',
      type: 'application/pdf',
      disposition: 'attachment',
      dispositionParameters: { filename: 'a.pdf' },
    };
    const fakeA = createFakeClient({
      folders: gmailFolders({
        inbox: [{ uid: 1, envelope: envelope('i'), bodyStructure: attachmentBody }],
        sent: [{ uid: 2, envelope: envelope('s'), bodyStructure: attachmentBody }],
      }),
    });
    const db = createFakeDb();
    const pool = new ConnectionPool([ACCOUNT_A], db, () =>
      new ImapConnection(ACCOUNT_A, () => fakeA.client),
    );

    launch(pool);
    await wait(50);

    expect(db.attachmentUpserts.map((a) => [a.folder, a.uid])).toEqual([
      ['INBOX', 1],
      ['[Gmail]/Sent Mail', 2],
    ]);
  });
});

describe('ConnectionPool — getDiscoveredFolders (Plan 5 Task 2)', () => {
  const harness = createPoolHarness();
  const launch = harness.launch;

  afterEach(async () => {
    await harness.stop();
  });

  it('returns undefined before this account has completed a sync cycle', () => {
    const db = createFakeDb();
    const pool = new ConnectionPool([ACCOUNT_A], db, () =>
      new ImapConnection(ACCOUNT_A, () => createFakeClient().client),
    );

    // Never launched: no LIST has happened for "a" yet.
    expect(pool.getDiscoveredFolders('a')).toBeUndefined();
  });

  it('returns undefined for an account id this pool does not know at all', () => {
    const db = createFakeDb();
    const pool = new ConnectionPool([ACCOUNT_A], db, () =>
      new ImapConnection(ACCOUNT_A, () => createFakeClient().client),
    );

    expect(pool.getDiscoveredFolders('does-not-exist')).toBeUndefined();
  });

  it('exposes each account\'s own discovery once its first cycle has run, keyed by account id', async () => {
    // Two accounts, two genuinely different discoveries — proving this is
    // keyed per account rather than one shared "the last account to sync"
    // value. "a" is Gmail-English-shaped; "b" deliberately is not.
    const fakeA = createFakeClient({
      folders: [
        { path: 'INBOX', specialUse: '\\Inbox', messages: [{ uid: 1, envelope: envelope('i') }] },
        { path: '[Gmail]/Sent Mail', specialUse: '\\Sent' },
        { path: '[Gmail]/Spam', specialUse: '\\Junk' },
        { path: '[Gmail]/Trash', specialUse: '\\Trash' },
      ],
    });
    const fakeB = createFakeClient({
      folders: [
        { path: 'INBOX', specialUse: '\\Inbox', messages: [{ uid: 1, envelope: envelope('i') }] },
        { path: 'Envoyés', specialUse: '\\Sent' },
        { path: 'Indésirables', specialUse: '\\Junk' },
        // No \Trash entry at all for "b" — its Trash was never discovered.
      ],
    });
    const db = createFakeDb();
    const pool = new ConnectionPool([ACCOUNT_A, ACCOUNT_B], db, (account) =>
      new ImapConnection(account, () => (account.id === 'a' ? fakeA.client : fakeB.client)),
    );

    launch(pool);
    await wait(50);

    expect(pool.getDiscoveredFolders('a')).toEqual({
      inbox: 'INBOX', sent: '[Gmail]/Sent Mail', spam: '[Gmail]/Spam', trash: '[Gmail]/Trash',
      archive: null,
    });
    // "b" resolves to its OWN native names — not "a"'s, and not undefined —
    // and a real null (discovered-as-absent), not a missing field, for the
    // one kind its server never flagged.
    expect(pool.getDiscoveredFolders('b')).toEqual({
      inbox: 'INBOX', sent: 'Envoyés', spam: 'Indésirables', trash: null, archive: null,
    });
  });
});

describe('ConnectionPool — a non-INBOX folder failure must not kill the cycle', () => {
  const harness = createPoolHarness();
  const launch = harness.launch;

  afterEach(async () => {
    await harness.stop();
  });

  it('logs and continues past a folder that fails to open, syncing the folders after it', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fakeA = createFakeClient({
      folders: [
        { path: 'INBOX', specialUse: '\\Inbox', messages: [{ uid: 1, envelope: envelope('i') }] },
        // Trash disabled by policy: SELECT fails. It is visited BEFORE
        // spam here only in the sense that spam comes after it in cycle
        // order (sent, spam, trash) — so to prove "continues past", the
        // failing folder must be Sent, which is visited second.
        { path: '[Gmail]/Sent Mail', specialUse: '\\Sent', openError: new Error('SELECT refused') },
        { path: '[Gmail]/Spam', specialUse: '\\Junk', messages: [{ uid: 3, envelope: envelope('j') }] },
        { path: '[Gmail]/Trash', specialUse: '\\Trash', messages: [{ uid: 4, envelope: envelope('t') }] },
      ],
    });
    const db = createFakeDb();
    const pool = new ConnectionPool([ACCOUNT_A], db, () =>
      new ImapConnection(ACCOUNT_A, () => fakeA.client),
    );

    launch(pool);
    await wait(50);

    // The folders AFTER the failing one still synced — the cycle was not
    // abandoned at the first error.
    expect(db.upserts.map((m) => m.folder)).toEqual(['INBOX', '[Gmail]/Spam', '[Gmail]/Trash']);
    // The connection is healthy: a per-folder failure is not a connection
    // failure, so no reconnect ladder and no torn-down socket.
    expect(pool.status.get('a')).toBe('connected');
    expect(fakeA.connect).toHaveBeenCalledTimes(1);

    const loggedFolderFailure = consoleErrorSpy.mock.calls.some((call) =>
      call.some(
        (arg) =>
          typeof arg === 'string' && arg.includes('"a"') && arg.includes('[Gmail]/Sent Mail'),
      ),
    );
    expect(loggedFolderFailure).toBe(true);
    consoleErrorSpy.mockRestore();
  });

  it('still treats an INBOX failure as a connection-health signal', async () => {
    // The complement: "keep going past a folder error" must NOT have
    // swallowed INBOX's error too, or an IMAP-suspended account (AUTH
    // succeeds, SELECT INBOX does not) would sit in a hot loop reporting
    // itself healthy forever.
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fakeA = createFakeClient({
      folders: [
        { path: 'INBOX', specialUse: '\\Inbox', openError: new Error('SELECT INBOX refused') },
        { path: '[Gmail]/Spam', specialUse: '\\Junk', messages: [{ uid: 3, envelope: envelope('j') }] },
      ],
    });
    const db = createFakeDb();
    const pool = new ConnectionPool([ACCOUNT_A], db, () =>
      new ImapConnection(ACCOUNT_A, () => fakeA.client),
    );

    launch(pool);
    await wait(50);

    expect(pool.status.get('a')).toBe('reconnecting');
    // Nothing was stored: the cycle aborted at INBOX rather than carrying
    // on into the other folders on a connection it no longer trusts.
    expect(db.upserts).toHaveLength(0);
    consoleErrorSpy.mockRestore();
  });
});

/**
 * Plan 5's headline notification constraint: the high-water mark becomes
 * per (account, folder), but ONLY INBOX feeds onNewMessages. Sent, Spam
 * and Trash advance their marks silently.
 */
describe('ConnectionPool — notifications are INBOX-only', () => {
  const harness = createPoolHarness();
  const launch = harness.launch;

  afterEach(async () => {
    await harness.stop();
  });

  /**
   * MUTATION TARGET (a): remove the INBOX-only dispatch guard in syncOnce
   * — i.e. replace `newByFolder.get('inbox') ?? []` with every folder's
   * new messages flattened — and this test fails, because spam's uid 31
   * reaches the hook.
   */
  it('fires ZERO callbacks when new mail appears in Spam', async () => {
    const spam: FakeFetchMessage[] = [{ uid: 30, envelope: envelope('spam-old') }];
    const fakeA = createFakeClient({
      folders: gmailFolders({ inbox: [{ uid: 10, envelope: envelope('i') }], spam }),
    });
    const db = createFakeDb();
    const onNewMessages = vi.fn();
    const pool = new ConnectionPool(
      [ACCOUNT_A],
      db,
      () => new ImapConnection(ACCOUNT_A, () => fakeA.client),
      onNewMessages,
    );

    launch(pool);
    await wait(50); // first cycle: every folder baselines, no calls

    expect(onNewMessages).not.toHaveBeenCalled();

    // Gmail files a new spam message. The connection wakes and re-syncs.
    spam.push({ uid: 31, envelope: envelope('spam-new') });
    fakeA.triggerExists();
    await wait(50);

    // Sanity: the spam message really was fetched and stored this cycle,
    // so "zero callbacks" is not true because nothing happened.
    expect(db.upserts.some((m) => m.folder === '[Gmail]/Spam' && m.uid === 31)).toBe(true);
    expect(onNewMessages).not.toHaveBeenCalled();
  });

  it('fires ZERO callbacks when new mail appears in Sent', async () => {
    const sent: FakeFetchMessage[] = [{ uid: 20, envelope: envelope('sent-old') }];
    const fakeA = createFakeClient({
      folders: gmailFolders({ inbox: [{ uid: 10, envelope: envelope('i') }], sent }),
    });
    const db = createFakeDb();
    const onNewMessages = vi.fn();
    const pool = new ConnectionPool(
      [ACCOUNT_A],
      db,
      () => new ImapConnection(ACCOUNT_A, () => fakeA.client),
      onNewMessages,
    );

    launch(pool);
    await wait(50);

    // The user sends a message; it lands in Sent. Buzzing their own phone
    // for their own outgoing mail is the bug this guards.
    sent.push({ uid: 21, envelope: envelope('sent-new') });
    fakeA.triggerExists();
    await wait(50);

    expect(db.upserts.some((m) => m.folder === '[Gmail]/Sent Mail' && m.uid === 21)).toBe(true);
    expect(onNewMessages).not.toHaveBeenCalled();
  });

  it('fires ZERO callbacks when new mail appears in Trash', async () => {
    const trash: FakeFetchMessage[] = [{ uid: 40, envelope: envelope('trash-old') }];
    const fakeA = createFakeClient({
      folders: gmailFolders({ inbox: [{ uid: 10, envelope: envelope('i') }], trash }),
    });
    const db = createFakeDb();
    const onNewMessages = vi.fn();
    const pool = new ConnectionPool(
      [ACCOUNT_A],
      db,
      () => new ImapConnection(ACCOUNT_A, () => fakeA.client),
      onNewMessages,
    );

    launch(pool);
    await wait(50);

    trash.push({ uid: 41, envelope: envelope('trash-new') });
    fakeA.triggerExists();
    await wait(50);

    expect(db.upserts.some((m) => m.folder === '[Gmail]/Trash' && m.uid === 41)).toBe(true);
    expect(onNewMessages).not.toHaveBeenCalled();
  });

  it('still notifies normally for INBOX while the other folders stay silent', async () => {
    // The complement to the three tests above: the guard must not have
    // been implemented as "never notify", which would pass all of them.
    const inbox: FakeFetchMessage[] = [{ uid: 10, envelope: envelope('i-old') }];
    const spam: FakeFetchMessage[] = [{ uid: 30, envelope: envelope('spam-old') }];
    const fakeA = createFakeClient({ folders: gmailFolders({ inbox, spam }) });
    const db = createFakeDb();
    const onNewMessages = vi.fn();
    const pool = new ConnectionPool(
      [ACCOUNT_A],
      db,
      () => new ImapConnection(ACCOUNT_A, () => fakeA.client),
      onNewMessages,
    );

    launch(pool);
    await wait(50);

    // New mail in BOTH inbox and spam on the same cycle: exactly one
    // callback, carrying only the inbox message.
    inbox.push({ uid: 11, envelope: envelope('i-new') });
    spam.push({ uid: 31, envelope: envelope('spam-new') });
    fakeA.triggerExists();
    await wait(50);

    expect(onNewMessages).toHaveBeenCalledTimes(1);
    const [accountId, messages] = onNewMessages.mock.calls[0] as [string, readonly MessageInput[]];
    expect(accountId).toBe('a');
    expect(messages.map((m) => [m.folder, m.uid])).toEqual([['INBOX', 11]]);
  });

  /**
   * The per-folder keying itself, made observable. With ONE mark per
   * account, Sent's uid 900 would move the shared mark past every INBOX
   * uid below it and silence INBOX's genuinely new mail — the exact
   * failure new-mail-marks.ts's markKey() exists to prevent.
   */
  it("a high Sent UID never suppresses INBOX's own new mail", async () => {
    const inbox: FakeFetchMessage[] = [{ uid: 10, envelope: envelope('i-old') }];
    const sent: FakeFetchMessage[] = [{ uid: 900, envelope: envelope('sent-old') }];
    const fakeA = createFakeClient({ folders: gmailFolders({ inbox, sent }) });
    const db = createFakeDb();
    const onNewMessages = vi.fn();
    const pool = new ConnectionPool(
      [ACCOUNT_A],
      db,
      () => new ImapConnection(ACCOUNT_A, () => fakeA.client),
      onNewMessages,
    );

    launch(pool);
    await wait(50);

    // Sent races ahead to 901; INBOX gets uid 11, far below it.
    sent.push({ uid: 901, envelope: envelope('sent-new') });
    inbox.push({ uid: 11, envelope: envelope('i-new') });
    fakeA.triggerExists();
    await wait(50);

    expect(onNewMessages).toHaveBeenCalledTimes(1);
    const [, messages] = onNewMessages.mock.calls[0] as [string, readonly MessageInput[]];
    expect(messages.map((m) => m.uid)).toEqual([11]);
  });

  /**
   * Amendment 3's backfill guard, now per folder: a fresh service start
   * against mailboxes that ALREADY have mail in all four folders must fire
   * nothing at all.
   */
  it('fires zero callbacks on a fresh start against existing mail in every folder', async () => {
    const fakeA = createFakeClient({
      folders: gmailFolders({
        inbox: [{ uid: 10, envelope: envelope('i') }, { uid: 11, envelope: envelope('i2') }],
        sent: [{ uid: 20, envelope: envelope('s') }],
        spam: [{ uid: 30, envelope: envelope('j') }],
        trash: [{ uid: 40, envelope: envelope('t') }],
      }),
    });
    const db = createFakeDb();
    const onNewMessages = vi.fn();
    const pool = new ConnectionPool(
      [ACCOUNT_A],
      db,
      () => new ImapConnection(ACCOUNT_A, () => fakeA.client),
      onNewMessages,
    );

    launch(pool);
    await wait(50);

    // All five pre-existing messages were seen and stored...
    expect(db.upserts).toHaveLength(5);
    // ...and not one of them was reported as new.
    expect(onNewMessages).not.toHaveBeenCalled();
  });

  it('re-baselines only the renumbered folder when its UIDVALIDITY changes', async () => {
    // UIDVALIDITY belongs to one mailbox. Spam being renumbered must not
    // reset INBOX's mark and re-report INBOX's existing mail as new.
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const inbox: FakeFetchMessage[] = [{ uid: 10, envelope: envelope('i-old') }];
    const spam: FakeFetchMessage[] = [{ uid: 30, envelope: envelope('spam-old') }];
    const fakeA = createFakeClient({ folders: gmailFolders({ inbox, spam }) });
    const db = createFakeDb();
    const onNewMessages = vi.fn();
    const pool = new ConnectionPool(
      [ACCOUNT_A],
      db,
      () => new ImapConnection(ACCOUNT_A, () => fakeA.client),
      onNewMessages,
    );

    launch(pool);
    await wait(50);

    // Spam is renumbered from below; INBOX is untouched and gets one new
    // message. INBOX must still notify for exactly that message.
    fakeA.setUidValidity(999n, '[Gmail]/Spam');
    spam.length = 0;
    spam.push({ uid: 1, envelope: envelope('spam-renumbered') });
    inbox.push({ uid: 11, envelope: envelope('i-new') });
    fakeA.triggerExists();
    await wait(50);

    expect(onNewMessages).toHaveBeenCalledTimes(1);
    const [, messages] = onNewMessages.mock.calls[0] as [string, readonly MessageInput[]];
    expect(messages.map((m) => [m.folder, m.uid])).toEqual([['INBOX', 11]]);

    const loggedForSpam = consoleErrorSpy.mock.calls.some((call) =>
      call.some(
        (arg) =>
          typeof arg === 'string' &&
          arg.includes('UIDVALIDITY changed') &&
          arg.includes('[Gmail]/Spam'),
      ),
    );
    expect(loggedForSpam).toBe(true);
    consoleErrorSpy.mockRestore();
  });
});

describe('ConnectionPool — folder sync stays inside the account critical section', () => {
  const harness = createPoolHarness();
  const launch = harness.launch;

  afterEach(async () => {
    await harness.stop();
  });

  it('holds the account lock across ALL folders, not just INBOX', async () => {
    // The hazard: releasing the mutex between folders would let an
    // on-demand API download (withAccountLock) issue a command on the same
    // imapflow client mid-cycle, with the mailbox pointing at Sent rather
    // than the folder the API asked for.
    //
    // Made observable without touching a private field: hold the account
    // lock from outside, then wake the pool. No folder may sync until the
    // lock is released.
    const fakeA = createFakeClient({
      folders: gmailFolders({ inbox: [{ uid: 1, envelope: envelope('i') }] }),
    });
    const db = createFakeDb();
    const pool = new ConnectionPool([ACCOUNT_A], db, () =>
      new ImapConnection(ACCOUNT_A, () => fakeA.client),
    );

    launch(pool);
    await wait(50);
    const recordsAfterFirstCycle = db.budgetRecordCalls.length;
    expect(recordsAfterFirstCycle).toBe(4);

    let releaseHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    const inFlight = pool.withAccountLock('a', () => held);

    fakeA.triggerExists();
    await wait(50);
    // Not one folder got through while the API held the key.
    expect(db.budgetRecordCalls.length).toBe(recordsAfterFirstCycle);

    releaseHeld();
    await inFlight;
    await wait(50);
    // ...and once released, the whole four-folder cycle ran.
    expect(db.budgetRecordCalls.length).toBe(recordsAfterFirstCycle + 4);
  });

  it('skips every folder when the daily byte budget is exhausted', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const base = createFakeDb();
    // Refuse every reservation, whichever folder asks.
    const db: Db = {
      ...base,
      async query(text, values) {
        if (text.includes('select bytes_used')) return [{ bytes_used: Number.MAX_SAFE_INTEGER }];
        return base.query(text, values);
      },
    };
    const fakeA = createFakeClient({
      folders: gmailFolders({
        inbox: [{ uid: 1, envelope: envelope('i') }],
        sent: [{ uid: 2, envelope: envelope('s') }],
      }),
    });
    const pool = new ConnectionPool([ACCOUNT_A], db, () =>
      new ImapConnection(ACCOUNT_A, () => fakeA.client),
    );

    launch(pool);
    await wait(50);

    expect(base.upserts).toHaveLength(0);
    expect(base.budgetRecordCalls).toHaveLength(0);
    // A throttled account is not a broken one.
    expect(pool.status.get('a')).toBe('connected');
    consoleErrorSpy.mockRestore();
  });
});
