import type { MessageInput } from '../db';

/**
 * Amendment 3's backfill guard: the per-(account, folder) high-water mark
 * that decides which of a cycle's fetched messages are genuinely new.
 *
 * Extracted from imap/pool.ts when multi-folder sync (Plan 5) landed —
 * this is the same reviewed logic, moved rather than rewritten, for two
 * reasons. It is a self-contained piece of bookkeeping with no dependency
 * on connections, budgets or dispatch, so it unit-tests without a pool at
 * all; and pool.ts was already at 764 lines against this project's 800-line
 * ceiling, which the folder loop would have blown through.
 *
 * Note: parameter properties are avoided project-wide because the service
 * runs under --experimental-strip-types, which does not support them.
 */

/**
 * Marks are keyed per (account, folder), not per account.
 *
 * Per-account keying was correct while INBOX was the only synced folder;
 * with four, a single shared mark is actively wrong in both directions.
 * Sent UIDs and INBOX UIDs come from independent numbering spaces on the
 * server, so one folder's higher UIDs would suppress the other folder's
 * genuinely new mail (a Sent message at uid 900 would silence every INBOX
 * message below 900 forever), and a folder whose UIDs happen to be lower
 * would report its entire newest-50 poll as new on every single cycle.
 *
 * The NUL separator cannot appear in an IMAP mailbox name or in this
 * service's account ids, so no (account, folder) pair can collide with
 * another by concatenation — `a` + `bc` and `ab` + `c` stay distinct.
 */
function markKey(accountId: string, folder: string): string {
  return `${accountId}\u0000${folder}`;
}

export class NewMailMarks {
  // Deliberately in-memory, not persisted: that is exactly what makes "a
  // fresh service start against an existing mailbox produces zero new-mail
  // notifications" hold on every restart, not just the very first one —
  // see track() below.
  private readonly firstCycleDone = new Set<string>();
  private readonly maxSeenUid = new Map<string, number>();
  // Fix round 1, Fix 3: the UIDVALIDITY the mark above was computed
  // against. A change here means the server renumbered the mailbox, which
  // invalidates `maxSeenUid` the same way a first cycle does — see track().
  private readonly seenUidValidity = new Map<string, bigint>();

  /**
   * Amendment 3 (backfill guard). Decides which of this cycle's fetched
   * messages are genuinely new — arrived since the last cycle THIS PROCESS
   * observed for this account and folder — and returns only those. A
   * folder's first cycle always returns an empty array, no matter how many
   * messages it fetched: that cycle only establishes the high-water mark,
   * it never reports anything as new.
   *
   * Because the mark is keyed per (account, folder), that guarantee is
   * per folder too: a fresh service start against existing mailboxes fires
   * nothing from INBOX, Sent, Spam or Trash, and each folder's first cycle
   * baselines independently of when the others had theirs.
   *
   * LIMITATION, stated plainly (Fix round 1, Fix 4 — the previous wording
   * here ("indistinguishable from have always been there") was not
   * accurate and is corrected): this is not just "old mail is silently
   * skipped". Mail that arrives WHILE THE SERVICE IS DOWN — a 10-minute
   * outage, a deploy, a crash-restart loop — is genuinely new and the
   * account's own recipient has never seen a notification for it, but the
   * first cycle after the restart folds it into the baseline exactly like
   * mail that has sat in the inbox for months. There is no signal at this
   * layer (a UID and a fetch timestamp) that can tell those two cases
   * apart. This is the accepted trade-off Amendment 3 makes: missing some
   * notifications after a restart is safe-direction and tolerable;
   * buzzing for the newest ~50 messages on every single restart is not.
   *
   * The three maps are in-memory and reset on every process restart BY
   * DESIGN — this pool has no durable resume point today (spec 9 / L9's
   * known limitation: the newest-50 poll, not a backfill), so there is no
   * reliable persisted watermark to compare against anyway. The in-memory
   * guard turns that same limitation into the correct behaviour for
   * notifications specifically: every restart re-earns "new" from a clean
   * baseline instead of trusting stale state.
   *
   * On a LATER cycle, only messages whose UID exceeds that folder's
   * previous high-water mark count as new. This is also what stops the
   * same ~50-newest poll from re-notifying every cycle: a liveness-probe
   * -triggered re-poll (every IDLE_LIVENESS_CHECK_INTERVAL_MS at most) or
   * a flag change re-fetches UIDs already at or below the mark, and they
   * are filtered out here rather than by whatever the caller does with
   * them.
   *
   * Fix round 1, Fix 3: the mark is also invalidated on a UIDVALIDITY
   * change, and re-baselined exactly like a first cycle (report nothing
   * this cycle, log one line, resume comparing on the NEXT cycle). Without
   * this, a UIDVALIDITY change where the server starts numbering from a
   * lower value makes `uid > previousMax` false for every message for the
   * rest of the process's life — a silent, permanent stop to every
   * new-mail notification for that folder until something happens to
   * restart the process. A real Gmail UIDVALIDITY change is rare enough
   * that logging it is a signal, not spam. UIDVALIDITY belongs to a single
   * mailbox, so this re-baseline is per folder too: Trash being renumbered
   * must not reset INBOX's mark.
   *
   * Runs unconditionally, whether or not the caller has a hook configured
   * — the bookkeeping itself must stay correct so that installing a hook
   * later in the process's life (there is no such caller today, but
   * nothing here assumes there won't be) sees an accurate baseline rather
   * than one that stopped updating. It also runs for folders whose
   * messages are never dispatched at all (Sent, Spam, Trash — see
   * ConnectionPool's INBOX-only dispatch guard), so that if those folders
   * ever DO gain a notification path, they start from a real baseline.
   */
  track(
    accountId: string,
    folder: string,
    messages: readonly MessageInput[],
    uidValidity: bigint | null,
  ): readonly MessageInput[] {
    const key = markKey(accountId, folder);

    const isFirstCycle = !this.firstCycleDone.has(key);
    this.firstCycleDone.add(key);

    const previousUidValidity = this.seenUidValidity.get(key);
    const uidValidityChanged =
      !isFirstCycle &&
      uidValidity !== null &&
      previousUidValidity !== undefined &&
      uidValidity !== previousUidValidity;

    if (uidValidityChanged) {
      console.error(
        `account "${accountId}" folder "${folder}": mailbox UIDVALIDITY changed ` +
          `(${previousUidValidity} -> ${uidValidity}) — re-establishing the new-mail baseline ` +
          'instead of comparing UIDs against the stale numbering',
      );
    }
    if (uidValidity !== null) this.seenUidValidity.set(key, uidValidity);

    const startsNewBaseline = isFirstCycle || uidValidityChanged;
    const previousMax = startsNewBaseline ? -Infinity : this.maxSeenUid.get(key) ?? -Infinity;
    const currentMax = messages.reduce((max, message) => Math.max(max, message.uid), previousMax);
    this.maxSeenUid.set(key, currentMax);

    if (startsNewBaseline) return [];
    return messages.filter((message) => message.uid > previousMax);
  }
}
