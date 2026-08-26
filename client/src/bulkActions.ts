import type { InboxMessage } from './api';
import { moveMessage, setMessageFlag } from './api';
import {
  canMoveFrom,
  canUndo,
  moveFailureFor,
  pastParticipleFor,
  undoFailureFor,
  type MoveDestination,
  type MoveResult,
  type PendingUndo,
} from './mailboxActions';
import { runBoundedBatch } from './bulkRunner';

/**
 * ACTING ON MANY MESSAGES AT ONCE — as pure data and injectable calls,
 * with no React anywhere near it.
 *
 * ---------------------------------------------------------------------
 * THE ONLY THING THAT MATTERS IN THIS FILE IS THE PARTIAL BATCH.
 * ---------------------------------------------------------------------
 * A batch of forty is forty HTTP requests, and on any real mailbox some
 * of them fail: a 502 from a mailbox that dropped its connection, a 429,
 * a socket that died halfway down the list. The single-message path
 * (App.tsx's `performMove`) has exactly two outcomes and both are easy —
 * the row is gone, or the row is back and a banner says why. A batch has
 * a third, and it is the dangerous one:
 *
 *   **THIRTY-SEVEN WENT AND THREE DID NOT.**
 *
 * If those three stay hidden, the user closes the tab believing their
 * inbox is clean while three messages are still sitting in it — a lie
 * they have no way to detect, and the exact failure ./mailboxActions.ts
 * is shaped around, only multiplied. If they come back but nothing says
 * so, three rows silently reappear and read as a rendering glitch. So
 * every outcome here reports THREE THINGS and the caller must act on all
 * three:
 *
 *   - `movedKeys` — stay hidden. The mailbox really changed.
 *   - `restoredKeys` — MUST be revealed. The mailbox did not change, or
 *     we have no evidence it did.
 *   - a failure sentence naming HOW MANY, because "something went wrong"
 *     over a forty-message batch tells the user nothing they can act on.
 *
 * `attempted` closes the loop: `movedKeys.length + restoredKeys.length`
 * always equals it, so a message that fell out of the accounting is a
 * test failure rather than a row that quietly vanished.
 *
 * **AND THE UNDO IS ONE ACTION, NOT FORTY.** A `BulkMoveOutcome` carries
 * one `PendingUndo` per message that actually moved AND produced a
 * server-issued ticket — so an undo taken after a partial batch puts back
 * exactly the ones that went, and touches nothing else.
 */

/**
 * One row in a batch: the key the UI hides it by, and the message the
 * request is built from.
 *
 * BOTH, rather than deriving one from the other here, because the key is
 * the caller's — App.tsx's hidden set, the selection set and the cursor
 * all key the same way (./bulkSelection.ts explains why it is
 * `accountId:uid`), and a batch that re-derived it would be a second
 * place that decision could drift.
 */
export interface BulkTarget {
  readonly key: string;
  readonly message: InboxMessage;
}

export interface BulkMoveOutcome {
  readonly destination: MoveDestination;
  /** Rows whose message really left the inbox. STAY HIDDEN. */
  readonly movedKeys: readonly string[];
  /** Rows that did not move, or that we cannot prove moved. REVEAL THESE. */
  readonly restoredKeys: readonly string[];
  /** One per moved message the server said could be taken back. Never a
   *  guess: `canUndo` decides, per row, exactly as it does for a single
   *  message. */
  readonly undos: readonly PendingUndo[];
  /** How many were asked for. Always `movedKeys + restoredKeys`. */
  readonly attempted: number;
}

export interface BulkUndoOutcome {
  /** Rows put back. REVEAL THESE. */
  readonly restoredKeys: readonly string[];
  /** Rows that stayed where the move left them. They remain hidden,
   *  because the message really is still in the other folder. */
  readonly stuckKeys: readonly string[];
  readonly attempted: number;
}

export interface BulkFlagOutcome {
  /** Which direction was asked for — `true` is "mark read". */
  readonly seen: boolean;
  /** Rows whose flag really changed. The optimistic override stands. */
  readonly changedKeys: readonly string[];
  /** Rows whose write failed. DROP the override, so the row falls back to
   *  what `flags` actually says rather than to the opposite of it — the
   *  same "revert, never invert" rule components/messageFlags.ts's
   *  `withoutStar` exists for. */
  readonly revertedKeys: readonly string[];
  readonly attempted: number;
}

/** The one move call, injectable so every test in this file runs without
 *  a network. Defaults to src/api.ts's per-message route — there is no
 *  bulk route and there must not be one (see sync/src/api/move.ts). */
export type MoveOne = (message: InboxMessage, destination: MoveDestination) => Promise<MoveResult>;
export type UndoOne = (undo: PendingUndo) => Promise<void>;
export type SetSeenOne = (message: InboxMessage, seen: boolean) => Promise<void>;

export interface BulkRunOptions {
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

const moveOne: MoveOne = (message, destination) =>
  moveMessage(message.account_id, message.folder, message.uid, { to: destination });

const undoOne: UndoOne = async (undo) => {
  // The SERVER's ticket, replayed verbatim. Nothing here constructs a
  // destination — see src/api.ts's `moveMessage` and mailboxActions.ts's
  // `UndoTicket` for why a client-invented uid would move an unrelated
  // message into the user's inbox.
  await moveMessage(undo.accountId, undo.ticket.folder, String(undo.ticket.uid), {
    to: 'undo',
    origin: undo.ticket.origin,
  });
};

const setSeenOne: SetSeenOne = (message, seen) =>
  setMessageFlag(message.account_id, message.folder, message.uid, 'seen', seen);

/**
 * Move every target, at most `MAX_CONCURRENT_BULK_REQUESTS` at a time,
 * and report what actually happened to each one.
 *
 * **WHICH STATUSES MEAN "STAYS HIDDEN", AND WHY EACH IS NOT THE OTHER:**
 *
 *  - `done` with `moved: true` — it went. Hidden, and it contributes an
 *    undo iff the server issued a ticket.
 *  - `done` with `moved: false` — it was ALREADY gone; somebody archived
 *    it from the Gmail app. Also hidden, because the row genuinely is not
 *    in the inbox. Revealing it would put a message back on screen that
 *    is not there. This mirrors App.tsx's single-message path exactly,
 *    where a `moved: false` result closes the reader and simply offers no
 *    undo.
 *  - `failed` — the request rejected. We have NO evidence the server
 *    acted, and the honest reading of "no evidence" is "still in the
 *    inbox": that is what the single-message path already does on a
 *    rejection, and it is the direction that fails safe. A row wrongly
 *    revealed corrects itself on the next sync; a row wrongly hidden
 *    never does.
 *  - `skipped` — never sent. Certainly still in the inbox. Revealed.
 */
export async function runBulkMove(
  targets: readonly BulkTarget[],
  destination: MoveDestination,
  options: BulkRunOptions & { readonly move?: MoveOne } = {},
): Promise<BulkMoveOutcome> {
  const move = options.move ?? moveOne;
  const results = await runBoundedBatch(
    targets,
    (target) => move(target.message, destination),
    { limit: options.limit, signal: options.signal },
  );

  const movedKeys: string[] = [];
  const restoredKeys: string[] = [];
  const undos: PendingUndo[] = [];

  for (const result of results) {
    const { key, message } = result.item;
    if (result.status !== 'done' || result.value === undefined) {
      restoredKeys.push(key);
      continue;
    }
    movedKeys.push(key);
    if (!canUndo(result.value)) continue;
    undos.push({
      key,
      accountId: message.account_id,
      destination,
      // Non-null by `canUndo`, which is the ONLY thing that decides
      // whether an undo may be offered at all — per row here, exactly as
      // per message in App.tsx.
      ticket: result.value.undo!,
    });
  }

  return { destination, movedKeys, restoredKeys, undos, attempted: targets.length };
}

/** True when a finished batch has anything to put back. Zero tickets — a
 *  batch of messages that were all already gone — means the bar shows the
 *  receipt without an Undo button, rather than a button that would do
 *  nothing. */
export function canUndoBulk(outcome: BulkMoveOutcome): boolean {
  return outcome.undos.length > 0;
}

/**
 * Put a whole batch back, one ticket at a time, bounded the same way.
 *
 * A ROW THAT WOULD NOT COME BACK STAYS HIDDEN, and that is not a
 * concession — the message really is still in the folder the move put it
 * in, so showing it in the inbox would be the same lie in the opposite
 * direction. `bulkUndoFailureFor` is what tells the user, in different
 * words from a failed move, because the message is not where a failed
 * move would have left it.
 */
export async function runBulkUndo(
  entries: readonly PendingUndo[],
  options: BulkRunOptions & { readonly undo?: UndoOne } = {},
): Promise<BulkUndoOutcome> {
  const undo = options.undo ?? undoOne;
  const results = await runBoundedBatch(entries, (entry) => undo(entry), {
    limit: options.limit,
    signal: options.signal,
  });

  const restoredKeys: string[] = [];
  const stuckKeys: string[] = [];
  for (const result of results) {
    if (result.status === 'done') restoredKeys.push(result.item.key);
    else stuckKeys.push(result.item.key);
  }
  return { restoredKeys, stuckKeys, attempted: entries.length };
}

/**
 * Mark a batch read or unread.
 *
 * The same optimistic-then-honest contract the star has, and the same
 * revert rule: a write that failed DROPS the override rather than
 * inverting it, so the row falls back to what the mailbox actually says.
 */
export async function runBulkFlag(
  targets: readonly BulkTarget[],
  seen: boolean,
  options: BulkRunOptions & { readonly setSeen?: SetSeenOne } = {},
): Promise<BulkFlagOutcome> {
  const setSeen = options.setSeen ?? setSeenOne;
  const results = await runBoundedBatch(targets, (target) => setSeen(target.message, seen), {
    limit: options.limit,
    signal: options.signal,
  });

  const changedKeys: string[] = [];
  const revertedKeys: string[] = [];
  for (const result of results) {
    if (result.status === 'done') changedKeys.push(result.item.key);
    else revertedKeys.push(result.item.key);
  }
  return { seen, changedKeys, revertedKeys, attempted: targets.length };
}

/**
 * Which messages a keystroke or a button acts on.
 *
 * THREE CASES, AND THE READER ONE IS THE ONE THAT IS EASY TO GET WRONG:
 *
 *  1. **The reader is open.** The open message, and only it — even with
 *     rows ticked behind. The reader has REPLACED the list, so those
 *     ticks are not on screen; archiving forty invisible rows because the
 *     user pressed `e` while reading one message is the opposite of what
 *     they asked for, and it is not undoable by looking at anything.
 *     Gmail does the same: in a conversation, `e` archives that
 *     conversation.
 *  2. **Rows are ticked in the list.** All of them. This is Gmail's rule
 *     and it is the whole reason `x` is worth having: a selection you
 *     cannot then act on from the keyboard is a half-built feature.
 *  3. **Nothing ticked.** Whatever is under the cursor, exactly as
 *     before this feature existed.
 */
export function moveTargetsFor(options: {
  readonly inHand: InboxMessage | null;
  readonly isReaderOpen: boolean;
  readonly selection: readonly InboxMessage[];
}): readonly InboxMessage[] {
  const { inHand, isReaderOpen, selection } = options;
  if (isReaderOpen) return inHand === null ? [] : [inHand];
  if (selection.length > 0) return selection;
  return inHand === null ? [] : [inHand];
}

/**
 * True when a row may be ticked at all.
 *
 * THE SAME PREDICATE THAT DECIDES WHETHER IT MAY BE MOVED, deliberately.
 * Every bulk action on the bar except mark-read is a move, and a
 * selection holding one row that cannot be archived would turn "Archive"
 * into a control that is partly inert — the failure mode this codebase
 * refuses everywhere. Keeping the two predicates identical means every
 * batch is uniformly actionable by construction, so `runBulkMove` never
 * needs a per-row "may I?" branch.
 *
 * Decided per ROW rather than per view because the Starred folder is a
 * flag query across every synced folder — see components/InboxList.tsx,
 * which gates its row controls the same way.
 */
export function canBulkSelect(message: InboxMessage): boolean {
  return canMoveFrom(message.folder);
}

/** What `x` says when pressed on a row that cannot be ticked. A bare key
 *  that visibly does nothing is worse than no key — the rule
 *  mailboxActions.ts's `unavailableHereFor` exists for, applied to
 *  selection. */
export function bulkSelectionUnavailableHere(): string {
  return 'Selecting messages is only available for mail in your Inbox.';
}

/** "12 messages" / "1 message". One helper, so every sentence in this
 *  file agrees with itself about plurals — a bar that says "1 messages"
 *  reads as a bug in everything else it claims. */
function plural(count: number): string {
  return count === 1 ? '1 message' : `${count} messages`;
}

/**
 * The receipt after a batch move. Past tense and plain, exactly like
 * `moveNoticeFor` — the thing has already happened and the bar is a
 * receipt with a way back, not a confirmation prompt.
 *
 * IT LEADS WITH THE COUNT because the count is the whole difference
 * between this and the single-message notice: "Archived." over forty rows
 * that just disappeared tells the user nothing about whether all forty
 * went.
 */
export function bulkMoveNoticeFor(destination: MoveDestination, count: number): string {
  switch (destination) {
    case 'archive':
      return `Archived ${plural(count)}.`;
    case 'trash':
      return `Moved ${plural(count)} to Trash.`;
    case 'spam':
      return `Reported ${plural(count)} as spam.`;
  }
}

/** The verb phrase each destination uses in a failure sentence. */
function failedVerbFor(destination: MoveDestination): string {
  switch (destination) {
    case 'archive':
      return 'archived';
    case 'trash':
      return 'moved to Trash';
    case 'spam':
      return 'reported as spam';
  }
}

/**
 * **HOW A PARTIAL FAILURE IS SAID OUT LOUD.** `null` when nothing failed.
 *
 * THE COUNT IS THE POINT. "Some messages could not be archived" leaves
 * the user with an inbox they cannot reconcile against what they just
 * watched happen; "3 of 40" is a fact they can check by looking. And the
 * sentence says WHERE THE THREE ARE, because the rows reappearing is
 * otherwise indistinguishable from a rendering glitch.
 *
 * A BATCH OF ONE FALLS BACK TO THE SINGLE-MESSAGE SENTENCE. "None of the
 * 1 messages" is the kind of copy that makes a user distrust everything
 * else on screen, and `moveFailureFor` already says the right thing —
 * reused rather than re-worded, so the two can never drift.
 */
export function bulkMoveFailureFor(
  destination: MoveDestination,
  outcome: BulkMoveOutcome,
): string | null {
  const failed = outcome.restoredKeys.length;
  if (failed === 0) return null;
  if (outcome.attempted === 1) return moveFailureFor(destination);

  const verb = failedVerbFor(destination);
  if (outcome.movedKeys.length === 0) {
    return `None of the ${plural(outcome.attempted)} could be ${verb} — Postbox couldn't reach your mailbox. They are all back in your inbox.`;
  }
  return `${failed} of ${outcome.attempted} messages could not be ${verb} — Postbox couldn't reach your mailbox. They are back in your inbox.`;
}

/**
 * What the undo button says, and what a screen reader announces for it.
 *
 * NAMES THE COUNT AS WELL AS THE VERB. A bare "Undo" read on its own,
 * after the reader has moved past the notice text, gives no way to tell
 * an undo of one message from an undo of forty.
 */
export function bulkUndoLabelFor(destination: MoveDestination, count: number): string {
  const verb =
    destination === 'archive' ? 'archive' : destination === 'trash' ? 'move to Trash' : 'report as spam';
  return `Undo ${verb} of ${plural(count)}`;
}

/**
 * What the user is told when some of a batch would not come BACK. `null`
 * when every row did.
 *
 * A DIFFERENT SENTENCE FROM A FAILED MOVE, for `undoFailureFor`'s reason:
 * after a failed move the messages are still in the inbox, after a failed
 * undo they are not, and telling the user "could not be archived" here
 * would send them looking in the wrong folder.
 */
export function bulkUndoFailureFor(
  destination: MoveDestination,
  outcome: BulkUndoOutcome,
): string | null {
  const stuck = outcome.stuckKeys.length;
  if (stuck === 0) return null;
  if (outcome.attempted === 1) return undoFailureFor(destination);

  const where = pastParticipleFor(destination);
  if (outcome.restoredKeys.length === 0) {
    return `None of the ${plural(outcome.attempted)} could be moved back — they all stayed ${where}.`;
  }
  return `${stuck} of ${outcome.attempted} messages stayed ${where} — Postbox couldn't move them back.`;
}

/**
 * What the user is told when some of a batch could not be marked read or
 * unread. `null` when every write took.
 *
 * There is no SUCCESS notice to pair with this, deliberately: a
 * successful mark-read is visible on the rows themselves (they stop being
 * bold), so a banner saying so would be chrome restating what the user
 * can already see. A FAILURE is not visible — the override is simply
 * dropped and the row quietly returns to bold — which is exactly why this
 * sentence exists.
 */
export function bulkFlagFailureFor(outcome: BulkFlagOutcome): string | null {
  const failed = outcome.revertedKeys.length;
  if (failed === 0) return null;

  const direction = outcome.seen ? 'read' : 'unread';
  if (outcome.attempted === 1) {
    return `That message could not be marked as ${direction} — Postbox couldn't reach your mailbox.`;
  }
  if (outcome.changedKeys.length === 0) {
    return `None of the ${plural(outcome.attempted)} could be marked as ${direction} — Postbox couldn't reach your mailbox.`;
  }
  return `${failed} of ${outcome.attempted} messages could not be marked as ${direction} — Postbox couldn't reach your mailbox.`;
}
