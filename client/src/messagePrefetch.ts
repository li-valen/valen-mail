import type { MessageCache, MessageTarget } from './messageCache';
import { messageCache, messageCacheKey } from './messageCache';
import { fetchMessage, inFlightRequests, type FetchMessage, type InFlightRequests } from './messageLoader';

/**
 * Speculative message fetching — warming the cache for a message the user
 * has not opened yet, so that when they do, ./messageLoader.ts's
 * `loadMessage` answers `cached` and the reader paints on the first
 * frame.
 *
 * ---------------------------------------------------------------------
 * CONSERVATIVE BY CONSTRUCTION, BECAUSE EVERY GUESS COSTS REAL MONEY.
 * ---------------------------------------------------------------------
 * A prefetch that misses the SERVER's cache is a full IMAP fetch on the
 * user's own connection, charged against that account's daily byte budget
 * (sync/src/budget.ts, spec L6) — a budget that, once exhausted, refuses
 * the fetches the user actually asked for. So this deliberately does NOT
 * prefetch the visible list. Prefetching 50 rows to save a click on one
 * of them would spend fifty fetches to win one, and on a bad day would
 * spend the budget that lets the user read at all.
 *
 * What it does instead, and why each is a real signal rather than a guess:
 *
 *  - POINTER HOVER / KEYBOARD FOCUS on a row. The user has physically
 *    moved to that row. Between hover and click there are typically
 *    100–300ms of human latency that would otherwise be dead time, and it
 *    is the single highest-yield free interval in the whole interaction.
 *  - THE ADJACENT MESSAGES once one is open. People read down a list; the
 *    next row is the most likely next open by a wide margin. One in each
 *    direction, never a window of ten.
 *
 * BOUNDED, CANCELLABLE, AND ORDER-SAFE:
 *
 *  - At most MAX_IN_FLIGHT requests at once, so a fast pointer dragging
 *    down a list queues rather than opening a dozen sockets and competing
 *    with the message the user actually clicked.
 *  - Every request carries an `AbortController`, and navigating away
 *    aborts all of them. Speculative work must never outlive the guess
 *    that motivated it.
 *  - A GENERATION counter, the same discipline InboxList's `loadMore`
 *    already uses for its pages: a response that lands after the view
 *    moved on is DISCARDED rather than written. See `cancelAll`.
 */

/**
 * How many prefetches may be in flight at once.
 *
 * Two, not one: a hover followed immediately by opening that message
 * should not make the open queue behind the hover's own request, and two
 * lets the adjacent-message pair (previous and next) run together. Not
 * more than two, because every one of these competes with the request the
 * user is actually waiting for, over the same connection.
 */
export const MAX_IN_FLIGHT = 2;

/**
 * How many targets may WAIT for a slot.
 *
 * A pointer sweeping down a 50-row list would otherwise enqueue fifty
 * guesses, of which the user wanted at most one — and by the time the
 * queue drained, the rows it named would be stale intent. A short queue
 * means the most recent hovers are the ones that get served and the rest
 * are simply dropped, which is the correct bias for a guess whose value
 * decays in a few hundred milliseconds.
 */
export const MAX_QUEUED = 4;

export interface PrefetcherOptions {
  readonly cache?: MessageCache;
  readonly fetchImpl?: FetchMessage;
  readonly maxInFlight?: number;
  readonly maxQueued?: number;
  /** Shared with the reader's own open path — see
   *  ./messageLoader.ts's InFlightRequests for why one registry rather
   *  than one each. */
  readonly sharedRequests?: InFlightRequests;
}

export class MessagePrefetcher {
  private readonly cache: MessageCache;
  private readonly fetchImpl: FetchMessage;
  private readonly maxInFlight: number;
  private readonly maxQueued: number;
  private readonly sharedRequests: InFlightRequests;

  /** Waiting for a slot, oldest first. */
  private queue: MessageTarget[] = [];
  /** One controller per request currently on the wire, by cache key. */
  private readonly active = new Map<string, AbortController>();
  /**
   * Keys whose prefetch already failed this session.
   *
   * Not a retry policy — a HAMMERING policy. Without it, a pointer moving
   * back and forth over a row whose fetch 429s would re-issue that fetch
   * on every pass. The OPEN path is deliberately unaffected: an explicit
   * click always fetches, always reports its own failure, and always
   * offers "Try again". A guess gets one attempt; a request does not.
   */
  private readonly failed = new Set<string>();
  /**
   * Bumped by `cancelAll`. Every request captures the value current when
   * it started and compares on the way back — see `start`.
   */
  private generation = 0;

  constructor(options: PrefetcherOptions = {}) {
    this.cache = options.cache ?? messageCache;
    this.fetchImpl = options.fetchImpl ?? fetchMessage;
    this.maxInFlight = options.maxInFlight ?? MAX_IN_FLIGHT;
    this.maxQueued = options.maxQueued ?? MAX_QUEUED;
    this.sharedRequests = options.sharedRequests ?? inFlightRequests;
  }

  /**
   * Asks for one message to be warmed. Cheap and idempotent: already
   * cached, already in flight, already queued and already failed all
   * return immediately, so a hover handler can call this on every
   * `pointerenter` without thinking about it.
   */
  prefetch(target: MessageTarget): void {
    const key = messageCacheKey(target);
    if (this.cache.get(target) !== undefined) return;
    // Already on the wire — most often because the user has ALREADY
    // clicked this row and the reader is fetching it. A guess must never
    // duplicate the request it was guessing about.
    if (this.sharedRequests.has(target)) return;
    if (this.active.has(key)) return;
    if (this.failed.has(key)) return;
    if (this.queue.some((queued) => messageCacheKey(queued) === key)) return;

    // Newest-first, and the OLDEST is what falls off the end. A queue that
    // dropped the newest entry would keep serving the row the pointer left
    // three rows ago while ignoring the one it is on now.
    this.queue = [target, ...this.queue].slice(0, this.maxQueued);
    this.pump();
  }

  /**
   * Prefetches the rows either side of `index` in an ordered list — the
   * "people read down a list" signal.
   *
   * `radius` is 1 by default and should stay small: each step out is
   * another real IMAP fetch against the daily budget for a guess that is
   * one row less likely to be right. Ordered NEXT FIRST, because reading
   * forward is much more common than reading back, and with a queue this
   * short the order decides which one actually gets a slot.
   */
  prefetchAround(targets: readonly MessageTarget[], index: number, radius = 1): void {
    if (index < 0) return;
    for (let step = 1; step <= radius; step += 1) {
      const next = targets[index + step];
      if (next !== undefined) this.prefetch(next);
      const previous = targets[index - step];
      if (previous !== undefined) this.prefetch(previous);
    }
  }

  /**
   * Abandons every guess: aborts what is on the wire, empties the queue,
   * and — the half an `abort()` alone does not buy — invalidates every
   * response still in flight.
   *
   * BOTH HALVES ARE LOAD-BEARING. `AbortController` stops the request,
   * but a fetch that has already resolved and is sitting in a microtask
   * cannot be un-resolved; its `.then` still runs. The generation bump is
   * what makes that late arrival harmless: `start` compares the
   * generation it captured against the current one and drops the result
   * rather than writing it. Without it, a prefetch issued for the folder
   * the user just left would land afterwards and spend cache bytes on
   * mail they navigated away from, evicting the mail they navigated TO.
   *
   * This is the same discipline InboxList's `loadMore` applies to a page
   * that resolves after the selection moved on (see `selectionRef` there
   * and ./components/inboxPaging.ts's `resolveLoadMorePage`) — one
   * counter, captured before the request, compared after it.
   *
   * Called on every navigation that changes what the user is looking at:
   * a folder or account switch, a search, a view change, leaving the
   * reader.
   */
  cancelAll(): void {
    this.generation += 1;
    this.queue = [];
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
  }

  /** In-flight request count. Diagnostics and tests — the concurrency cap
   *  is not otherwise observable from outside. */
  get inFlight(): number {
    return this.active.size;
  }

  /** Targets waiting for a slot. */
  get queued(): number {
    return this.queue.length;
  }

  /** Starts requests while there is both a slot and something waiting. */
  private pump(): void {
    while (this.active.size < this.maxInFlight && this.queue.length > 0) {
      const target = this.queue.shift();
      if (target !== undefined) this.start(target);
    }
  }

  private start(target: MessageTarget): void {
    const key = messageCacheKey(target);
    const controller = new AbortController();
    const issuedAt = this.generation;
    this.active.set(key, controller);

    this.sharedRequests.run(target, () => this.fetchImpl(target, controller.signal)).then(
      (message) => {
        this.settle(key, issuedAt);
        // THE GUARD. A response for a superseded view is dropped rather
        // than cached — see cancelAll.
        if (issuedAt !== this.generation) return;
        this.cache.set(target, message);
        this.pump();
      },
      (error: unknown) => {
        this.settle(key, issuedAt);
        if (issuedAt !== this.generation) return;
        this.failed.add(key);
        // An abort is not a failure — it is this class doing exactly what
        // it was told. Only a genuine one is worth a line, and it is
        // worth a line rather than silence: a prefetch that fails is the
        // early warning that the open the user is about to attempt will
        // fail too. Nothing about the message reaches the log.
        if (!isAbort(error)) {
          console.error('messagePrefetch: speculative message fetch failed', error);
        }
        this.pump();
      },
    );
  }

  /** Releases the slot, but only if this request still owns it — a
   *  `cancelAll` has already cleared the map, and a later request for the
   *  same key may since have claimed the entry. */
  private settle(key: string, issuedAt: number): void {
    if (issuedAt !== this.generation) return;
    this.active.delete(key);
  }
}

/** True for the rejection an `AbortController` produces. Checked by name
 *  rather than by class because `DOMException` is not guaranteed to be
 *  the rejection's constructor across every fetch implementation this
 *  runs on (a test stand-in, a polyfill), and the name is. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * The one prefetcher this app uses, warming ./messageCache.ts's one
 * cache. Module scope for the same reason that cache is: it has to
 * outlive the components that trigger it, and nothing about it should
 * cause a render.
 */
export const messagePrefetcher = new MessagePrefetcher();
