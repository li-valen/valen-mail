import type { ParsedMessage } from './message';

/**
 * The in-memory cache of PARSED messages that makes re-opening a message
 * instant instead of another IMAP round trip.
 *
 * Before this existed, GET /api/message/{account}/{folder}/{uid} did a
 * live fetch-and-parse on every single open: re-reading the message you
 * closed ten seconds ago re-downloaded it from Gmail and re-ran
 * mailparser over it. Every open paid full latency, and the client had no
 * way to avoid it because there was nothing to avoid it WITH.
 *
 * A latency cache, not storage. Nothing here is written to Postgres, and
 * that is deliberate in both directions: losing the whole cache on a
 * restart is CORRECT (the next open just pays what it used to), and a
 * second durable copy of mailbox bodies sitting on disk would be a real
 * liability for a product whose entire message store already lives in one
 * well-defined place.
 *
 * ---------------------------------------------------------------------
 * BOUNDED BY BYTES, NEVER BY ENTRY COUNT. THIS IS THE WHOLE DESIGN.
 * ---------------------------------------------------------------------
 * ../imap/fetch.ts caps a single on-demand fetch at MAX_BODY_PART_BYTES
 * (32 MB), which is a bound on ONE message and says nothing about a
 * hundred of them. A "100 entries" LRU is therefore a cache whose worst
 * case is 3.2 GB — on a 955 MB box that also runs Postgres and up to ten
 * live IMAP connections. That is not a tail risk; it is an OOM kill that
 * takes every account's connection down with it, which is precisely the
 * failure MAX_BODY_PART_BYTES itself exists to avoid. So the ceiling
 * below is stated in bytes, every entry is measured, and eviction runs
 * against the measured total.
 *
 * See MESSAGE_CACHE_MAX_BYTES for the arithmetic against that box.
 *
 * INVALIDATION — two triggers, both narrow and both load-bearing:
 *
 *  1. A successful flag write (`PATCH .../flags`) evicts that one key.
 *     The STORE mutates the message on the server, and this cache holds a
 *     snapshot of it; a route that mutates a message and leaves a stale
 *     copy behind is how a cache becomes a source of wrong answers.
 *  2. A UIDVALIDITY change evicts the whole (account, folder). A
 *     renumbered mailbox makes every cached uid meaningless — uid 42 is
 *     now a DIFFERENT message — so serving one would show the user
 *     someone else's mail under the row they clicked. Same signal, and
 *     the same "null means cannot tell" degradation, that
 *     ../imap/new-mail-marks.ts and ../imap/backfill.ts already act on.
 *
 * Note: parameter properties are avoided project-wide because the service
 * runs under --experimental-strip-types, which does not support them.
 */

/**
 * Total resident ceiling for everything this cache holds: 32 MiB.
 *
 * THE ARITHMETIC, against the 955 MB box this service is deployed on:
 *
 *   Postgres (shared_buffers 128 MB + backends)      ~200 MB
 *   Node baseline + V8 heap for imapflow/pg/mailparser ~120 MB
 *   one in-flight body fetch and its parse
 *     (2 x MAX_BODY_PART_BYTES — fetchBodyPart
 *      accumulates, then mailparser buffers again)    ~64 MB
 *   OS, Caddy, sshd                                  ~100 MB
 *   ----------------------------------------------------------
 *   fixed cost before this cache exists              ~484 MB
 *   + this cache at its ceiling                       ~33 MB
 *   ----------------------------------------------------------
 *   total                                            ~517 MB of 955 MB
 *
 * That leaves ~438 MB of headroom, which matters because V8 does not
 * promptly return freed heap to the OS: the number to survive is not the
 * steady state but a burst — several large opens in flight while the
 * cache is full — and 438 MB absorbs six more simultaneous 64 MB fetches
 * before anything is at risk.
 *
 * WHY 32 MiB IS ALSO GENEROUS, not merely safe: a PARSED message is not a
 * raw one. ParsedAttachment carries metadata and never content (see
 * ./message.ts), so a mail with a 20 MB video attached parses down to a
 * few KB of html plus a filename. A real message body in this mailbox
 * runs 60–90 KB of html; counted at the two-bytes-per-code-unit upper
 * bound `measureBytes` uses, that is ~180 KB an entry, so the ceiling
 * holds roughly 180 typical messages. Nobody opens 180 distinct messages
 * in a session, which means in practice this evicts approximately never
 * and the ceiling is a safety bound rather than an operating constraint.
 */
export const MESSAGE_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * The largest single entry that may be admitted: one eighth of the
 * ceiling, i.e. 4 MiB measured.
 *
 * Without this, one pathological message — a 30 MB html newsletter, a
 * base64 blob pasted inline — is admitted, evicts most of the cache to
 * make room for itself, and is then evicted in turn by the next ordinary
 * message. The cache would spend its whole budget on the one message
 * least likely to be re-read, and every genuinely warm entry would be
 * thrown out to pay for it. Refusing admission instead is honest: that
 * message stays exactly as slow as it was before this file existed, and
 * nothing else gets slower to subsidise it.
 *
 * One eighth specifically, so a single admitted entry can never evict
 * more than an eighth of what is already warm.
 */
export const MAX_CACHED_ENTRY_BYTES = MESSAGE_CACHE_MAX_BYTES / 8;

/**
 * Flat cost charged per entry on top of its strings: the Map node, the
 * key string, the ParsedMessage object header, and the address records
 * (`from`/`to`/`cc`), which are small and bounded by the header sizes
 * IMAP itself limits.
 */
const PER_ENTRY_OVERHEAD_BYTES = 512;

/** Flat cost per attachment METADATA record — filename, mime type, part
 *  id, content id. Never attachment content, which this response does not
 *  carry at all. */
const PER_ATTACHMENT_OVERHEAD_BYTES = 256;

/**
 * The (account, folder, uid) key, and the (account, folder) prefix a
 * UIDVALIDITY eviction sweeps.
 *
 * NUL separated, for the reason ../imap/new-mail-marks.ts states: NUL
 * cannot appear in an IMAP mailbox name or in this service's account ids,
 * so no two distinct triples can collide by concatenation — `a` + `bc`
 * and `ab` + `c` stay distinct keys rather than becoming one.
 */
function folderKey(accountId: string, folder: string): string {
  return `${accountId}\u0000${folder}`;
}

function entryKey(accountId: string, folder: string, uid: number): string {
  return `${folderKey(accountId, folder)}\u0000${uid}`;
}

/**
 * An upper bound on the heap one parsed message occupies.
 *
 * TWO BYTES PER CODE UNIT, deliberately. V8 stores a string as one byte
 * per character only while every character is Latin-1; anything else — an
 * emoji subject, a CJK body, a `’` in a newsletter — is a two-byte
 * string. `length` is UTF-16 code units, so `length * 2` is a true upper
 * bound on the character data in every case, and an over-estimate of
 * roughly 2x for the ASCII html that dominates real mail.
 *
 * Over-estimating is the safe direction for a ceiling whose purpose is
 * not being OOM-killed: the cost of being wrong high is holding fewer
 * messages than we could, and the cost of being wrong low is the box.
 *
 * Pure and exported so the ceiling's behaviour is testable without an
 * IMAP fetch or a router.
 */
export function measureBytes(message: ParsedMessage): number {
  const strings = [
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

  return (
    characters * 2 +
    PER_ENTRY_OVERHEAD_BYTES +
    message.attachments.length * PER_ATTACHMENT_OVERHEAD_BYTES
  );
}

/** One cached message, plus the two facts eviction needs about it. */
interface CacheEntry {
  readonly message: ParsedMessage;
  readonly bytes: number;
  /**
   * The mailbox's UIDVALIDITY as the pool had last observed it when this
   * entry was written, or null when the pool had never observed one (an
   * account whose first sync cycle has not completed, or a folder whose
   * fetch was skipped by the byte budget).
   */
  readonly uidValidity: bigint | null;
}

export class MessageCache {
  /**
   * Insertion-ordered by design: a JS `Map` iterates in insertion order,
   * and `get` re-inserts on a hit, so the FIRST key the iterator yields
   * is always the least recently used one. That is the whole LRU
   * mechanism — no heap, no timestamps, no second index to keep in sync.
   */
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;
  private totalBytes = 0;

  /**
   * @param maxBytes Total resident ceiling. Defaults to
   *   MESSAGE_CACHE_MAX_BYTES; a test passes a small one so eviction can
   *   be driven with a realistically-sized message rather than with 32 MB
   *   of fixture.
   * @param maxEntryBytes Per-entry admission cap, defaulting to an eighth
   *   of `maxBytes` so the relationship documented on
   *   MAX_CACHED_ENTRY_BYTES holds for a custom ceiling too.
   */
  constructor(maxBytes: number = MESSAGE_CACHE_MAX_BYTES, maxEntryBytes: number = maxBytes / 8) {
    this.maxBytes = maxBytes;
    this.maxEntryBytes = maxEntryBytes;
  }

  /**
   * The cached message for one uid, or `undefined` on a miss — in which
   * case the caller must do the IMAP fetch it would have done anyway.
   *
   * `currentUidValidity` is what the pool has most recently observed for
   * this mailbox. When it disagrees with what the entry was written
   * against, the server has RENUMBERED the mailbox and every uid cached
   * for this folder now addresses a different message, so the whole
   * folder is dropped rather than just this key: the other entries are
   * exactly as wrong, and leaving them to be discovered one at a time
   * would serve wrong mail in the meantime.
   *
   * A `null` on either side means "cannot tell" and the entry is served —
   * the same resolution ../imap/backfill.ts's `hasUidValidityChanged`
   * makes for the same reason. Treating unknown as changed would flush
   * the cache on every start-up before the first sync cycle completes,
   * which is the state a cold client is most likely to be reading in.
   */
  get(
    accountId: string,
    folder: string,
    uid: number,
    currentUidValidity: bigint | null,
  ): ParsedMessage | undefined {
    const key = entryKey(accountId, folder, uid);
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;

    if (
      entry.uidValidity !== null &&
      currentUidValidity !== null &&
      entry.uidValidity !== currentUidValidity
    ) {
      this.evictFolder(accountId, folder);
      return undefined;
    }

    // Re-insert to move this key to the most-recently-used end. Delete
    // first: `Map.set` on an existing key updates in place and does NOT
    // reorder, so without the delete every entry would keep its original
    // position forever and this would be FIFO wearing an LRU's name.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.message;
  }

  /**
   * Caches one parsed message, then evicts least-recently-used entries
   * until the total is back under the ceiling.
   *
   * Insert-then-trim rather than trim-then-insert: the invariant that
   * matters to a reader is the one that holds after every call
   * (`sizeBytes <= maxBytes`), and this way there is exactly one place
   * that enforces it. The transient peak inside this method is bounded by
   * the ceiling plus one admitted entry, i.e. 36 MiB at the defaults.
   *
   * An entry above the per-entry cap is not cached at all — see
   * MAX_CACHED_ENTRY_BYTES. Not an error and not logged: the request it
   * came from succeeded, and the only consequence is that this one
   * message stays as slow as it was before the cache existed.
   */
  set(
    accountId: string,
    folder: string,
    uid: number,
    message: ParsedMessage,
    uidValidity: bigint | null,
  ): void {
    const bytes = measureBytes(message);
    if (bytes > this.maxEntryBytes) return;

    const key = entryKey(accountId, folder, uid);
    this.remove(key);
    this.entries.set(key, { message, bytes, uidValidity });
    this.totalBytes += bytes;

    for (const oldest of this.entries.keys()) {
      if (this.totalBytes <= this.maxBytes) break;
      // Never evict the entry just admitted, even if it alone is over the
      // ceiling — the per-entry cap above already guarantees it is not,
      // and a loop that could evict its own insertion would be a cache
      // that silently stores nothing.
      if (oldest === key) continue;
      this.remove(oldest);
    }
  }

  /**
   * Drops one message. Called by the flag route after a STORE it knows
   * succeeded on the server, so the next open re-reads the message rather
   * than serving the snapshot taken before the write.
   */
  evict(accountId: string, folder: string, uid: number): void {
    this.remove(entryKey(accountId, folder, uid));
  }

  /**
   * Drops every entry for one mailbox. Reached from `get` on a
   * UIDVALIDITY change; see that method for why the sweep is folder-wide
   * rather than per key.
   */
  evictFolder(accountId: string, folder: string): void {
    const prefix = `${folderKey(accountId, folder)}\u0000`;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.remove(key);
    }
  }

  /** Measured resident total. Exposed so a test can assert the ceiling is
   *  actually held rather than inferring it from eviction order. */
  get sizeBytes(): number {
    return this.totalBytes;
  }

  /** How many messages are held. Diagnostics and tests only — nothing in
   *  this cache's behaviour is a function of entry COUNT. */
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
