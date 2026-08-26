import type { ParsedMessage } from './api';

/**
 * The reader's in-memory cache of already-fetched messages, and the
 * reason clicking back and then forward again shows the message on the
 * next frame instead of re-fetching it.
 *
 * The sync service now caches parsed messages too (sync/src/api/
 * message-cache.ts), which removes the IMAP round trip. This removes the
 * rest: the HTTP request, the JSON parse, and — the part the user
 * actually sees — the loading state between the click and the mail.
 * A server cache alone still leaves a network round trip and therefore
 * still leaves a frame where the reader has nothing to render.
 *
 * WHY THIS IS A SECOND IMPLEMENTATION rather than the server's one
 * imported. `client/` and `sync/` are separate packages with separate
 * tsconfigs and no shared module; the server's version measures with
 * `Buffer` and carries the UIDVALIDITY guard, neither of which exists or
 * belongs here. The two are the same IDEA, deliberately kept as two
 * files, and the ceiling below is the one that is right for a browser
 * tab rather than the one that is right for a 955 MB VM.
 *
 * BOUNDED BY BYTES, not by entry count, for the same reason the server's
 * is: message bodies are not a uniform size, so "20 entries" is a bound
 * on nothing. A phone browser kills a tab that grows without limit, and
 * losing the tab is a much worse outcome than losing a cache entry.
 */

/**
 * Total ceiling: 8 MiB of measured message text.
 *
 * A real body in this mailbox runs 60–90 KB of html, counted at the
 * two-bytes-per-code-unit upper bound `measureBytes` uses — so ~180 KB an
 * entry, and this ceiling holds roughly 45 messages. That is far more
 * than a reading session revisits, which is the workload this exists for:
 * open, read, back, open the next one, back to the first.
 *
 * Small against the browser it lives in (a single page of an inbox list
 * plus its React tree is already comparable), and small enough that it is
 * never the reason a phone reclaims the tab.
 */
export const MESSAGE_CACHE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The largest single entry admitted: an eighth of the ceiling, so one
 * pathological message cannot evict most of what is warm to store itself
 * and then be evicted in turn by the next ordinary one. A message above
 * it simply stays uncached and costs exactly what it cost before this
 * file existed.
 */
export const MAX_CACHED_ENTRY_BYTES = MESSAGE_CACHE_MAX_BYTES / 8;

/** Flat cost per entry: the key, the Map node, the object headers and the
 *  address records, which are bounded by header sizes. */
const PER_ENTRY_OVERHEAD_BYTES = 512;

/** Which message. `folder` is part of the identity and cannot be dropped:
 *  Gmail numbers each mailbox independently, so uid 42 in Sent is not the
 *  same message as uid 42 in the inbox. */
export interface MessageTarget {
  readonly account_id: string;
  readonly folder: string;
  readonly uid: string;
}

/**
 * The cache key.
 *
 * NUL separated so no two targets can collide by concatenation — a Gmail
 * folder path legitimately contains `/`, `:` and `]`, and NUL is the one
 * character that appears in neither a mailbox name nor an account id.
 * Deliberately NOT components/messageBody.ts's `messageKey`, which is
 * `account_id:uid` and carries no folder: that key answers "is this the
 * same ROW", and this one has to answer "is this the same MESSAGE".
 */
export function messageCacheKey(target: MessageTarget): string {
  return `${target.account_id}\u0000${target.folder}\u0000${target.uid}`;
}

/**
 * An upper bound on the memory one parsed message holds.
 *
 * Two bytes per UTF-16 code unit, because that is what a JS engine costs
 * for any string that is not pure Latin-1 — an emoji subject, a CJK body,
 * a curly quote in a newsletter. `length * 2` is therefore a true upper
 * bound in every case and an over-estimate of about 2x for the ASCII html
 * that dominates real mail. Wrong-high costs cache entries; wrong-low
 * costs the tab.
 *
 * Attachment CONTENT is not counted because it is not here: the API
 * returns attachment metadata only (see api.ts's MessageAttachment).
 */
export function measureBytes(message: ParsedMessage): number {
  const strings: readonly (string | null | undefined)[] = [
    message.html,
    message.text,
    message.subject,
    message.from?.name,
    message.from?.address,
    ...message.to.flatMap((address) => [address.name, address.address]),
    ...message.cc.flatMap((address) => [address.name, address.address]),
    ...message.attachments.flatMap((attachment) => [
      attachment.partId,
      attachment.filename,
      attachment.mimeType,
      attachment.contentId,
    ]),
  ];

  const characters = strings.reduce<number>(
    (total, value) => total + (typeof value === 'string' ? value.length : 0),
    0,
  );
  return characters * 2 + PER_ENTRY_OVERHEAD_BYTES;
}

interface CacheEntry {
  readonly message: ParsedMessage;
  readonly bytes: number;
}

export class MessageCache {
  /**
   * Insertion-ordered by design: a `Map` iterates in insertion order and
   * `get` re-inserts on a hit, so the first key the iterator yields is
   * always the least recently used. That is the whole LRU — no heap, no
   * timestamps, no second index that can fall out of sync.
   */
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;
  private totalBytes = 0;

  constructor(maxBytes: number = MESSAGE_CACHE_MAX_BYTES, maxEntryBytes: number = maxBytes / 8) {
    this.maxBytes = maxBytes;
    this.maxEntryBytes = maxEntryBytes;
  }

  /** The cached message, or `undefined` on a miss. Synchronous on
   *  purpose: the reader reads this during render, which is what makes a
   *  re-open paint on the first frame instead of after a promise. */
  get(target: MessageTarget): ParsedMessage | undefined {
    const key = messageCacheKey(target);
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;

    // Delete before set: `Map.set` on an existing key updates in place
    // and does NOT reorder, so without this every entry would keep its
    // original position forever and this would be FIFO wearing an LRU's
    // name.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.message;
  }

  /** Caches one message, then evicts least-recently-used entries until
   *  the measured total is back under the ceiling. The invariant that
   *  holds after every call is `sizeBytes <= maxBytes`. */
  set(target: MessageTarget, message: ParsedMessage): void {
    const bytes = measureBytes(message);
    if (bytes > this.maxEntryBytes) return;

    const key = messageCacheKey(target);
    this.remove(key);
    this.entries.set(key, { message, bytes });
    this.totalBytes += bytes;

    for (const oldest of this.entries.keys()) {
      if (this.totalBytes <= this.maxBytes) break;
      // Never evict the insertion this call just made; the per-entry cap
      // above already guarantees it fits.
      if (oldest === key) continue;
      this.remove(oldest);
    }
  }

  /** Drops one message — for a caller that knows the server copy has
   *  changed under it. */
  evict(target: MessageTarget): void {
    this.remove(messageCacheKey(target));
  }

  get sizeBytes(): number {
    return this.totalBytes;
  }

  get size(): number {
    return this.entries.size;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
  }
}

/**
 * The one cache this app uses.
 *
 * Module scope rather than React context: it must OUTLIVE every component
 * that reads it — the whole point is that MessageView unmounting on Back
 * does not throw away what it fetched — and nothing about it needs to
 * trigger a render, so a context would add a provider and a re-render
 * cascade to buy nothing. The class is exported alongside it so tests get
 * a fresh, small-ceilinged instance instead of sharing this one.
 */
export const messageCache = new MessageCache();
