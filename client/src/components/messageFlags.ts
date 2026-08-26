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

/**
 * IMAP's "starred" flag. Same normalisation caveat as `SEEN_FLAG` above —
 * sync/src/normalize.ts sorts system flags alphabetically, so `\Flagged`
 * arrives before `\Seen` in `['\Flagged', '\Seen']` and after nothing in
 * particular anywhere else. Membership, never position.
 */
const FLAGGED_FLAG = '\\Flagged';

/**
 * True when `message` is starred — the presence of `\Flagged`.
 *
 * The mirror of `isUnread` above, and it inherits that function's entire
 * STALENESS caveat unchanged: sync/ only re-reads flags for messages
 * inside its ~50-UID window, so a message starred in the real mailbox
 * after it aged out will never show a star here. The write path below is
 * what keeps a star SET FROM THIS APP honest in the meantime.
 */
export function isStarred(message: InboxMessage): boolean {
  return (message.flags ?? []).includes(FLAGGED_FLAG);
}

/**
 * The optimistic layer over `isStarred`.
 *
 * **WHY AN OVERLAY RATHER THAN A MUTATED ROW.** The list rows are owned
 * by components/InboxList.tsx's `messages` state; the reader's copy is
 * owned by App.tsx's `selected`; the thread rows are owned by
 * the thread stack. Starring from a keyboard shortcut has to change what all
 * three draw, and threading a setter into each one would put the same
 * write in three places that can drift. A `Map<messageKey, boolean>` in
 * App.tsx is read by every one of them through this function and is a
 * single place to revert from when the PATCH fails.
 *
 * **AND WHY IT IS NOT A CACHE.** An entry means "this app changed this
 * flag and the server agreed", not "this is the truth about this
 * message". It lives for the session, and the next sync cycle's `flags`
 * are what the row falls back to the moment the entry is dropped.
 */
export function resolveStar(
  message: InboxMessage,
  overrides: ReadonlyMap<string, boolean>,
  key: string,
): boolean {
  return overrides.get(key) ?? isStarred(message);
}

/**
 * The same optimistic overlay, for `\Seen`.
 *
 * **THE MAP STORES `seen`, AND THIS RETURNS `unread`.** The inversion is
 * here, once, on purpose: the wire field is `seen` (src/api.ts's
 * `FlagField`, sync/src/api/flags.ts's body), so an override written as
 * anything else would need translating at every write site instead of at
 * the one read site. A `true` entry means "this app marked it read and
 * the server agreed", so the row is not unread.
 *
 * ABSENT means "no opinion", which falls through to `isUnread` above —
 * NOT to "read". That is what makes the revert path safe: a bulk
 * mark-read whose PATCH failed DELETES the entry rather than flipping it,
 * so the row falls back to what the mailbox actually says rather than to
 * the opposite of what was asked for.
 */
export function resolveUnread(
  message: InboxMessage,
  seenOverrides: ReadonlyMap<string, boolean>,
  key: string,
): boolean {
  const override = seenOverrides.get(key);
  if (override === undefined) return isUnread(message);
  return !override;
}

/** A NEW map with one entry set. Never mutates its input — the whole
 *  point of holding this in React state is that a changed map is a new
 *  identity a render can key on. */
export function withFlagOverride(
  overrides: ReadonlyMap<string, boolean>,
  key: string,
  value: boolean,
): ReadonlyMap<string, boolean> {
  return new Map(overrides).set(key, value);
}

/** A NEW map with one entry removed — the revert path when the PATCH
 *  fails, which drops back to whatever `flags` actually says rather than
 *  asserting the opposite. */
export function withoutFlagOverride(
  overrides: ReadonlyMap<string, boolean>,
  key: string,
): ReadonlyMap<string, boolean> {
  const next = new Map(overrides);
  next.delete(key);
  return next;
}

/**
 * The same two operations over MANY keys, in ONE new map.
 *
 * Not a fold of the singular forms, and the difference is not
 * micro-optimisation: `keys.reduce(withFlagOverride, map)` allocates a
 * fresh `Map` per key, so a bulk mark-read over forty rows would build
 * forty maps and hand React thirty-nine identities it must not render
 * against. One copy, one state update, one render.
 */
export function withFlagOverrides(
  overrides: ReadonlyMap<string, boolean>,
  keys: readonly string[],
  value: boolean,
): ReadonlyMap<string, boolean> {
  if (keys.length === 0) return overrides;
  const next = new Map(overrides);
  for (const key of keys) next.set(key, value);
  return next;
}

/** The bulk revert. Returns the SAME map when nothing was dropped, so a
 *  batch in which every write took causes no render at all. */
export function withoutFlagOverrides(
  overrides: ReadonlyMap<string, boolean>,
  keys: readonly string[],
): ReadonlyMap<string, boolean> {
  if (keys.length === 0) return overrides;
  const next = new Map(overrides);
  for (const key of keys) next.delete(key);
  return next;
}

/** Star-named aliases, kept because that is what the star's call sites
 *  mean and a generically-named call there would read as though it could
 *  set any flag. One implementation, two honest names. */
export function withStar(
  overrides: ReadonlyMap<string, boolean>,
  key: string,
  value: boolean,
): ReadonlyMap<string, boolean> {
  return withFlagOverride(overrides, key, value);
}

export function withoutStar(
  overrides: ReadonlyMap<string, boolean>,
  key: string,
): ReadonlyMap<string, boolean> {
  return withoutFlagOverride(overrides, key);
}
