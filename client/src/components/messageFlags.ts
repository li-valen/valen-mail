import type { InboxMessage } from '../api';

/**
 * IMAP's own "has been read" flag. sync/src/normalize.ts's `toSortedArray`
 * groups system flags (the `\`-prefixed ones) before custom labels, then
 * sorts alphabetically within each group — which is why a real row's
 * flags read `['\Answered', '\Seen']` or `['\Flagged', '\Seen']` (A, F <
 * S) rather than `\Seen` always being first or last by insertion order.
 * `isUnread` below must not assume a position; it checks membership.
 */
const SEEN_FLAG = '\\Seen';

/**
 * True when `message` has not been read: the absence of the IMAP `\Seen`
 * flag (client/DESIGN.md's MessageRow anatomy, "sender (500 if unread)").
 *
 * **Why this is safe to derive from `flags` at all.** Originally left
 * unimplemented in this task (see task-4-report.md's first pass) because
 * the one sample message given up front showed `flags: []`, with no way
 * to tell "the sync path never captures flags" from "this message really
 * has none set" — guessing wrong would have rendered every row unread.
 * Resolved with data: a 200-message sample across accounts came back 156
 * `[]` / 38 `['\Seen']` / 5 `['\Answered', '\Seen']` / 1
 * `['\Flagged', '\Seen']` (task-4-report.md, "fix round 1") — flags ARE
 * populated through the same sync path as every other field, an empty
 * array is a genuine "no flags set", and roughly 22% \Seen is unremarkable
 * for a newsletter-heavy inbox.
 *
 * **Membership, not emptiness.** `flags.length === 0` is the wrong check:
 * `['\Answered', '\Seen']` must read as read despite having two entries,
 * and `['\Flagged']` (no `\Seen`) must read as unread despite having one.
 * Only `.includes(SEEN_FLAG)` gets both right — see
 * client/tests/message-flags.test.ts for the cases this must not regress
 * on, and task-4-report.md for exactly which naive length-based
 * implementations they were chosen to catch.
 *
 * **STALENESS — read this before treating an old bolded row as a bug.**
 * sync/ only ever fetches the newest ~50 UIDs per account (see
 * sync/src/imap/fetch.ts and the backfill window in sync/src/db.ts); flags
 * on any message that has aged out of that window are never re-fetched
 * after their first sync. A message read in the real mailbox months ago
 * can therefore render as unread here PERMANENTLY, if it was already
 * outside the window (or fell out of it) before this client ever saw an
 * updated `\Seen`. This is a genuine limitation of the sync design, not a
 * bug in this function, and it cannot be corrected from the client — this
 * function only ever sees whatever sync/ last wrote to Postgres.
 * Deliberately NOT surfaced as a UI caveat (per-row disclaimers are noise,
 * not honesty — no mail client explains its own sync model in the list);
 * this comment is the intended place a future reader finds the answer.
 *
 * A `null` `flags` value (the type allows it defensively; sync/ itself
 * always sends an array, even an empty one — normalize.ts's
 * `toSortedArray` never returns anything else) is treated the same as an
 * empty array: unread. Unknown is the conservative default here, the same
 * way an unrecognised read-state classification degrades to "unconfirmed"
 * rather than "confirmed" elsewhere in this product.
 */
export function isUnread(message: InboxMessage): boolean {
  return !(message.flags ?? []).includes(SEEN_FLAG);
}
