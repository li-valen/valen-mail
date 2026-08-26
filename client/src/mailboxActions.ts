import type { InboxMessage } from './api';

/**
 * Archive, trash and spam, as PURE DATA — everything the feature decides
 * that is not React.
 *
 * client/CLAUDE.md's standing constraint is that no test in this project
 * renders a component, so a decision made inside App.tsx is a decision no
 * test can reach. Everything here is therefore reachable from
 * tests/mailbox-actions.test.ts: which rows are hidden, when an undo may
 * be offered, and what the user is told in each of the six outcomes.
 *
 * **THE OPTIMISTIC LAYER IS AN OVERLAY, NOT A MUTATED LIST** — the same
 * shape, and the same reasoning, as components/messageFlags.ts's star
 * overrides. The list rows are owned by components/InboxList.tsx's
 * `messages` state and the reader's copy by App.tsx's `selected`;
 * archiving from a keyboard shortcut has to change what both draw, and
 * threading a setter into each is how the same write ends up in two
 * places that drift. A `Set<messageKey>` in App.tsx is read by both and
 * is a single place to roll back from.
 *
 * **AND IT ROLLS BACK.** An entry is added the instant the key is pressed
 * and REMOVED if the move fails, so the row returns to the list. A
 * message that visibly comes back after a failed archive is honest; one
 * that stays gone in the UI while still sitting in the inbox is not, and
 * that is the failure this whole module is shaped to prevent.
 */

/** The three moves a user can ask for. Matches the server's forward
 *  destination set exactly (sync/src/api/move.ts) — the wire value IS
 *  this string, so a fourth member here without one there is a 400. */
export type MoveDestination = 'archive' | 'trash' | 'spam';

/**
 * How long the undo affordance stays on screen.
 *
 * **8 SECONDS, AND THE NUMBER IS ABOUT REGRET, NOT ABOUT READING SPEED.**
 * Gmail's own default is 5, and the reason its archive feels safe enough
 * to use without thinking is precisely that the bar is there when you
 * realise you hit the wrong row. The realisation is what takes the time:
 * a keyboard user presses `e`, watches the row go, and only then reads
 * the sender they just archived. Five seconds is enough for a mouse user
 * who was already looking at the row; eight covers the keyboard case
 * without leaving a stale bar sitting over the list.
 *
 * IT IS NOT LOAD-BEARING FOR CORRECTNESS. Expiry only removes the
 * affordance — the move already happened and stays happened. A timer
 * that never fired (a backgrounded tab throttling timeouts, which
 * browsers do aggressively) would leave an undo offer on screen that
 * still works, which is a cosmetic fault rather than a wrong one. Same
 * property, and the same reason for stating it, as keyboard/shortcuts.ts's
 * CHORD_TIMEOUT_MS.
 */
export const UNDO_WINDOW_MS = 8_000;

/**
 * The ticket the SERVER issues, replayed verbatim to take a move back.
 *
 * A client never constructs one of these, and that is the point: the
 * `origin` is a logical folder kind the server resolved from its own
 * special-use discovery, and `uid` is the message's new uid read out of
 * the server's COPYUID response. A client that invented either would be
 * asking the service to move some other message into the user's inbox.
 */
export interface UndoTicket {
  readonly folder: string;
  readonly uid: number;
  readonly origin: string;
}

/** What POST /api/message/…/move answers (sync/src/api/move.ts's
 *  MoveResultBody). `undo` is null when the move cannot be taken back. */
export interface MoveResult {
  readonly moved: boolean;
  readonly undo: UndoTicket | null;
}

/** An undo the user can still take, held by App.tsx for `UNDO_WINDOW_MS`. */
export interface PendingUndo {
  /** `messageKey` of the row that was hidden, so accepting the undo
   *  reveals the same row the move hid. */
  readonly key: string;
  readonly accountId: string;
  readonly destination: MoveDestination;
  readonly ticket: UndoTicket;
}

/**
 * The ONE folder these actions are offered from.
 *
 * RFC 3501 makes `INBOX` the single mailbox name that is reserved,
 * case-insensitive and present on every server, which is why
 * sync/src/imap/folders.ts is allowed to hardcode it and why this
 * comparison is not the "never hardcode a folder name" violation it
 * looks like. Every DESTINATION is still discovered server-side; this is
 * only a question about where the message currently is.
 */
const INBOX_FOLDER = 'INBOX';

/**
 * True when archive / trash / spam may be offered for a message in this
 * folder — which today means the inbox and nowhere else.
 *
 * **THE RESTRICTION IS DELIBERATE AND IT IS ABOUT SENT MAIL.** On Gmail
 * every folder is a label, so archiving a message that lives in
 * `[Gmail]/Sent Mail` removes the SENT label: the message survives in
 * All Mail, but it vanishes from Sent — and the follow-up queue (spec
 * §7A) is built entirely out of sent mail. An `e` pressed in the
 * follow-up view would silently delete a row from the feature the user is
 * looking at. Gmail's own client does allow that, and can, because its
 * label model is visible on screen; here it would be invisible.
 *
 * Trash from Spam and "not spam" from Spam are both reasonable and both
 * deliberately out of scope rather than half-built — see the task report.
 */
export function canMoveFrom(folder: string): boolean {
  return folder.toUpperCase() === INBOX_FOLDER;
}

/**
 * What the user is told when they press `e` or `#` somewhere the action
 * is not offered.
 *
 * A KEYSTROKE THAT VISIBLY DOES NOTHING IS WORSE THAN NO KEYSTROKE — the
 * rule this codebase applies to every other bare key. The buttons are
 * simply absent outside the inbox, so only the keyboard can reach this.
 */
export function unavailableHereFor(destination: MoveDestination): string {
  const action =
    destination === 'archive' ? 'Archive' : destination === 'trash' ? 'Move to Trash' : 'Report as spam';
  return `${action} is only available from your Inbox.`;
}

/** A NEW set with one key hidden. Never mutates its input — the whole
 *  point of holding this in React state is that a changed set is a new
 *  identity a render can key on. Mirrors messageFlags.ts's `withStar`. */
export function hideMessage(hidden: ReadonlySet<string>, key: string): ReadonlySet<string> {
  return new Set(hidden).add(key);
}

/** A NEW set with one key revealed — the rollback path when the move
 *  fails, and the accept path when the user takes an undo. Both restore
 *  the row rather than asserting anything new about it. */
export function revealMessage(hidden: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(hidden);
  next.delete(key);
  return next;
}

/**
 * The rows still to draw.
 *
 * Filtering at RENDER rather than deleting from the list state is what
 * makes rollback possible at all: the row is never thrown away, so
 * putting it back costs nothing and cannot lose its place in the day
 * grouping or its position under the keyboard cursor.
 */
export function visibleMessages(
  messages: readonly InboxMessage[],
  hidden: ReadonlySet<string>,
  keyOf: (message: InboxMessage) => string,
): readonly InboxMessage[] {
  if (hidden.size === 0) return messages;
  return messages.filter((message) => !hidden.has(keyOf(message)));
}

/**
 * True when this result may be offered as an undo.
 *
 * BOTH CONDITIONS, and neither is redundant. `moved: false` means the
 * message was already gone — someone archived it from the Gmail app —
 * so there is nothing to put back. A null `undo` means the server could
 * not name where the message now is (no COPYUID, or a source folder it
 * cannot name), and an undo built on a guessed uid would move an
 * unrelated message into the user's inbox. Offering a control that would
 * do either is worse than offering none: the whole value of an undo is
 * that pressing it is safe.
 */
export function canUndo(result: MoveResult): boolean {
  return result.moved && result.undo !== null;
}

/** What the undo bar says after a successful move. Past tense and plain:
 *  the thing has already happened, and the bar is a receipt with a way
 *  back, not a confirmation prompt. */
export function moveNoticeFor(destination: MoveDestination): string {
  switch (destination) {
    case 'archive':
      return 'Archived.';
    case 'trash':
      return 'Moved to Trash.';
    case 'spam':
      return 'Reported as spam.';
  }
}

/**
 * What the user is told when the move did NOT happen — said in the same
 * breath as the row coming back, so the two agree.
 *
 * Names the mailbox rather than the app ("Postbox couldn't reach your
 * mailbox"), matching the star failure copy in App.tsx: the user's model
 * is that this app talks to Gmail, and the actionable fact is that the
 * far end did not answer.
 */
export function moveFailureFor(destination: MoveDestination): string {
  switch (destination) {
    case 'archive':
      return "That message could not be archived — Postbox couldn't reach your mailbox.";
    case 'trash':
      return "That message could not be moved to Trash — Postbox couldn't reach your mailbox.";
    case 'spam':
      return "That message could not be reported as spam — Postbox couldn't reach your mailbox.";
  }
}

/**
 * What the user is told when the message really did move but PUTTING IT
 * BACK failed.
 *
 * A separate string from `moveFailureFor` because the two states are not
 * the same and the row does not end up in the same place: after a failed
 * move the message is still in the inbox, after a failed undo it is not.
 * Telling the user "could not be archived" for the second would send them
 * looking in the wrong folder.
 */
export function undoFailureFor(destination: MoveDestination): string {
  return `That message stayed ${pastParticipleFor(destination)} — Postbox couldn't move it back.`;
}

/**
 * Where a message ENDED UP, as the word a failed-undo sentence needs:
 * "stayed archived", "stayed trashed", "stayed reported".
 *
 * Exported only because ./bulkActions.ts needs the identical word for the
 * batch form of the same sentence, and two hand-written copies of a
 * three-way ternary is how "trashed" becomes "moved to Trash" in one
 * place and not the other. Behaviour is unchanged — `undoFailureFor`
 * above produces exactly the strings it always did.
 */
export function pastParticipleFor(destination: MoveDestination): string {
  switch (destination) {
    case 'archive':
      return 'archived';
    case 'trash':
      return 'trashed';
    case 'spam':
      return 'reported';
  }
}

/** What the undo bar's own button says, and what a screen reader
 *  announces for it. One string, so the visible label and the accessible
 *  name cannot drift. */
export function undoLabelFor(destination: MoveDestination): string {
  return `Undo ${destination === 'archive' ? 'archive' : destination === 'trash' ? 'move to Trash' : 'report as spam'}`;
}
