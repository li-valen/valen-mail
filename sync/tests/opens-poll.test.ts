import { describe, it, expect, vi, afterEach } from 'vitest';
import { createOpensPoll, OPENS_POLL_INTERVAL_MS } from '../src/push/opens-poll';
import type { OpenEvent } from '../src/api/opens';
import type { TrackingConfig } from '../src/config';
import type { VapidConfig } from '../src/push/vapid';
import type { SendImpl } from '../src/push/send';
import { makeFakeDb } from './helpers/api-fakes.ts';

/**
 * The opens poll: reuses `fetchOpens` (../src/api/opens.ts, Task 2) rather
 * than a second tracking-service client, persists its last-seen
 * `occurredAt` through the existing `sync_state` table pattern (Plan 2),
 * and mirrors Amendment 3's backfill principle for its own first-ever run.
 *
 * Every test injects `fetchImpl` (the exact seam `fetchOpens` itself
 * exposes) and `sendImpl` (the seam `notifyOpens`/`sendPush` expose) —
 * nothing here makes a real network call.
 */

const VAPID: VapidConfig = { publicKey: 'pub', privateKey: 'priv', subject: 'https://postbox.example' };
const TRACKING: TrackingConfig = { baseUrl: 'https://t.example', readToken: 'r'.repeat(32) };

function makeOpenEvent(overrides: Partial<OpenEvent> = {}): OpenEvent {
  return {
    token: 'tok-1',
    recipientEmail: 'a@b.com',
    subject: 'hi',
    sentAt: 1_756_000_000_000,
    occurredAt: 1_756_000_100_000,
    classification: 'open',
    deviceClass: null,
    os: null,
    ...overrides,
  };
}

function fetchStubReturning(opens: readonly OpenEvent[], status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ opens }), { status, headers: { 'content-type': 'application/json' } }),
  ) as unknown as typeof fetch;
}

function failingFetchStub(): typeof fetch {
  return vi.fn(async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
}

/** In-memory stand-in for the ONE sync_state row this poll reads/writes,
 *  shared across however many `createOpensPoll` calls a test makes — this
 *  is what lets a test simulate "the process restarted" honestly: a
 *  second poll instance reading the SAME persisted row a first instance
 *  already wrote to, exactly as a real restart would read the same
 *  Postgres row a previous process wrote. */
function makeSharedSyncStateDb() {
  const rows = new Map<string, { uidValidity: bigint | null; lastSeenUid: bigint; backfillDone: boolean }>();
  const subscriptions: Array<{ endpoint: string; p256dh: string; auth: string }> = [
    { endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' },
  ];

  return makeFakeDb({
    query: async (text: string) => {
      if (text.includes('select endpoint')) return subscriptions;
      if (text.includes('delete from push_subscriptions')) return [];
      throw new Error(`unexpected query: ${text}`);
    },
    getSyncState: async (accountId: string, folder: string) => rows.get(`${accountId}|${folder}`) ?? null,
    setSyncState: async (accountId: string, folder: string, state: unknown) => {
      rows.set(`${accountId}|${folder}`, state as { uidValidity: bigint | null; lastSeenUid: bigint; backfillDone: boolean });
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createOpensPoll — first-ever run', () => {
  it('does not notify on the very first run — establishes the baseline at the newest existing event instead', async () => {
    const db = makeSharedSyncStateDb();
    const sendImpl = vi.fn(async () => ({ statusCode: 201 }));
    const fetchImpl = fetchStubReturning([
      makeOpenEvent({ token: 'a', occurredAt: 100 }),
      makeOpenEvent({ token: 'b', occurredAt: 200 }),
    ]);
    const poll = createOpensPoll(db, VAPID, TRACKING, { fetchImpl, sendImpl: sendImpl as unknown as SendImpl });

    await poll.tick();

    expect(sendImpl).not.toHaveBeenCalled();
  });

  /**
   * Mutation check target: if the "first-ever run" special case were
   * deleted (i.e. every tick just filtered by `occurredAt > (lastSeen ??
   * -Infinity)`), the very first tick against an existing backlog would
   * notify for ALL of it. This test's own inverse — deleting the guard —
   * is exercised in the report.
   */
  it('a later tick only notifies for events strictly newer than the established baseline', async () => {
    const db = makeSharedSyncStateDb();
    const sendImpl = vi.fn(async () => ({ statusCode: 201 }));
    const poll = createOpensPoll(db, VAPID, TRACKING, {
      fetchImpl: fetchStubReturning([makeOpenEvent({ token: 'a', occurredAt: 100 })]),
      sendImpl: sendImpl as unknown as SendImpl,
    });
    await poll.tick(); // first-ever run: baseline set to 100, no notify

    const poll2 = createOpensPoll(db, VAPID, TRACKING, {
      fetchImpl: fetchStubReturning([
        makeOpenEvent({ token: 'a', occurredAt: 100 }),
        makeOpenEvent({ token: 'b', occurredAt: 200 }),
      ]),
      sendImpl: sendImpl as unknown as SendImpl,
    });
    await poll2.tick();

    expect(sendImpl).toHaveBeenCalledTimes(1);
  });
});

describe('createOpensPoll — restart safety (persisted last-seen)', () => {
  /**
   * This is the test that actually proves a restart does not re-notify —
   * not just calling the function twice on the SAME instance (which would
   * pass even if the poll cached last-seen only in memory and never wrote
   * it to `db` at all). Two SEPARATE `createOpensPoll` instances share one
   * underlying db-backed row, exactly mirroring one process writing
   * sync_state and a second process (after a restart) reading it back.
   */
  it('a second poll instance, sharing only the db, does not re-notify events the first instance already saw', async () => {
    const db = makeSharedSyncStateDb();
    const sent1: string[] = [];
    const firstPoll = createOpensPoll(db, VAPID, TRACKING, {
      fetchImpl: fetchStubReturning([makeOpenEvent({ token: 'seed', occurredAt: 50 })]),
      sendImpl: (async () => ({ statusCode: 201 })) as unknown as SendImpl,
    });
    await firstPoll.tick(); // first-ever run, baseline = 50, no notify

    const secondPollSend = vi.fn(async (_sub: unknown, payload: string) => {
      sent1.push(payload);
      return { statusCode: 201 };
    });
    const secondPoll = createOpensPoll(db, VAPID, TRACKING, {
      fetchImpl: fetchStubReturning([
        makeOpenEvent({ token: 'seed', occurredAt: 50 }),
        makeOpenEvent({ token: 'fresh', occurredAt: 150 }),
      ]),
      sendImpl: secondPollSend as unknown as SendImpl,
    });
    await secondPoll.tick(); // reads persisted lastSeen=50 from the SAME db

    expect(sent1).toHaveLength(1);
    expect(sent1[0]).toContain('a@b.com'); // sanity: it's a real payload, not empty

    // A THIRD instance ("restart" again) must not re-notify either of the
    // two events already seen.
    const thirdSend = vi.fn(async () => ({ statusCode: 201 }));
    const thirdPoll = createOpensPoll(db, VAPID, TRACKING, {
      fetchImpl: fetchStubReturning([
        makeOpenEvent({ token: 'seed', occurredAt: 50 }),
        makeOpenEvent({ token: 'fresh', occurredAt: 150 }),
      ]),
      sendImpl: thirdSend as unknown as SendImpl,
    });
    await thirdPoll.tick();

    expect(thirdSend).not.toHaveBeenCalled();
  });
});

describe('createOpensPoll — down-state logging', () => {
  it('logs once when the tracking service goes down, not on every failed tick', async () => {
    const db = makeSharedSyncStateDb();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const poll = createOpensPoll(db, VAPID, TRACKING, {
      fetchImpl: failingFetchStub(),
      sendImpl: (async () => ({ statusCode: 201 })) as unknown as SendImpl,
    });

    await poll.tick();
    await poll.tick();
    await poll.tick();

    const downLines = errorSpy.mock.calls.filter((call) =>
      call.some((arg) => typeof arg === 'string' && arg.toLowerCase().includes('down')),
    );
    expect(downLines).toHaveLength(1);
  });

  it('logs once when the tracking service recovers', async () => {
    const db = makeSharedSyncStateDb();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // The SAME poll instance sees a failing fetch on the first two ticks,
    // then a working one — `wasUp` is per-instance state, so the
    // transition has to be observed within one instance's lifetime, the
    // same as a real long-running process.
    let failing = true;
    const fetchImpl = vi.fn(async () => {
      if (failing) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify({ opens: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const poll = createOpensPoll(db, VAPID, TRACKING, {
      fetchImpl,
      sendImpl: (async () => ({ statusCode: 201 })) as unknown as SendImpl,
    });

    await poll.tick();
    await poll.tick();
    failing = false;
    await poll.tick();

    const upLines = errorSpy.mock.calls.filter((call) =>
      call.some((arg) => typeof arg === 'string' && arg.toLowerCase().includes('back up')),
    );
    expect(upLines).toHaveLength(1);
  });

  it('does not log a down-state line when the very first tick succeeds', async () => {
    const db = makeSharedSyncStateDb();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const poll = createOpensPoll(db, VAPID, TRACKING, {
      fetchImpl: fetchStubReturning([]),
      sendImpl: (async () => ({ statusCode: 201 })) as unknown as SendImpl,
    });
    await poll.tick();

    const stateLines = errorSpy.mock.calls.filter((call) =>
      call.some(
        (arg) => typeof arg === 'string' && (arg.toLowerCase().includes('down') || arg.toLowerCase().includes('back up')),
      ),
    );
    expect(stateLines).toHaveLength(0);
  });
});

describe('createOpensPoll — notification filtering', () => {
  it('only dispatches for confirmed opens, reusing notifyOpens\'s own shouldNotifyOpen rule', async () => {
    const db = makeSharedSyncStateDb();
    const sendImpl = vi.fn(async () => ({ statusCode: 201 }));
    const seedPoll = createOpensPoll(db, VAPID, TRACKING, {
      fetchImpl: fetchStubReturning([]),
      sendImpl: sendImpl as unknown as SendImpl,
    });
    await seedPoll.tick(); // establish baseline at "nothing yet" (lastSeen null -> no events -> no write, still null)

    const poll = createOpensPoll(db, VAPID, TRACKING, {
      fetchImpl: fetchStubReturning([
        makeOpenEvent({ token: 'a', occurredAt: 10, classification: 'open' }),
        makeOpenEvent({ token: 'b', occurredAt: 20, classification: 'mpp' }),
      ]),
      sendImpl: sendImpl as unknown as SendImpl,
    });
    await poll.tick();

    expect(sendImpl).toHaveBeenCalledTimes(1);
  });
});

describe('createOpensPoll — start/stop cadence', () => {
  it('polls immediately on start, then again every OPENS_POLL_INTERVAL_MS', async () => {
    vi.useFakeTimers();
    try {
      const db = makeSharedSyncStateDb();
      const fetchImpl = fetchStubReturning([]);
      const poll = createOpensPoll(db, VAPID, TRACKING, {
        fetchImpl,
        sendImpl: (async () => ({ statusCode: 201 })) as unknown as SendImpl,
      });

      poll.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(OPENS_POLL_INTERVAL_MS);
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      await poll.stop();
      await vi.advanceTimersByTimeAsync(OPENS_POLL_INTERVAL_MS * 3);
      expect(fetchImpl).toHaveBeenCalledTimes(2); // no further calls after stop()
    } finally {
      vi.useRealTimers();
    }
  });

  it('start() twice does not create two overlapping timers', async () => {
    vi.useFakeTimers();
    try {
      const db = makeSharedSyncStateDb();
      const fetchImpl = fetchStubReturning([]);
      const poll = createOpensPoll(db, VAPID, TRACKING, {
        fetchImpl,
        sendImpl: (async () => ({ statusCode: 201 })) as unknown as SendImpl,
      });

      poll.start();
      poll.start();
      await vi.advanceTimersByTimeAsync(0);
      const afterStart = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length;

      await vi.advanceTimersByTimeAsync(OPENS_POLL_INTERVAL_MS);
      expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBe(afterStart + 1);

      await poll.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
