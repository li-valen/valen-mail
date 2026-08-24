import type { FetchQueryObject } from 'imapflow';
import type { ImapConnection } from './connection';
import type { MessageInput } from '../db';
import type { AttachmentMeta } from '../attachments';
import { extractAttachments } from '../attachments.ts';
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
  readonly bytesDownloaded: number;
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

const EMPTY_RESULT: FetchResult = { messages: [], attachments: new Map(), bytesDownloaded: 0 };

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

    const span = resolveUidSpan(range, Number(mailbox.uidNext) - 1);
    if (!span) return EMPTY_RESULT;

    const messages: MessageInput[] = [];
    const attachments = new Map<number, readonly AttachmentMeta[]>();
    let bytesDownloaded = 0;

    for await (const message of client.fetch(
      `${span.lowestUid}:${span.highestUid}`,
      HEADER_FETCH_OPTIONS,
      { uid: true },
    )) {
      const parts = extractAttachments(message.bodyStructure);
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

      bytesDownloaded += ESTIMATED_BYTES_PER_HEADER_FETCH;
    }

    return { messages, attachments, bytesDownloaded };
  } finally {
    // Released unconditionally: Task 7 keeps these connections alive for
    // the process lifetime, so a lock leaked here on a thrown error would
    // wedge every later operation on this connection's mailbox.
    lock.release();
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
 */
export async function fetchBodyPart(
  connection: ImapConnection,
  folder: string,
  uid: number,
  partId?: string,
): Promise<Buffer> {
  const client = connection.rawClient();
  const lock = await client.getMailboxLock(folder);

  try {
    const download = await client.download(String(uid), partId, { uid: true });
    const chunks: Buffer[] = [];
    for await (const chunk of download.content) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  } finally {
    // See fetchHeaders() above — same leaked-lock hazard, same fix.
    lock.release();
  }
}
