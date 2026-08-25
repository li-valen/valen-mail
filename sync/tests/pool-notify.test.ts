import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConnectionPool } from '../src/imap/pool';
import { ImapConnection } from '../src/imap/connection';
import type { MessageInput } from '../src/db';
import {
  ACCOUNT_A,
  createFakeClient,
  createFakeDb,
  createPoolHarness,
  wait,
  type FakeFetchMessage,
} from './helpers/pool-fakes.ts';

/**
 * Amendment 3 — the backfill guard, plus the injected-callback contract
 * that makes ConnectionPool safe to wire a push dispatcher into.
 *
 * The pool syncs the newest ~50 UIDs per account on every cycle. Without a
 * guard, the FIRST sync of an account — every process start, since the
 * guard's state is deliberately in-memory (see trackNewMessages's own
 * comment in pool.ts) — would report every one of those pre-existing
 * messages as "new", buzzing for old mail on every configured account
 * simultaneously. The property under test: a fresh service start against
 * an existing (non-empty) mailbox produces ZERO new-mail callback
 * invocations.
 *
 * None of this imports anything from push/ — the callback is a plain
 * function the test controls, proving the pool has no idea what a
 * "notification" is, only that it invokes an injected hook for genuinely
 * new messages and never lets a hook failure become a sync failure.
 */

describe('ConnectionPool — onNewMessages backfill guard and injected-callback contract', () => {
  const harness = createPoolHarness();
  const launch = harness.launch;

  afterEach(async () => {
    await harness.stop();
  });

  it('calls onNewMessages zero times on a fresh start against an existing mailbox (Amendment 3)', async () => {
    const fakeA = createFakeClient({
      messages: [
        { uid: 501, envelope: { messageId: '<m1@x>', subject: 'old 1' } },
        { uid: 502, envelope: { messageId: '<m2@x>', subject: 'old 2' } },
      ],
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

    // Sanity: the cycle actually ran and saw the mailbox's existing mail —
    // otherwise "zero calls" would be true for the wrong reason (nothing
    // synced at all).
    expect(db.upserts.length).toBe(2);
    expect(onNewMessages).not.toHaveBeenCalled();
  });

  it('is byte-identical (no throw, no behaviour change) when no callback is provided, even with existing mail', async () => {
    const fakeA = createFakeClient({
      messages: [{ uid: 501, envelope: { messageId: '<m1@x>' } }],
    });
    const db = createFakeDb();
    const pool = new ConnectionPool([ACCOUNT_A], db, () => new ImapConnection(ACCOUNT_A, () => fakeA.client));

    launch(pool);
    await wait(50);

    expect(pool.status.get('a')).toBe('connected');
    expect(db.upserts.length).toBe(1);
  });

  it('invokes onNewMessages only for messages newer than the account\'s established baseline, on a later cycle', async () => {
    const msgs: FakeFetchMessage[] = [{ uid: 501, envelope: { messageId: '<m1@x>', subject: 'old' } }];
    const fakeA = createFakeClient({ messages: msgs });
    const db = createFakeDb();
    const onNewMessages = vi.fn();
    const pool = new ConnectionPool(
      [ACCOUNT_A],
      db,
      () => new ImapConnection(ACCOUNT_A, () => fakeA.client),
      onNewMessages,
    );

    launch(pool);
    await wait(50); // first cycle: baseline established at uid 501, no call

    expect(onNewMessages).not.toHaveBeenCalled();

    // A genuinely new message arrives — the server would deliver it and
    // fire 'exists'; the fake client's `messages` array is mutated in
    // place (see pool-fakes.ts's dynamic mailbox getter) and the same
    // 'exists' wake is triggered.
    msgs.push({ uid: 502, envelope: { messageId: '<m2@x>', subject: 'new' } });
    fakeA.triggerExists();
    await wait(50);

    expect(onNewMessages).toHaveBeenCalledTimes(1);
    const [accountId, messages] = onNewMessages.mock.calls[0] as [string, readonly MessageInput[]];
    expect(accountId).toBe('a');
    expect(messages.map((m) => m.uid)).toEqual([502]);
  });

  it('does not re-invoke onNewMessages for the same UIDs on a repeated poll (no notification storm)', async () => {
    const msgs: FakeFetchMessage[] = [{ uid: 501, envelope: { messageId: '<m1@x>' } }];
    const fakeA = createFakeClient({ messages: msgs });
    const db = createFakeDb();
    const onNewMessages = vi.fn();
    const pool = new ConnectionPool(
      [ACCOUNT_A],
      db,
      () => new ImapConnection(ACCOUNT_A, () => fakeA.client),
      onNewMessages,
    );

    launch(pool);
    await wait(50); // first cycle: baseline set, no call

    msgs.push({ uid: 502, envelope: { messageId: '<m2@x>' } });
    fakeA.triggerExists();
    await wait(50); // second cycle: uid 502 is new, one call

    expect(onNewMessages).toHaveBeenCalledTimes(1);

    // A liveness-timeout-triggered re-poll (or any repeat) re-fetches the
    // SAME 50 newest UIDs, uid 501 and 502 both included, with nothing new
    // added. It must not call onNewMessages again for messages already
    // reported.
    fakeA.triggerExists();
    await wait(50);

    expect(onNewMessages).toHaveBeenCalledTimes(1);
  });

  it('logs and continues when the onNewMessages callback throws — a dispatch failure must never break mail sync', async () => {
    const msgs: FakeFetchMessage[] = [{ uid: 501, envelope: { messageId: '<m1@x>' } }];
    const fakeA = createFakeClient({ messages: msgs });
    const db = createFakeDb();
    const onNewMessages = vi.fn(() => {
      throw new Error('push dispatch boom');
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pool = new ConnectionPool(
      [ACCOUNT_A],
      db,
      () => new ImapConnection(ACCOUNT_A, () => fakeA.client),
      onNewMessages,
    );

    launch(pool);
    await wait(50); // first cycle: baseline set, callback not yet invoked

    msgs.push({ uid: 502, envelope: { messageId: '<m2@x>' } });
    fakeA.triggerExists();
    await wait(50); // second cycle: callback invoked and throws

    expect(onNewMessages).toHaveBeenCalledTimes(1);
    // The account must still be healthy: a hook failure is NOT treated as
    // a sync/connection failure. If it were caught by runAccount()'s
    // outer catch instead of inside syncOnce, this account would have
    // been marked 'reconnecting' and its backoff ladder corrupted over a
    // fault that has nothing to do with IMAP.
    expect(pool.status.get('a')).toBe('connected');
    const loggedHookFailure = consoleErrorSpy.mock.calls.some((call) =>
      call.some(
        (arg) => typeof arg === 'string' && arg.includes('"a"') && arg.includes('notification hook failed'),
      ),
    );
    expect(loggedHookFailure).toBe(true);

    // Sync must keep working after the hook failure: a further genuinely
    // new message on a later cycle is still picked up and stored.
    msgs.push({ uid: 503, envelope: { messageId: '<m3@x>' } });
    fakeA.triggerExists();
    await wait(50);
    expect(db.upserts.some((m) => m.uid === 503)).toBe(true);

    consoleErrorSpy.mockRestore();
  });

  it('handles an async callback rejection the same way as a synchronous throw', async () => {
    const msgs: FakeFetchMessage[] = [{ uid: 501, envelope: { messageId: '<m1@x>' } }];
    const fakeA = createFakeClient({ messages: msgs });
    const db = createFakeDb();
    const onNewMessages = vi.fn(async () => {
      throw new Error('async push boom');
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pool = new ConnectionPool(
      [ACCOUNT_A],
      db,
      () => new ImapConnection(ACCOUNT_A, () => fakeA.client),
      onNewMessages,
    );

    launch(pool);
    await wait(50);

    msgs.push({ uid: 502, envelope: { messageId: '<m2@x>' } });
    fakeA.triggerExists();
    await wait(50);

    expect(onNewMessages).toHaveBeenCalledTimes(1);
    expect(pool.status.get('a')).toBe('connected');
    consoleErrorSpy.mockRestore();
  });
});
