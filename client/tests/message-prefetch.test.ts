import { describe, expect, it, vi, afterEach } from 'vitest';
import type { ParsedMessage } from '../src/api';
import { MessageCache } from '../src/messageCache';
import type { MessageTarget } from '../src/messageCache';
import { MAX_IN_FLIGHT, MAX_QUEUED, MessagePrefetcher } from '../src/messagePrefetch';

/**
 * Speculative prefetching — and the three ways it could quietly go wrong.
 *
 *  1. It could spend the user's daily IMAP byte budget on guesses. The
 *     concurrency cap and the queue bound are what stop that, and both
 *     are asserted here rather than assumed from reading the constants.
 *  2. It could outlive the guess. `cancelAll` has to actually abort the
 *     request, not merely stop caring about it.
 *  3. It could land LATE and populate a view the user already left. An
 *     abort cannot un-resolve a fetch that has already settled, so the
 *     generation guard is the half that makes a late arrival harmless —
 *     and a test that only checked `abort()` would pass without it.
 */

function messageOf(html: string): ParsedMessage {
  return {
    html,
    text: null,
    subject: null,
    from: null,
    to: [],
    cc: [],
    date: null,
    attachments: [],
  };
}

function targetAt(uid: number): MessageTarget {
  return { account_id: 'primary', folder: 'INBOX', uid: String(uid) };
}

/** A fetch stand-in that resolves nothing until the test says so, and
 *  records the AbortSignal each call was handed. */
function deferredFetch() {
  const signals: AbortSignal[] = [];
  const resolvers: Array<(message: ParsedMessage) => void> = [];
  const rejecters: Array<(error: unknown) => void> = [];
  const targets: MessageTarget[] = [];

  const fetchImpl = vi.fn((target: MessageTarget, signal?: AbortSignal) => {
    targets.push(target);
    if (signal !== undefined) signals.push(signal);
    return new Promise<ParsedMessage>((resolve, reject) => {
      resolvers.push(resolve);
      rejecters.push(reject);
    });
  });

  return { fetchImpl, signals, resolvers, rejecters, targets };
}

/** Lets every already-settled promise's `.then` run. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MessagePrefetcher / warming the cache', () => {
  it('fetches a target and caches what comes back', async () => {
    const cache = new MessageCache();
    const { fetchImpl, resolvers } = deferredFetch();
    const prefetcher = new MessagePrefetcher({ cache, fetchImpl });

    prefetcher.prefetch(targetAt(1));
    expect(prefetcher.inFlight).toBe(1);

    const message = messageOf('<p>warm</p>');
    resolvers[0]!(message);
    await flush();

    expect(cache.get(targetAt(1))).toBe(message);
    expect(prefetcher.inFlight).toBe(0);
  });

  it('does nothing at all for something already cached', () => {
    const cache = new MessageCache();
    cache.set(targetAt(1), messageOf('<p>already</p>'));
    const { fetchImpl } = deferredFetch();

    new MessagePrefetcher({ cache, fetchImpl }).prefetch(targetAt(1));

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('collapses repeat asks for the same target while one is in flight', () => {
    // A pointer resting on a row fires `pointerenter` more than once in
    // practice; the handler must be safe to call on every one.
    const { fetchImpl } = deferredFetch();
    const prefetcher = new MessagePrefetcher({ cache: new MessageCache(), fetchImpl });

    prefetcher.prefetch(targetAt(1));
    prefetcher.prefetch(targetAt(1));
    prefetcher.prefetch(targetAt(1));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('MessagePrefetcher / bounds', () => {
  it('runs no more than the cap at once', () => {
    const { fetchImpl } = deferredFetch();
    const prefetcher = new MessagePrefetcher({ cache: new MessageCache(), fetchImpl, maxInFlight: 2 });

    for (let uid = 1; uid <= 6; uid += 1) prefetcher.prefetch(targetAt(uid));

    // Every guess competes with the request the user is actually waiting
    // for, over the same connection — six at once would make the open
    // slower than no prefetching at all.
    expect(prefetcher.inFlight).toBe(2);
  });

  it('starts the next one only as a slot frees up', async () => {
    const cache = new MessageCache();
    const { fetchImpl, resolvers } = deferredFetch();
    const prefetcher = new MessagePrefetcher({ cache, fetchImpl, maxInFlight: 1, maxQueued: 4 });

    prefetcher.prefetch(targetAt(1));
    prefetcher.prefetch(targetAt(2));
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    resolvers[0]!(messageOf('one'));
    await flush();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('bounds the queue, dropping the OLDEST guesses rather than the newest', () => {
    // A pointer sweeping down a 50-row list must not enqueue fifty
    // guesses. And the ones worth keeping are the most recent: the row
    // the pointer is on now, not the one it left three rows ago.
    const { fetchImpl, targets } = deferredFetch();
    const prefetcher = new MessagePrefetcher({
      cache: new MessageCache(),
      fetchImpl,
      maxInFlight: 1,
      maxQueued: 2,
    });

    for (let uid = 1; uid <= 10; uid += 1) prefetcher.prefetch(targetAt(uid));

    expect(prefetcher.queued).toBeLessThanOrEqual(2);
    // Only the first ever started; the queue holds the newest asks.
    expect(targets.map((target) => target.uid)).toEqual(['1']);
  });

  it('publishes a conservative cap and a short queue', () => {
    expect(MAX_IN_FLIGHT).toBeLessThanOrEqual(2);
    expect(MAX_IN_FLIGHT).toBeGreaterThanOrEqual(1);
    expect(MAX_QUEUED).toBeLessThanOrEqual(8);
  });
});

describe('MessagePrefetcher / navigation cancels a guess', () => {
  it('aborts every request still on the wire', () => {
    const { fetchImpl, signals } = deferredFetch();
    const prefetcher = new MessagePrefetcher({ cache: new MessageCache(), fetchImpl, maxInFlight: 2 });

    prefetcher.prefetch(targetAt(1));
    prefetcher.prefetch(targetAt(2));
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);

    prefetcher.cancelAll();

    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(prefetcher.inFlight).toBe(0);
  });

  it('empties the queue too, so a freed slot does not start a stale guess', async () => {
    const { fetchImpl } = deferredFetch();
    const prefetcher = new MessagePrefetcher({ cache: new MessageCache(), fetchImpl, maxInFlight: 1 });

    prefetcher.prefetch(targetAt(1));
    prefetcher.prefetch(targetAt(2));
    expect(prefetcher.queued).toBe(1);

    prefetcher.cancelAll();
    await flush();

    expect(prefetcher.queued).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a LATE prefetch cannot populate the superseded view', async () => {
    // THE case an `abort()` alone does not cover: the fetch had already
    // resolved and its `.then` was sitting in the microtask queue when
    // the user navigated. Aborting cannot un-resolve it, so without the
    // generation guard this response would be written into the cache —
    // spending the cache's bytes on the folder the user just left, and
    // evicting the one they went to.
    //
    // MUTATION: delete the `issuedAt !== this.generation` check in
    // `start`'s success branch and this line fails.
    const cache = new MessageCache();
    const { fetchImpl, resolvers } = deferredFetch();
    const prefetcher = new MessagePrefetcher({ cache, fetchImpl });

    prefetcher.prefetch(targetAt(1));
    prefetcher.cancelAll();
    resolvers[0]!(messageOf('<p>too late</p>'));
    await flush();

    expect(cache.get(targetAt(1))).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('a late FAILURE cannot poison the new view either', async () => {
    // The rejection path has the same guard for the same reason: marking
    // a key failed on behalf of a view nobody is looking at would
    // suppress a legitimate prefetch of it later.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cache = new MessageCache();
    const { fetchImpl, rejecters, resolvers } = deferredFetch();
    const prefetcher = new MessagePrefetcher({ cache, fetchImpl });

    prefetcher.prefetch(targetAt(1));
    prefetcher.cancelAll();
    rejecters[0]!(new Error('502'));
    await flush();
    expect(errors).not.toHaveBeenCalled();

    // The key is still prefetchable in the new generation.
    prefetcher.prefetch(targetAt(1));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    resolvers[1]!(messageOf('<p>fine now</p>'));
    await flush();
    expect(cache.get(targetAt(1))).toBeDefined();
  });

  it('takes new guesses normally after a cancel', async () => {
    const cache = new MessageCache();
    const { fetchImpl, resolvers } = deferredFetch();
    const prefetcher = new MessagePrefetcher({ cache, fetchImpl });

    prefetcher.prefetch(targetAt(1));
    prefetcher.cancelAll();

    prefetcher.prefetch(targetAt(2));
    expect(prefetcher.inFlight).toBe(1);
    resolvers[1]!(messageOf('<p>new folder</p>'));
    await flush();
    expect(cache.get(targetAt(2))).toBeDefined();
  });
});

describe('MessagePrefetcher / failures', () => {
  it('logs a genuine failure and does not re-issue that guess', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fetchImpl, rejecters } = deferredFetch();
    const prefetcher = new MessagePrefetcher({ cache: new MessageCache(), fetchImpl });

    prefetcher.prefetch(targetAt(1));
    rejecters[0]!(new Error('429'));
    await flush();

    expect(errors).toHaveBeenCalled();
    // A pointer moving back and forth over a failing row must not
    // re-issue the request on every pass. The OPEN path is unaffected —
    // an explicit click always fetches and always offers "Try again".
    prefetcher.prefetch(targetAt(1));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never logs the message itself', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fetchImpl, rejecters } = deferredFetch();
    const prefetcher = new MessagePrefetcher({ cache: new MessageCache(), fetchImpl });

    prefetcher.prefetch({ account_id: 'primary', folder: 'INBOX', uid: '42' });
    rejecters[0]!(new Error('failed'));
    await flush();

    for (const call of errors.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('SENTINEL');
    }
    expect(errors.mock.calls[0]?.[0]).toBe(
      'messagePrefetch: speculative message fetch failed',
    );
  });

  it('treats an abort as instruction followed, not as a failure worth logging', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cache = new MessageCache();
    const abort = new Error('The user aborted a request.');
    abort.name = 'AbortError';

    // A rejection that arrives WITHOUT a cancelAll — the shape a fetch
    // implementation produces when its signal fires — must still be
    // silent, because this class is what fired the signal.
    const { fetchImpl, rejecters } = deferredFetch();
    const prefetcher = new MessagePrefetcher({ cache, fetchImpl });
    prefetcher.prefetch(targetAt(1));
    rejecters[0]!(abort);
    await flush();

    expect(errors).not.toHaveBeenCalled();
  });
});

describe('MessagePrefetcher / adjacent messages', () => {
  const list = [targetAt(1), targetAt(2), targetAt(3), targetAt(4), targetAt(5)];

  it('warms one row either side, NEXT first', async () => {
    // People read down a list, and with a queue this short the order is
    // what decides which guess actually gets a slot.
    const { fetchImpl, targets } = deferredFetch();
    const prefetcher = new MessagePrefetcher({
      cache: new MessageCache(),
      fetchImpl,
      maxInFlight: 1,
    });

    prefetcher.prefetchAround(list, 2);

    expect(targets.map((target) => target.uid)).toEqual(['4']);
    expect(prefetcher.queued).toBe(1);
  });

  it('warms both neighbours when there are slots for both', () => {
    const { fetchImpl, targets } = deferredFetch();
    const prefetcher = new MessagePrefetcher({
      cache: new MessageCache(),
      fetchImpl,
      maxInFlight: 2,
    });

    prefetcher.prefetchAround(list, 2);

    expect(targets.map((target) => target.uid).sort()).toEqual(['2', '4']);
  });

  it('never warms the message that is already open', () => {
    const { fetchImpl, targets } = deferredFetch();
    const prefetcher = new MessagePrefetcher({
      cache: new MessageCache(),
      fetchImpl,
      maxInFlight: 4,
    });

    prefetcher.prefetchAround(list, 2);

    expect(targets.map((target) => target.uid)).not.toContain('3');
  });

  it('does not run off either end of the list', () => {
    const { fetchImpl, targets } = deferredFetch();
    const prefetcher = new MessagePrefetcher({
      cache: new MessageCache(),
      fetchImpl,
      maxInFlight: 4,
    });

    prefetcher.prefetchAround(list, 0);
    prefetcher.prefetchAround(list, list.length - 1);

    expect(targets.map((target) => target.uid).sort()).toEqual(['2', '4']);
  });

  it('does nothing for a row that is not in the list', () => {
    // The reader is also reachable from a thread row and from an opens
    // event, where there is no surrounding list — guessing a neighbour
    // there would be a fetch spent on a row the user cannot see.
    const { fetchImpl } = deferredFetch();
    const prefetcher = new MessagePrefetcher({ cache: new MessageCache(), fetchImpl });

    prefetcher.prefetchAround(list, -1);

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
