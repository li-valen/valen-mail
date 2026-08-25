/**
 * The sidebar's account roster (Plan 5 Task 3).
 *
 * Postbox has no roster endpoint, and this task does not add one: the
 * account rows are derived from the pages GET /api/inbox has already
 * returned (components/InboxList.tsx's `summarizeAccounts`), because
 * "how many of the loaded messages are yours" is a claim the loaded
 * messages can actually support.
 *
 * Deriving it that way has exactly one sharp edge, which is what this
 * module is for. The instant a user filters to `harvard`, every loaded
 * message is harvard's — so a switcher rebuilt from the current page
 * would delete every other account's row, removing the controls needed to
 * switch back. The same thing happens on a folder that is empty in this
 * view (an unsynced Trash empties the sidebar).
 *
 * ONE rule, applied everywhere, so the numbers can never quietly mean two
 * different things:
 *
 *   the ROSTER only grows within a session; every COUNT always describes
 *   what is loaded right now.
 *
 * So an account filtered out of the current view keeps its row and reads
 * `0` — which is the true count of its messages in what is loaded, not a
 * stale number left over from a view the user has since left. The roster
 * resets on reload, which is also when a config change would take effect.
 */

export interface AccountSummary {
  readonly id: string;
  readonly count: number;
}

/**
 * Folds one view's observed per-account counts into the known roster.
 *
 * Pure and non-mutating (both inputs are only read; a new array comes
 * back), and idempotent — folding the same observation twice is the same
 * as folding it once, which matters because React may call this during a
 * re-render that did not change anything.
 *
 * Sorted by id so the sidebar does not reorder itself as pages arrive.
 */
export function foldAccountRoster(
  known: readonly AccountSummary[],
  observed: readonly AccountSummary[],
): readonly AccountSummary[] {
  const counts = new Map<string, number>(observed.map((account) => [account.id, account.count]));
  const ids = new Set<string>([...known.map((account) => account.id), ...counts.keys()]);
  return [...ids]
    .map((id) => ({ id, count: counts.get(id) ?? 0 }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The number beside the "All accounts" row: how many messages are loaded
 *  across the whole roster. */
export function totalOf(accounts: readonly AccountSummary[]): number {
  return accounts.reduce((sum, account) => sum + account.count, 0);
}
