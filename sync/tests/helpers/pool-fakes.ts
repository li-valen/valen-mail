import { vi } from 'vitest';
import type { ImapFlow } from 'imapflow';
import { ConnectionPool } from '../../src/imap/pool.ts';
import type { AttachmentInput, Db, MessageInput } from '../../src/db';
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
}

export interface FakeClientOptions {
  readonly connectBehavior?: () => Promise<void>;
  /** If true, every idle() call rejects on the next microtask instead of
   *  hanging — simulates a connection that dies while idling. */
  readonly idleRejectsImmediately?: boolean;
  readonly noopBehavior?: () => Promise<void>;
  /** Messages client.fetch() yields. Supplying these also raises the
   *  reported uidNext so resolveUidSpan produces a non-empty span; without
   *  them the mailbox looks empty and fetchHeaders short-circuits. */
  readonly messages?: readonly FakeFetchMessage[];
  /** Injected between the download starting and its first chunk, so a test
   *  can hold an on-demand fetch open while it observes what else runs. */
  readonly downloadGate?: Promise<void>;
  /** Initial UIDVALIDITY the fake mailbox reports. Defaults to 1. A test
   *  simulating a real UIDVALIDITY change uses the returned handle's
   *  `setUidValidity()` rather than a second option — a live IMAP server
   *  changes this value on an already-open connection mid-session, not at
   *  connect time, so the fake needs to be mutable the same way `messages`
   *  is (see the `mailbox` getter's own comment on why it recomputes
   *  rather than snapshots). */
  readonly uidValidity?: number;
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

  const getMailboxLock = vi.fn(async () => ({ release: () => {} }));

  const messages = options.messages ?? [];
  let uidValidity = options.uidValidity ?? 1;

  const fetch = vi.fn(function* fetchImpl() {
    for (const message of messages) yield message;
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
      // Recomputed on every access, not snapshotted at creation: a test
      // that pushes a new entry into the SAME `messages` array (to
      // simulate a later cycle seeing genuinely new mail) needs uidNext to
      // reflect it, or resolveUidSpan() would keep computing a span from
      // the stale original highest UID and never fetch the new message.
      const highestUid = messages.reduce((max, m) => Math.max(max, m.uid), 0);
      return { path: 'INBOX', uidValidity, uidNext: highestUid + 1, exists: messages.length };
    },
  };

  return {
    client: fake as unknown as ImapFlow,
    connect,
    logout,
    idle,
    noop,
    download,
    downloadCalls,
    triggerExists: () => {
      for (const handler of existsListeners) handler({});
    },
    existsListenerCount: () => existsListeners.size,
    setUidValidity: (value: number) => {
      uidValidity = value;
    },
  };
}

export interface FakeDb extends Db {
  readonly upserts: MessageInput[];
  readonly attachmentUpserts: AttachmentInput[];
  readonly budgetRecordCalls: number[];
  seedBytesUsedToday(accountId: string, bytes: number): void;
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

  const today = (): string => new Date().toISOString().slice(0, 10);

  return {
    upserts,
    attachmentUpserts,
    budgetRecordCalls,
    seedBytesUsedToday(accountId, bytes) {
      bytesUsedByKey.set(`${accountId}|${today()}`, bytes);
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
    async getSyncState() {
      return null;
    },
    async setSyncState() {},
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
