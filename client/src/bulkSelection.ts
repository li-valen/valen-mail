import type { InboxMessage } from './api';
import { messageKey } from './components/messageBody';

/**
 * WHICH ROWS THE USER HAS TICKED — as pure data, and nothing else.
 *
 * client/CLAUDE.md's standing constraint is that no test in this project
 * renders a component, so a decision made inside a checkbox's onClick is
 * a decision no test can reach. Everything about the selection therefore
 * lives here: what a key is, what toggling means, what "select all"
 * selects, and what happens to a tick whose row has left the list.
 *
 * ---------------------------------------------------------------------
 * **THE KEY IS `accountId:uid`, AND THAT IS THE SINGLE MOST IMPORTANT
 * LINE IN THIS FILE.**
 * ---------------------------------------------------------------------
 * IMAP uids are allocated per mailbox, so a four-account merged inbox
 * routinely holds `primary:9` and `harvard:9` at the same time — two
 * unrelated messages from two unrelated people. A selection keyed by uid
 * alone would tick both from one click and then ARCHIVE BOTH, which is
 * not a rendering bug: it is mail the user never looked at leaving their
 * inbox. `selectionKeyFor` is therefore ./components/messageBody.ts's
 * `messageKey` and not a second key shape of its own.
 *
 * **AND IT IS THE SAME KEY ../src/mailboxActions.ts HIDES ROWS BY.** That
 * is not a coincidence to leave implicit — App.tsx compares the two sets
 * directly (a row that really moved is dropped from the selection and
 * kept in the hidden set; a row that failed is revealed and, likewise,
 * dropped) and two different key shapes would make that comparison
 * silently empty. One key function, imported, not copied.
 *
 * A FOLDER IS NOT PART OF THE KEY, and it does not need to be: bulk
 * actions are only ever offered from the inbox (`mailboxActions.ts`'s
 * `canMoveFrom`), so every message in one batch is in `INBOX` and the
 * per-mailbox uid ambiguity cannot arise within a batch. The Starred
 * view — the one list that merges folders — offers no bulk controls for
 * exactly this reason.
 *
 * **THE UNIT OF SELECTION IS THE ROW, AND A ROW IS NOW A CONVERSATION.**
 * The keys stay per MESSAGE — they have to, because a move is one request
 * per message and the hidden set is per message — but they are added and
 * removed in whole groups (`toggleGroupSelection`, `selectableKeys`).
 * Nothing here knows what a conversation is; the caller passes the
 * members, ./conversations.ts decides what they are, and this module's
 * only claim is that a group goes in and comes out together.
 */

/**
 * The empty selection, as a module-level constant.
 *
 * A STABLE IDENTITY, for the reason components/InboxList.tsx already
 * hoists its `NO_HIDDEN_KEYS`: this is a `useState` initial value and a
 * default prop, and a fresh `new Set()` per render would change the memo
 * key of every derived value over a fifty-row list, every render, for
 * nothing.
 */
export const NOTHING_SELECTED: ReadonlySet<string> = new Set();

/**
 * The identity of one selectable row.
 *
 * A named export rather than an inline `messageKey(...)` at each call
 * site so there is exactly one place this decision is written down, and
 * so tests/bulk-selection.test.ts can assert on the decision itself
 * rather than only on its consequences.
 */
export function selectionKeyFor(message: InboxMessage): string {
  return messageKey(message);
}

/** True when this row is ticked. A function rather than `.has` at the
 *  call sites so the set's shape stays this module's business. */
export function isSelected(selected: ReadonlySet<string>, key: string): boolean {
  return selected.has(key);
}

/**
 * Tick or untick one row, as a NEW set.
 *
 * Never mutates — the same contract, for the same reason, as
 * mailboxActions.ts's `hideMessage`: a set changed in place is a set
 * React cannot tell has changed, so the bar's count would freeze at
 * whatever it was on the first render.
 */
export function toggleSelection(selected: ReadonlySet<string>, key: string): ReadonlySet<string> {
  return toggleGroupSelection(selected, [key]);
}

/**
 * Tick or untick MANY keys as ONE decision — what a collapsed
 * conversation's checkbox does.
 *
 * **ALL-OR-NOTHING, AND THE DIRECTION IS DECIDED ONCE FOR THE WHOLE
 * GROUP.** Toggling each key independently would leave a conversation
 * half-ticked whenever it was already partly selected, and a half-ticked
 * conversation is a row whose box says one thing while an Archive would
 * do another. So: fully selected -> drop all of them; anything else ->
 * add all of them. That also makes the second press of `x` on the same
 * row always the exact inverse of the first, which is the only behaviour
 * a user can predict.
 *
 * An empty group returns the SAME set — a no-op update React bails out of
 * rather than a render over a fifty-row list.
 */
export function toggleGroupSelection(
  selected: ReadonlySet<string>,
  keys: readonly string[],
): ReadonlySet<string> {
  if (keys.length === 0) return selected;
  const isFullySelected = keys.every((key) => selected.has(key));
  const next = new Set(selected);
  for (const key of keys) {
    if (isFullySelected) next.delete(key);
    else next.add(key);
  }
  return next;
}

/**
 * Tick exactly the rows named — REPLACING whatever was ticked before.
 *
 * Replace rather than union, deliberately. "Select all" is a statement
 * about what is on screen now; unioning would quietly keep a tick on a
 * row the user paged past ten minutes ago and then act on it, which is
 * the invisible-action failure this whole feature has to avoid.
 */
export function selectAll(keys: readonly string[]): ReadonlySet<string> {
  return new Set(keys);
}

/** Untick everything. Returns the shared empty identity. */
export function clearSelection(): ReadonlySet<string> {
  return NOTHING_SELECTED;
}

/**
 * True when every row currently on screen is ticked — what the header
 * checkbox draws itself from.
 *
 * AN EMPTY LIST IS NEVER "EVERYTHING SELECTED". Vacuous truth would tick
 * the header box over an empty inbox and leave "clear" as the only thing
 * it could possibly do, which is a control that lies about its own state.
 *
 * Extra keys in the selection that are NOT in `keys` are ignored rather
 * than disqualifying: after a move hides rows, the selection is pruned
 * separately, and a header box that flickered off mid-batch would be
 * reporting on bookkeeping rather than on what the user can see.
 */
export function isEverythingSelected(
  selected: ReadonlySet<string>,
  keys: readonly string[],
): boolean {
  if (keys.length === 0) return false;
  return keys.every((key) => selected.has(key));
}

/**
 * Drop specific keys — the path a finished batch takes.
 *
 * Rows that MOVED are dropped because they are gone; rows that FAILED are
 * dropped too, because they are back in the list and leaving them ticked
 * would arm a second batch the user did not ask for. Both cases are the
 * same operation, which is why there is one function and not two.
 */
export function deselectKeys(
  selected: ReadonlySet<string>,
  keys: readonly string[],
): ReadonlySet<string> {
  const next = new Set(selected);
  for (const key of keys) next.delete(key);
  return next;
}

/**
 * Drop every tick whose row is no longer in the list.
 *
 * Called when the LIST changes underneath the selection — a folder
 * switch, an account switch, a search — for the same reason
 * keyboard/selection.ts reconciles the cursor: a tick on a row nobody can
 * see is an action waiting to happen invisibly. The count in the bar has
 * to mean "these rows, the ones you can point at".
 *
 * RETURNS THE SAME SET WHEN NOTHING CHANGED. This runs on every list
 * report, and a fresh `Set` each time would invalidate every memo keyed
 * on the selection across a fifty-row list for no change at all.
 */
export function pruneSelection(
  selected: ReadonlySet<string>,
  keys: readonly string[],
): ReadonlySet<string> {
  if (selected.size === 0) return selected;
  const live = new Set(keys);
  const kept = [...selected].filter((key) => live.has(key));
  if (kept.length === selected.size) return selected;
  return new Set(kept);
}

/**
 * Which keys "select all" is allowed to tick — every message whose WHOLE
 * conversation can be acted on.
 *
 * `groupOf(message).every(canSelect)`, not `canSelect(message)`, and the
 * difference only shows in the one view that merges folders. In Starred a
 * conversation can hold an INBOX message and a Sent one; ticking the
 * INBOX half alone would put a partial conversation in the selection,
 * whose row would then draw itself UNTICKED (the box asks whether the
 * whole conversation is selected) while a batch archived half of it. The
 * group is the unit of selection or it is not a unit at all.
 *
 * With the default `groupOf` — one message per group — this is exactly
 * `messages.filter(canSelect).map(selectionKeyFor)`, i.e. the ungrouped
 * behaviour, unchanged.
 */
export function selectableKeys(
  messages: readonly InboxMessage[],
  canSelect: (message: InboxMessage) => boolean,
  groupOf: (message: InboxMessage) => readonly InboxMessage[] = (message) => [message],
): readonly string[] {
  return messages
    .filter((message) => groupOf(message).every(canSelect))
    .map(selectionKeyFor);
}

/**
 * The selected rows, IN LIST ORDER.
 *
 * List order, not selection order, and it is load-bearing rather than
 * tidy: the batch issues its moves in this order, so a partially-failed
 * batch fails in a pattern the user can read down their own screen
 * instead of in whatever sequence they happened to click.
 *
 * `keyOf` is injected for the same reason mailboxActions.ts injects it —
 * so this module can be exercised against a stand-in key without a
 * component anywhere near it.
 */
export function selectedMessages(
  messages: readonly InboxMessage[],
  selected: ReadonlySet<string>,
  keyOf: (message: InboxMessage) => string,
): readonly InboxMessage[] {
  if (selected.size === 0) return [];
  return messages.filter((message) => selected.has(keyOf(message)));
}

/**
 * The live count, as the bar says it.
 *
 * A COUNT AND NOT A NOUN. "12 selected" rather than "12 messages
 * selected": the bar sits directly above the rows it is counting, the
 * noun is visible on screen, and the shorter string is what survives at
 * 375px next to four action buttons.
 */
export function countLabel(count: number): string {
  return `${count} selected`;
}
