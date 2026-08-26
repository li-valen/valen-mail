import { getMessage } from './api';
import type { ParsedMessage } from './api';
import type { MessageCache, MessageTarget } from './messageCache';
import { messageCacheKey } from './messageCache';

/**
 * The one place the reader decides between "I already have this" and "go
 * and get it", extracted from MessageView so the decision itself is
 * testable.
 *
 * That extraction is the point. No test in this project renders a
 * component (client/CLAUDE.md's standing constraint — there is no DOM
 * environment in the vitest config), so a cache check written inline in
 * an effect would be a claim nothing could hold. Here, "a cached open
 * makes no network call" is an assertion about a function: pass a spy
 * `fetchImpl`, prime the cache, and prove the spy was never touched.
 */

/** Fetches one message. The seam both the reader and the prefetcher go
 *  through, so a test can supply a controllable stand-in for either. */
export type FetchMessage = (
  target: MessageTarget,
  signal?: AbortSignal,
) => Promise<ParsedMessage>;

/** The real one: ./api.ts's `getMessage`, adapted to a MessageTarget. */
export const fetchMessage: FetchMessage = (target, signal) =>
  getMessage(target.account_id, target.folder, target.uid, fetch, signal);

/**
 * One request per message at a time, however many callers ask for it.
 *
 * WHY THIS IS NOT A NICETY. Measured against the live dev server: hovering
 * a row starts a prefetch, and the click 45ms later found nothing cached
 * yet and started a SECOND fetch of the same message. Both miss the
 * server's cache (the first has not returned to populate it), so both take
 * the account lock, both pull the message off IMAP, and both charge the
 * daily byte budget — on the single most common interaction in the app.
 * The prefetch was doubling the cost of the thing it exists to make
 * cheaper.
 *
 * Joining instead of starting fixes three cases with one mechanism:
 * hover-then-click (the reader adopts the prefetch already running),
 * click-then-hover (the prefetch sees the open and stays out of the way),
 * and React StrictMode's development double-invoke of the reader's own
 * effect, which used to issue two identical requests on every open.
 *
 * The entry is dropped as soon as the request settles, success or
 * failure — this coalesces concurrent requests and caches NOTHING. What
 * gets remembered is ./messageCache.ts's job, and a failed request must
 * leave nothing behind for the retry to find.
 */
export class InFlightRequests {
  private readonly byKey = new Map<string, Promise<ParsedMessage>>();

  /** True while a request for this message is on the wire, whoever
   *  started it. */
  has(target: MessageTarget): boolean {
    return this.byKey.has(messageCacheKey(target));
  }

  /** The in-flight request for this message, or a new one from `start`. */
  run(target: MessageTarget, start: () => Promise<ParsedMessage>): Promise<ParsedMessage> {
    const key = messageCacheKey(target);
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;

    const request = start();
    this.byKey.set(key, request);
    // Compared by identity before deleting: a later request for the same
    // message may already have claimed the slot by the time this one
    // settles, and clearing it would leave that one uncoalesced.
    const release = (): void => {
      if (this.byKey.get(key) === request) this.byKey.delete(key);
    };
    request.then(release, release);
    return request;
  }
}

/** The one registry, shared by the reader and the prefetcher — two
 *  registries would coalesce each side against itself and miss the case
 *  that actually costs: one of each, for the same message. */
export const inFlightRequests = new InFlightRequests();

/**
 * What opening a message resolved to.
 *
 * A UNION rather than a promise in both cases, and that is the whole
 * shape of "instant". A `Promise<ParsedMessage>` that happens to be
 * already-resolved still delivers its value on a microtask, which means
 * at least one frame where the reader has state but nothing to show — a
 * loading flash for a message that was in memory the entire time. The
 * `cached` arm hands the message back SYNCHRONOUSLY so the caller can
 * render it in the same pass.
 */
export type MessageLoad =
  | { readonly kind: 'cached'; readonly parsed: ParsedMessage }
  | { readonly kind: 'pending'; readonly parsed: Promise<ParsedMessage> };

/**
 * The cached message, or undefined — for a caller that must decide during
 * render and must not start anything.
 *
 * Separate from `loadMessage` below precisely because it starts nothing:
 * React invokes a `useState` initializer during render (twice, under
 * StrictMode), so the function a component reaches for there has to be
 * free of side effects. Kicking off a fetch from one would be a request
 * issued during render and, in development, two.
 */
export function readCachedMessage(
  cache: MessageCache,
  target: MessageTarget,
): ParsedMessage | undefined {
  return cache.get(target);
}

/**
 * Resolves one message, from cache when it is there and from the network
 * when it is not, populating the cache on the way back.
 *
 * On a HIT this does not call `fetchImpl` at all — not "calls it and
 * ignores the result", not "calls it to revalidate". That is what the
 * feature is: the second open of a message performs no I/O whatsoever.
 * tests/message-loader.test.ts asserts exactly that with a spy.
 *
 * A failed fetch caches nothing, so the next attempt is a real retry
 * rather than a replay of the failure, and the error propagates to the
 * caller — the reader shows it and offers "Try again". Nothing is
 * swallowed here.
 */
export function loadMessage(
  cache: MessageCache,
  target: MessageTarget,
  fetchImpl: FetchMessage = fetchMessage,
  signal?: AbortSignal,
  inFlight: InFlightRequests = inFlightRequests,
): MessageLoad {
  const cached = cache.get(target);
  if (cached !== undefined) return { kind: 'cached', parsed: cached };

  // Joins a request already running for this message rather than starting
  // a second one — most often the hover prefetch that has not landed yet.
  // See InFlightRequests.
  const parsed = inFlight.run(target, () => fetchImpl(target, signal)).then((message) => {
    cache.set(target, message);
    return message;
  });
  return { kind: 'pending', parsed };
}

/**
 * Fetches unconditionally, ignoring whatever is cached, and replaces the
 * cache entry with what comes back.
 *
 * The "Try again" path, and the one case where reading the cache would be
 * wrong: the user is retrying PAST something, and answering their retry
 * with the copy they are retrying past would make the button appear to do
 * nothing. Everything else — every ordinary open — goes through
 * `loadMessage` and takes the cached answer.
 */
export function refetchMessage(
  cache: MessageCache,
  target: MessageTarget,
  fetchImpl: FetchMessage = fetchMessage,
  signal?: AbortSignal,
): Promise<ParsedMessage> {
  // Deliberately NOT coalesced either: joining an in-flight request would
  // hand the retry the very attempt it is retrying past.
  return fetchImpl(target, signal).then((message) => {
    cache.set(target, message);
    return message;
  });
}

/** The identity of the message an inbox row points at. Narrow on purpose:
 *  everything downstream of this needs three strings, and taking a whole
 *  InboxMessage would let the cache key silently start depending on
 *  fields that change between syncs. */
export function targetFor(message: MessageTarget): MessageTarget {
  return { account_id: message.account_id, folder: message.folder, uid: message.uid };
}
