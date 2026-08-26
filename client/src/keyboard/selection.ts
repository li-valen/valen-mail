/**
 * What happens to the cursor when the list changes underneath it.
 *
 * THE LIST CHANGES IN THREE DIFFERENT WAYS and they do not want the same
 * answer, which is the entire reason this is a module rather than a
 * `Math.min` at the call site:
 *
 *   1. **`loadMore` appends.** components/InboxList.tsx's `loadMore`
 *      splices a second page onto the end. Every row the user can see
 *      keeps its position and its identity. The cursor must not move at
 *      all — not visually, not by index.
 *   2. **A folder, account or search swaps the list wholesale.** Fifty
 *      messages from Inbox become eleven from Trash. The old index means
 *      nothing here.
 *   3. **A row disappears from a list that is otherwise the same.** A
 *      refetch after a retry, or a message that has aged out of sync/'s
 *      ~50-UID window. The list is still "the same list", minus one.
 *
 * **THE CURSOR IS AN IDENTITY, NOT AN INDEX.** It is stored as a
 * `messageKey` (`account_id:uid`, components/messageBody.ts) and the
 * index is re-derived on every list change. Case 1 then needs no code at
 * all: the key is still in the list, at whatever index it is now at, and
 * an append cannot move it. This is the same discipline
 * src/motion/newEntries.ts already applies to the opens feed — *"keying
 * on array INDEX makes it worse in a way that looks like it works"* — and
 * for the identical reason.
 *
 * **CLAMPING IS THE ANSWER TO CASE 3 AND THE WRONG ANSWER TO CASE 2.**
 * `Math.min(previousIndex, next.length - 1)` is right when the list is
 * the same list minus a row: the user's place is approximately preserved,
 * and only a removal at or before the cursor shifts it, by exactly one.
 * Applied to case 2 it produces a cursor sitting on row 37 of Sent
 * because the user had been on row 37 of Inbox — a position derived from
 * a list that is no longer on screen, which is the definition of
 * arbitrary. Worse, it is *silently* arbitrary: it always produces a
 * plausible-looking index, so nothing ever reports it.
 *
 * The two cases are told apart by the HEAD of the list. If `next[0]` is
 * the same message as `previous[0]`, this is the same query answered
 * again — an append, a refetch, a removal — and the previous index is
 * still meaningful, so it clamps. If the head changed, the user is
 * looking at different mail, and the only non-arbitrary cursor is the
 * newest message: index 0.
 *
 * **AN EMPTY LIST HAS NO CURSOR, AND NEITHER DOES A FRESH SESSION.**
 * `NO_SELECTION` is not a degenerate 0 — it is a real state that says the
 * user has not asked for a cursor yet. Auto-selecting row 0 on load would
 * put a selection ring on screen for a mouse user who never pressed a
 * key, and would make `s` (star) act on a message they never chose.
 * ./shortcuts.ts's `moveTo` is what turns `NO_SELECTION` into row 0, on
 * the first `j` or `k` and not before.
 */

/** No cursor. Distinct from index 0 — see the header. */
export const NO_SELECTION = -1;

export interface SelectionSnapshot {
  /** The `messageKey` under the cursor, or `null` for no cursor. */
  readonly key: string | null;
  /** Where that key was in the PREVIOUS list. Only consulted when the key
   *  has since disappeared from a list whose head is unchanged. */
  readonly index: number;
  /** The `messageKey` of the previous list's first row, or `null` when
   *  the previous list was empty. The one signal that separates "the same
   *  query, answered again" from "different mail". */
  readonly headKey: string | null;
}

export interface SelectionResult {
  readonly key: string | null;
  readonly index: number;
}

const NOTHING: SelectionResult = { key: null, index: NO_SELECTION };

/**
 * The cursor's new home after the list changed.
 *
 * @param previous what the cursor was, and enough about the list it was
 *                 in to tell an append from a swap.
 * @param nextKeys the new list's `messageKey`s, in list order.
 */
export function reconcileSelection(
  previous: SelectionSnapshot,
  nextKeys: readonly string[],
): SelectionResult {
  if (nextKeys.length === 0) return NOTHING;

  // No cursor stays no cursor. A list arriving is not a reason to invent
  // a selection the user never asked for.
  if (previous.key === null) return NOTHING;

  const found = nextKeys.indexOf(previous.key);
  if (found !== NO_SELECTION) return { key: previous.key, index: found };

  // The cursor's message is gone. Same list or different list?
  const isSameList = previous.headKey !== null && nextKeys[0] === previous.headKey;

  const index = isSameList
    ? Math.min(Math.max(previous.index, 0), nextKeys.length - 1)
    : 0;

  // `noUncheckedIndexedAccess` makes this explicit rather than assumed:
  // `index` is inside a non-empty array by construction above, so the
  // fallback is unreachable — and is a `NOTHING` rather than a `!`
  // assertion, because a cursor pointing at a row that does not exist is
  // worse than no cursor.
  const key = nextKeys[index];
  return key === undefined ? NOTHING : { key, index };
}

/**
 * The snapshot to hand `reconcileSelection` next time, built from the
 * list currently on screen.
 *
 * Exists so the head key is captured from the SAME array the cursor
 * indexes into, at the same moment — a caller assembling the two halves
 * from different renders is exactly how the append/swap distinction would
 * silently rot.
 */
export function snapshotSelection(
  keys: readonly string[],
  index: number,
): SelectionSnapshot {
  const key = index >= 0 ? keys[index] ?? null : null;
  return { key, index, headKey: keys[0] ?? null };
}
