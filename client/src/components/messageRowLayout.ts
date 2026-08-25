import type { InboxMessage } from '../api';

/**
 * The text of one inbox row, resolved from a message — and with it, the
 * row's height contract.
 *
 * **THE PROBLEM THIS FILE EXISTS FOR.** Plan 7 Task 1 gave messages a
 * `snippet`, and explicitly did not backfill: every one of the 461 rows
 * already in the database has `snippet: null` permanently, and only mail
 * synced from now on gets one. The mixed list is therefore not an edge
 * case to tolerate — it is the ordinary case, and it will stay the
 * ordinary case for months. A two-line row that reserves its second line
 * for a preview would render most of this user's mail as a row with a
 * blank gap in it, and a row that grows a line only when a snippet exists
 * would make the list jitter between heights as the user scrolls.
 *
 * **THE ANATOMY THAT SOLVES BOTH.** Two lines, always:
 *
 * ```
 *   line 1   Kate Bell ································· 📎  pri  10:04
 *   line 2   Q3 numbers — Numbers attached, see tab two.
 * ```
 *
 * The preview EXTENDS line 2; it never adds a line 3. A row without one
 * is just `Q3 numbers`; a row with one is `Q3 numbers — Numbers
 * attached…`; both are exactly two lines tall. That is Gmail's own
 * answer, and it is the only arrangement that satisfies "longer
 * descriptions at the bottom" and "no layout shift between a row that has
 * one and a row that doesn't" at the same time.
 *
 * The load-bearing consequence: **line 2 must never be empty**, or the
 * one message with neither a subject nor a snippet becomes the single
 * short row in the list. `NO_SUBJECT_LABEL` is what guarantees it.
 *
 * **A PURE MODULE, NOT A COMPONENT.** No test in this codebase renders a
 * component (client/CLAUDE.md's standing constraint), so this is where
 * the height contract can actually be asserted —
 * tests/message-row-layout.test.ts proves the null-snippet and
 * with-snippet rows agree on `lines`, and that `preview` is `null` rather
 * than `''` so the component renders no node at all instead of an empty
 * span carrying its parent's gap.
 *
 * **XSS.** `from_name`, `from_email`, `subject` and `snippet` are all
 * attacker-authored — any sender picks their own display name, subject
 * and body. Everything here returns PLAIN TEXT and never markup, so the
 * only thing the component can do with the result is interpolate it as a
 * JSX text child, which React escapes. Nothing in this file or its caller
 * touches `dangerouslySetInnerHTML`.
 */

/** The same copy components/openEvents.ts uses for a missing subject, so
 *  a reader who has seen one has seen the other. */
export const NO_SUBJECT_LABEL = '(no subject)';

/** Shown when a message carries neither a display name nor an address —
 *  rare, and never a blank sender column. */
export const UNKNOWN_SENDER_LABEL = 'Unknown sender';

/** How many text lines every row occupies, snippet or not. The number a
 *  row's `min-height` and its skeleton are both derived from. */
export const ROW_LINES = 2;

/**
 * How many avatar tones the caller offers (Plan 7 Task 3's mobile
 * addendum: "a coloured circle with the sender's initial, and the colours
 * vary per sender").
 *
 * Six, not sixteen. The point of the colour is to make the same
 * correspondent recognisable at a glance while scrolling, which needs
 * only enough tones that neighbours differ — not enough to identify a
 * sender by colour alone, which no palette can do anyway. Six also keeps
 * the set small enough that every tone can be hand-checked against both
 * grounds, which is what the dark-mode rule actually requires.
 *
 * The tone INDEX is computed here; the colours themselves live in
 * MessageRow.tsx, because that is a `.tsx` file and therefore the file
 * tests/neutral-class-guard.test.ts scans for missing `dark:` pairings.
 * A palette hidden in a `.ts` module would be invisible to that guard.
 */
export const AVATAR_TONE_COUNT = 6;

export interface RowLayout {
  /** Line 1, left. Display name, else address, else a label. */
  readonly sender: string;
  /** Line 2, and never empty — see the header for why that is the whole
   *  point rather than a nicety. */
  readonly subject: string;
  /** Line 2, continued, muted. `null` — never `''` — when this message
   *  has no usable preview, which is every message synced before Plan 7. */
  readonly preview: string | null;
  /** The height contract: always `ROW_LINES`. Present as a field rather
   *  than left implicit so a test can hold two layouts against each
   *  other. */
  readonly lines: number;
  /** One character for the avatar circle below `lg:`. Uppercased, and
   *  the first LETTER OR DIGIT rather than the first character, so the
   *  marketing senders whose display names begin with an emoji or a
   *  bracket do not all render as the same glyph. */
  readonly initial: string;
  /** A stable index into the caller's tone palette, `0 …
   *  AVATAR_TONE_COUNT - 1`. Derived from the sender's ADDRESS where
   *  there is one, so the same correspondent keeps the same colour even
   *  when they change their display name — and so two different people
   *  sharing a first name do not share a circle. */
  readonly tone: number;
}

/**
 * Collapses the whitespace that arrives with header and body text —
 * folded subject headers carry `\r\n ` mid-value, and a snippet is body
 * text with its paragraph breaks intact. Left as-is they render as a
 * single space anyway in HTML, but they make the string's own length
 * lie about how much text there is, and they defeat any later measurement
 * of it.
 */
function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Normalised text, or `null` if there is nothing left after normalising.
 *  The `null` is what keeps an absent value from becoming an empty node. */
function textOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const collapsed = collapse(value);
  return collapsed.length === 0 ? null : collapsed;
}

/** The glyph in the avatar circle. `Array.from` rather than indexing, so
 *  a name beginning with an astral-plane character (an emoji, which a
 *  surprising number of marketing senders use) yields that whole
 *  character rather than half a surrogate pair. */
function initialOf(sender: string): string {
  const characters = Array.from(sender);
  const letterOrDigit = characters.find((character) => /[\p{L}\p{N}]/u.test(character));
  return (letterOrDigit ?? characters[0] ?? '?').toUpperCase();
}

/**
 * A small, stable, deterministic hash — FNV-1a's shape, kept to 32 bits
 * with `Math.imul` so it cannot drift into float territory on a long
 * address.
 *
 * NOT a security primitive and never used as one: its whole job is to
 * pick the same circle colour for the same correspondent on every render,
 * every reload and every device.
 */
function toneOf(identity: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.abs(hash) % AVATAR_TONE_COUNT;
}

export function rowLayoutFor(message: InboxMessage): RowLayout {
  const sender =
    textOrNull(message.from_name) ?? textOrNull(message.from_email) ?? UNKNOWN_SENDER_LABEL;
  return {
    sender,
    subject: textOrNull(message.subject) ?? NO_SUBJECT_LABEL,
    preview: textOrNull(message.snippet),
    lines: ROW_LINES,
    initial: initialOf(sender),
    tone: toneOf((textOrNull(message.from_email) ?? sender).toLowerCase()),
  };
}
