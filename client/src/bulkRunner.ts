/**
 * BOUNDED, CANCELLABLE FAN-OUT — the machinery a bulk action runs on.
 *
 * Forty archived messages are forty HTTP requests (src/api.ts's
 * `moveMessage` and sync/src/api/move.ts both say, at length, that
 * nothing on this path is bulk and nothing on it should become bulk: one
 * request moves one message, which is what bounds the damage a bug can do
 * to a live mailbox). So the batching is the CLIENT's problem, and this
 * is where it is solved — once, generically, rather than once per action.
 *
 * The discipline is ./messagePrefetch.ts's, deliberately reused rather
 * than reinvented: a hard cap on how many requests exist at once, an
 * `AbortSignal` to stop issuing more, and a caller-side generation guard
 * to drop a result the view has moved past. Two things are different, and
 * both differences are about the fact that these are REQUESTS rather than
 * guesses:
 *
 *  - **A failure is reported, never swallowed.** messagePrefetch adds a
 *    failed key to a `failed` set and moves on, because nobody asked for
 *    that fetch. Here every item's outcome comes back to the caller,
 *    because the caller has hidden forty rows optimistically and the only
 *    thing that decides which of them come back is this report.
 *  - **The signal gates, it does not cancel.** See `runBoundedBatch`.
 */

/**
 * How many bulk requests may be on the wire at once.
 *
 * **FOUR, AND EVERY ONE OF THE FOUR REASONS IS A REAL CONSTRAINT RATHER
 * THAN A ROUND NUMBER:**
 *
 *  1. **The server serialises per account anyway.** sync/src/api/move.ts
 *     runs its MOVE inside `pool.withAccountLock(accountId, …)`, which is
 *     a `KeyedMutex` keyed by account (sync/src/imap/keyed-mutex.ts).
 *     Forty concurrent moves for one account do not become forty
 *     concurrent IMAP commands; they become a forty-deep queue. The
 *     parallelism above 1 buys nothing *per account*.
 *  2. **But a merged inbox is not one account.** The mutex is per key, so
 *     four accounts genuinely do run four moves at once. A limit of 1
 *     would serialise a cross-account batch for no reason at all, which
 *     is why this is not 1.
 *  3. **A deep queue starves the sync loop.** `withAccountLock` has no
 *     timeout (its own comment says so: *"What it does NOT guarantee is a
 *     bounded wait"*), and `syncOnce()` and the IDLE liveness probe share
 *     that key. Every extra queued move is another thing the account's
 *     next sync cycle waits behind. Keeping the client's own queue short
 *     keeps that wait short.
 *  4. **Browsers cap ~6 connections per HTTP/1.1 origin.** Anything above
 *     that queues in the browser instead, ahead of the message body the
 *     user is actually waiting to read. Four leaves headroom for the
 *     reader's own fetch and the opens poll.
 *
 * It is a CEILING, not a target: a batch of two runs two.
 */
export const MAX_CONCURRENT_BULK_REQUESTS = 4;

/**
 * What happened to one item.
 *
 *  - `done` — the request resolved. The caller may trust `value`.
 *  - `failed` — the request rejected. The caller has NO evidence the
 *    server acted, and must roll its optimistic change back.
 *  - `skipped` — the request was never sent, because the signal was
 *    already aborted when this item's turn came. Distinct from `failed`
 *    on purpose: "never attempted" is a stronger, cleaner fact than "we
 *    do not know", and it is the only status that can be asserted about
 *    the mailbox with certainty.
 */
export type BatchStatus = 'done' | 'failed' | 'skipped';

export interface BatchResult<TItem, TValue> {
  readonly item: TItem;
  readonly status: BatchStatus;
  /** Present only when `status === 'done'`. */
  readonly value?: TValue;
  /** Present only when `status === 'failed'`. Carried so the caller can
   *  log it — nothing here logs, because what is worth logging depends on
   *  which action ran. */
  readonly error?: unknown;
}

export interface BoundedBatchOptions {
  /** Defaults to `MAX_CONCURRENT_BULK_REQUESTS`. A limit below 1 degrades
   *  to 1 rather than deadlocking on zero workers. */
  readonly limit?: number;
  /** Stops FURTHER requests being issued — see `runBoundedBatch`. */
  readonly signal?: AbortSignal;
}

/**
 * Runs `run` over `items`, at most `limit` at a time, and reports every
 * item's outcome in INPUT ORDER.
 *
 * **IT NEVER REJECTS.** A batch that threw would take its own report down
 * with it, and the report is the only thing that knows which of forty
 * optimistically-hidden rows have to come back. `Promise.all` is
 * therefore the wrong primitive twice over — it abandons the rest on the
 * first rejection, and it loses the successes it had already collected.
 *
 * **THE SIGNAL GATES; IT DOES NOT CANCEL.** Checked before each request
 * is issued and never used to abort one already on the wire, and the
 * difference is a correctness one rather than an optimisation:
 *
 *   - An item that was never sent is `skipped`. The client can state
 *     positively that the mailbox did not change, so the caller can put
 *     that row back with confidence.
 *   - An item already on the wire is allowed to SETTLE. Aborting it would
 *     produce an `AbortError` indistinguishable from a network failure,
 *     while the server may well have completed the MOVE — and a row put
 *     back into the list because of that would be exactly the lie
 *     (message shown in the inbox, message not in the inbox) that
 *     ../src/mailboxActions.ts is shaped to prevent, only inverted.
 *
 * ./messagePrefetch.ts can and does abort in flight, because abandoning a
 * *guess* costs nothing and writing a stale one into the cache costs
 * real bytes. This is the opposite trade.
 *
 * ORDER IS PRESERVED BY INDEX, not by completion. Workers pull from a
 * shared cursor and write into the slot they claimed, so a batch where
 * item 3 fails and item 4 succeeds still reports 3 as 3 and 4 as 4.
 * Zipping two separate success/failure lists back against the input is
 * how a bulk action ends up archiving the wrong rows.
 */
export async function runBoundedBatch<TItem, TValue>(
  items: readonly TItem[],
  run: (item: TItem) => Promise<TValue>,
  options: BoundedBatchOptions = {},
): Promise<readonly BatchResult<TItem, TValue>[]> {
  if (items.length === 0) return [];

  const limit = options.limit ?? MAX_CONCURRENT_BULK_REQUESTS;
  const { signal } = options;
  const results: BatchResult<TItem, TValue>[] = new Array(items.length);

  // The shared cursor. Incremented and read in the same synchronous step
  // — there is no `await` between the two — so no two workers can ever
  // claim the same slot however the event loop interleaves them.
  let cursor = 0;

  // Never more workers than there is work, and never fewer than one: a
  // limit of 0 (or a negative one from some future caller doing
  // arithmetic on a count) would otherwise start no workers at all and
  // leave the returned promise pending forever, with forty rows hidden
  // behind it.
  const workerCount = Math.max(1, Math.min(limit, items.length));

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index] as TItem;

      if (signal?.aborted === true) {
        results[index] = { item, status: 'skipped' };
        continue;
      }

      try {
        // `await run(...)` inside the try, so a `run` that throws
        // SYNCHRONOUSLY is caught here rather than escaping the worker
        // and taking every other worker's results with it.
        const value = await run(item);
        results[index] = { item, status: 'done', value };
      } catch (error: unknown) {
        results[index] = { item, status: 'failed', error };
      }
    }
  }

  // Safe despite the name: no worker can reject — every call to `run` is
  // inside the try/catch above — so this settles only when all of them
  // have drained the cursor.
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}
