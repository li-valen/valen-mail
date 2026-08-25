import type { AttachmentMeta } from '../attachments';
import type { BudgetDecision } from '../budget';
import type { AttachmentInput, MessageInput, SyncStateInput } from '../db';
import type { ImapConnection } from './connection';
import type { UidSpan } from './fetch';
import type { DiscoveredFolders } from './folders';
import type { PreviewBudget, PreviewStore } from './previews';
import { folderSyncOrder } from './folders.ts';
import { BACKFILL_SHARE, DAILY_BYTE_LIMIT } from '../budget.ts';
import { ESTIMATED_BYTES_PER_HEADER_FETCH, fetchHeaders } from './fetch.ts';
import { collectPreviews } from './previews.ts';
import { applySnippet } from '../normalize.ts';

/**
 * Historical backfill (Plan 8 Task 1): the second, lower-priority pass that
 * walks a folder BACKWARDS from the oldest UID already synced, one bounded
 * page per cycle, until it reaches the bottom of the mailbox.
 *
 * Live sync (ConnectionPool.syncFolder) polls the newest HEADER_FETCH_LIMIT
 * (50) UIDs and stops. That is what made the shipped inbox three days deep
 * on the primary account and six on the personal one: search and browse
 * could only ever reach that window. This module is the other half — the
 * one that makes "last month's email" a thing the product can answer.
 *
 * Its own module rather than more methods on ConnectionPool, matching how
 * ./backoff.ts, ./keyed-mutex.ts, ./new-mail-marks.ts, ./folder-cache.ts
 * and ./previews.ts were split out of that same file: pool.ts sits near
 * the project's 800-line ceiling, and this is a self-contained decision
 * that needs four narrow capabilities (a store, a byte budget, a
 * connection, a folder name) rather than the pool's whole surface. Taking
 * those as an options object — instead of a ConnectionPool — is also what
 * lets it be tested without one.
 *
 * THREE PROPERTIES ARE LOAD-BEARING AND NONE IS NEGOTIABLE:
 *
 *  - NO NOTIFICATIONS, EVER. See "SUPPRESSION" on runBackfillPage below.
 *    Backfilling months of mail must not produce months of phone buzzes.
 *  - NO SECOND CONNECTION. This runs inside ConnectionPool's existing
 *    per-account cycle, under the existing per-account mutex, on the same
 *    ImapConnection, AFTER live sync. Gmail allows ~15 concurrent
 *    connections per account and this project has a reconnect-storm
 *    history; a backfill that opened its own connection would spend both.
 *  - BUDGET FIRST. Every page reserves and records against the same
 *    per-account daily byte budget live sync uses, capped at
 *    BACKFILL_BYTE_LIMIT so a backfill can never spend the allowance new
 *    mail needs. See that constant for the arithmetic.
 *
 * Note: parameter properties and enums are avoided project-wide because
 * the service runs under --experimental-strip-types.
 */

/**
 * How many UIDs one backfill page covers.
 *
 * THE ARITHMETIC: a header page costs ESTIMATED_BYTES_PER_HEADER_FETCH
 * (2048) bytes per message, so 200 x 2048 = 409,600 bytes — ~400 KB — per
 * page, plus at most 200 x ESTIMATED_BYTES_PER_PREVIEW_FETCH (1024) =
 * ~200 KB of previews for the messages that page turns out to contain,
 * for a ~600 KB worst-case page.
 *
 * WHAT THAT COSTS PER DAY, worst case: one page per folder per cycle, four
 * folders per account = ~2.4 MB per account per full cycle. At the FLOOR
 * cadence of one cycle per IDLE_LIVENESS_CHECK_INTERVAL_MS (180s) = 480
 * cycles/day, that is ~1.15 GB/day against BACKFILL_BYTE_LIMIT's 1.4 GiB —
 * inside the share, with live sync's own ~281 MB/day (see
 * ESTIMATED_BYTES_PER_PREVIEW_FETCH) still comfortably under the remaining
 * 30%. The budget, not this constant, is the real enforcement; this
 * constant is what keeps ONE page's mutex hold and memory footprint
 * bounded so a cycle stays a cycle.
 *
 * 200 rather than 1000: the page is fetched while this account's mutex is
 * held, so it delays the liveness probe and any on-demand API download
 * queued behind it. 200 envelopes is a single round trip of a few hundred
 * kilobytes — seconds, not minutes.
 */
export const BACKFILL_PAGE_SIZE = 200;

/**
 * The lowest UID an IMAP mailbox can assign (RFC 3501: UIDs are strictly
 * positive). This is the walk's terminator — a folder whose backfill has
 * covered UID 1 has no history left below it, by definition.
 */
const LOWEST_IMAP_UID = 1;

/**
 * The ceiling a backfill reservation is measured against, rather than
 * DAILY_BYTE_LIMIT itself: 0.7 x 2 GiB = ~1.4 GiB.
 *
 * `used` in that comparison is the account's TOTAL for the day (live sync,
 * previews, on-demand API downloads AND backfill — they all share one
 * counter), so what this actually enforces is "backfill stops asking for
 * more once the account has spent 70% of its day", leaving the remaining
 * 30% for new mail. That is the whole point of BACKFILL_SHARE and the
 * reason it was written before there was a backfill to apply it: without
 * it, a backfill exhausts the day's allowance and new mail stops arriving
 * until midnight.
 *
 * Deliberately NOT a second budget counter keyed by purpose. One counter
 * with two limits needs no schema change and cannot drift out of sync with
 * itself; two counters would need both.
 */
export const BACKFILL_BYTE_LIMIT = Math.floor(DAILY_BYTE_LIMIT * BACKFILL_SHARE);

/** The two byte-budget operations this needs, structurally rather than by
 *  class — ../budget.ts's ByteBudget satisfies it, and so does a fake.
 *  Unlike PreviewBudget's, this `reserve` takes the explicit limit, which
 *  is how the backfill share is applied at all. */
export interface BackfillBudget {
  reserve(accountId: string, bytes: number, limit?: number): Promise<BudgetDecision>;
  record(accountId: string, bytes: number): Promise<void>;
}

/**
 * The store operations one backfill page needs. `Db` satisfies this; a
 * fake satisfies it too, which is what lets the whole pass be tested
 * without Postgres.
 *
 * Extends PreviewStore because a backfilled page goes through the same
 * ./previews.ts collectPreviews as a live one — old mail with no preview
 * is exactly as useless in search as new mail with no preview.
 */
export interface BackfillStore extends PreviewStore {
  upsertMessage(message: MessageInput): Promise<void>;
  upsertAttachment(attachment: AttachmentInput): Promise<void>;
  getSyncState(accountId: string, folder: string): Promise<SyncStateInput | null>;
  setSyncState(accountId: string, folder: string, state: SyncStateInput): Promise<void>;
  getOldestSyncedUid(accountId: string, folder: string): Promise<number | null>;
}

/** Everything one backfill page needs except which folder it is for. */
export interface BackfillContext {
  readonly db: BackfillStore;
  readonly budget: BackfillBudget;
  readonly accountId: string;
  readonly connection: ImapConnection;
  /** Test seam. Production callers take BACKFILL_PAGE_SIZE. */
  readonly pageSize?: number;
}

export interface BackfillPageOptions extends BackfillContext {
  readonly folder: string;
}

/**
 * What one cycle's backfill attempt did for one folder.
 *
 * SUPPRESSION LIVES IN THIS TYPE (Plan 8 global constraint: backfilled
 * messages MUST NOT notify). There is no `messages` field, and there never
 * may be one: counts and a UID span are all a caller gets back, so there
 * is no value here that could be handed to ConnectionPool's
 * OnNewMessagesHandler even by accident. Combined with this module never
 * touching NewMailMarks at all (see runBackfillPage), that makes "a
 * backfill page produces zero dispatch calls" a property of the SHAPE of
 * the code rather than of a conditional somebody could invert.
 */
export interface BackfillPageResult {
  /**
   *  - 'paged'            a page was fetched and written.
   *  - 'complete'         this folder's history is fully synced; nothing
   *                       was fetched and nothing ever will be again.
   *  - 'nothing-to-walk'  no rows for this folder yet, so there is no
   *                       oldest UID to walk back from. Live sync has to
   *                       land something first. Not terminal.
   *  - 'budget-exhausted' the backfill share is spent for today. Not
   *                       terminal — it resumes when the budget rolls over.
   */
  readonly status: 'paged' | 'complete' | 'nothing-to-walk' | 'budget-exhausted';
  readonly span: UidSpan | null;
  readonly messageCount: number;
  readonly bytesCharged: number;
}

const COMPLETE: BackfillPageResult = { status: 'complete', span: null, messageCount: 0, bytesCharged: 0 };
const NOTHING_TO_WALK: BackfillPageResult = { status: 'nothing-to-walk', span: null, messageCount: 0, bytesCharged: 0 };
const BUDGET_EXHAUSTED: BackfillPageResult = { status: 'budget-exhausted', span: null, messageCount: 0, bytesCharged: 0 };

/**
 * The lowest UID this (account, folder) has already covered — everything
 * at or above it is synced, everything below it is what backfill still
 * owes. `null` means there is no floor yet at all.
 *
 * Two sources, in priority order, and the order matters:
 *
 *  - The persisted watermark (`sync_state.last_seen_uid`) when it is set.
 *    This is what makes the walk RESUMABLE: it is written after every
 *    page, so a restart mid-backfill continues from where it stopped
 *    rather than starting the whole mailbox over.
 *  - Otherwise the oldest row already in `messages` for this folder, which
 *    is where live sync's newest-50 poll happens to have left off. That is
 *    the FIRST run's starting point and the reason the very first page
 *    leaves no gap: live sync covered [oldest, newest], so backfill starts
 *    at oldest - 1 and walks down.
 *
 * `null` when neither exists — a folder nothing has synced yet. Backfill
 * declines rather than guessing: with no floor, "walk backwards from here"
 * has no here, and picking the mailbox's top instead would re-download the
 * newest 50 UIDs live sync already owns.
 *
 * Pure, and exported so tests/backfill.test.ts can prove this without a
 * database.
 */
export function backfillFloor(
  state: SyncStateInput | null,
  oldestSyncedUid: number | null,
): number | null {
  const watermark = state === null ? 0 : Number(state.lastSeenUid);
  if (watermark > 0) return watermark;
  if (oldestSyncedUid !== null && oldestSyncedUid > 0) return oldestSyncedUid;
  return null;
}

/**
 * The inclusive UID span to fetch next for one (account, folder), or
 * `null` when there is nothing to fetch.
 *
 * THE PAGING RULE, in one line: the page is the `pageSize` UIDs
 * immediately BELOW the floor — `[max(1, floor - pageSize), floor - 1]`.
 *
 * That is what makes consecutive pages tile the mailbox with neither a gap
 * nor an overlap: the watermark written after each page IS that page's
 * `lowestUid`, so the next page's floor is exactly where this one started.
 * (An overlap would be harmless anyway — every write goes through
 * `upsertMessage`, idempotent on (account_id, folder, uid) — but a GAP
 * would be silent lost mail, which is the failure this arithmetic exists
 * to make impossible.)
 *
 * `null` in exactly three cases, which the caller distinguishes with
 * backfillFloor() above:
 *  - the folder is already marked `backfill_done` — terminal;
 *  - the floor has reached UID 1, so there is no UID left below it —
 *    terminal, and what the caller turns INTO `backfill_done`;
 *  - there is no floor at all yet (nothing synced) — not terminal.
 *
 * Pure and unit-tested (tests/backfill.test.ts): the whole paging decision
 * is provable without a database or an IMAP server, which is the point of
 * it being a standalone function rather than three lines inside the fetch
 * path.
 */
export function nextBackfillPage(
  state: SyncStateInput | null,
  oldestSyncedUid: number | null,
  pageSize: number = BACKFILL_PAGE_SIZE,
): UidSpan | null {
  if (state?.backfillDone) return null;
  // Defensive rather than reachable: a non-positive page size would build
  // an inverted range, and `UID a:b` with a > b is a malformed fetch.
  if (pageSize <= 0) return null;

  const floor = backfillFloor(state, oldestSyncedUid);
  if (floor === null) return null;

  const highestUid = floor - 1;
  if (highestUid < LOWEST_IMAP_UID) return null;

  return { lowestUid: Math.max(LOWEST_IMAP_UID, highestUid - pageSize + 1), highestUid };
}

/**
 * The preview half of a backfilled page, budgeted against the BACKFILL
 * share rather than the whole daily limit.
 *
 * ./previews.ts's PreviewBudget deliberately has no `limit` parameter — it
 * was written for live sync, which spends against the full allowance. This
 * adapter is what keeps a backfill's previews inside the same 70% ceiling
 * as its headers instead of quietly reaching past it into the 30% reserved
 * for new mail. It is exactly why PreviewBudget is a structural interface
 * and not `ByteBudget`.
 */
function shareLimited(budget: BackfillBudget): PreviewBudget {
  return {
    reserve: (accountId, bytes) => budget.reserve(accountId, bytes, BACKFILL_BYTE_LIMIT),
    record: (accountId, bytes) => budget.record(accountId, bytes),
  };
}

/**
 * Writes one fetched page: each message with whatever preview was
 * collected for it, then that message's attachment metadata.
 *
 * Attachments come AFTER their message's own row, never before —
 * `attachments` has a foreign key onto messages(account_id, folder, uid),
 * so the reverse order fails outright on a message this page is seeing for
 * the first time, which every backfilled message is. (Same constraint, and
 * the same ordering, as ConnectionPool.persistAttachments; deliberately
 * duplicated rather than shared so live sync's write path is not touched
 * by this task at all.)
 */
async function persistPage(
  options: BackfillPageOptions,
  messages: readonly MessageInput[],
  attachments: ReadonlyMap<number, readonly AttachmentMeta[]>,
  previews: ReadonlyMap<number, string>,
): Promise<void> {
  const { accountId, db, folder } = options;
  for (const message of messages) {
    await db.upsertMessage(applySnippet(message, previews.get(message.uid) ?? null));
    for (const part of attachments.get(message.uid) ?? []) {
      await db.upsertAttachment({
        accountId,
        folder,
        uid: message.uid,
        partId: part.partId,
        filename: part.filename,
        mimeType: part.mimeType,
        sizeBytes: part.sizeBytes,
      });
    }
  }
}

/**
 * Runs at most ONE backfill page for one (account, folder), on the
 * connection the caller already holds.
 *
 * SUPPRESSION — the constraint this function exists under, stated where it
 * is enforced: nothing here imports, constructs or calls NewMailMarks, and
 * nothing here returns a MessageInput. A backfilled message is written to
 * Postgres and that is the end of it. The high-water mark cannot move
 * (forwards or BACKWARDS) because it is never touched, and no message can
 * reach ConnectionPool's dispatch hook because BackfillPageResult has no
 * channel to carry one.
 *
 * Deliberately not routed through ConnectionPool.syncFolder even though
 * that method does nearly the same reserve/fetch/preview/upsert work: it
 * calls `marks.track()` and RETURNS the messages it decided were new,
 * straight into the map syncOnce dispatches from. Reusing it is the one
 * refactor that turns "backfill a year of mail" into "buzz a phone a
 * thousand times", so this pass has its own write path on purpose.
 *
 * Worse, `track()` treats a folder's first call as a baseline — so a
 * backfill page that got there first would baseline the mark at a LOW uid
 * and then report live sync's entire newest-50 poll as new on the very
 * next cycle. Not calling it at all is what makes both failures
 * unreachable.
 *
 * Never throws for an ordinary IMAP or budget outcome; a genuine failure
 * (mailbox will not open, Postgres unreachable) propagates to the caller,
 * which logs it and keeps going — see ConnectionPool.backfillFolders for
 * why a backfill failure must not be treated as a connection-health signal
 * the way an INBOX live-sync failure is.
 */
export async function runBackfillPage(
  options: BackfillPageOptions,
): Promise<BackfillPageResult> {
  const { accountId, budget, connection, db, folder } = options;
  const pageSize = options.pageSize ?? BACKFILL_PAGE_SIZE;

  const state = await db.getSyncState(accountId, folder);
  // The terminal check comes first and costs one indexed lookup: a folder
  // that finished its walk months ago must not pay for an oldest-UID scan
  // on every cycle forever.
  if (state?.backfillDone) return COMPLETE;

  const oldestSyncedUid = await db.getOldestSyncedUid(accountId, folder);
  if (backfillFloor(state, oldestSyncedUid) === null) return NOTHING_TO_WALK;

  const span = nextBackfillPage(state, oldestSyncedUid, pageSize);
  if (span === null) {
    // The floor exists and has reached UID 1: the walk is over. Recorded
    // rather than merely returned, so no later cycle even asks again.
    await markComplete(options, state);
    return COMPLETE;
  }

  const spanSize = span.highestUid - span.lowestUid + 1;
  const requested = spanSize * ESTIMATED_BYTES_PER_HEADER_FETCH;
  const decision = await budget.reserve(accountId, requested, BACKFILL_BYTE_LIMIT);
  if (!decision.allowed) {
    // The whole point of the share: backfill stops, live sync does not.
    // syncFolder reserves against the FULL DAILY_BYTE_LIMIT and is
    // therefore still allowed at this moment — new mail keeps arriving
    // while history stops filling, which is the correct order to starve
    // these two in.
    console.error(
      `account "${accountId}" folder "${folder}": backfill byte share exhausted, skipping this ` +
        `page (requested ${requested}, remaining ${decision.remaining})`,
    );
    return BUDGET_EXHAUSTED;
  }

  const result = await fetchHeaders(connection, folder, {
    limit: spanSize,
    sinceUid: span.lowestUid,
  });

  // RECORDED BEFORE collectPreviews RESERVES, never after the upserts.
  // A reservation is advisory — it is a read of a snapshot, not a hold —
  // so previews measured against a snapshot taken before this fetch was
  // charged would be reserving against an allowance that pretends the
  // fetch never happened, and the guard above would be unreachable for
  // exactly the reason syncFolder documents. Zero bytes (an empty span, a
  // range whose messages were all deleted) is skipped rather than charged
  // as a literal 0, which would add nothing but noise to the accounting.
  if (result.bytesDownloaded > 0) await budget.record(accountId, result.bytesDownloaded);

  const previews = await collectPreviews({
    db,
    budget: shareLimited(budget),
    accountId,
    connection,
    folder,
    result,
  });

  await persistPage(options, result.messages, result.attachments, previews);

  // The watermark is written AFTER the rows it describes, so a crash
  // mid-page leaves the watermark where it was and the next cycle re-fetches
  // that page — harmless, because upsertMessage is idempotent on
  // (account_id, folder, uid). The reverse order would skip a page whose
  // messages were never written: silent lost mail.
  const complete = span.lowestUid <= LOWEST_IMAP_UID;
  await db.setSyncState(accountId, folder, {
    uidValidity: result.uidValidity ?? state?.uidValidity ?? null,
    lastSeenUid: BigInt(span.lowestUid),
    backfillDone: complete,
  });

  logPage(accountId, folder, span, result.messages.length, result.bytesDownloaded, complete);
  return {
    status: 'paged',
    span,
    messageCount: result.messages.length,
    bytesCharged: result.bytesDownloaded,
  };
}

/** Marks a folder's walk finished without fetching anything: the floor had
 *  already reached LOWEST_IMAP_UID, which backfillFloor guarantees is the
 *  only way to get here (it never returns a value below 1). */
async function markComplete(
  options: BackfillPageOptions,
  state: SyncStateInput | null,
): Promise<void> {
  await options.db.setSyncState(options.accountId, options.folder, {
    uidValidity: state?.uidValidity ?? null,
    lastSeenUid: BigInt(LOWEST_IMAP_UID),
    backfillDone: true,
  });
  console.error(
    `account "${options.accountId}" folder "${options.folder}": backfill complete — history is ` +
      `synced down to uid ${LOWEST_IMAP_UID}`,
  );
}

/**
 * One line per completed page, so an operator can watch a multi-hour
 * backfill progress instead of guessing whether it is running.
 *
 * ACCOUNT ID, FOLDER, UID SPAN, COUNT AND BYTES ONLY — never a subject,
 * never an address, never any part of a body. This log goes to the same
 * journald stream as every other line this service writes, and mail
 * content does not belong there.
 *
 * console.error rather than console.log because stderr is this service's
 * only operator channel — the same one folder-cache.ts's missing-folder
 * line and new-mail-marks.ts's UIDVALIDITY line use, neither of which is
 * an error either.
 */
function logPage(
  accountId: string,
  folder: string,
  span: UidSpan,
  messageCount: number,
  bytesDownloaded: number,
  complete: boolean,
): void {
  console.error(
    `account "${accountId}" folder "${folder}": backfill page uid ${span.lowestUid}:${span.highestUid} ` +
      `— ${messageCount} message(s), ${bytesDownloaded} byte(s)` +
      (complete ? '; backfill complete, history is fully synced' : ''),
  );
}

/**
 * One backfill page per discovered folder — the whole of an account's
 * backfill for one sync cycle, and the only thing ConnectionPool calls.
 *
 * EVERY folder's failure is best-effort here, INCLUDING INBOX. That is the
 * one place this deliberately differs from the pool's live folder loop,
 * where an INBOX failure IS the connection's health signal and propagates
 * into runAccount()'s reconnect ladder. A backfill page failing says
 * nothing about whether new mail can arrive, and tearing down a healthy
 * connection over one would turn a bad page into this project's old
 * reconnect storm: one per cycle, forever, against a working account.
 *
 * Sequential, not concurrent: every folder here shares one imapflow
 * client, which serialises commands per connection anyway, and each page
 * is bounded by BACKFILL_PAGE_SIZE so a cycle's mutex hold stays a
 * cycle's.
 *
 * Returns nothing. See runBackfillPage's SUPPRESSION note — there is no
 * value for a caller to hand a notification hook, by construction.
 */
export async function runBackfillCycle(
  context: BackfillContext,
  folders: DiscoveredFolders,
): Promise<void> {
  for (const target of folderSyncOrder(folders)) {
    try {
      await runBackfillPage({ ...context, folder: target.path });
    } catch (error) {
      // Account id and folder name only — never a subject or an address.
      console.error(
        `account "${context.accountId}": backfill page for folder "${target.path}" failed, ` +
          'continuing with the rest of the cycle',
        error,
      );
    }
  }
}
