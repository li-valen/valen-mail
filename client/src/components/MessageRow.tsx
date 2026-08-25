import { Paperclip } from 'lucide-react';
import type { InboxMessage } from '../api';
import { formatWhen } from './inboxDates';
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
 * One row of the unified inbox (client/DESIGN.md §6, component #7):
 * account label · sender · subject · time, one line, ellipsis-truncated,
 * plus a paperclip when the message has an attachment.
 *
 * **No snippet.** `snippet` is always `null` today (task-4-brief.md ground
 * truth: "a known, parked limitation"). This renders the row correctly
 * without one rather than reserving a line for it or writing placeholder
 * text that implies a snippet is coming — DESIGN.md's row anatomy lists a
 * snippet, but rendering an empty/greyed placeholder there would promise
 * something the sync service does not deliver.
 *
 * **No "unread" bold treatment.** DESIGN.md's anatomy lists "sender (500
 * if unread)", derivable in principle from `message.flags` containing the
 * IMAP `\Seen` flag. Left out here: the ground truth sample this task was
 * given shows `flags: []` for a real, already-synced message, and there
 * is no way to confirm from here whether that means "flags are not being
 * populated for any message" (in which case every row would render bold,
 * a systematically wrong and misleading result) or "this message is
 * actually unread." Guessing at unverified wire behavior and shipping it
 * either way risked a UI that is confidently wrong for every row in a
 * live inbox — flagged in task-4-report.md rather than guessed here.
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
export default function MessageRow({ message, now }: MessageRowProps) {
  const sender = message.from_name || message.from_email || 'Unknown sender';
  const subject = message.subject || '(no subject)';

  return (
    <li className="row">
      <div className="row__primary">
        <span className="row__sender">{sender}</span>
        <span className="row__subject">{subject}</span>
      </div>
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
        <span className="row__account">{message.account_id}</span>
        <span className="row__time">{formatWhen(message.date, now)}</span>
      </div>
    </li>
  );
}
