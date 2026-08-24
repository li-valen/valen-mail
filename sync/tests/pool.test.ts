import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ImapFlow } from 'imapflow';
import {
  computeBackoffMs,
  MAX_BACKOFF_MS,
  KeyedMutex,
  waitForIdleWake,
  probeLiveness,
  ConnectionPool,
} from '../src/imap/pool';
import { ImapConnection } from '../src/imap/connection';
import { DAILY_BYTE_LIMIT } from '../src/budget';
import type { Db, MessageInput } from '../src/db';
import type { AccountConfig } from '../src/config';

/**
 * None of these tests open a real socket or a live Gmail account.
 * ImapConnection's injectable client factory (Task 5) lets a fake imapflow
 * client stand in everywhere a connection is needed, and ConnectionPool
 * accepts an injectable `createConnection` for the same reason. The pool's
 * own logic — backoff, status transitions, per-account serialisation,
 * stop-safety — is what these tests exercise, not imapflow or Gmail.
 */

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ACCOUNT_A: AccountConfig = { id: 'a', email: 'a@example.com', appPassword: 'x'.repeat(16), isPrimary: true };
const ACCOUNT_B: AccountConfig = { id: 'b', email: 'b@example.com', appPassword: 'y'.repeat(16), isPrimary: false };

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeClientOptions {
  readonly connectBehavior?: () => Promise<void>;
  /** If true, every idle() call rejects on the next microtask instead of
   *  hanging — simulates a connection that dies while idling. */
  readonly idleRejectsImmediately?: boolean;
  readonly noopBehavior?: () => Promise<void>;
}

/**
 * Minimal stand-in for the subset of ImapFlow the pool actually touches:
 * connect/logout/usable (connection lifecycle, mirrors
 * connection-lifecycle.test.ts's fake), idle/noop (Amendment 1's wait and
 * liveness probe), getMailboxLock/mailbox (fetchHeaders, Task 6), and
 * on/removeListener('exists') (the real new-mail wake signal — see
 * waitForIdleWake's own doc comment for why idle() alone can't be it).
 *
 * mailbox.uidNext is fixed at 1 so resolveUidSpan (fetch.ts) always
 * resolves to an empty span: fetchHeaders returns zero messages without
 * this fake needing to implement client.fetch() at all. Fetch correctness
 * is Task 6's job, not this suite's.
 */
function createFakeClient(options: FakeClientOptions = {}) {
  let usable = false;
  let currentIdle: { resolve: () => void } | null = null;
  const existsListeners = new Set<(data: unknown) => void>();

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

  const fake = {
    connect,
    logout,
    idle,
    noop,
    getMailboxLock,
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
      return { path: 'INBOX', uidValidity: 1, uidNext: 1, exists: 0 };
    },
  };

  return {
    client: fake as unknown as ImapFlow,
    connect,
    logout,
    idle,
    noop,
    triggerExists: () => {
      for (const handler of existsListeners) handler({});
    },
    existsListenerCount: () => existsListeners.size,
  };
}

interface FakeDb extends Db {
  readonly upserts: MessageInput[];
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
function createFakeDb(): FakeDb {
  const bytesUsedByKey = new Map<string, number>();
  const upserts: MessageInput[] = [];
  const budgetRecordCalls: number[] = [];

  const today = (): string => new Date().toISOString().slice(0, 10);

  return {
    upserts,
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

// ---------------------------------------------------------------------------
// computeBackoffMs
// ---------------------------------------------------------------------------

describe('computeBackoffMs', () => {
  it('grows with each attempt', () => {
    expect(computeBackoffMs(2)).toBeGreaterThan(computeBackoffMs(1));
    expect(computeBackoffMs(3)).toBeGreaterThan(computeBackoffMs(2));
  });

  it('never exceeds the ceiling', () => {
    for (const attempt of [10, 20, 100]) {
      expect(computeBackoffMs(attempt)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
    }
  });

  it('is always positive', () => {
    for (let attempt = 1; attempt <= 20; attempt++) {
      expect(computeBackoffMs(attempt)).toBeGreaterThan(0);
    }
  });

  it('is jittered — ten accounts must not reconnect in lockstep', () => {
    const samples = new Set(Array.from({ length: 50 }, () => computeBackoffMs(5)));
    // Deterministic backoff would collapse to a single value.
    expect(samples.size).toBeGreaterThan(1);
  });

  it('treats attempt 1 as a short delay, not an immediate retry', () => {
    expect(computeBackoffMs(1)).toBeGreaterThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------
// KeyedMutex (Amendment 2's serialisation primitive)
// ---------------------------------------------------------------------------

describe('KeyedMutex', () => {
  it('serialises calls that share a key', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];

    const first = mutex.run('a', async () => {
      events.push('first-start');
      await wait(20);
      events.push('first-end');
    });
    const second = mutex.run('a', async () => {
      events.push('second-start');
      await wait(5);
      events.push('second-end');
    });

    await Promise.all([first, second]);
    expect(events).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
  });

  it('runs calls with different keys concurrently — accounts must not serialise against each other', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];

    const a = mutex.run('a', async () => {
      events.push('a-start');
      await wait(20);
      events.push('a-end');
    });
    const b = mutex.run('b', async () => {
      events.push('b-start');
      await wait(5);
      events.push('b-end');
    });

    await Promise.all([a, b]);
    // b (shorter, different key) finishes before a despite starting after
    // it — proof the two keys never waited on each other. If this mutex
    // serialised globally, b-end would come after a-end.
    expect(events.indexOf('b-end')).toBeLessThan(events.indexOf('a-end'));
  });

  it('does not wedge the queue for later callers when an earlier task throws', async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.run('a', async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    const result = await mutex.run('a', async () => 'ok');
    expect(result).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// waitForIdleWake (Amendment 1: bounded IDLE wait)
// ---------------------------------------------------------------------------

function createIdleWaitClient(idleImpl: () => Promise<boolean>) {
  const existsListeners = new Set<(data: unknown) => void>();
  const fake = {
    idle: vi.fn(() => idleImpl()),
    on(event: string, handler: (data: unknown) => void) {
      if (event === 'exists') existsListeners.add(handler);
      return fake;
    },
    removeListener(event: string, handler: (data: unknown) => void) {
      if (event === 'exists') existsListeners.delete(handler);
      return fake;
    },
  };
  return {
    client: fake as unknown as ImapFlow,
    triggerExists: () => {
      for (const handler of existsListeners) handler({});
    },
    listenerCount: () => existsListeners.size,
  };
}

describe('waitForIdleWake', () => {
  it('resolves "mail" when the exists event fires before the timeout', async () => {
    const { client, triggerExists } = createIdleWaitClient(() => new Promise<boolean>(() => {}));
    // Deliberately far from vitest's own default per-test timeout: if the
    // 'mail' wiring regressed, this test should fail on a clean assertion
    // once the real timeout fires, not race vitest's runner for which one
    // times out first.
    const promise = waitForIdleWake(client, 300);
    triggerExists();
    await expect(promise).resolves.toBe('mail');
  });

  it('resolves "timeout" when nothing happens before timeoutMs — this is what catches a half-open socket', async () => {
    const { client } = createIdleWaitClient(() => new Promise<boolean>(() => {}));
    await expect(waitForIdleWake(client, 15)).resolves.toBe('timeout');
  });

  it('resolves "idle-ended" when the underlying idle() call settles first', async () => {
    const { client } = createIdleWaitClient(() => Promise.reject(new Error('socket closed')));
    await expect(waitForIdleWake(client, 300)).resolves.toBe('idle-ended');
  });

  it('removes its exists listener once settled, regardless of which branch won', async () => {
    const { client, listenerCount } = createIdleWaitClient(() => new Promise<boolean>(() => {}));
    await waitForIdleWake(client, 10);
    expect(listenerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// probeLiveness (Amendment 1: the cheap round trip on timeout)
// ---------------------------------------------------------------------------

describe('probeLiveness', () => {
  it('resolves when NOOP succeeds', async () => {
    const client = { noop: vi.fn(async () => {}) } as unknown as ImapFlow;
    await expect(probeLiveness(client, 1_000)).resolves.toBeUndefined();
  });

  it('rejects when NOOP itself rejects', async () => {
    const client = { noop: vi.fn(async () => { throw new Error('dead socket'); }) } as unknown as ImapFlow;
    await expect(probeLiveness(client, 1_000)).rejects.toThrow('dead socket');
  });

  it('rejects on its own timeout when NOOP hangs — a half-open socket cannot wedge the probe forever', async () => {
    const client = { noop: vi.fn(() => new Promise<void>(() => {})) } as unknown as ImapFlow;
    await expect(probeLiveness(client, 15)).rejects.toThrow(/timed out/);
  });
});

// ---------------------------------------------------------------------------
// ConnectionPool
// ---------------------------------------------------------------------------

describe('ConnectionPool', () => {
  let activePool: ConnectionPool | null = null;
  let activeStart: Promise<void> | null = null;

  function launch(pool: ConnectionPool): void {
    activePool = pool;
    activeStart = pool.start();
  }

  afterEach(async () => {
    if (activePool) await activePool.stop();
    if (activeStart) await activeStart;
    activePool = null;
    activeStart = null;
  });

  it('connects each configured account and reports "connected" status', async () => {
    const fakeA = createFakeClient();
    const fakeB = createFakeClient();
    const db = createFakeDb();
    const pool = new ConnectionPool([ACCOUNT_A, ACCOUNT_B], db, (account) =>
      new ImapConnection(account, () => (account.id === 'a' ? fakeA.client : fakeB.client)),
    );

    launch(pool);
    await wait(50);

    expect(pool.status.get('a')).toBe('connected');
    expect(pool.status.get('b')).toBe('connected');
    expect(fakeA.connect).toHaveBeenCalledTimes(1);
    expect(fakeB.connect).toHaveBeenCalledTimes(1);
  });

  it('isolates a failing account: one bad password never stops its healthy sibling', async () => {
    const fakeA = createFakeClient({
      connectBehavior: async () => {
        throw new Error('invalid credentials');
      },
    });
    const fakeB = createFakeClient();
    const db = createFakeDb();
    const pool = new ConnectionPool([ACCOUNT_A, ACCOUNT_B], db, (account) =>
      new ImapConnection(account, () => (account.id === 'a' ? fakeA.client : fakeB.client)),
    );

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    launch(pool);
    await wait(50);

    expect(pool.status.get('a')).toBe('reconnecting');
    expect(pool.status.get('b')).toBe('connected');

    // Wait past attempt 1's backoff window (500-1000ms) to prove account
    // "a" actually retries rather than giving up after one failure.
    await wait(1_200);
    expect(fakeA.connect.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(pool.status.get('b')).toBe('connected');

    const loggedAccountA = consoleErrorSpy.mock.calls.some((call) =>
      call.some((arg) => typeof arg === 'string' && arg.includes('"a"')),
    );
    expect(loggedAccountA).toBe(true);
    consoleErrorSpy.mockRestore();
  });

  it('does not let a synchronously-throwing connection factory take down other accounts (Finding 2)', async () => {
    // createConnection is a caller-supplied factory. If its call sat
    // outside runAccount's try/catch, a factory that throws synchronously
    // would escape runAccount entirely, rejecting start()'s Promise.all
    // and terminating that account's loop with no retry at all — exactly
    // the failure this guards against, just triggered by the factory
    // instead of by connect().
    const fakeB = createFakeClient();
    const db = createFakeDb();
    const throwingFactory = vi.fn((account: AccountConfig) => {
      if (account.id === 'a') throw new Error('factory misconfigured');
      return new ImapConnection(account, () => fakeB.client);
    });
    const pool = new ConnectionPool([ACCOUNT_A, ACCOUNT_B], db, throwingFactory);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    launch(pool);
    await wait(50);

    // If the throw escaped runAccount, "a" would never reach the catch
    // block that sets 'reconnecting' — its status would stay unset.
    expect(pool.status.get('a')).toBe('reconnecting');
    expect(pool.status.get('b')).toBe('connected');

    // Wait past attempt 1's backoff window to prove the factory is
    // actually retried, not just called once before the loop died.
    await wait(1_200);
    expect(throwingFactory.mock.calls.filter((call) => call[0].id === 'a').length).toBeGreaterThanOrEqual(2);
    expect(pool.status.get('b')).toBe('connected');

    consoleErrorSpy.mockRestore();
  });

  it('reconnects with backoff when the liveness probe fails after IDLE ends unexpectedly', async () => {
    const fakeA = createFakeClient({
      idleRejectsImmediately: true,
      noopBehavior: async () => {
        throw new Error('socket is dead');
      },
    });
    const fakeB = createFakeClient();
    const db = createFakeDb();
    const pool = new ConnectionPool([ACCOUNT_A, ACCOUNT_B], db, (account) =>
      new ImapConnection(account, () => (account.id === 'a' ? fakeA.client : fakeB.client)),
    );

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    launch(pool);
    await wait(50);

    // First connect succeeded and the first sync ran; then idle() rejected
    // immediately, the liveness probe (noop) failed, and the account
    // dropped into reconnecting — all without touching "b".
    expect(pool.status.get('a')).toBe('reconnecting');
    expect(pool.status.get('b')).toBe('connected');
    expect(fakeA.noop).toHaveBeenCalled();

    await wait(1_200);
    expect(fakeA.connect.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(pool.status.get('b')).toBe('connected');

    consoleErrorSpy.mockRestore();
  });

  it('wakes on new mail and runs another bounded fetch cycle', async () => {
    const fakeA = createFakeClient();
    const db = createFakeDb();
    const pool = new ConnectionPool([ACCOUNT_A], db, () => new ImapConnection(ACCOUNT_A, () => fakeA.client));

    launch(pool);
    await wait(50);

    // The initial connect triggers one sync cycle before IDLE is even entered.
    expect(db.budgetRecordCalls.length).toBe(1);

    fakeA.triggerExists();
    await wait(50);

    expect(db.budgetRecordCalls.length).toBe(2);
    expect(pool.status.get('a')).toBe('connected');
  });

  it('skips the fetch and logs the account id when the daily budget is exhausted (Amendment 4)', async () => {
    const fakeA = createFakeClient();
    const db = createFakeDb();
    db.seedBytesUsedToday('a', DAILY_BYTE_LIMIT);

    const pool = new ConnectionPool([ACCOUNT_A], db, () => new ImapConnection(ACCOUNT_A, () => fakeA.client));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    launch(pool);
    await wait(50);

    // Budget refusal skips the fetch entirely — not "log and continue".
    expect(db.upserts).toHaveLength(0);
    expect(db.budgetRecordCalls).toHaveLength(0);
    // A throttled account is not a broken one: it must stay connected.
    expect(pool.status.get('a')).toBe('connected');

    const loggedSkipForAccountA = consoleErrorSpy.mock.calls.some((call) =>
      call.some(
        (arg) => typeof arg === 'string' && arg.includes('"a"') && arg.includes('budget'),
      ),
    );
    expect(loggedSkipForAccountA).toBe(true);
    consoleErrorSpy.mockRestore();
  });

  it('stop() disconnects every active connection and marks all accounts stopped', async () => {
    const fakeA = createFakeClient();
    const fakeB = createFakeClient();
    const db = createFakeDb();
    const pool = new ConnectionPool([ACCOUNT_A, ACCOUNT_B], db, (account) =>
      new ImapConnection(account, () => (account.id === 'a' ? fakeA.client : fakeB.client)),
    );

    launch(pool);
    await wait(50);
    expect(pool.status.get('a')).toBe('connected');
    expect(pool.status.get('b')).toBe('connected');

    await activePool!.stop();
    await activeStart;
    activePool = null;
    activeStart = null;

    expect(fakeA.logout).toHaveBeenCalledTimes(1);
    expect(fakeB.logout).toHaveBeenCalledTimes(1);
    expect(pool.status.get('a')).toBe('stopped');
    expect(pool.status.get('b')).toBe('stopped');
  });

  it('stop() disconnects a connection that is still mid-connect, without leaking it', async () => {
    // Registration in this.connections happens before connect() is even
    // attempted (see runAccount's comment) specifically so this race is
    // safe: stop() must find and disconnect this instance even though its
    // connect() call has not resolved yet.
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const fakeA = createFakeClient({
      connectBehavior: async () => {
        await connectGate;
      },
    });
    const db = createFakeDb();
    const pool = new ConnectionPool([ACCOUNT_A], db, () => new ImapConnection(ACCOUNT_A, () => fakeA.client));

    launch(pool);
    await wait(20);
    // connect() is in flight; nothing has been marked "connected" yet.
    expect(pool.status.get('a')).not.toBe('connected');

    const stopPromise = activePool!.stop();
    releaseConnect();
    await stopPromise;
    await activeStart;
    activePool = null;
    activeStart = null;

    expect(fakeA.logout).toHaveBeenCalledTimes(1);
    expect(pool.status.get('a')).toBe('stopped');
  });

  it('stop() clears the pending backoff timer instead of leaving it dangling (regression: uncleared setTimeout blocks process exit)', async () => {
    // Asserting the race resolves quickly is not enough on its own — that
    // was already true before this fix, since stopRequested still wins
    // Promise.race immediately. What was missing is that the loser's
    // setTimeout handle was never cleared, so it stayed queued in Node's
    // timer list for up to MAX_BACKOFF_MS after stop() had already
    // returned — invisible to a test that only checks elapsed time, but
    // fatal to a clean process exit under systemd. Fake timers let this
    // test observe the timer queue directly instead of elapsed wall time.
    vi.useFakeTimers();
    try {
      const fakeA = createFakeClient({
        connectBehavior: async () => {
          throw new Error('invalid credentials');
        },
      });
      const db = createFakeDb();
      const pool = new ConnectionPool([ACCOUNT_A], db, () => new ImapConnection(ACCOUNT_A, () => fakeA.client));

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      launch(pool);

      // Let the first (failing) connect() reject and land the account in
      // its backoff sleep. Rejection and the resulting catch block are
      // pure microtask work — advancing fake time by 0ms is enough to
      // flush them without ever firing the backoff timer itself.
      await vi.advanceTimersByTimeAsync(0);
      expect(pool.status.get('a')).toBe('reconnecting');
      expect(vi.getTimerCount()).toBe(1); // exactly the pending backoff timer

      await activePool!.stop();
      await activeStart;
      activePool = null;
      activeStart = null;

      // The regression: this used to stay 1 (the uncleared backoff
      // timer), even though stop() had already resolved.
      expect(vi.getTimerCount()).toBe(0);
      expect(pool.status.get('a')).toBe('stopped');

      consoleErrorSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() resolves promptly even while an account is mid-backoff sleep', async () => {
    const fakeA = createFakeClient({
      connectBehavior: async () => {
        throw new Error('invalid credentials');
      },
    });
    const db = createFakeDb();
    const pool = new ConnectionPool([ACCOUNT_A], db, () => new ImapConnection(ACCOUNT_A, () => fakeA.client));

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    launch(pool);
    // Give the first (failing) connect attempt time to land the account in
    // its backoff sleep (up to 1000ms for attempt 1), without waiting for
    // the sleep to finish on its own.
    await wait(50);
    expect(pool.status.get('a')).toBe('reconnecting');

    const stopStartedAt = Date.now();
    await activePool!.stop();
    await activeStart;
    activePool = null;
    activeStart = null;
    const stopDurationMs = Date.now() - stopStartedAt;

    // computeBackoffMs(1) can be as long as ~1000ms; stop() must not wait
    // that delay out — the interruptible sleep is what makes this fast.
    expect(stopDurationMs).toBeLessThan(500);
    expect(pool.status.get('a')).toBe('stopped');

    consoleErrorSpy.mockRestore();
  });
});
