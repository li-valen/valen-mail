import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Ref, RefObject } from 'react';
import { ArrowLeft, FileText } from 'lucide-react';
import { ApiError, getMessage } from '../api';
import type { InboxMessage, ParsedMessage } from '../api';
import { Alert, AlertDescription } from '../ui/Alert';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { Panel } from '../motion';
import AttachmentList from './MessageAttachments';
import ThreadContext from './ThreadContext';
import { formatReceived } from './inboxDates';
import {
  BODY_HEIGHT_BOUNDS_PX,
  IFRAME_SANDBOX,
  bodyKind,
  estimatedBodyHeightPx,
  srcDocFor,
} from './messageBody';

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
  /** Where the reader's opening focus lands. Passed down rather than
   *  found with a `querySelector` from above, now that there is no card
   *  wrapping the header to hang a ref on. */
  readonly headingRef: Ref<HTMLHeadingElement>;
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
function MessageHeader({ message, headingRef }: MessageHeaderProps) {
  const sender = message.from_name || message.from_email || 'Unknown sender';
  const recipients = (message.to_emails ?? []).join(', ');
  const copies = (message.cc_emails ?? []).join(', ');

  // NO CARD AND NO RULE UNDER IT any more — *"Try to remove the outline
  // borders where possible makes it look janky."* The header used to be
  // the top half of a bordered `Card` whose bottom half was the message,
  // separated by a hairline. Both are gone: the header is now plain
  // chrome on the app's own ground, and the message below it is a raised
  // sheet of its own (see BodyFrame). Whitespace and type hierarchy carry
  // the separation, which is the same thing the borderless mobile inbox
  // list already does.
  //
  // This is ALSO where the phishing boundary moved to, and it did not
  // weaken: see BodyFrame's note.
  return (
    <header className="px-1">
      {/* tabIndex -1 so focus can be moved here when the reader opens:
          the reader replaces the list in place, so without this a screen
          reader would be left announcing from wherever the vanished row
          used to be. */}
      <h2
        ref={headingRef}
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
 * **THE HEIGHT IS ESTIMATED, BECAUSE THE PARENT REALLY CANNOT MEASURE IT.**
 * The obvious fix for "the frame scrolls inside the page" is to size the
 * frame to `contentDocument.documentElement.scrollHeight` on load. That
 * was tried against the running app and it is not available here: with a
 * sandbox that omits `allow-same-origin` the frame gets an opaque origin,
 * so `iframe.contentDocument` is `null` and `iframe.contentWindow.document`
 * throws `SecurityError: Blocked a frame with origin "…" from accessing a
 * cross-origin frame`. The usual `postMessage` workaround needs
 * `allow-scripts` inside the frame. Both attributes are refused — they
 * are the XSS boundary, not a styling knob, and components/messageBody.ts
 * plus its guard test exist to keep them refused. There is no third
 * channel: `window.length`, `focus` and `postMessage` are all a
 * cross-origin frame exposes, and none of them is a height.
 *
 * So the height is a BOUNDED ESTIMATE, computed from the message's own
 * html by `estimatedBodyHeightPx` — see that function for the measured
 * constants, the clamp, and why it is biased to over-estimate. The short
 * version: one generous fixed height was tried first and rejected on
 * sight, because a Gmail reply whose whole body is `<div><br></div>`
 * became ~1786px of blank white. **The cost, stated plainly: the estimate
 * is an estimate. When it runs high the message is followed by white
 * space; when it runs low the frame scrolls internally, which is exactly
 * what shipped before, so the worst case is the old behaviour and not a
 * new one.** Both are worse than a frame that measured itself; neither is
 * worth `allow-scripts`.
 *
 * **THE PHISHING BOUNDARY, AND WHERE IT WENT.** The user asked for the
 * outline borders to go, and the header's card and its hairline went with
 * them. The boundary those provided did NOT go: this frame is a white
 * sheet with its own rounded corners, its own shadow, and a gap of app
 * ground above it. Attacker-authored HTML therefore still announces
 * itself as a separate object — in dark mode by a full white-on-near-black
 * inversion, in light mode by elevation and the gap. What a message
 * cannot do is paint something that reads as Postbox's own chrome, which
 * is the property the old border was actually buying. A shadow and a gap
 * buy it without a hairline; a borderless sheet flush against the header
 * would not, which is why the gap is not negotiable decoration.
 *
 * The white ground is deliberate in BOTH themes — see BODY_STYLE in
 * components/messageBody.ts for why forcing dark inside here breaks real
 * mail rather than theming it.
 */
/**
 * The frame's OWN width, which the parent is free to read — it is our
 * element; the opaque origin only hides what is INSIDE it.
 *
 * `useLayoutEffect` for the first read so the height is right on the
 * first paint rather than after a visible reflow, and a `ResizeObserver`
 * after it so rotating a phone or dragging a window re-estimates. Only
 * the WIDTH is read, and state is only set when it actually changes —
 * which is what keeps setting the frame's HEIGHT from feeding this
 * observer back into itself.
 */
function useFrameWidth(ref: RefObject<HTMLIFrameElement | null>): number {
  const [width, setWidth] = useState<number>(BODY_HEIGHT_BOUNDS_PX.referenceWidth);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;

    const read = (next: number) => {
      if (next > 0) setWidth((current) => (Math.abs(current - next) < 1 ? current : next));
    };

    read(element.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) read(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}

function BodyFrame({ html, subject }: BodyFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const width = useFrameWidth(frameRef);

  // Memoised: the estimate walks a string that is routinely 60–90KB, and
  // it must not be redone on every unrelated re-render of the reader.
  // `srcDocFor` is memoised beside it for a different and sharper reason —
  // handing React a fresh `srcDoc` string reloads the frame, so a new
  // string on a width change would restart the message.
  const height = useMemo(() => estimatedBodyHeightPx(html, width), [html, width]);
  const doc = useMemo(() => srcDocFor(html), [html]);

  return (
    <iframe
      ref={frameRef}
      // Named for what it contains: a screen reader user tabbing into an
      // unlabelled frame is told only "frame".
      title={`Message body: ${subject}`}
      sandbox={IFRAME_SANDBOX}
      srcDoc={doc}
      referrerPolicy="no-referrer"
      // The height is a computed pixel value, so it is an inline style
      // rather than a class — Tailwind cannot emit a utility for a number
      // that only exists at runtime. Everything else stays in classes.
      style={{ height: `${height}px` }}
      className="block w-full rounded-lg border-0 bg-white shadow-sm dark:bg-white"
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
  // `max-w-[68ch]` (Plan 7 Task 3): the reader column is `max-w-5xl`, so
  // a plain-text message was being set at roughly 150 characters per
  // line — about twice the width at which the eye reliably finds the
  // start of the next one, and the reason long plain-text mail read as a
  // wall. 68 characters sits in the middle of the 45–75 band typography
  // has settled on. HTML mail is untouched: it renders in its own iframe
  // under the sender's own layout.
  return (
    // `px-1` rather than the old `px-4 sm:px-6`: that padding was the
    // inside of a card that no longer exists, and kept here it would set
    // plain-text mail on a different left edge from the subject above it.
    // `overflow-x-auto` stays — it is what keeps a 400-character URL
    // scrolling in this block instead of moving the page.
    <pre className="max-w-[68ch] overflow-x-auto whitespace-pre-wrap break-words px-1 font-sans text-sm leading-relaxed text-neutral-800 dark:text-foreground">
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
  // The subject heading, for the focus effect below. A direct ref now
  // that the card that used to wrap it (and that the old code reached
  // through with a `querySelector`) is gone.
  const headingRef = useRef<HTMLHeadingElement | null>(null);

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
    headingRef.current?.focus({ preventScroll: true });
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

      {/* NO CARD AROUND THE HEADER AND BODY any more. They were one
          bordered box split by a hairline; they are now two things
          separated by the `space-y-4` above — quiet chrome, then the
          message as its own raised sheet. See MessageHeader and BodyFrame
          for what replaced the border in each case, including why the
          gap under the header is load-bearing rather than decorative. */}
      <MessageHeader message={message} headingRef={headingRef} />

      {load.status === 'loading' && (
        <div className="space-y-3 px-1" aria-busy="true">
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
            <Button variant="outline" size="sm" onClick={retry}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {load.status === 'ready' && (
        <MessageBody parsed={load.parsed} subject={message.subject || '(no subject)'} />
      )}

      {load.status === 'ready' && (
        <AttachmentList message={message} attachments={load.parsed.attachments} />
      )}

      <ThreadContext message={message} now={now} onOpen={onOpen} />
    </Panel>
  );
}
