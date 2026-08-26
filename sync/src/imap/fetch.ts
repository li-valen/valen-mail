import type { FetchQueryObject } from 'imapflow';
import type { ImapConnection } from './connection';
import type { MessageInput } from '../db';
import type { AttachmentMeta } from '../attachments';
import type { TextPart } from '../preview';
import { extractAttachments } from '../attachments.ts';
import { firstTextPart, previewTextFrom } from '../preview.ts';
import { normalizeMessage } from '../normalize.ts';

export interface FetchRange {
  readonly limit: number;
  /**
   * Lower UID bound, inclusive — matches IMAP's own `UID a:b` range
   * semantics, where both ends are inclusive. `limit` ALWAYS bounds the
   * number of UIDs fetched, even when `sinceUid` is set: the fetched span
   * is `[sinceUid, min(mailbox's current highest UID, sinceUid + limit -
   * 1)]`. A caller doing incremental sync after a gap gets one bounded
   * page here, never one uncapped fetch — it must loop, passing the last
   * UID it actually saw + 1 as the next call's `sinceUid`, until it catches
   * up to the mailbox's current top.
   */
  readonly sinceUid?: number;
}

export interface FetchResult {
  readonly messages: readonly MessageInput[];
  readonly attachments: ReadonlyMap<number, readonly AttachmentMeta[]>;
  /**
   * Per UID, the part a preview should be fetched from — the first
   * text/plain leaf, or the first text/* one for HTML-only mail. Absent
   * for a message with no text part at all.
   *
   * Derived from the BODYSTRUCTURE this fetch ALREADY pulled (see
   * HEADER_FETCH_OPTIONS below), not from anything new on the wire: no
   * extra bytes, no extra round trip, and — the point — no widening of
   * the header fetch. fetchPreviews() consumes it; nothing here fetches a
   * preview.
   */
  readonly textParts: ReadonlyMap<number, TextPart>;
  readonly bytesDownloaded: number;
  /**
   * The mailbox's UIDVALIDITY at the moment of this fetch, or `null` when
   * the mailbox was never actually opened (the `range.limit <= 0`
   * short-circuit below, which no production caller triggers).
   *
   * Task 7 / Fix round 1: imap/pool.ts keys its new-mail high-water mark
   * on this value alongside the UID itself. UIDVALIDITY changing means
   * the server has renumbered the mailbox — a UID from before the change
   * means something different from the same UID after it, most commonly
   * lower, which would otherwise make `uid > previousMax` false for every
   * message for the rest of the process's life and silently stop all
   * new-mail notifications until the next restart happened to re-baseline.
   */
  readonly uidValidity: bigint | null;
}

/**
 * The ONLY fields fetched during sync. Adding a body-bearing key here —
 * `source`, `bodyParts`, or anything else that pulls `BODY[...]` content —
 * is simultaneously the storage blowup (10 GB instead of 1 GB across ten
 * mailboxes) and the fastest route to Gmail's ~2.5 GB/day ceiling, which
 * suspends IMAP for 24 hours across the affected account. (Spec L6)
 *
 * This constant is asserted on directly, by exact shape, in
 * tests/fetch-unit.test.ts — that test (not the live byte-magnitude check
 * below) is the real guard against BODY[] creeping into the header fetch.
 */
export const HEADER_FETCH_OPTIONS = {
  uid: true,
  envelope: true,
  flags: true,
  size: true,
  bodyStructure: true,
  labels: true,
  threadId: true,
} as const satisfies FetchQueryObject;

/**
 * Conservative fixed per-message charge for the byte budget. imapflow does
 * not expose a wire-byte counter for an individual fetch call, so this is an
 * ESTIMATE of what one envelope + BODYSTRUCTURE fetch costs on the wire, not
 * a measurement. src/budget.ts compares the running total this produces
 * against Gmail's ~2.5 GB/day suspension threshold, using our internal 2 GB
 * target as the safety margin — under-reporting this number would erode
 * that margin and risk a 24-hour IMAP lockout on the affected account. Do
 * not tune it down to make totals look smaller, and do not try to make it
 * exact; conservative-and-approximate is the deliberate choice here.
 *
 * Because this is a fixed charge rather than a measurement, it cannot by
 * itself detect a real BODY[] regression — see HEADER_FETCH_OPTIONS above
 * for the assertion that actually does that job.
 *
 * Exported so Task 7's connection pool can size its pre-fetch budget
 * reservation (`limit * this constant`) from the same number this module
 * actually charges after the fetch, rather than duplicating the literal
 * and risking the two drifting apart.
 */
export const ESTIMATED_BYTES_PER_HEADER_FETCH = 2048;

const EMPTY_RESULT: FetchResult = {
  messages: [],
  attachments: new Map(),
  textParts: new Map(),
  bytesDownloaded: 0,
  uidValidity: null,
};

export interface UidSpan {
  readonly lowestUid: number;
  readonly highestUid: number;
}

/**
 * Computes the inclusive `[lowestUid, highestUid]` span to fetch, or `null`
 * if nothing should be fetched. Pure and IMAP-client-free on purpose: this
 * is the one place `sinceUid`/`limit` interact, and keeping it a standalone
 * function lets tests/fetch-unit.test.ts prove the arithmetic — including
 * the "does `limit` actually cap a `sinceUid` fetch" property — without a
 * live Gmail connection.
 *
 * `limit` always bounds the span's size, even when `sinceUid` is set: an
 * incremental-sync caller resuming after a long gap gets a bounded first
 * page, not one fetch covering the entire backlog in a single IMAP round
 * trip. `record()`-ing the byte estimate only happens after fetchHeaders()
 * returns (see budget.ts), so an unbounded span would already have hit
 * Gmail before the budget could ever refuse it — bounding the span here is
 * what keeps that scenario from being possible at all.
 */
export function resolveUidSpan(
  range: FetchRange,
  highestUidInMailbox: number,
): UidSpan | null {
  if (range.limit <= 0) return null;

  const lowestUid = range.sinceUid ?? Math.max(1, highestUidInMailbox - range.limit + 1);
  const highestUid = Math.min(highestUidInMailbox, lowestUid + range.limit - 1);

  if (highestUid < lowestUid) return null;
  return { lowestUid, highestUid };
}

/**
 * The IMAP UID range string for one fetch — and the fix for the push
 * latency bug, so the reasoning lives here rather than in a commit message.
 *
 * THE BUG. `resolveUidSpan` is handed `mailbox.uidNext - 1` as the highest
 * UID in the mailbox. `mailbox.uidNext` is imapflow's CACHE, and the
 * library writes it in exactly two places: the SELECT/EXAMINE response
 * parser (commands/select.js) and a STATUS response (commands/status.js).
 * The untagged `EXISTS` that a server pushes during IDLE updates
 * `mailbox.exists` and NOTHING ELSE (imap-flow.js `untaggedExists`) — and
 * `getMailboxLock()` takes a fast path that issues no SELECT at all when
 * the mailbox is already selected. So the sync cycle woken BY a new
 * message computed its ceiling from a `uidNext` captured before that
 * message existed, and the top of its range landed exactly one UID below
 * the message that caused the wake. Every message was therefore fetched
 * one full cycle late — the cycle's closing `openMailbox(INBOX)` re-SELECTs
 * (the folder loop has since moved to Sent/Spam), which refreshes the
 * cache, so the NEXT cycle could finally see it. Measured in production:
 * uid 33126 arrived 05:14:45 and woke IDLE with `reason=mail` at 05:14:45;
 * the cycle that wake triggered stored nothing; the row appeared at
 * 05:17:41, one `IDLE_LIVENESS_CHECK_INTERVAL_MS` later.
 *
 * THE FIX. For the live poll, the ceiling is not ours to know — only the
 * server knows what the newest message is. `*` is the IMAP placeholder for
 * exactly that, resolved server-side at fetch time, so no client-side
 * cache can hide a message again. imapflow passes a compound range like
 * `"33076:*"` through untouched (only a BARE `'*'` gets rewritten into a
 * sequence number by `resolveRange`), so this really does reach the wire.
 *
 * A `sinceUid` caller keeps the computed numeric ceiling: that is
 * ./backfill.ts walking BACKWARDS through history, where the span is a
 * deliberate, bounded historical window. `*` there would fetch from the
 * watermark to the newest message in the mailbox in one round trip — the
 * unbounded fetch `resolveUidSpan`'s `limit` exists to prevent.
 *
 * BYTE COST. The live poll's span becomes "the newest `limit`, plus
 * whatever arrived since the last SELECT" rather than exactly `limit`. The
 * overshoot is only ever genuinely-new mail — the messages this poll
 * exists to collect — never history, because `lowestUid` is unchanged.
 * `fetchHeaders` charges the budget per message actually yielded, so a
 * burst is metered rather than hidden.
 */
export function uidRangeString(range: FetchRange, span: UidSpan): string {
  const ceiling = range.sinceUid === undefined ? '*' : String(span.highestUid);
  return `${span.lowestUid}:${ceiling}`;
}

/**
 * Overrides normalizeMessage()'s stubbed `hasAttach: false` with the real
 * value from the BODYSTRUCTURE walk. normalizeMessage() has no visibility
 * into BODYSTRUCTURE, so only a caller holding both the normalized fields
 * and extractAttachments()'s result can set this correctly. Exported as its
 * own function (rather than left inline in the fetch loop) so this override
 * can be unit-tested without a live IMAP connection — see
 * tests/fetch-unit.test.ts.
 */
export function applyAttachmentFlag(
  normalized: MessageInput,
  parts: readonly AttachmentMeta[],
): MessageInput {
  return { ...normalized, hasAttach: parts.length > 0 };
}

/**
 * Fetches envelope, flags, labels, size, thread id and BODYSTRUCTURE for a
 * range of messages — deliberately NEVER `BODY[]`. Full bodies are fetched
 * on demand, per part, by fetchBodyPart(). Bulk-fetching bodies here would
 * be simultaneously the storage blowup (10 GB instead of 1 GB across ten
 * mailboxes) and the fastest route to Gmail's ~2.5 GB/day ceiling, which
 * suspends IMAP for 24 hours across the affected account. (Spec L6)
 *
 * Returns an empty result rather than throwing for an empty or inverted UID
 * range (e.g. a freshly created mailbox, where uidNext is 1 and nothing has
 * ever been delivered) — see resolveUidSpan() for the range arithmetic,
 * including how `limit` caps the span even when `sinceUid` is set.
 */
export async function fetchHeaders(
  connection: ImapConnection,
  folder: string,
  range: FetchRange,
): Promise<FetchResult> {
  if (range.limit <= 0) return EMPTY_RESULT;

  const client = connection.rawClient();
  const lock = await client.getMailboxLock(folder);

  try {
    const mailbox = client.mailbox;
    if (typeof mailbox === 'boolean') {
      throw new Error(`account "${connection.accountId}": failed to open mailbox "${folder}"`);
    }

    // Captured once the mailbox is genuinely open, so every return below
    // this point (including the empty-span case) reports the real value
    // rather than EMPTY_RESULT's `null` — the mailbox WAS opened, and its
    // UIDVALIDITY is known, even when there is nothing to fetch this
    // cycle.
    const mailboxUidValidity = BigInt(mailbox.uidValidity);

    const span = resolveUidSpan(range, Number(mailbox.uidNext) - 1);
    if (!span) return { ...EMPTY_RESULT, uidValidity: mailboxUidValidity };

    const messages: MessageInput[] = [];
    const attachments = new Map<number, readonly AttachmentMeta[]>();
    const textParts = new Map<number, TextPart>();
    let bytesDownloaded = 0;

    for await (const message of client.fetch(
      uidRangeString(range, span),
      HEADER_FETCH_OPTIONS,
      { uid: true },
    )) {
      const parts = extractAttachments(message.bodyStructure);
      const textPart = firstTextPart(message.bodyStructure);
      const normalized = normalizeMessage(
        {
          uid: message.uid,
          size: message.size,
          flags: message.flags,
          labels: message.labels,
          threadId: message.threadId,
          envelope: message.envelope,
        },
        connection.accountId,
        folder,
      );

      messages.push(applyAttachmentFlag(normalized, parts));
      if (parts.length > 0) attachments.set(message.uid, parts);
      if (textPart !== null) textParts.set(message.uid, textPart);

      bytesDownloaded += ESTIMATED_BYTES_PER_HEADER_FETCH;
    }

    return { messages, attachments, textParts, bytesDownloaded, uidValidity: mailboxUidValidity };
  } finally {
    // Released unconditionally: Task 7 keeps these connections alive for
    // the process lifetime, so a lock leaked here on a thrown error would
    // wedge every later operation on this connection's mailbox.
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// Message previews (Plan 7 Task 1)
// ---------------------------------------------------------------------------

/**
 * How much of a text part one preview fetch pulls.
 *
 * This is a PARTIAL fetch (`<0.512>`), which is the whole reason previews
 * are affordable at all: the cost is 512 bytes whether the message is 2 KB
 * or 4 MB, so a mailbox full of newsletters with megabyte-sized HTML
 * bodies costs exactly the same as one full of one-liners. Sized against
 * SNIPPET_CHARS (280) with room to spare — quoted-printable and base64
 * both inflate, and the leading lines are often stripped as quotes or a
 * signature, so 512 raw bytes is roughly what it takes to reliably yield
 * 280 readable characters.
 */
export const PREVIEW_PART_BYTES = 512;

/**
 * Conservative fixed per-message charge for the byte budget, in the same
 * spirit — and for the same reason — as ESTIMATED_BYTES_PER_HEADER_FETCH
 * above: imapflow exposes no wire-byte counter, so this is an ESTIMATE,
 * and it is deliberately rounded UP rather than made exact.
 *
 * THE ARITHMETIC, per message:
 *   512  bytes  payload ceiling (PREVIEW_PART_BYTES, enforced by the
 *               server through the `<0.512>` partial — not by us after
 *               the fact)
 *  + ~48 bytes  untagged response framing:
 *               `* 1234 FETCH (UID 56789 BODY[1]<0> {512}\r\n` ... `)\r\n`
 *  + ~10 bytes  this UID's share of the request's sequence set
 *  = ~570 bytes  -> charged as 1024, ~1.8x headroom.
 *
 * WHAT THIS DOES TO THE DAILY BUDGET, worst case: a folder cycle fetches
 * at most HEADER_FETCH_LIMIT (50) messages, so previews add at most
 * 50 x 1024 = 50 KB on top of that folder's existing 100 KB header charge
 * — 150 KB per folder-fetch, 600 KB per account per four-folder cycle
 * (was 400 KB). At the floor cadence of 480 cycles/day that is ~281 MB/day
 * against DAILY_BYTE_LIMIT's 2 GiB, still under 15%.
 *
 * That worst case is also a one-time one: ConnectionPool only asks for a
 * preview for a message that has no snippet stored yet, so after the first
 * cycle over a given 50 UIDs the ongoing charge is zero, and the steady
 * state is the same ~187 MB/day it was before previews existed.
 *
 * Exported alongside the constant above so the pool charges the same
 * number this module reports, rather than duplicating the literal.
 */
export const ESTIMATED_BYTES_PER_PREVIEW_FETCH = 1024;

/**
 * The fetch options for one preview, as sent to imapflow.
 *
 * A FUNCTION rather than a frozen object because the part number is
 * resolved per message from BODYSTRUCTURE (see firstTextPart) — but it is
 * pinned by an exact-shape assertion in tests/fetch-unit.test.ts exactly
 * the way HEADER_FETCH_OPTIONS is, and by a second test that compiles it
 * through imapflow's own command builder and asserts the literal wire
 * command. Two properties are load-bearing and neither is negotiable:
 *
 *  - PEEK. imapflow renders every `bodyParts` entry as `BODY.PEEK[...]`,
 *    never a bare `BODY[...]`. That is what keeps fetching a preview from
 *    setting `\Seen` and silently marking the owner's unread mail as read
 *    — a bug that would be immediately visible and impossible to undo.
 *    Any rewrite of this that reaches for `query.source`, `client.download()`
 *    or a raw FETCH must prove the same property before it ships.
 *  - The `<0.512>` partial. Without it the same call downloads the ENTIRE
 *    part, and the estimate above stops being an estimate of anything.
 */
export function previewFetchOptions(partId: string): FetchQueryObject {
  return {
    uid: true,
    bodyParts: [{ key: partId, start: 0, maxLength: PREVIEW_PART_BYTES }],
  };
}

/** One message a preview is wanted for, and the part to take it from. */
export interface PreviewTarget {
  readonly uid: number;
  readonly part: TextPart;
}

export interface PreviewFetchResult {
  /** Preview text by UID. A message whose fetch failed, whose part came
   *  back empty, or whose first 512 bytes were entirely quoted text or
   *  stylesheet is simply absent — never present with an empty string. */
  readonly previews: ReadonlyMap<number, string>;
  readonly bytesDownloaded: number;
}

const EMPTY_PREVIEW_RESULT: PreviewFetchResult = { previews: new Map(), bytesDownloaded: 0 };

/**
 * Groups targets by part number so the whole batch costs one IMAP round
 * trip per DISTINCT part number rather than one per message. Real mail
 * clusters hard into two or three shapes ('1' for singlepart, '1.1' for
 * multipart/alternative), so 50 messages is typically two fetches.
 */
function groupByPartId(targets: readonly PreviewTarget[]): Map<string, PreviewTarget[]> {
  const groups = new Map<string, PreviewTarget[]>();
  for (const target of targets) {
    const existing = groups.get(target.part.partId);
    if (existing) existing.push(target);
    else groups.set(target.part.partId, [target]);
  }
  return groups;
}

/**
 * Fetches a bounded, PEEK'd preview for each given message.
 *
 * This is a SEPARATE, separately-budgeted step from fetchHeaders() on
 * purpose. HEADER_FETCH_OPTIONS is frozen by an exact-shape test because
 * ESTIMATED_BYTES_PER_HEADER_FETCH is only a valid estimate for a
 * header-only fetch; adding a body-bearing key there would silently make
 * the budget lie. Previews instead carry their own options
 * (previewFetchOptions), their own per-message estimate
 * (ESTIMATED_BYTES_PER_PREVIEW_FETCH), and their own reservation at the
 * call site — so the budget sees these bytes rather than absorbing them
 * into a number that was never sized for them.
 *
 * FAILURE IS NEVER FATAL TO A MESSAGE. A part group whose fetch throws is
 * logged — with the account, folder, part number and message COUNT, never
 * any body content — and simply contributes no previews; the caller still
 * upserts every one of those messages with a null snippet. One bad part
 * group does not cost the others their previews either, which is why the
 * catch is inside the loop.
 *
 * Bytes are charged for every message ATTEMPTED, including a group that
 * threw: bytes may well have crossed the wire before the failure, and
 * under-charging the budget is the one direction that risks a 24-hour
 * IMAP lockout.
 */
export async function fetchPreviews(
  connection: ImapConnection,
  folder: string,
  targets: readonly PreviewTarget[],
): Promise<PreviewFetchResult> {
  if (targets.length === 0) return EMPTY_PREVIEW_RESULT;

  const client = connection.rawClient();
  const lock = await client.getMailboxLock(folder);

  try {
    const previews = new Map<number, string>();
    let bytesDownloaded = 0;

    for (const [partId, group] of groupByPartId(targets)) {
      bytesDownloaded += group.length * ESTIMATED_BYTES_PER_PREVIEW_FETCH;
      const partByUid = new Map(group.map((target) => [target.uid, target.part]));

      try {
        for await (const message of client.fetch(
          group.map((target) => target.uid).join(','),
          previewFetchOptions(partId),
          { uid: true },
        )) {
          // imapflow strips the `<0>` partial suffix from the response key
          // before building this map, so the part number we asked for is
          // the key we read back.
          const raw = message.bodyParts?.get(partId);
          const part = partByUid.get(message.uid);
          if (!raw || !part) continue;

          const text = previewTextFrom(raw, part);
          if (text.length > 0) previews.set(message.uid, text);
        }
      } catch (error) {
        console.error(
          `account "${connection.accountId}" folder "${folder}": preview fetch failed for part ` +
            `"${partId}" (${group.length} message(s)); those messages sync without a preview`,
          error,
        );
      }
    }

    return { previews, bytesDownloaded };
  } finally {
    // See fetchHeaders() above — same leaked-lock hazard, same fix.
    lock.release();
  }
}

/**
 * Hard ceiling on a single on-demand body/attachment fetch.
 *
 * Why a cap exists at all: this service is sized for a GCP always-free
 * e2-micro — 1 GB of RAM shared with Postgres and up to ten live IMAP
 * connections. fetchBodyPart() accumulates the part in memory, and the API
 * buffers it again on the way out, so peak footprint is roughly twice the
 * part size. Uncapped, Gmail's own 50 MB message ceiling would translate
 * into ~100 MB of transient heap for one request, and /api/message/.../body
 * downloads the WHOLE raw message including every attachment, so that is
 * not a hypothetical worst case.
 *
 * Why 32 MB specifically: it is comfortably under Gmail's 50 MB message
 * ceiling (so the cap is a real, reachable bound rather than dead code),
 * it covers essentially every attachment a human actually sends, and at a
 * ~64 MB peak it stays a small fraction of 1 GB even with several requests
 * in flight. Requests above it are refused with 413 rather than served —
 * an OOM-killed process takes all ten accounts' connections down with it,
 * which is strictly worse than one refused download.
 */
export const MAX_BODY_PART_BYTES = 32 * 1024 * 1024;

/**
 * Thrown by fetchBodyPart() when a part exceeds MAX_BODY_PART_BYTES. A
 * distinct type (rather than a string match on the message) is what lets
 * the API answer 413 for this case while still answering 502 for a genuine
 * IMAP failure.
 *
 * Note: an explicit field assignment, not a TypeScript parameter property —
 * the service runs under --experimental-strip-types, which rejects those.
 */
export class BodyPartTooLargeError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(`body part exceeds the ${limitBytes}-byte maximum`);
    this.name = 'BodyPartTooLargeError';
    this.limitBytes = limitBytes;
  }
}

/**
 * Fetches one body part (e.g. an attachment's bytes) on demand, by IMAP part
 * number, or the whole raw message when `partId` is omitted. This is NOT
 * part of the sync loop — fetchHeaders() never calls it, and nothing in
 * this module wires it into a per-message loop. It exists for Task 8's API:
 * the full-body route calls it with no `partId` (imapflow's own
 * `download()` returns the whole raw message source in that case), the
 * attachment route calls it with the attachment's own `partId`. That split
 * is what keeps sync itself header-only. Do not call this from
 * fetchHeaders() or any bulk loop "for convenience" — that reintroduces the
 * exact BODY[]-during-sync problem this module exists to avoid.
 *
 * Bounded by `maxBytes` (default MAX_BODY_PART_BYTES): the running total is
 * checked BEFORE each chunk is retained, so an oversized part is abandoned
 * partway rather than fully accumulated and then rejected. Breaking out of
 * the for-await closes the underlying stream via the iterator's return().
 *
 * The caller is responsible for charging the returned bytes against the
 * per-account daily budget (spec L6) — these bytes travel the same
 * connection Gmail meters. See routes.ts's fetchBudgetedPart.
 */
export async function fetchBodyPart(
  connection: ImapConnection,
  folder: string,
  uid: number,
  partId?: string,
  maxBytes: number = MAX_BODY_PART_BYTES,
): Promise<Buffer> {
  const client = connection.rawClient();
  const lock = await client.getMailboxLock(folder);

  try {
    const download = await client.download(String(uid), partId, { uid: true });
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of download.content) {
      const buffer = chunk as Buffer;
      total += buffer.length;
      if (total > maxBytes) throw new BodyPartTooLargeError(maxBytes);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  } finally {
    // See fetchHeaders() above — same leaked-lock hazard, same fix.
    lock.release();
  }
}
