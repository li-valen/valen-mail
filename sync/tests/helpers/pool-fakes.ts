import { vi } from 'vitest';
import type { ImapFlow } from 'imapflow';
import { ConnectionPool } from '../../src/imap/pool.ts';
import type { AttachmentInput, Db, MessageInput, SyncStateInput } from '../../src/db';
import type { AccountConfig } from '../../src/config';

/**
 * Shared fakes for the ConnectionPool suites.
 *
 * None of these open a real socket or a live Gmail account. ImapConnection's
 * injectable client factory (Task 5) lets a fake imapflow client stand in
 * everywhere a connection is needed, and ConnectionPool accepts an
 * injectable `createConnection` for the same reason. The pool's own logic —
 * backoff, status transitions, per-account serialisation, stop-safety,
 * attachment persistence — is what the suites exercise, not imapflow or
 * Gmail.
 *
 * Extracted from tests/pool.test.ts so the pool's growing test surface can
 * live in more than one focused file without either copying the fakes or
 * pushing a single file past the project's 800-line ceiling.
 */

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const ACCOUNT_A: AccountConfig = { id: 'a', email: 'a@example.com', appPassword: 'x'.repeat(16), isPrimary: true };
export const ACCOUNT_B: AccountConfig = { id: 'b', email: 'b@example.com', appPassword: 'y'.repeat(16), isPrimary: false };

export interface FakeFetchMessage {
  readonly uid: number;
  readonly size?: number;
  readonly envelope?: Record<string, unknown>;
  readonly bodyStructure?: unknown;
  /** The bytes a PEEK'd partial fetch of this message's text part returns
   *  (Plan 7 Task 1). Absent means the server answers the preview fetch
   *  with no body part for this UID — exactly what a message whose part
   *  vanished between the header fetch and the preview fetch looks like. */
  readonly previewBytes?: Buffer;
}

/** One `client.fetch()` call the fake server saw, recorded so a test can
 *  assert the SHAPE of what sync actually asked for — the header query, the
 *  preview query, the UID set — rather than only its effects. */
export interface FakeFetchCall {
  readonly range: unknown;
  readonly query: Record<string, unknown>;
}

/**
 * One mailbox on the fake server.
 *
 * `specialUse` carries imapflow's REAL shape: a single backslash-prefixed
 * string (`'\\Sent'`, `'\\Junk'`, `'\\Trash'`, and the non-standard
 * `'\\Inbox'`), present only on the one entry imapflow picked as that
 * type's winner, and `undefined` — not `''`, not `[]` — on every ordinary
 * folder. A fake that modelled this as an array, or as the mailbox's whole
 * flag set, would let a discovery implementation pass here that cannot
 * read a real Gmail listing.
 *
 * `messages` is read-only TO THIS FAKE and never copied by it: the test
 * keeps the mutable reference and pushes into it to simulate mail arriving
 * in that specific folder between cycles.
 */
export interface FakeFolder {
  readonly path: string;
  readonly specialUse?: string;
  readonly messages?: readonly FakeFetchMessage[];
  readonly uidValidity?: bigint;
  /** When set, getMailboxLock(path) rejects with it — a mailbox that
   *  fails to SELECT (Trash disabled by policy, folder deleted between
   *  LIST and SELECT), which is how a real per-folder failure presents. */
  readonly openError?: Error;
}

export interface FakeClientOptions {
  readonly connectBehavior?: () => Promise<void>;
  /** If true, every idle() call rejects on the next microtask instead of
   *  hanging — simulates a connection that dies while idling. */
  readonly idleRejectsImmediately?: boolean;
  readonly noopBehavior?: () => Promise<void>;
  /** Messages client.fetch() yields for INBOX. Supplying these also raises
   *  the reported uidNext so resolveUidSpan produces a non-empty span;
   *  without them the mailbox looks empty and fetchHeaders short-circuits.
   *
   *  Shorthand for a single-INBOX server — see `folders` for the
   *  multi-folder form. The two are mutually exclusive; `folders` wins. */
  readonly messages?: readonly FakeFetchMessage[];
  /**
   * The whole mailbox list this fake server reports, for multi-folder
   * tests. Defaults to INBOX alone (carrying `messages`/`uidValidity`
   * above), which is what keeps every pre-Plan-5 test in these suites
   * describing exactly the server it always described: one folder, one
   * fetch per cycle, one budget record per cycle.
   */
  readonly folders?: readonly FakeFolder[];
  /** When set, list() rejects with it — a LIST that fails on an otherwise
   *  authenticated connection. */
  readonly listError?: Error;
  /** Injected between the download starting and its first chunk, so a test
   *  can hold an on-demand fetch open while it observes what else runs. */
  readonly downloadGate?: Promise<void>;
  /** When set, any PREVIEW fetch (a query carrying `bodyParts`) rejects
   *  with it, while header fetches keep working — how a part that fails to
   *  fetch on an otherwise healthy connection presents. */
  readonly previewError?: Error;
  /** Initial UIDVALIDITY the fake mailbox reports. Defaults to 1n. Typed
   *  `bigint`, not `number`, to mirror imapflow's own
   *  `MailboxObject.uidValidity` (imap-flow.d.ts) — fetch.ts reads this
   *  field directly as a bigint (`BigInt(mailbox.uidValidity)` is a
   *  defensive identity conversion, not a widening one), so a fake typed
   *  as `number` here would silently diverge from what production code
   *  actually receives. A test simulating a real UIDVALIDITY change uses
   *  the returned handle's `setUidValidity()` rather than a second
   *  option — a live IMAP server changes this value on an already-open
   *  connection mid-session, not at connect time, so the fake needs to be
   *  mutable the same way `messages` is (see the `mailbox` getter's own
   *  comment on why it recomputes rather than snapshots). */
  readonly uidValidity?: bigint;
}

/**
 * Minimal stand-in for the subset of ImapFlow the pool actually touches:
 * connect/logout/usable (connection lifecycle, mirrors
 * connection-lifecycle.test.ts's fake), idle/noop (Amendment 1's wait and
 * liveness probe), getMailboxLock/mailbox (fetchHeaders, Task 6), and
 * on/removeListener('exists') (the real new-mail wake signal — see
 * waitForIdleWake's own doc comment for why idle() alone can't be it).
 *
 * By default mailbox.uidNext is 1, so resolveUidSpan (fetch.ts) resolves
 * to an empty span and fetchHeaders returns zero messages without this
 * fake needing to yield anything from fetch(). Fetch correctness is Task
 * 6's job, not this suite's. Tests that DO need rows (attachment
 * persistence) pass `messages`, which raises uidNext accordingly.
 */
export function createFakeClient(options: FakeClientOptions = {}) {
  let usable = false;
  let currentIdle: { resolve: () => void } | null = null;
  const existsListeners = new Set<(data: unknown) => void>();
  const downloadCalls: Array<{ uid: string; partId: string | undefined }> = [];

  const connect = vi.fn(async () => {
    if (options.connectBehavior) {
      await options.connectBehavior();
      return;
    }
    usable = true;
  });

  const logout = vi.fn(async () => {
    usable = false;
    // Mirrors real imapflow: tearing down the socket breaks any IDLE that
    // is currently in flight rather than leaving it hanging forever.
    if (currentIdle) {
      currentIdle.resolve();
      currentIdle = null;
    }
  });

  const idle = vi.fn(() => {
    return new Promise<boolean>((resolve, reject) => {
      currentIdle = { resolve: () => resolve(true) };
      if (options.idleRejectsImmediately) {
        Promise.resolve().then(() => reject(new Error('connection reset')));
      }
      // Otherwise: hangs until logout() breaks it or the test calls
      // triggerExists(), exactly like a quiet, healthy IDLE session.
    });
  });

  const noop = vi.fn(async () => {
    if (options.noopBehavior) await options.noopBehavior();
  });

  // One INBOX by default, so a test that says nothing about folders gets
  // exactly the single-folder server these suites have always assumed.
  const folders: readonly FakeFolder[] = options.folders ?? [
    {
      path: 'INBOX',
      specialUse: '\\Inbox',
      // NOT copied — the SAME array the caller passed. Several suites
      // simulate later cycles by pushing into their own reference to it
      // (see the `mailbox` getter's comment); a defensive copy here would
      // silently sever that and make every "a new message arrives" test
      // observe an inbox frozen at its first cycle.
      messages: options.messages ?? [],
      uidValidity: options.uidValidity ?? 1n,
    },
  ];

  interface FolderState {
    readonly path: string;
    readonly specialUse: string | undefined;
    // readonly to this fake, which only ever reads it; the TEST keeps the
    // mutable reference and is what pushes new mail into it.
    readonly messages: readonly FakeFetchMessage[];
    uidValidity: bigint;
    readonly openError: Error | undefined;
  }

  const states = new Map<string, FolderState>(
    folders.map((folder) => [
      folder.path,
      {
        path: folder.path,
        specialUse: folder.specialUse,
        messages: folder.messages ?? [],
        uidValidity: folder.uidValidity ?? 1n,
        openError: folder.openError,
      },
    ]),
  );

  /** Mirrors imapflow: the last SELECTed mailbox stays selected after the
   *  lock is released, and `mailbox` is `false` until one is opened. */
  let selectedPath: string | null = null;
  const openedMailboxes: string[] = [];

  /**
   * Entries in imapflow's real ListResponse shape, not a two-field
   * convenience object. Everything here is a field imapflow genuinely
   * populates, so ImapConnection.listMailboxes() has to pick the right two
   * out of a realistic record rather than out of one built to suit it.
   */
  const list = vi.fn(async () => {
    if (options.listError) throw options.listError;
    return [...states.values()].map((state) => {
      const segments = state.path.split('/');
      return {
        path: state.path,
        pathAsListed: state.path,
        name: segments[segments.length - 1] ?? state.path,
        delimiter: '/',
        parent: segments.slice(0, -1),
        parentPath: segments.slice(0, -1).join('/'),
        flags: new Set<string>(state.specialUse ? [state.specialUse] : []),
        // Absent, not empty-string, on an ordinary folder — exactly as
        // imapflow reports it.
        ...(state.specialUse ? { specialUse: state.specialUse, specialUseSource: 'extension' } : {}),
        listed: true,
        subscribed: true,
      };
    });
  });

  const getMailboxLock = vi.fn(async (path: string) => {
    const state = states.get(path);
    if (!state) throw new Error(`fake imap: no such mailbox "${path}"`);
    if (state.openError) throw state.openError;
    openedMailboxes.push(path);
    selectedPath = path;
    return { path, release: () => {} };
  });

  const selectedState = (): FolderState | null =>
    selectedPath === null ? null : states.get(selectedPath) ?? null;

  const fetchCalls: FakeFetchCall[] = [];

  const fetch = vi.fn(function* fetchImpl(range: unknown, query: Record<string, unknown>) {
    fetchCalls.push({ range, query });

    const messages = selectedState()?.messages ?? [];

    // A query carrying `bodyParts` is a PREVIEW fetch (Plan 7 Task 1), and
    // a real server answers it with body parts, not envelopes. Keyed on the
    // query rather than on a separate fake method so the production code
    // reaches it through the same client.fetch() it uses for headers —
    // which is what lets a test assert the emitted options.
    const bodyParts = query?.bodyParts as
      | readonly { key: string; start?: number; maxLength?: number }[]
      | undefined;

    if (bodyParts && bodyParts.length > 0) {
      if (options.previewError) throw options.previewError;
      const requested = new Set(String(range).split(',').map(Number));
      const partId = bodyParts[0]!.key;
      for (const message of messages) {
        if (!requested.has(message.uid) || message.previewBytes === undefined) continue;
        // imapflow strips the `<0>` partial suffix before building this
        // map, so the key is the part number that was asked for.
        yield { uid: message.uid, bodyParts: new Map([[partId, message.previewBytes]]) };
      }
      return;
    }

    // Yields the SELECTED folder's messages that fall inside the REQUESTED
    // UID RANGE — both halves matter. A cycle that opened Spam must not be
    // handed INBOX's mail, or every per-folder assertion in these suites
    // would be measuring the same array four times; and a fetch that
    // ignored `UID lo:hi` would hand a backfill page of low UIDs the
    // newest messages instead, making every backfill assertion here true
    // for the wrong reason. Live sync's own spans are unaffected: it
    // always asks for the newest HEADER_FETCH_LIMIT, which is a superset
    // of what any of these fakes contain.
    const [lowestUid, highestUid] = String(range).split(':').map(Number);
    for (const message of messages) {
      if (lowestUid !== undefined && message.uid < lowestUid) continue;
      if (highestUid !== undefined && message.uid > highestUid) continue;
      yield message;
    }
  });

  const download = vi.fn(async (uid: string, partId: string | undefined) => {
    downloadCalls.push({ uid, partId });
    const gate = options.downloadGate;
    return {
      content: {
        async *[Symbol.asyncIterator]() {
          if (gate) await gate;
          yield Buffer.from('part-bytes');
        },
      },
    };
  });

  const fake = {
    connect,
    logout,
    idle,
    noop,
    list,
    getMailboxLock,
    fetch,
    download,
    on(event: string, handler: (data: unknown) => void) {
      if (event === 'exists') existsListeners.add(handler);
      return fake;
    },
    removeListener(event: string, handler: (data: unknown) => void) {
      if (event === 'exists') existsListeners.delete(handler);
      return fake;
    },
    get usable() {
      return usable;
    },
    get mailbox() {
      // `false` until something is SELECTed, exactly like imapflow's own
      // `mailbox: MailboxObject | false` — fetch.ts and openMailbox() both
      // branch on that, so a fake that always returned an object would
      // hide a real "opened nothing" bug.
      const state = selectedState();
      if (!state) return false;
      // Recomputed on every access, not snapshotted at creation: a test
      // that pushes a new entry into the SAME `messages` array (to
      // simulate a later cycle seeing genuinely new mail) needs uidNext to
      // reflect it, or resolveUidSpan() would keep computing a span from
      // the stale original highest UID and never fetch the new message.
      const highestUid = state.messages.reduce((max, m) => Math.max(max, m.uid), 0);
      return {
        path: state.path,
        uidValidity: state.uidValidity,
        uidNext: highestUid + 1,
        exists: state.messages.length,
      };
    },
  };

  return {
    client: fake as unknown as ImapFlow,
    connect,
    logout,
    idle,
    noop,
    list,
    download,
    downloadCalls,
    /** Every client.fetch() call, in order, with the range and query it
     *  was given. */
    fetchCalls,
    /** Just the preview fetches — the ones carrying `bodyParts`. */
    previewFetchCalls: (): readonly FakeFetchCall[] =>
      fetchCalls.filter((call) => call.query?.bodyParts !== undefined),
    /** Every getMailboxLock path, in order — the record of which mailboxes
     *  a cycle actually opened and in what sequence. */
    openedMailboxes,
    /** The mailbox left SELECTed right now. Proves where IDLE re-arms
     *  after a multi-folder cycle. */
    selectedMailbox: () => selectedPath,
    triggerExists: () => {
      for (const handler of existsListeners) handler({});
    },
    existsListenerCount: () => existsListeners.size,
    /** Defaults to INBOX so existing single-folder callers are unchanged. */
    setUidValidity: (value: bigint, path = 'INBOX') => {
      const state = states.get(path);
      if (!state) throw new Error(`fake imap: no such mailbox "${path}"`);
      state.uidValidity = value;
    },
  };
}

export interface FakeDb extends Db {
  readonly upserts: MessageInput[];
  readonly attachmentUpserts: AttachmentInput[];
  readonly budgetRecordCalls: number[];
  /** Every (accountId, folder, uids) findUidsWithSnippet was asked about,
   *  so a test can prove the pool consults the store before spending
   *  preview bytes rather than re-fetching every cycle. */
  readonly snippetLookups: Array<{ accountId: string; folder: string; uids: readonly number[] }>;
  seedBytesUsedToday(accountId: string, bytes: number): void;
  /** Marks a (accountId, folder, uid) as already having a preview stored,
   *  which is what a second sync cycle over the same UIDs sees. */
  seedSnippet(accountId: string, folder: string, uid: number): void;
  /**
   * Turns the historical backfill ON for one (account, folder) by clearing
   * this fake's default "already finished" sync-state row — see
   * createFakeDb's own comment for why that is the default.
   */
  seedBackfillPending(accountId: string, folder: string): void;
  /** Writes a sync_state row directly, as a restart would find one. */
  seedSyncState(accountId: string, folder: string, state: SyncStateInput): void;
  /** The sync_state row for one (account, folder) as it stands now — the
   *  backfill watermark and its terminal flag. */
  syncState(accountId: string, folder: string): SyncStateInput | undefined;
}

/**
 * In-memory stand-in for the Db interface. ByteBudget only ever calls
 * query() with two literal statements (select the day's bytes_used, or
 * upsert-add to it); this fake pattern-matches on that literal text rather
 * than parsing SQL, which is enough to exercise Amendment 4's reserve/skip
 * logic without a Postgres connection.
 */
export function createFakeDb(): FakeDb {
  const bytesUsedByKey = new Map<string, number>();
  const upserts: MessageInput[] = [];
  const attachmentUpserts: AttachmentInput[] = [];
  const budgetRecordCalls: number[] = [];
  const snippetLookups: Array<{ accountId: string; folder: string; uids: readonly number[] }> = [];
  const storedSnippets = new Set<string>();
  const syncStates = new Map<string, SyncStateInput>();
  const backfillPending = new Set<string>();

  /**
   * What getSyncState answers for a (account, folder) no test has said
   * anything about: a folder whose historical backfill (Plan 8 Task 1) is
   * already FINISHED, so runBackfillPage returns immediately without
   * fetching, opening a mailbox or charging a byte.
   *
   * That default is what keeps every pre-Plan-8 suite in this directory
   * describing exactly the server it always described — same fetch counts,
   * same budget records, same openedMailboxes sequence — for the same
   * reason `folders` defaults to a single INBOX. "Fully backfilled" is
   * also the real steady state of a deployed account, not a fiction.
   * tests/pool-backfill.test.ts opts in with seedBackfillPending().
   */
  const BACKFILL_ALREADY_DONE: SyncStateInput = {
    uidValidity: null,
    lastSeenUid: 1n,
    backfillDone: true,
  };

  const today = (): string => new Date().toISOString().slice(0, 10);

  return {
    upserts,
    attachmentUpserts,
    budgetRecordCalls,
    snippetLookups,
    seedBytesUsedToday(accountId, bytes) {
      bytesUsedByKey.set(`${accountId}|${today()}`, bytes);
    },
    seedSnippet(accountId, folder, uid) {
      storedSnippets.add(`${accountId}|${folder}|${uid}`);
    },
    seedBackfillPending(accountId, folder) {
      backfillPending.add(`${accountId}|${folder}`);
      syncStates.delete(`${accountId}|${folder}`);
    },
    seedSyncState(accountId, folder, state) {
      backfillPending.add(`${accountId}|${folder}`);
      syncStates.set(`${accountId}|${folder}`, state);
    },
    syncState(accountId, folder) {
      return syncStates.get(`${accountId}|${folder}`);
    },
    async findUidsWithSnippet(accountId, folder, uids) {
      snippetLookups.push({ accountId, folder, uids });
      return new Set(uids.filter((uid) => storedSnippets.has(`${accountId}|${folder}|${uid}`)));
    },
    async applySchema() {},
    async query(text, values = []) {
      if (text.includes('select bytes_used')) {
        const [accountId, day] = values as [string, string];
        return [{ bytes_used: bytesUsedByKey.get(`${accountId}|${day}`) ?? 0 }];
      }
      if (text.includes('insert into byte_budget')) {
        const [accountId, day, bytes] = values as [string, string, number];
        const key = `${accountId}|${day}`;
        bytesUsedByKey.set(key, (bytesUsedByKey.get(key) ?? 0) + bytes);
        budgetRecordCalls.push(bytes);
        return [];
      }
      throw new Error(`fake db: unexpected query: ${text}`);
    },
    async upsertMessage(message) {
      upserts.push(message);
    },
    async upsertAttachment(attachment) {
      attachmentUpserts.push(attachment);
    },
    async getUnifiedInbox() {
      return [];
    },
    async getThread() {
      return [];
    },
    async getOldestSyncedUid(accountId, folder) {
      // min(uid) over the rows this fake has actually stored, which is
      // what Postgres answers too — including `null` for a folder nothing
      // has synced yet.
      const uids = upserts
        .filter((message) => message.accountId === accountId && message.folder === folder)
        .map((message) => message.uid);
      return uids.length === 0 ? null : Math.min(...uids);
    },
    async getSyncState(accountId, folder) {
      const key = `${accountId}|${folder}`;
      return syncStates.get(key) ?? (backfillPending.has(key) ? null : BACKFILL_ALREADY_DONE);
    },
    async setSyncState(accountId, folder, state) {
      syncStates.set(`${accountId}|${folder}`, state);
    },
    async close() {},
  };
}

/**
 * Starts a pool and guarantees it is stopped again, so a test that fails
 * mid-flight cannot leave an account loop reconnecting in the background
 * and leaking timers into the next test.
 */
export function createPoolHarness() {
  let activePool: ConnectionPool | null = null;
  let activeStart: Promise<void> | null = null;

  return {
    launch(pool: ConnectionPool): void {
      activePool = pool;
      activeStart = pool.start();
    },
    /** The pool currently under test, for a test that needs to stop it itself. */
    current(): ConnectionPool | null {
      return activePool;
    },
    started(): Promise<void> | null {
      return activeStart;
    },
    async stop(): Promise<void> {
      if (activePool) await activePool.stop();
      if (activeStart) await activeStart;
      activePool = null;
      activeStart = null;
    },
  };
}
