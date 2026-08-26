import { Alert, AlertDescription } from '../ui/Alert';
import { Button } from '../ui/Button';
import { cn } from '../ui/cn';
import { Skeleton } from '../ui/Skeleton';
import { TOUCH_HEIGHT } from '../ui/touchTarget';
import type { InboxMessage } from '../api';
import AttachmentList from './MessageAttachments';
import { MessageBody } from './MessageBodyContent';
import { formatReceived, formatWhen } from './inboxDates';
import { useMessageBody } from './useMessageBody';

const SKELETON_LINE_COUNT = 5;

/**
 * ONE MESSAGE INSIDE A CONVERSATION — collapsed to a line, or open with its
 * body.
 *
 * **WHY THIS EXISTS.** The reader showed the opened message and listed the
 * rest of its thread underneath as "ALSO IN THIS THREAD (2)", each row a
 * link that navigated away to a fresh reader. The user, with Gmail open
 * beside it: *"Replies on a specific email also dont chain like gmail."*
 * Gmail does not turn a conversation into a list of links to other screens
 * — it stacks the messages in one scroll, oldest first, and opens any of
 * them where it sits.
 *
 * The DATA was never the problem, which is worth recording so nobody goes
 * looking there again: `db.getThread` matches on `account_id` and
 * `thread_id` with NO folder predicate, ordered oldest-first, so a reply
 * sitting in Sent already came back with the rest. It was arriving and being
 * rendered as a footnote.
 *
 * **COLLAPSED COSTS NOTHING.** `useMessageBody`'s `enabled` flag is false
 * until this message is open, so a twenty-message thread issues one body
 * fetch rather than twenty. Expanding starts the fetch — and because that
 * hook reads the shared cache in a `useState` initializer, a message the
 * prefetcher already warmed opens in the same frame as the click.
 *
 * **THE WHOLE ROW IS THE CONTROL.** Collapsed, it is one `<button>` carrying
 * `aria-expanded`, so a screen reader announces it as the disclosure it is.
 * Open, the header stays that button so the message can be closed again —
 * except when it is the only message in the thread, where collapsing it
 * would leave the reader showing nothing at all.
 */

interface ThreadMessageProps {
  readonly message: InboxMessage;
  readonly isExpanded: boolean;
  readonly onToggle: () => void;
  /** Resolved once by the reader so every timestamp in the stack agrees on
   *  what "today" means, exactly as the inbox list does. */
  readonly now: Date;
  /** False for a one-message thread: there would be nothing left to read. */
  readonly canCollapse: boolean;
}

export default function ThreadMessage({
  message,
  isExpanded,
  onToggle,
  now,
  canCollapse,
}: ThreadMessageProps) {
  const { load, isSlow, retry } = useMessageBody(
    message.account_id,
    message.folder,
    message.uid,
    isExpanded,
  );

  const sender = message.from_name || message.from_email || 'Unknown sender';
  const recipients = (message.to_emails ?? []).join(', ');
  const isInteractive = !isExpanded || canCollapse;

  return (
    <article
      className={cn(
        'rounded-lg border border-neutral-200 dark:border-border',
        // Open messages sit on the card; closed ones stay flush with the
        // page, so the stack reads as a column of headers with one sheet
        // among them — the shape a Gmail conversation has.
        isExpanded ? 'bg-card' : 'bg-transparent',
      )}
    >
      <button
        type="button"
        onClick={isInteractive ? onToggle : undefined}
        aria-expanded={isExpanded}
        disabled={!isInteractive}
        className={cn(
          'flex w-full items-baseline gap-3 rounded-lg px-3 py-3 text-left',
          isInteractive &&
            'cursor-pointer touch-manipulation transition-colors hover:bg-neutral-50 dark:hover:bg-accent/40',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-neutral-900 dark:text-foreground">
            {sender}
            {isExpanded && message.from_name && message.from_email && (
              <span className="font-normal text-neutral-500 dark:text-muted-foreground">
                {' '}
                &lt;{message.from_email}&gt;
              </span>
            )}
          </span>
          {isExpanded ? (
            recipients !== '' && (
              <span className="block truncate text-xs text-neutral-500 dark:text-muted-foreground">
                to {recipients}
              </span>
            )
          ) : (
            // The snippet is what makes a closed row worth reading at all —
            // without it the stack is a column of names.
            <span className="block truncate text-xs text-neutral-500 dark:text-muted-foreground">
              {message.snippet ?? ''}
            </span>
          )}
        </span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-neutral-500 dark:text-muted-foreground">
          {isExpanded ? formatReceived(message.date) : formatWhen(message.date, now)}
        </span>
      </button>

      {isExpanded && (
        <div className="px-3 pb-3">
          {load.status === 'loading' && isSlow && (
            <div className="space-y-3" aria-busy="true">
              <p className="sr-only" role="status">
                Loading this message…
              </p>
              {Array.from({ length: SKELETON_LINE_COUNT }, (_, index) => (
                <Skeleton key={index} className={index === 0 ? 'h-3 w-2/3' : 'h-3 w-full'} />
              ))}
            </div>
          )}

          {load.status === 'error' && (
            <Alert variant="destructive">
              <AlertDescription className="flex flex-wrap items-center gap-3">
                <span>{load.message}</span>
                <Button variant="outline" size="sm" className={TOUCH_HEIGHT} onClick={retry}>
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {load.status === 'ready' && (
            <>
              <MessageBody parsed={load.parsed} subject={message.subject ?? ''} />
              <AttachmentList message={message} attachments={load.parsed.attachments} />
            </>
          )}
        </div>
      )}
    </article>
  );
}
