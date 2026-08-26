import { Paperclip } from 'lucide-react';
import type { InboxMessage, MessageAttachment } from '../api';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { LIST_DIVIDERS, LIST_SURFACE } from './listSurface';
import { attachmentUrl, formatSize, isDownloadable } from './messageBody';

/**
 * The reader's attachment list. Its own file rather than more JSX inside
 * MessageView.tsx, for the same reason ./ThreadContext.tsx is: each of
 * the reader's three panels is independently readable, and MessageView
 * stays about the message.
 */

interface AttachmentEntryProps {
  readonly message: InboxMessage;
  readonly attachment: MessageAttachment;
}

/**
 * One attachment row: name, type, human size, and either a download link
 * or an honest statement that there is not one.
 *
 * **`partId === ''` renders as "Unavailable", never as a link.** The
 * server emits an empty part id when it could not establish the real IMAP
 * part number and refused to guess (sync/src/api/message.ts): a guessed
 * number is the 4th segment of the download route, so it 404s or, worse,
 * quietly downloads a different part of the message. The attachment is
 * still listed, because it exists and the user should know it does; what
 * is withheld is a link that could not work.
 *
 * The size shown is the DECODED one this route supplies — see
 * `formatSize` for why it must not be reconciled against the inbox row's
 * encoded `size_bytes`.
 */
function AttachmentEntry({ message, attachment }: AttachmentEntryProps) {
  const name = attachment.filename ?? '(unnamed attachment)';

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm lg:px-4">
      <Paperclip className="h-4 w-4 shrink-0 text-neutral-400 dark:text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-neutral-900 dark:text-foreground">{name}</span>
      {attachment.isInline && (
        <Badge variant="neutral" className="px-1.5 py-0 text-[10px] font-medium uppercase">
          embedded
        </Badge>
      )}
      <span className="shrink-0 font-mono text-xs text-neutral-500 dark:text-muted-foreground">
        {attachment.mimeType} · {formatSize(attachment.sizeBytes)}
      </span>
      {isDownloadable(attachment) ? (
        <a
          href={attachmentUrl(message.account_id, message.folder, message.uid, attachment.partId)}
          download={attachment.filename ?? undefined}
          className="shrink-0 rounded-md text-xs font-medium text-neutral-900 underline underline-offset-4 hover:no-underline dark:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Download<span className="sr-only"> {name}</span>
        </a>
      ) : (
        <span
          className="shrink-0 text-xs text-neutral-400 dark:text-muted-foreground"
          title="This part has no IMAP part number, so Postbox has no address to download it from. A guessed one would fetch the wrong bytes."
        >
          Unavailable
          <span className="sr-only"> — no download address for this attachment</span>
        </span>
      )}
    </li>
  );
}

interface AttachmentListProps {
  readonly message: InboxMessage;
  readonly attachments: readonly MessageAttachment[];
}

export default function AttachmentList({ message, attachments }: AttachmentListProps) {
  if (attachments.length === 0) return null;
  const hasInline = attachments.some((attachment) => attachment.isInline);

  return (
    <section className="space-y-2">
      <h3 className="px-1 text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-muted-foreground">
        Attachments ({attachments.length})
      </h3>
      {/* Embedded parts are listed rather than hidden: a `cid:` URL is a
          MIME reference, not something a browser can fetch, so an image
          the sender embedded in the body cannot be displayed inline in
          any sandboxed frame. Listing it is the only way it stays
          reachable at all. */}
      {hasInline && (
        <p className="px-1 text-xs text-neutral-500 dark:text-muted-foreground">
          Items marked embedded are referenced from inside the message body and are not displayed there.
        </p>
      )}
      {/* Same borderless-on-mobile surface as the inbox list and the
          thread rows below — *"Try to remove the outline borders where
          possible makes it look janky."* Below `lg:` the attachments are
          rows on the app's own ground with no card and no hairlines; the
          desktop card is unchanged. */}
      <Card className={LIST_SURFACE}>
        <ul className={LIST_DIVIDERS}>
          {attachments.map((attachment, index) => (
            <AttachmentEntry
              // Part ids are unique when present, but the "not
              // addressable" sentinel is the empty string and two of them
              // can appear on one message — so the index is part of the
              // key rather than the part id alone.
              key={`${attachment.partId}:${index}`}
              message={message}
              attachment={attachment}
            />
          ))}
        </ul>
      </Card>
    </section>
  );
}
