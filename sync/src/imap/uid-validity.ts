/**
 * The most recent UIDVALIDITY this process has observed for each
 * (account, folder), recorded as a by-product of work live sync already
 * pays for.
 *
 * Split out of ConnectionPool for the same reason ./backoff.ts,
 * ./keyed-mutex.ts, ./new-mail-marks.ts and ./folder-cache.ts were: it is
 * self-contained state with a rule of its own, and pool.ts sits close
 * enough to this project's 800-line ceiling that a fifth concern with its
 * own doc comment would push it through.
 *
 * WHY IT IS NOT syncOnce()'s OWN `liveUidValidity` MAP. That map is built
 * fresh each cycle and handed to ./backfill.ts, where it must keep meaning
 * "observed on THIS cycle" — a folder whose fetch failed, or was skipped
 * by the byte budget, contributes nothing, and backfill correctly reads
 * that absence as "cannot tell" rather than as a renumbering. This log
 * persists across cycles instead, because its consumer is asking a
 * different question.
 *
 * WHO ASKS. ../api/message-cache.ts, which holds parsed messages keyed by
 * uid: a UIDVALIDITY change means the server RENUMBERED the mailbox, so
 * every cached uid now addresses a different message and the folder's
 * entries must be dropped rather than served. For that question
 * last-known-good is the right answer, and "this folder was not fetched in
 * the last three minutes" is emphatically not a renumbering.
 *
 * Deliberately in-memory and never persisted, like every other piece of
 * pool bookkeeping here: the only thing it guards is an in-memory cache
 * that a restart empties anyway.
 *
 * Note: parameter properties are avoided project-wide because the service
 * runs under --experimental-strip-types, which does not support them.
 */

/** Per (account, folder), NUL separated for the reason ./new-mail-marks.ts
 *  states: NUL appears in neither an IMAP mailbox name nor one of this
 *  service's account ids, so `a` + `bc` and `ab` + `c` cannot collide into
 *  a single key. */
function key(accountId: string, folder: string): string {
  return `${accountId}\u0000${folder}`;
}

export class UidValidityLog {
  // Never cleared, same as ConnectionPool's `statuses` — bounded by
  // MAX_ACCOUNTS (10) times the handful of folders each account has.
  private readonly observed = new Map<string, bigint>();

  /**
   * Records one observation. A `null` — no fetch happened this cycle, so
   * nothing was observed — is IGNORED rather than stored: it means "cannot
   * tell", and overwriting a known-good value with it would turn a skipped
   * cycle into a false "the numbering is unknown now".
   *
   * `folder` is the NATIVE mailbox path (`INBOX`, `[Gmail]/Sent Mail`),
   * the same value syncFolder() is given and the same value the message
   * routes carry in their path segment — never a logical FolderKind.
   */
  record(accountId: string, folder: string, uidValidity: bigint | null): void {
    if (uidValidity === null) return;
    this.observed.set(key(accountId, folder), uidValidity);
  }

  /**
   * The last observed UIDVALIDITY for one mailbox, or null when this
   * process has never observed one — the same shape, and the same "null
   * means cannot tell", that FetchResult.uidValidity already has.
   */
  get(accountId: string, folder: string): bigint | null {
    return this.observed.get(key(accountId, folder)) ?? null;
  }
}
