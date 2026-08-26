import { describe, expect, it, vi } from 'vitest';
import {
  MAX_CONCURRENT_BULK_REQUESTS,
  runBoundedBatch,
  type BatchResult,
} from '../src/bulkRunner';

/**
 * The bounded batch runner.
 *
 * TWO PROPERTIES ARE LOAD-BEARING AND EVERYTHING ELSE HERE SUPPORTS THEM:
 *
 *  1. **The bound is real.** Forty moves fired at once queue behind the
 *     server's per-account `KeyedMutex` anyway and, while they wait, hold
 *     the same lock the sync loop and the IDLE liveness probe need. The
 *     peak-concurrency probe below is the test that fails the moment
 *     somebody replaces this with `Promise.all(items.map(run))`.
 *  2. **One rejection never costs the others their result.** A batch
 *     where the third move 502s must still issue the other thirty-seven
 *     and must still report, per item, which ones landed — because that
 *     report is the only thing that decides which rows come back.
 */

/** A promise plus the two functions that settle it, so a test can hold a
 *  request open and observe how many others start behind it. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Runs `run` against `count` items, recording the highest number that
 *  were ever in flight at the same moment. */
function concurrencyProbe(): {
  run: (item: number) => Promise<number>;
  peak: () => number;
  started: () => readonly number[];
} {
  let inFlight = 0;
  let peak = 0;
  const started: number[] = [];
  return {
    run: async (item: number) => {
      started.push(item);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Two microtask turns, so a batch that ignored the bound would have
      // every item in flight before the first one settles.
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return item * 2;
    },
    peak: () => peak,
    started: () => started,
  };
}

function statuses<TItem, TValue>(results: readonly BatchResult<TItem, TValue>[]): readonly string[] {
  return results.map((result) => result.status);
}

describe('the concurrency bound', () => {
  it('never runs more than the limit at once', async () => {
    const probe = concurrencyProbe();
    await runBoundedBatch([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], probe.run, { limit: 3 });
    expect(probe.peak()).toBeLessThanOrEqual(3);
  });

  it('actually reaches the limit — the probe is not vacuous', async () => {
    // Without this, a runner that quietly went fully sequential would
    // pass the cap test above while being ten times slower than asked.
    const probe = concurrencyProbe();
    await runBoundedBatch([1, 2, 3, 4, 5, 6, 7, 8], probe.run, { limit: 3 });
    expect(probe.peak()).toBe(3);
  });

  it('holds the bound while a slow request blocks a worker', async () => {
    // THE CASE THAT MATTERS ON A REAL MAILBOX: one move sits behind the
    // account lock for seconds. The other workers must keep going, and
    // the total in flight must still never exceed the limit.
    const gate = deferred<string>();
    let inFlight = 0;
    let peak = 0;
    const run = async (item: number): Promise<string> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      if (item === 0) await gate.promise;
      inFlight -= 1;
      return `done ${item}`;
    };
    const batch = runBoundedBatch([0, 1, 2, 3, 4, 5], run, { limit: 2 });
    await Promise.resolve();
    await Promise.resolve();
    gate.resolve('go');
    const results = await batch;
    expect(peak).toBeLessThanOrEqual(2);
    expect(results).toHaveLength(6);
    expect(statuses(results)).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
  });

  it('degrades a nonsense limit to one rather than deadlocking', async () => {
    const run = vi.fn(async (item: number) => item);
    const results = await runBoundedBatch([1, 2], run, { limit: 0 });
    expect(results).toHaveLength(2);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not spawn more workers than there are items', async () => {
    const probe = concurrencyProbe();
    await runBoundedBatch([1, 2], probe.run, { limit: 10 });
    expect(probe.peak()).toBeLessThanOrEqual(2);
  });

  it('defaults to the named constant, and the constant is small', async () => {
    const probe = concurrencyProbe();
    await runBoundedBatch([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], probe.run);
    expect(probe.peak()).toBeLessThanOrEqual(MAX_CONCURRENT_BULK_REQUESTS);
    // Below the browser's ~6-per-origin cap, so a batch can never starve
    // the message fetch the user is actually waiting for.
    expect(MAX_CONCURRENT_BULK_REQUESTS).toBeLessThan(6);
    expect(MAX_CONCURRENT_BULK_REQUESTS).toBeGreaterThan(1);
  });
});

describe('every item gets exactly one result', () => {
  it('reports in INPUT order regardless of completion order', async () => {
    const run = async (item: number): Promise<number> => {
      // Later items finish first.
      for (let turn = 0; turn < 10 - item; turn += 1) await Promise.resolve();
      return item;
    };
    const results = await runBoundedBatch([1, 2, 3, 4, 5], run, { limit: 5 });
    expect(results.map((result) => result.item)).toEqual([1, 2, 3, 4, 5]);
    expect(results.map((result) => result.value)).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps each value attached to its own item when some fail', async () => {
    // THE OFF-BY-ONE THIS EXISTS TO CATCH: a runner that collected
    // successes into one array and failures into another, then zipped
    // them back against the input, would archive the wrong rows.
    const run = async (item: number): Promise<string> => {
      if (item % 2 === 0) throw new Error(`no ${item}`);
      return `ok ${item}`;
    };
    const results = await runBoundedBatch([1, 2, 3, 4, 5], run, { limit: 2 });
    expect(results.map((result) => [result.item, result.status, result.value])).toEqual([
      [1, 'done', 'ok 1'],
      [2, 'failed', undefined],
      [3, 'done', 'ok 3'],
      [4, 'failed', undefined],
      [5, 'done', 'ok 5'],
    ]);
  });

  it('does nothing at all for an empty batch', async () => {
    const run = vi.fn(async (item: number) => item);
    expect(await runBoundedBatch([], run)).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('a failure never stops the batch', () => {
  it('runs every remaining item after the first rejection', async () => {
    const seen: number[] = [];
    const run = async (item: number): Promise<number> => {
      seen.push(item);
      if (item === 1) throw new Error('boom');
      return item;
    };
    const results = await runBoundedBatch([1, 2, 3, 4], run, { limit: 1 });
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(statuses(results)).toEqual(['failed', 'done', 'done', 'done']);
  });

  it('never rejects, however many items do', async () => {
    // A batch that threw would take its own report down with it, and the
    // report is what decides which rows come back.
    const run = async (): Promise<never> => {
      throw new Error('every one');
    };
    const results = await runBoundedBatch([1, 2, 3], run, { limit: 2 });
    expect(statuses(results)).toEqual(['failed', 'failed', 'failed']);
  });

  it('carries the error through so a caller can log it', async () => {
    const boom = new Error('502');
    const results = await runBoundedBatch([1], async () => {
      throw boom;
    });
    expect(results[0]?.error).toBe(boom);
  });

  it('survives a synchronously-throwing run function', async () => {
    // `run` is called inside the worker; a synchronous throw must not
    // escape past the worker and kill the other workers with it.
    const run = (item: number): Promise<number> => {
      if (item === 2) throw new Error('sync');
      return Promise.resolve(item);
    };
    const results = await runBoundedBatch([1, 2, 3], run, { limit: 2 });
    expect(statuses(results)).toEqual(['done', 'failed', 'done']);
  });
});

describe('aborting stops what has NOT started, and only that', () => {
  it('skips everything when the signal is already aborted', async () => {
    const run = vi.fn(async (item: number) => item);
    const controller = new AbortController();
    controller.abort();
    const results = await runBoundedBatch([1, 2, 3], run, { limit: 2, signal: controller.signal });
    expect(statuses(results)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(run).not.toHaveBeenCalled();
  });

  it('lets an IN-FLIGHT request settle rather than reporting it failed', async () => {
    // **THE DELIBERATE DIFFERENCE FROM messagePrefetch.ts.** Aborting a
    // speculative FETCH costs nothing. Aborting a MOVE mid-flight tells
    // the client nothing about whether the server already moved the
    // message — and "unknown" reported as "failed" would put a row back
    // in the list that is really gone. So the signal is a gate before
    // each request, never a cancellation of one already sent.
    const gate = deferred<string>();
    const controller = new AbortController();
    const started: number[] = [];
    const run = async (item: number): Promise<string> => {
      started.push(item);
      if (item === 1) return gate.promise;
      return `ok ${item}`;
    };
    const batch = runBoundedBatch([1, 2, 3, 4], run, { limit: 1, signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    gate.resolve('landed anyway');
    const results = await batch;
    expect(started).toEqual([1]);
    expect(results[0]).toMatchObject({ item: 1, status: 'done', value: 'landed anyway' });
    expect(statuses(results).slice(1)).toEqual(['skipped', 'skipped', 'skipped']);
  });

  it('a skipped item carries no error — it was never attempted', async () => {
    const controller = new AbortController();
    controller.abort();
    const results = await runBoundedBatch([1], async (item: number) => item, {
      signal: controller.signal,
    });
    expect(results[0]?.error).toBeUndefined();
    expect(results[0]?.value).toBeUndefined();
  });
});
