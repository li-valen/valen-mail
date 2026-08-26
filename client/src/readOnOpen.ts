import type { InboxMessage } from './api';
import { setMessageFlag } from './api';

/**
 * Marking a message `\Seen` because a person opened it — as pure data and
 * injected ports, with no React anywhere near it.
 *
 * client/CLAUDE.md's standing constraint is that no test in this project
 * renders a component, so a decision made inside App.tsx's `openMessage`
 * is a decision no test can reach. The decision lives here; App.tsx holds
 * only the overlay state and calls this.
 *
 * ---------------------------------------------------------------------
 * THIS IS NOT A READ-STATE IN THE SENSE components/ReadState.tsx MEANS.
 * ---------------------------------------------------------------------
 * That file's vocabulary — `confirmed`, `unknown`, and the feed's own
 * `unavailable` — is about whether a RECIPIENT read mail the user SENT,
 * and its whole reason to exist is refusing to overclaim that. Those
 * three tones are untouched by this module and must stay that way: the
 * `\Seen` flag is the opposite direction (mail the user RECEIVED and has
 * now looked at), it is a fact rather than an inference, and it is the
 * mailbox's own bit rather than a classification of a pixel fetch.
 * Nothing here may ever be rendered through `readStateFor`, and nothing
 * here changes what a tracking event means — conflating the two would
 * turn "you opened this" into "they opened this", which is the single
 * claim this product exists not to make.
 *
 * ---------------------------------------------------------------------
 * ONLY AN ACTUAL OPEN, NEVER A PREFETCH.
 * ---------------------------------------------------------------------
 * ./messagePrefetch.ts warms the cache for hovered and adjacent
 * messages — a pointer sweeping down the list, and the rows either side
 * of whatever is open. Those are guesses about what the user MIGHT read.
 * Marking them read would silently clear mail nobody looked at, which is
 * data loss dressed as a convenience: the user's own words for what this
 * feature is for are *"this way I know which emails I have opened."*
 *
 * The structural guarantee is that this module is not reachable from the
 * prefetcher: prefetch calls ./messageLoader.ts's `fetchMessage` and
 * nothing else, and the only caller of `markReadOnOpen` is App.tsx's
 * `openMessage` — the single funnel every real open goes through (a list
 * row, a thread row inside the reader, a click in the opens rail). It is
 * a function of the OPEN, not of the fetch, which is also why a message
 * served from cache still marks read: `openMessage` runs whether or not
 * anything went to the network.
 */

/** The write itself, injectable so tests never touch `fetch`. Mirrors
 *  ./bulkActions.ts's `SetSeenOne`, which is the same PATCH from the bulk
 *  bar's side. */
export type WriteSeen = (message: InboxMessage, seen: boolean) => Promise<void>;

const writeSeen: WriteSeen = (message, seen) =>
  setMessageFlag(message.account_id, message.folder, message.uid, 'seen', seen);

/**
 * What an open does to the read state, in one place.
 *
 * `'skipped'`  — the message was already read, so nothing was written.
 * `'marked'`   — the flag was written and the row stays un-highlighted.
 * `'reverted'` — the write failed and the row went back to unread.
 */
export type MarkReadOutcome = 'skipped' | 'marked' | 'reverted';

export interface MarkReadOnOpenOptions {
  /**
   * Whether the row is unread AS THE LIST CURRENTLY DRAWS IT — i.e. via
   * components/messageFlags.ts's `resolveUnread`, which consults the
   * optimistic overrides before it consults `flags`.
   *
   * Reading it through the overrides rather than off `message.flags` is
   * what makes re-opening a message a no-op: the first open's override
   * already says "read", so the second open writes nothing. Without that,
   * every re-open of the same message would fire another PATCH at Gmail
   * for a flag it already has.
   */
  readonly isUnread: boolean;
  /** The row's `messageKey` — the identity the overlay is keyed by. */
  readonly key: string;
  /** Applies the optimistic overlay. App.tsx's `applySeen`. */
  readonly setSeen: (keys: readonly string[], seen: boolean) => void;
  /**
   * DROPS the overlay entry, which falls back to whatever `flags`
   * actually says rather than asserting the opposite — see
   * components/messageFlags.ts's `resolveUnread`. App.tsx's `revertSeen`.
   */
  readonly revertSeen: (keys: readonly string[]) => void;
  readonly write?: WriteSeen;
  /** Where a failed write is reported. Never swallowed silently. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Marks one opened message `\Seen`, optimistically, and puts it back if
 * the write fails.
 *
 * **OPTIMISTIC, AND IT ROLLS BACK** — the same discipline, and the same
 * reasoning, as ./mailboxActions.ts's hide/reveal. The overlay is written
 * the instant the message is opened, so the row un-highlights while the
 * reader is still painting rather than a round trip later; and it is
 * REMOVED if the PATCH fails, so a row whose flag never actually changed
 * goes back to looking unread. A row that silently stays un-highlighted
 * over mail Gmail still considers unread is exactly the lie this rollback
 * exists to prevent — the user would believe they had dealt with
 * something they had not.
 *
 * ONE MESSAGE, NOT THE CONVERSATION. A collapsed row stands for a whole
 * thread, but the reader shows one message body; marking the other
 * members read would clear mail that was never on screen. The row's own
 * rollup then does the right thing for free — ./conversations.ts's
 * `isConversationUnread` is "any member is unread", so a conversation
 * with one unread message un-highlights on this open and one with three
 * correctly stays bold until they are read.
 *
 * Never rejects: a failed flag write is reported and rolled back, not
 * thrown at a caller that opened a message successfully.
 */
export async function markReadOnOpen(
  message: InboxMessage,
  options: MarkReadOnOpenOptions,
): Promise<MarkReadOutcome> {
  const { isUnread, key, setSeen, revertSeen, write = writeSeen, onError } = options;
  if (!isUnread) return 'skipped';

  setSeen([key], true);
  try {
    await write(message, true);
    return 'marked';
  } catch (error: unknown) {
    revertSeen([key]);
    onError?.(error);
    return 'reverted';
  }
}
