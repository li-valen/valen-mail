import { Paperclip } from 'lucide-react';
import type { InboxMessage } from '../api';
import { Badge } from '../ui/Badge';
import { formatWhen } from './inboxDates';
import { messageKey } from './messageBody';
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
}

/**
 * One row of the unified inbox, restyled onto Plunk's list vocabulary
 * (AGPL-3.0): the `divide-y divide-neutral-100` row list inside a `Card`
 * that `apps/web/src/pages/contacts/index.tsx` uses, with
 * `hover:bg-neutral-50` and a `Badge` for the account label.
 *
 * **Anatomy is width-dependent, on purpose.**
 *   - `>= sm` (640px+): one line — sender in a fixed 160px column, subject
 *     taking every remaining pixel, meta (paperclip · account · time)
 *     right-aligned.
 *   - `< sm` (phones): TWO lines, because a fixed sender column starves the
 *     subject at ~400px. Line 1 is sender + meta; line 2 is the subject at
 *     the FULL row width. DOM order stays sender → subject → meta (the
 *     order a screen reader should hear); the visual reflow is done with
 *     flex `order`, so nothing is announced out of sequence.
 *
 * **No snippet.** `snippet` is always `null` today (task-4-brief.md ground
 * truth: "a known, parked limitation"). This renders the row correctly
 * without one rather than reserving a line for it or writing placeholder
 * text that implies a snippet is coming.
 *
 * **Unread (sender at semibold).** Derived from `message.flags` via
 * `./messageFlags`'s `isUnread` — see that file's doc comment for why this
 * is safe to derive at all, and for the staleness caveat that comes with
 * it. The visually-hidden "Unread." prefix gives screen reader users the
 * same signal the weight gives sighted ones.
 *
 * **A BUTTON, as of Plan 6.** Every earlier version of this file was a
 * plain `<li>`, correctly, because there was no reading view to navigate
 * to and focus affordances for a destination that does not exist are a
 * dead end. Task 2 builds that destination, so the row becomes the
 * control that reaches it — a real `<button>` inside the `<li>`, not a
 * `<li onClick>`: a button is in the tab order, announces itself as a
 * control, and gets Enter/Space activation from the platform rather than
 * from a hand-written `onKeyDown` that would have to reimplement both and
 * would still not be announced. The list stays a list; each item now has
 * one control in it.
 *
 * `data-message-key` is what App.tsx finds this button by when the reader
 * closes, so keyboard focus returns to the row the user opened rather
 * than to the top of the document.
 *
 * **XSS.** `subject`, `from_name`/`from_email`, and `account_id` are
 * attacker-controlled — any Gmail sender picks their own display name and
 * subject line. They are only ever interpolated as JSX text children,
 * which React escapes by default; this file never touches
 * `dangerouslySetInnerHTML`.
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

/** `ring-inset` rather than `ring-offset-2`: these rows sit inside a
 *  `Card`, which is `overflow-hidden`, so an outset ring would be clipped
 *  along the row's full-bleed left and right edges — visible focus that
 *  is only half visible is the failure this avoids.
 *
 *  Exported (task V3) so OpensFeed.tsx's `OpenEntry` — a button-per-row
 *  inside the SAME kind of `overflow-hidden` `Card`/rail — gets the
 *  identical inset-ring treatment rather than a second, drifting copy of
 *  this string. */
export const ROW_FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset';

export default function MessageRow({ message, now, onOpen }: MessageRowProps) {
  const sender = message.from_name || message.from_email || 'Unknown sender';
  const subject = message.subject || '(no subject)';
  const unread = isUnread(message);

  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(message)}
        data-message-key={messageKey(message)}
        className={`flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2 text-left text-sm transition-colors hover:bg-neutral-50 dark:hover:bg-accent ${ROW_FOCUS} sm:h-11 sm:flex-nowrap sm:py-0`}
      >
        {unread && <span className="sr-only">Unread. </span>}

        <span
          className={
            unread
              ? 'order-1 min-w-0 flex-1 truncate font-semibold text-neutral-900 dark:text-foreground sm:w-40 sm:flex-none'
              : 'order-1 min-w-0 flex-1 truncate text-neutral-700 dark:text-muted-foreground sm:w-40 sm:flex-none'
          }
        >
          {sender}
        </span>

        <span className="order-3 w-full min-w-0 truncate text-neutral-500 dark:text-muted-foreground sm:order-2 sm:w-auto sm:flex-1">
          {subject}
        </span>

        <span className="order-2 flex shrink-0 items-center gap-2 sm:order-3">
          {message.has_attach && (
            <>
              <Paperclip className="h-3.5 w-3.5 text-neutral-400 dark:text-muted-foreground" aria-hidden="true" />
              <span className="sr-only">Has attachment</span>
            </>
          )}
          <Badge variant="neutral" className="px-1.5 py-0 font-mono text-[10px] font-medium uppercase">
            {accountChip(message.account_id)}
          </Badge>
          <span className="w-16 whitespace-nowrap text-right font-mono text-xs tabular-nums text-neutral-400 dark:text-muted-foreground">
            {formatWhen(message.date, now)}
          </span>
        </span>
      </button>
    </li>
  );
}
