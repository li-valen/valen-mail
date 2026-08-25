import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, FileText } from 'lucide-react';
import { ApiError, getMessage } from '../api';
import type { InboxMessage, ParsedMessage } from '../api';
import { Alert, AlertDescription } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { Panel } from '../motion';
import AttachmentList from './MessageAttachments';
import ThreadContext from './ThreadContext';
import { formatReceived } from './inboxDates';
import { IFRAME_SANDBOX, bodyKind, srcDocFor } from './messageBody';

/**
 * The reading view: the thing an email client must do, and the one the
 * user asked for repeatedly ("the emails are still not openable").
 *
 * Replaces the list in the main content column rather than opening beside
 * it — one column at every width, full width on a phone, no split pane to
 * starve either side at 400px. App.tsx keeps the list MOUNTED but hidden
 * behind it, which is what makes "Back" instant and lossless: no refetch,
 * no lost pages, and the scroll position (and keyboard focus) restored to
 * the row that was opened.
 *
 * TWO INDEPENDENT FAILURE DOMAINS, deliberately not collapsed into one:
 *
 *  1. The message itself — a failure here is the whole view, so it gets an
 *     in-place Alert with a retry, never a modal, and Back still works.
 *  2. Thread context — secondary. A thread fetch that fails logs and
 *     renders nothing at all; a message must never fail to open because
 *     the conversation around it could not be listed.
 *
 * THERE USED TO BE A THIRD: remote images, blocked per message behind a
 * "Load remote images" bar. The user removed it — "remove the dont load
 * images thing i dont care if people can track me with the pixels" — so
 * mail now renders the way the sender built it, first time. See
 * components/messageBody.ts's `contentSecurityPolicyFor` for the full
 * note, including why this changes the PRIVACY posture and leaves the XSS
 * boundary (`IFRAME_SANDBOX`: no allow-scripts, no allow-same-origin)
 * exactly where it was.
 *
 * SECURITY. `parsed.html` is the sender's markup, unsanitised on purpose
 * all the way from sync/src/api/message.ts. It reaches the DOM through
 * exactly one path — `srcDocFor` into the `srcDoc` of the sandboxed
 * iframe below — and this file contains no `dangerouslySetInnerHTML`.
 * Every other attacker-controlled string here (subject, sender name,
 * filename, mime type) is a JSX text child, which React escapes.
 */

const SKELETON_LINE_COUNT = 5;

/** Matches the shape of every other in-place failure in this app
 *  (App.tsx's SessionError, InboxList's messageFor): name what happened,
 *  never a stack trace, never a credential. */
function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return `The sync service answered ${error.status}. This message could not be opened.`;
  }
  return "Postbox can't reach the sync service. This message could not be opened.";
}

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly parsed: ParsedMessage }
  | { readonly status: 'error'; readonly message: string };

interface MessageHeaderProps {
  readonly message: InboxMessage;
}

/**
 * Subject, sender, recipients and full timestamp — all read from the
 * INBOX ROW, never from the parsed response, even though the parsed
 * response carries the same four fields.
 *
 * The row is already in hand when the reader mounts, so the header paints
 * on the first frame and never reflows when the body arrives; both
 * sources agree (sync normalises headers the same way on both paths); and
 * one source means there is no second place for the two to drift apart.
 * The parsed response is used for exactly what the row cannot supply: the
 * body and the attachment list.
 */
function MessageHeader({ message }: MessageHeaderProps) {
  const sender = message.from_name || message.from_email || 'Unknown sender';
  const recipients = (message.to_emails ?? []).join(', ');
  const copies = (message.cc_emails ?? []).join(', ');

  return (
    <header className="border-b border-neutral-200 dark:border-border px-4 py-3 sm:px-6 sm:py-4">
      {/* tabIndex -1 so focus can be moved here when the reader opens:
          the reader replaces the list in place, so without this a screen
          reader would be left announcing from wherever the vanished row
          used to be. */}
      <h2
        tabIndex={-1}
        className="text-base font-semibold text-neutral-900 dark:text-foreground sm:text-lg"
      >
        {message.subject || '(no subject)'}
      </h2>
      <p className="mt-1 text-sm text-neutral-700 dark:text-muted-foreground">
        <span className="font-medium text-neutral-900 dark:text-foreground">{sender}</span>
        {message.from_name && message.from_email && (
          <span className="text-neutral-500 dark:text-muted-foreground"> &lt;{message.from_email}&gt;</span>
        )}
      </p>
      {recipients !== '' && (
        <p className="mt-0.5 truncate text-xs text-neutral-500 dark:text-muted-foreground">to {recipients}</p>
      )}
      {copies !== '' && (
        <p className="truncate text-xs text-neutral-500 dark:text-muted-foreground">cc {copies}</p>
      )}
      <p className="mt-1 font-mono text-xs text-neutral-400 dark:text-muted-foreground">
        {formatReceived(message.date)}
      </p>
    </header>
  );
}

interface BodyFrameProps {
  readonly html: string;
  readonly subject: string;
}

/**
 * The message body, and the security boundary of this whole feature.
 *
 * `sandbox={IFRAME_SANDBOX}` carries no `allow-scripts` and no
 * `allow-same-origin` — see components/messageBody.ts for the full
 * reasoning and for the guard test that keeps it that way. `srcDocFor`
 * puts a restrictive CSP `<meta>` inside the document, which is what
 * denies everything the message might otherwise pull in — objects,
 * frames, forms, a `<base>` of its own. The two are not belt and braces
 * for one concern: the sandbox stops EXECUTION, the CSP stops FETCHING,
 * and dropping either one leaves a real hole. `img-src` is the one
 * directive that now permits remote hosts, by the user's decision — see
 * components/messageBody.ts.
 *
 * **FIXED HEIGHT, ON PURPOSE.** An iframe cannot size itself to its
 * content without script inside it measuring and reporting the height —
 * which would mean `allow-scripts`, i.e. giving up the boundary to avoid
 * a scrollbar. (`allow-same-origin` alone would also let the parent
 * measure it, and is likewise refused: it is one careless edit away from
 * being paired with `allow-scripts`, which is the documented way to
 * remove a sandbox entirely.) So the frame gets a tall viewport-relative
 * box and scrolls internally. A short message leaving white space below
 * it is the visible cost of a boundary that holds.
 *
 * The white ground is deliberate in BOTH themes — see BODY_STYLE in
 * components/messageBody.ts for why forcing dark inside here breaks real
 * mail rather than theming it.
 */
function BodyFrame({ html, subject }: BodyFrameProps) {
  return (
    <iframe
      // Named for what it contains: a screen reader user tabbing into an
      // unlabelled frame is told only "frame".
      title={`Message body: ${subject}`}
      sandbox={IFRAME_SANDBOX}
      srcDoc={srcDocFor(html)}
      referrerPolicy="no-referrer"
      className="block h-[70vh] min-h-96 w-full border-0 bg-white dark:bg-white"
    />
  );
}

interface TextBodyProps {
  readonly text: string;
}

/**
 * The `text/plain` alternative, rendered when a message has no html.
 *
 * NOT in an iframe, deliberately, and it is not an inconsistency: plain
 * text is a JSX text child, so React escapes it and there is no markup to
 * isolate — the iframe exists to contain HTML, and there is none here.
 * Rendering it in-app instead means it inherits the semantic palette and
 * is therefore actually readable in dark mode, which the light-carded
 * iframe would not be.
 *
 * `whitespace-pre-wrap` keeps the sender's newlines and blank lines (the
 * only structure a plain-text mail has) while still wrapping to the
 * column; `break-words` stops a 400-character unbroken URL — ordinary in
 * a plain-text newsletter — from forcing the page sideways at 400px.
 */
function TextBody({ text }: TextBodyProps) {
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words px-4 py-4 font-sans text-sm leading-relaxed text-neutral-800 dark:text-foreground sm:px-6">
      {text}
    </pre>
  );
}

interface MessageBodyProps {
  readonly parsed: ParsedMessage;
  readonly subject: string;
}

/**
 * Chooses which of the three body surfaces a loaded message gets, in one
 * place: the sandboxed frame for html, in-app text for a plain-text
 * alternative, an empty state for a message that carries neither.
 *
 * `bodyKind` is consulted ONCE here rather than at each branch, so the
 * three cases cannot drift into overlapping or — worse — into all three
 * being false for some input and the reader rendering a message with no
 * body area at all.
 */
function MessageBody({ parsed, subject }: MessageBodyProps) {
  const kind = bodyKind(parsed);

  // No wrapping fragment any more: the html case used to be a
  // remote-images bar stacked above the frame, and with the bar gone the
  // frame IS the html body.
  if (kind === 'html') return <BodyFrame html={parsed.html ?? ''} subject={subject} />;

  if (kind === 'text') return <TextBody text={parsed.text ?? ''} />;

  return (
    <EmptyState
      icon={FileText}
      title="This message has no body"
      description={
        parsed.attachments.length > 0
          ? 'It carries attachments and no readable text — they are listed below.'
          : 'The sender included neither text nor HTML content.'
      }
    />
  );
}

export interface MessageViewProps {
  /** The inbox row that was opened. Supplies the header and every path
   *  segment the body and attachment requests are built from. */
  readonly message: InboxMessage;
  /** The list's shared "now", threaded through to the thread rows so a
   *  row reads the same here as it does in the list. */
  readonly now: Date;
  readonly onBack: () => void;
  /** Opens a different message — used by the thread rows below. */
  readonly onOpen: (message: InboxMessage) => void;
}

export default function MessageView({ message, now, onBack, onOpen }: MessageViewProps) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // The Card, used only to find the <h2> inside it — see the focus
  // effect below. Card forwards `ref` to its own <div>, so this needs no
  // extra wrapper element.
  const cardRef = useRef<HTMLDivElement | null>(null);

  const accountId = message.account_id;
  const folder = message.folder;
  const uid = message.uid;

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: 'loading' });

    getMessage(accountId, folder, uid).then(
      (parsed) => {
        if (cancelled) return;
        setLoad({ status: 'ready', parsed });
      },
      (error: unknown) => {
        if (cancelled) return;
        console.error('MessageView: message fetch failed', error);
        setLoad({ status: 'error', message: messageFor(error) });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [accountId, folder, uid, attempt]);

  // Focus lands on the subject when the reader opens, because the reader
  // REPLACES the list in place: there is no new page for the browser to
  // move focus to, so without this a keyboard or screen reader user is
  // left focused on a button that is no longer rendered. `preventScroll`
  // because App.tsx has already positioned the column for this view and
  // this must not fight it.
  useEffect(() => {
    cardRef.current?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  }, [accountId, folder, uid]);

  const retry = useCallback(() => setAttempt((previous) => previous + 1), []);

  return (
    // PLAN 7 TASK 2 — the reader arrives. App.tsx keys this component on
    // the message, so opening a different one from the thread rows below
    // remounts and replays the entrance rather than swapping the body
    // underneath a stationary frame. There is no matching exit: see
    // src/motion/Panel.tsx for why Back is deliberately instant.
    <Panel className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft aria-hidden="true" />
        Back to inbox
      </Button>

      <Card ref={cardRef}>
        <MessageHeader message={message} />

        {load.status === 'loading' && (
          <div className="space-y-3 px-4 py-4 sm:px-6" aria-busy="true">
            <p className="sr-only" role="status">
              Loading this message…
            </p>
            {Array.from({ length: SKELETON_LINE_COUNT }, (_, index) => (
              <Skeleton key={index} className={index === 0 ? 'h-3 w-2/3' : 'h-3 w-full'} />
            ))}
          </div>
        )}

        {load.status === 'error' && (
          <div className="px-4 py-4 sm:px-6">
            <Alert variant="destructive">
              <AlertDescription className="flex flex-wrap items-center gap-3">
                <span>{load.message}</span>
                <Button variant="outline" size="sm" onClick={retry}>
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        )}

        {load.status === 'ready' && (
          <MessageBody parsed={load.parsed} subject={message.subject || '(no subject)'} />
        )}
      </Card>

      {load.status === 'ready' && (
        <AttachmentList message={message} attachments={load.parsed.attachments} />
      )}

      <ThreadContext message={message} now={now} onOpen={onOpen} />
    </Panel>
  );
}
