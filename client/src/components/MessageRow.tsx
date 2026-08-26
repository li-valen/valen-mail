import type { ReactNode } from 'react';
import { Archive, Paperclip, Star, Trash2 } from 'lucide-react';
import type { InboxMessage } from '../api';
import type { MoveDestination } from '../mailboxActions';
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
  /**
   * True when this row is under the keyboard cursor. Draws the selection
   * treatment (see SELECTED below) and sets `aria-current`.
   *
   * NOT the same thing as focus, and the difference is the whole reason
   * this is a prop rather than a `:focus` style. The cursor survives the
   * user clicking a folder in the sidebar, tabbing to the theme toggle,
   * or opening and closing the reader — none of which leave focus on the
   * row, all of which must leave the cursor where it was.
   */
  readonly isSelected?: boolean;
  /** Whether to draw the star. Resolved by the caller through
   *  ./messageFlags.ts's `resolveStar`, so an optimistic toggle that has
   *  not yet been confirmed by the server draws the same as a real one. */
  readonly isStarred?: boolean;
  /**
   * This row's place in the roving tab order — `0` for the one tab stop,
   * `-1` for everything else. See the ROVING TABINDEX note in the
   * component header for why this list uses that and not
   * `aria-activedescendant`.
   */
  readonly tabIndex?: number;
  /** Fired when the row takes focus, so a user driving with Tab (or a
   *  screen reader moving through the list) brings the cursor with them
   *  rather than leaving it behind on a row they are no longer on. */
  readonly onSelect?: (message: InboxMessage) => void;
  /**
   * Archive / Move to Trash for this row, revealed on hover at `lg:` and
   * ABOVE ONLY.
   *
   * **`lg:` only, and it is the user's split rather than a size
   * threshold** — the same reasoning as the two anatomies above and as
   * the selection ring. Below `lg:` the row IS the tap target: a pair of
   * 32px controls sitting on top of it would put a destructive action a
   * thumb-width from "open this message", and there is no hover on a
   * phone to keep them out of the way in the meantime. Gmail's own mobile
   * app uses a swipe for this, which is a gesture system this app does
   * not have and is not the subject of this task.
   *
   * Omitted (no controls at all) rather than present-and-inert when the
   * surface does not support the action.
   */
  readonly onMailboxMove?: (message: InboxMessage, destination: MoveDestination) => void;
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
 * **ROVING TABINDEX, NOT `aria-activedescendant` — and the choice is
 * forced by what a row already is.** Every row here is a real
 * `<button>`: the platform gives it a role, an accessible name built from
 * the text inside it, and activation on both Enter and Space, none of
 * which this file has to implement or can get wrong.
 * `aria-activedescendant` would require the opposite arrangement — one
 * focusable container with `role="listbox"`, rows demoted to
 * `role="option"`, and activation re-implemented by hand because focus
 * would live on the container rather than on the thing being activated.
 * It would also be a lie about what the list IS: a listbox is how you
 * CHOOSE A VALUE, and opening a message is navigation. There is a
 * structural obstacle on top of the semantic one — InboxList renders one
 * `<ul>` per day group inside its own `<Card>`, so there is no single
 * element that owns all the rows for an `aria-activedescendant`
 * relationship to point through without `aria-owns` gymnastics.
 *
 * Roving keeps all of that and fixes a wart it inherits: the list used to
 * be fifty tab stops, and is now one — Tab lands on the cursor row, and
 * `j`/`k` move from there. Moving the cursor also moves real DOM focus
 * (src/keyboard/revealRow.ts), which is what makes each move ANNOUNCED
 * rather than merely drawn.
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
 * The keyboard cursor's own treatment: a tint one step stronger than
 * hover, plus a 2px bar down the leading edge.
 *
 * **`lg:` ONLY.** A phone has no keyboard, so below `lg:` there is no
 * cursor to draw — and the user was explicit that the mobile list stays
 * borderless and untinted. Drawing a selection band there would
 * reintroduce exactly the highlight they asked to remove, for a feature
 * that cannot be operated on that device.
 *
 * **AN INSET SHADOW, NOT A BORDER.** A border would add 2px to the row's
 * box and shift every sender name sideways the moment the cursor arrived;
 * an inset shadow paints inside the existing box and costs no layout.
 * (The `Card` above is `overflow-hidden`, which is also why ROW_FOCUS
 * uses `ring-inset` — same constraint, same answer.)
 *
 * **DISTINCT FROM THE FOCUS RING ON PURPOSE.** The two coincide most of
 * the time (moving the cursor moves focus) and must not be the same mark,
 * because they come apart exactly when it matters: click a folder, and
 * focus goes to the sidebar while the cursor stays on the row it was on.
 */
export const ROW_SELECTED =
  'lg:bg-neutral-100 dark:lg:bg-accent lg:shadow-[inset_2px_0_0_0_var(--color-primary)]';

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

interface RowActionProps {
  /** The ACCESSIBLE NAME, and it names the message as well as the verb.
   *  A list of fifty rows produces fifty "Archive" buttons; a screen
   *  reader user tabbing through them needs to know which row they are
   *  on, and the row's own text is not read as part of a nested control's
   *  name. */
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}

/**
 * One hover action on a list row.
 *
 * Not `ui/Button.tsx`: that component's `motion-safe:active:scale-[0.97]`
 * is right for a button-shaped button and wrong for a 28px icon sitting
 * inside a 44px row, where a 3% scale reads as a wobble. Same focus ring,
 * same hover tint, same transition duration — everything a Button gives
 * that this needs, without the press scale.
 */
function RowAction({ label, onClick, children }: RowActionProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      /* The row underneath is itself a button whose click opens the
         message. Without this, archiving a row would open it in the same
         gesture — the click bubbles to the row's own handler. */
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      /* Roving tabindex on the ROWS is what keyboard/selection.ts drives;
         these are not part of that sequence and must not become fifty
         extra tab stops in a fifty-row list. They stay reachable — Tab
         from the row lands on them — because -1 only removes them from
         the SEQUENTIAL order, not from focus. The keyboard's real path to
         this behaviour is `e` and `#`. */
      tabIndex={-1}
      className={cn(
        'inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md',
        'text-neutral-500 transition-colors duration-150 dark:text-muted-foreground',
        'hover:bg-neutral-200 hover:text-neutral-900 dark:hover:bg-secondary dark:hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      {children}
    </button>
  );
}

export default function MessageRow({
  message,
  now,
  onOpen,
  onPrefetch,
  isSelected = false,
  isStarred = false,
  tabIndex,
  onSelect,
  onMailboxMove,
}: MessageRowProps) {
  const { sender, subject, preview, initial, tone } = rowLayoutFor(message);
  const unread = isUnread(message);
  const when = formatWhen(message.date, now);

  return (
    // `group` and `relative` exist ONLY for the hover actions below: the
    // row button cannot contain them (a <button> inside a <button> is
    // invalid and browsers un-nest it), so they are a SIBLING positioned
    // over the row's right end.
    <li className="group relative">
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
        onFocus={() => {
          onPrefetch?.(message);
          // Tab (or a screen reader's own row-to-row movement) brings the
          // cursor with it, so a following `j` continues from where the
          // user actually is rather than from wherever the cursor was
          // left. Idempotent: src/keyboard/revealRow.ts focuses the row
          // the cursor just moved TO, so this fires with the index the
          // caller already holds and React bails out of the update.
          onSelect?.(message);
        }}
        data-message-key={messageKey(message)}
        /* Roving: `0` on the cursor row, `-1` on the rest. `undefined`
           when the list is not being driven by the keyboard at all,
           which leaves the platform's own default (every button a tab
           stop) exactly as it was. */
        tabIndex={tabIndex}
        /* `aria-current`, not `aria-selected`: the latter is only
           meaningful inside a listbox/grid, which this deliberately is
           not (see the ROVING TABINDEX note above). `true` is the right
           token for "the one in this set the user is on". */
        aria-current={isSelected ? true : undefined}
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
          isSelected && ROW_SELECTED,
        )}
      >
        {unread && <span className="sr-only">Unread. </span>}
        {isStarred && <span className="sr-only">Starred. </span>}

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
              {isStarred && (
                /* `aria-hidden`: the sr-only "Starred." above the row
                   already says it once, at the start, where it is useful
                   — repeating it here would put it in the middle of the
                   sender's name. */
                <Star
                  className="h-3.5 w-3.5 shrink-0 fill-current text-amber-500 dark:text-amber-400"
                  aria-hidden="true"
                />
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

          {/* Hidden — not removed — while the hover actions are showing,
              so the row's width never changes under the pointer and the
              actions need no backdrop of their own to stay legible.
              `invisible` keeps the layout, which is the whole point.

              **HOVER ONLY, NEVER `group-focus-within`.** This originally
              also hid on focus-within, and live verification caught what
              that costs: the hover actions are `tabIndex={-1}`, so
              FOCUSING a row (every `j`/`k` move, and the focus restore on
              Back from the reader) hid the badge and timestamp while
              nothing appeared in their place — a row that silently lost
              half its content whenever the keyboard touched it. Every
              test in the suite passed through that. The two conditions
              have to be the SAME condition, and hover is the one the
              actions actually appear on. */}
          <span
            className={cn(
              'flex shrink-0 items-center gap-2',
              onMailboxMove !== undefined && 'group-hover:invisible',
            )}
          >
            {message.has_attach && (
              <>
                <Paperclip
                  className="h-3.5 w-3.5 text-neutral-400 dark:text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="sr-only">Has attachment</span>
              </>
            )}
            {isStarred && (
              <Star
                className="h-3.5 w-3.5 fill-current text-amber-500 dark:text-amber-400"
                aria-hidden="true"
              />
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

      {onMailboxMove !== undefined && (
        /* THE HOVER ACTIONS. They REPLACE the right-hand cluster rather
           than sitting on top of it — see the `group-hover:invisible`
           above — which is what Gmail does and what removes the need for
           an opaque backdrop that would have to track the row's hover,
           selected and active tints to stay legible.

           `focus-within:` as well as `group-hover:`, so the controls are
           reachable by Tab and are VISIBLE once focused rather than being
           a transparent thing the focus ring is drawn around.
           `pointer-events-none` while hidden so they can never swallow a
           click meant for the row underneath. */
        <span
          className={cn(
            'pointer-events-none absolute inset-y-0 right-0 hidden items-center gap-0.5 pr-3 opacity-0',
            'transition-opacity duration-150',
            'group-hover:pointer-events-auto group-hover:opacity-100',
            'focus-within:pointer-events-auto focus-within:opacity-100',
            'lg:flex',
          )}
        >
          <RowAction
            label={`Archive: ${subject}`}
            onClick={() => onMailboxMove(message, 'archive')}
          >
            <Archive className="h-4 w-4" aria-hidden="true" />
          </RowAction>
          <RowAction
            label={`Move to Trash: ${subject}`}
            onClick={() => onMailboxMove(message, 'trash')}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </RowAction>
        </span>
      )}
    </li>
  );
}
