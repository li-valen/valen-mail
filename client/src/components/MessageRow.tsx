import { Paperclip } from 'lucide-react';
import type { InboxMessage } from '../api';
import { formatWhen } from './inboxDates';
import { isUnread } from './messageFlags';
import './MessageRow.css';

export interface MessageRowProps {
  readonly message: InboxMessage;
  /** The "now" InboxList resolved for this render pass — passed down
   *  rather than read from `new Date()` here so every row in the same
   *  list agrees on what "today" means, and so formatWhen stays testable
   *  as a pure function (task-4-brief.md Amendment 3). */
  readonly now: Date;
}

/**
 * One row of the unified inbox (client/DESIGN.md §6, component #7, as
 * amended by Amendment 1 — client/DESIGN.md's "Amendment 1: density &
 * ergonomics"): sender (fixed 168px column, 500 if unread) · subject (all
 * remaining width, ellipsis-truncated) · meta (paperclip, then a short
 * account chip, then the time), one line. The account label moved out of
 * the meta text and into `accountChip` below — see that function's own
 * comment for the exact derivation.
 *
 * **No snippet.** `snippet` is always `null` today (task-4-brief.md ground
 * truth: "a known, parked limitation"). This renders the row correctly
 * without one rather than reserving a line for it or writing placeholder
 * text that implies a snippet is coming — DESIGN.md's row anatomy lists a
 * snippet, but rendering an empty/greyed placeholder there would promise
 * something the sync service does not deliver.
 *
 * **Unread (sender at weight 500).** Derived from `message.flags` via
 * `./messageFlags`'s `isUnread` — see that file's doc comment for why this
 * is safe to derive at all (it was NOT implemented in this task's first
 * pass, on the reasoning that an empty `flags: []` sample was ambiguous
 * between "genuinely unread" and "sync never captured flags"; resolved
 * with a live 200-message sample, task-4-report.md "fix round 1"), for the
 * staleness caveat that comes with it (a message read in Gmail long ago
 * can still render unread here, permanently, once it ages out of the
 * sync backfill window), and for why that caveat is documented in code
 * rather than the UI. The visually-hidden "Unread." prefix gives screen
 * reader users the same signal the bold weight gives sighted ones — bold
 * alone is a purely visual cue.
 *
 * **Not a link or button.** No later task in this plan adds a message
 * detail/reading view yet, so this row has nowhere to navigate to; giving
 * it hover/focus/active affordances for a destination that does not exist
 * would be a mouse-only-looking dead end, which is worse than plain
 * content. It is a plain `<li>` — a list is a list.
 *
 * **XSS.** `subject`, `from_name`/`from_email`, and `account_id` are
 * attacker-controlled — any Gmail sender picks their own display name and
 * subject line. They are only ever interpolated as JSX text children,
 * which React escapes by default; this file never touches
 * `dangerouslySetInnerHTML`.
 */

/**
 * The account chip's text (Amendment 1): the first three characters of
 * `accountId`, lower-cased — `primary` -> `pri`, `harvard` -> `har`,
 * `personal` -> `per`, `masterman` -> `mas`, matching every account id
 * this inbox actually has today. It is a label, never a filter — no
 * click handler, nothing it can be pressed to do — so an id shorter than
 * three characters degrading to itself in full is an acceptable edge
 * case rather than one worth a fallback branch for accounts that do not
 * exist yet.
 */
function accountChip(accountId: string): string {
  return accountId.slice(0, 3).toLowerCase();
}

export default function MessageRow({ message, now }: MessageRowProps) {
  const sender = message.from_name || message.from_email || 'Unknown sender';
  const subject = message.subject || '(no subject)';
  const unread = isUnread(message);

  return (
    <li className="row">
      {unread && <span className="visually-hidden">Unread. </span>}
      <span className={`row__sender${unread ? ' row__sender--unread' : ''}`}>{sender}</span>
      <span className="row__subject">{subject}</span>
      <div className="row__meta">
        {message.has_attach && (
          <>
            <Paperclip
              className="row__attach-icon"
              size={16}
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <span className="visually-hidden">Has attachment</span>
          </>
        )}
        <span className="row__chip">{accountChip(message.account_id)}</span>
        <span className="row__time">{formatWhen(message.date, now)}</span>
      </div>
    </li>
  );
}
