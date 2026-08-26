import { Paperclip } from 'lucide-react';
import type { InboxMessage } from '../api';
import { Badge } from '../ui/Badge';
import { cn } from '../ui/cn';
import { formatWhen } from './inboxDates';
import { messageKey } from './messageBody';
import { rowLayoutFor } from './messageRowLayout';
import { isUnread } from './messageFlags';

export interface MessageRowProps {
  readonly message: InboxMessage;
  /** The "now" InboxList resolved for this render pass — passed down
   *  rather than read from `new Date()` here so every row in the same
   *  list agrees on what "today" means, and so formatWhen stays testable
   *  as a pure function (task-4-brief.md Amendment 3). */
  readonly now: Date;
  /** Opens this message in the reader. Required, not optional: a row with
   *  no destination is the defect Plan 6 exists to fix, and an optional
   *  handler would let a caller reintroduce it silently. */
  readonly onOpen: (message: InboxMessage) => void;
  /**
   * Warms this message's body before it is opened — fired on MOUSE hover
   * and on keyboard focus, which are the two moments a user has committed
   * attention to a row without having clicked yet.
   *
   * Optional, unlike `onOpen`: a list that does not prefetch is slower,
   * not broken, and the opens rail's own row list has no reason to.
   */
  readonly onPrefetch?: (message: InboxMessage) => void;
}

/**
 * One row of the unified inbox.
 *
 * **TWO ANATOMIES, SPLIT AT `lg:` — and the split is the user's, not a
 * design preference.** Shown the desktop app they said *"it looks pretty
 * decent on mac"*; shown a Gmail-mobile screenshot they asked for the
 * phone layout to become that. So:
 *
 *   - **`>= lg` — UNCHANGED.** One line: sender in a fixed 160px column,
 *     subject taking every remaining pixel, meta (paperclip · account
 *     chip · time) right-aligned, inside the divided `Card` this list has
 *     always used. Its borders, spacing and unread expression are exactly
 *     what shipped before Plan 7 Task 3. The ONE addition is the preview,
 *     and it is an addition to the subject's own line rather than to the
 *     row: see the height contract below.
 *   - **`< lg` — the Gmail-mobile row.** A circular initial avatar, then
 *     sender with the time right-aligned beside it, then subject and
 *     preview. No card, no dividers, no rules of any kind: rows are
 *     separated by nothing but the whitespace inside them, and the only
 *     rounded thing is the soft press/hover shape. Unread is **weight
 *     alone** — identical background and identical text colour on every
 *     row, `font-semibold` on the two lines that carry meaning. The
 *     borderless treatment lives in InboxList.tsx, which owns the card
 *     and the dividers this row sits between.
 *
 * **ONE `<button>`, TWO LAYOUT BLOCKS, and only ever one of them live.**
 * The alternative — a single DOM reshuffled with `display: contents` and
 * responsive `order` — was rejected for a reason bigger than taste: the
 * whole point of the correction is that the desktop row must be
 * verifiably untouched, and a shared DOM makes every mobile tweak a
 * potential desktop regression. Two blocks under `hidden`/`lg:hidden`
 * make the desktop markup readable as its own thing. `hidden` is
 * `display: none`, so the inactive block is out of the accessibility tree
 * and the tab order too — a screen reader never hears the subject twice.
 * `data-message-key` stays on the single button, which is what App.tsx
 * finds to restore focus when the reader closes; two buttons would give
 * that query two answers.
 *
 * **THE HEIGHT CONTRACT — why the preview never gets a line of its own.**
 * Plan 7 Task 1 populated `snippet` for newly-synced mail only, so all
 * 461 rows in the database today have `snippet: null` permanently. A row
 * that reserved line three for a preview would render as a blank gap on
 * every message this user currently owns, and a row that GREW a line when
 * one arrived would make the list change height under the reader's thumb
 * as new mail syncs. So the preview extends the SUBJECT's line — "Q3
 * numbers — Numbers attached, see tab two" — and a row without one is
 * simply "Q3 numbers". Same height either way, at both breakpoints, and
 * nothing anywhere reserves space for something that may never come.
 * ./messageRowLayout.ts owns that resolution and
 * tests/message-row-layout.test.ts holds it.
 *
 * **XSS.** `subject`, `from_name`/`from_email`, `snippet` and
 * `account_id` are attacker-controlled — any sender picks their own
 * display name, subject line and message body. They are only ever
 * interpolated as JSX text children, which React escapes; this file never
 * touches `dangerouslySetInnerHTML`.
 */

/**
 * The account chip's text: the first three characters of `accountId`,
 * lower-cased — `primary` -> `pri`, `harvard` -> `har`. It is a label,
 * never a filter — no click handler, nothing it can be pressed to do — so
 * an id shorter than three characters degrading to itself in full is an
 * acceptable edge case rather than one worth a fallback branch for
 * accounts that do not exist yet.
 */
function accountChip(accountId: string): string {
  return accountId.slice(0, 3).toLowerCase();
}

/** `ring-inset` rather than `ring-offset-2`: above `lg:` these rows sit
 *  inside a `Card`, which is `overflow-hidden`, so an outset ring would
 *  be clipped along the row's full-bleed left and right edges — visible
 *  focus that is only half visible is the failure this avoids. Below
 *  `lg:` there is no card, and an inset ring is still the right shape:
 *  it follows the row's own rounded corners.
 *
 *  Exported (task V3) so OpensFeed.tsx's `OpenEntry` — a button-per-row
 *  inside the SAME kind of `overflow-hidden` `Card`/rail — gets the
 *  identical inset-ring treatment rather than a second, drifting copy of
 *  this string. */
export const ROW_FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset';

/**
 * The avatar circles, below `lg:` only.
 *
 * SIX HAND-CHECKED PAIRS, not a generated ramp. Each entry names its own
 * dark values explicitly rather than relying on a semantic token, because
 * there is no semantic token for "one of several peer identities" — the
 * palette in src/styles.css has exactly one accent. The light halves sit
 * at the `-100`/`-900` steps and the dark halves at `-950`/`-200`, which
 * keeps every tone a pale ground with dark text in light mode and the
 * reverse in dark, at comparable contrast in both.
 *
 * DELIBERATELY LOW CHROMA. client/DESIGN.md's thesis reserves saturated
 * colour for the three read-states, and the opens rail renders those
 * marks on the same screen. Pale circles at the `-100` step do not
 * compete with a saturated 8px dot; six mid-tone circles would.
 *
 * Kept in this `.tsx` file on purpose: tests/neutral-class-guard.test.ts
 * scans `src/**\/*.tsx`, so a palette declared here is inside the guard's
 * reach. Declared in a `.ts` module it would not be.
 */
const AVATAR_TONES: readonly string[] = [
  'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200',
  'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
  'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200',
  'bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-200',
];

export default function MessageRow({ message, now, onOpen, onPrefetch }: MessageRowProps) {
  const { sender, subject, preview, initial, tone } = rowLayoutFor(message);
  const unread = isUnread(message);
  const when = formatWhen(message.date, now);

  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(message)}
        /* PREFETCH TRIGGERS — hover and focus, and nothing else.
           `pointerType === 'mouse'` is the whole desktop/touch split, and
           it is not fussiness: on a touch screen `pointerenter` fires
           immediately before `click`, so an unguarded handler would issue
           a speculative fetch for the message the very next line is about
           to fetch for real — two requests, one message, on the device
           least able to afford either. A mouse hover, by contrast, buys
           the 100–300ms of human latency between arriving at a row and
           pressing it.
           `onFocus` is the keyboard's equivalent of that hover and needs
           no guard: tabbing to a row is as deliberate as pointing at it.
           Both are idempotent — see src/messagePrefetch.ts, which drops a
           request for anything already cached, queued or in flight, so
           these can fire as often as the browser likes. */
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') onPrefetch?.(message);
        }}
        onFocus={() => onPrefetch?.(message)}
        data-message-key={messageKey(message)}
        /* PLAN 7 TASK 2 — pressed feedback, as a TINT and never a scale.
           A 3% scale is right for a button-shaped button (see
           ui/Button.tsx); on a full-bleed row inside a divided list it
           shrinks the row away from its own dividers and reads as a
           glitch. A darker tint on `:active` gives the same "heard you"
           on the one property a 50-row list can afford to animate.
           `transition-colors` is Tailwind's 150ms, which is
           DURATION_MS.hover (src/motion/tokens.ts). No `motion-safe:`
           gate: this is a colour change with no movement in it, which is
           the class of feedback reduced-motion guidance says to keep.

           The tint itself is unchanged at both breakpoints; only its
           SHAPE differs — `rounded-xl` below `lg:`, where there is no
           card and the user asked for soft edges, and square above it,
           where the row is a full-bleed slice of a divided card. */
        className={cn(
          'block w-full cursor-pointer text-left text-sm transition-colors',
          'rounded-xl hover:bg-neutral-50 active:bg-neutral-100 dark:hover:bg-accent dark:active:bg-accent',
          'lg:rounded-none',
          ROW_FOCUS,
        )}
      >
        {unread && <span className="sr-only">Unread. </span>}

        {/* ── below lg: the Gmail-mobile row ───────────────────────── */}
        <span className="flex items-start gap-3 px-3 py-2.5 lg:hidden">
          {/* `aria-hidden`: the circle is a recognition aid for the eye,
              and its letter is the first letter of the sender name the
              next line already announces. Reading "K, Kate Bell" is
              noise. */}
          <span
            aria-hidden="true"
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
              AVATAR_TONES[tone] ?? AVATAR_TONES[0],
            )}
          >
            {initial}
          </span>

          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              {/* UNREAD IS WEIGHT ALONE below `lg:`. Same colour, same
                  ground, both states — the user asked for the tinted
                  highlight to go, and a colour step would be the same
                  claim in a quieter voice. */}
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-neutral-900 dark:text-foreground',
                  unread && 'font-semibold',
                )}
              >
                {sender}
              </span>
              {message.has_attach && (
                <>
                  <Paperclip
                    className="h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="sr-only">Has attachment</span>
                </>
              )}
              <span className="shrink-0 font-mono text-[11px] uppercase text-neutral-500 dark:text-muted-foreground">
                {accountChip(message.account_id)}
              </span>
              <span className="shrink-0 font-mono text-xs tabular-nums text-neutral-500 dark:text-muted-foreground">
                {when}
              </span>
            </span>

            {/* ONE BLOCK, allowed to WRAP to two lines — not one
                truncating line, and not a dedicated preview line.

                The preview is a continuation of the subject rather than a
                field of its own, which is what keeps a row's structure
                independent of whether `snippet` is null. What varies is
                how much TEXT there is, exactly as it would for a long
                subject with no snippet at all — so a row with a preview
                and a row without are not two shapes, they are the same
                shape with different amounts of text in it. Nothing is
                ever reserved and nothing is ever blank.

                `line-clamp-2` rather than `truncate` because a phone is
                ~250px wide here: on one line the subject consumes all of
                it and the preview renders as three characters and an
                ellipsis, which is the user's "longer descriptions at the
                bottom" delivered in name only. Two lines is where the
                preview becomes something you can actually read. The
                desktop row keeps its single line, where 500+px means the
                preview is legible without one. */}
            <span
              className={cn(
                'mt-0.5 line-clamp-2 text-neutral-900 dark:text-foreground',
                unread && 'font-semibold',
              )}
            >
              {subject}
              {preview !== null && (
                <span className="font-normal text-neutral-500 dark:text-muted-foreground">
                  {' '}
                  — {preview}
                </span>
              )}
            </span>
          </span>
        </span>

        {/* ── lg and up: the desktop row, unchanged ────────────────── */}
        <span className="hidden h-11 w-full items-center gap-3 px-4 lg:flex">
          <span
            className={
              unread
                ? 'w-40 shrink-0 truncate font-semibold text-neutral-900 dark:text-foreground'
                : 'w-40 shrink-0 truncate text-neutral-700 dark:text-muted-foreground'
            }
          >
            {sender}
          </span>

          <span className="min-w-0 flex-1 truncate text-neutral-500 dark:text-muted-foreground">
            {subject}
            {preview !== null && (
              <span className="text-neutral-400 dark:text-muted-foreground"> — {preview}</span>
            )}
          </span>

          <span className="flex shrink-0 items-center gap-2">
            {message.has_attach && (
              <>
                <Paperclip
                  className="h-3.5 w-3.5 text-neutral-400 dark:text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="sr-only">Has attachment</span>
              </>
            )}
            <Badge variant="neutral" className="px-1.5 py-0 font-mono text-[10px] font-medium uppercase">
              {accountChip(message.account_id)}
            </Badge>
            <span className="w-16 whitespace-nowrap text-right font-mono text-xs tabular-nums text-neutral-400 dark:text-muted-foreground">
              {when}
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}
