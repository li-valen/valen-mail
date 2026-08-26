import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Ref, RefObject } from 'react';
import { Archive, ArrowLeft, FileText, Forward, Reply, ReplyAll, Star, Trash2 } from 'lucide-react';
import { ApiError } from '../api';
import type { InboxMessage, ParsedMessage } from '../api';
import { messageCache } from '../messageCache';
import type { MoveDestination } from '../mailboxActions';
import type { ReplyMode } from '../replyDraft';
import { loadMessage, readCachedMessage, refetchMessage, targetFor } from '../messageLoader';
import { messagePrefetcher } from '../messagePrefetch';
import { Alert, AlertDescription } from '../ui/Alert';
import { Button } from '../ui/Button';
import { cn } from '../ui/cn';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { useTheme } from '../useTheme';
import { Panel, SKELETON_DELAY_MS } from '../motion';
import AttachmentList from './MessageAttachments';
import ThreadContext from './ThreadContext';
import { formatReceived } from './inboxDates';
import {
  FALLBACK_BODY_HEIGHT_PX,
  IFRAME_SANDBOX,
  bodyKind,
  measuredBodyHeightPx,
  safeGroundColor,
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
      <p className="mt-1 font-mono text-xs text-neutral-500 dark:text-muted-foreground">
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
 * `sandbox={IFRAME_SANDBOX}` carries no `allow-scripts` — see
 * components/messageBody.ts for the full reasoning, for why
 * `allow-same-origin` beside it is not the same concession, and for the
 * guard tests that keep both facts true. `srcDocFor`
 * puts a restrictive CSP `<meta>` inside the document, which is what
 * denies everything the message might otherwise pull in — objects,
 * frames, forms, a `<base>` of its own. The two are not belt and braces
 * for one concern: the sandbox stops EXECUTION, the CSP stops FETCHING,
 * and dropping either one leaves a real hole. `img-src` is the one
 * directive that now permits remote hosts, by the user's decision — see
 * components/messageBody.ts.
 *
 * **THE HEIGHT IS MEASURED, AND THE COMMENT THAT STOOD HERE SAID IT
 * COULD NOT BE.** What this paragraph used to argue — that an opaque
 * origin leaves `contentDocument` null, that `postMessage` needs
 * `allow-scripts`, that "there is no third channel" — was true about the
 * sandbox as it was then configured and false about the conclusion drawn
 * from it. `allow-same-origin` is not `allow-scripts`; granting the first
 * makes the document readable without making it executable, which was
 * verified directly against all four combinations before this changed.
 * See `IFRAME_SANDBOX` for that evidence and for the cost it carries.
 *
 * So the frame is sized to `measuredBodyHeightPx(contentDocument)` on
 * load, and a `ResizeObserver` on the message's own `body` re-measures it
 * whenever the content reflows — which is not a nicety: images in mail
 * arrive after the load event, and a load-only measurement is short by
 * exactly the height of every image on the page.
 *
 * The estimate this replaces, and its seven measured constants, are gone
 * rather than kept as a fallback. A second height path is how a future
 * edit quietly reintroduces the bug, and the honest fallback for "could
 * not measure" is a tall, still-scrollable frame — see
 * `FALLBACK_BODY_HEIGHT_PX`.
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
 * The ground follows the theme: light mail on white, and in dark mode the
 * message is inverted onto the app's own `--color-card` so the frame and
 * the page cannot disagree at their seam. See BODY_STYLE and
 * DARK_BODY_STYLE in components/messageBody.ts for why that is done by
 * inverting the message rather than by recolouring it.
 */
/**
 * THE FRAME'S HEIGHT, READ OUT OF THE DOCUMENT INSIDE IT.
 *
 * Two triggers, because one is not enough. `load` gives the first
 * measurement, and a `ResizeObserver` on the message's own `body` gives
 * every one after it. The observer is the load-bearing half: mail is full
 * of images, images finish arriving well after `load`, and each one that
 * lands makes the message taller. A frame sized once at load is short by
 * the height of all of them.
 *
 * **THE OBSERVER WATCHES THE BODY, NOT THE FRAME.** Watching our own
 * element would be a loop — we set that element's height, so observing it
 * would re-trigger on our own write. The body's height is content-driven
 * and is not something this component writes; the one way a message could
 * make it track the frame is a percentage height, which BODY_STYLE's single
 * `!important` rule exists to prevent. Resizing the window needs no
 * separate observer either: a narrower frame reflows the text, which
 * changes the body, which is what is already being watched.
 *
 * `doc` is in the deps rather than `html` because it is `doc` that is
 * handed to `srcDoc`: a theme change rebuilds the document and reloads the
 * frame, and a subscription still pointing at the old document would never
 * fire again. The previous message's height is deliberately NOT cleared
 * while the next one loads — a `srcDoc` swap parses in a frame or two, and
 * blanking to the fallback in between is a visible jump for no gain.
 */
function useMeasuredBodyHeight(
  ref: RefObject<HTMLIFrameElement | null>,
  doc: string,
): number | null {
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const frame = ref.current;
    if (frame === null) return;

    let observer: ResizeObserver | null = null;

    const measure = () => {
      const next = measuredBodyHeightPx(frame.contentDocument);
      // `null` is "could not read it", never "it is zero tall". Holding the
      // last good value is right in both the transient case (mid-reload) and
      // the permanent one (unreadable document).
      if (next === null) return;
      setHeight((current) =>
        current !== null && Math.abs(current - next) < 1 ? current : next,
      );
    };

    const onLoad = () => {
      measure();
      const body = frame.contentDocument?.body;
      if (body === null || body === undefined) return;
      observer?.disconnect();
      observer = new ResizeObserver(measure);
      observer.observe(body);
    };

    frame.addEventListener('load', onLoad);
    // A `srcDoc` document can finish parsing before this effect runs, in
    // which case the `load` above has already fired and will not fire
    // again. StrictMode's double-invoke makes that the common case rather
    // than a rare one, so it is handled rather than raced.
    if (frame.contentDocument?.readyState === 'complete') onLoad();

    return () => {
      frame.removeEventListener('load', onLoad);
      observer?.disconnect();
      observer = null;
    };
  }, [ref, doc]);

  return height;
}

function BodyFrame({ html, subject }: BodyFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const { resolved } = useTheme();

  /**
   * Per-message escape back to the sender's own colours.
   *
   * Keyed off nothing but this frame's own state, so it resets when the
   * reader moves to another message — which is the behaviour we want:
   * "show this one as sent" is a judgement about ONE message, and
   * carrying it forward would silently turn dark mode off for the rest of
   * the session after a single awkward newsletter.
   *
   * It exists because ../components/messageBody.ts's inversion has two
   * failure modes it cannot fix from inside the frame — a CSS
   * `background-image` inverts with the page, and mail already authored
   * dark comes out light. Outlook ships the same escape for the same two
   * reasons.
   */
  const [showOriginal, setShowOriginal] = useState(false);
  const isDark = resolved === 'dark' && !showOriginal;


  /**
   * THE APP'S OWN GROUND, READ FROM THE LIVE PALETTE rather than written
   * into the stylesheet as a literal.
   *
   * A dark message is painted on an opaque colour that must equal the
   * card it sits in, or the seam this whole treatment exists to remove
   * simply moves to the frame's edge. `--color-card` is what `bg-card`
   * below resolves to, so reading it here makes the two the same value by
   * construction instead of by a comment asking someone to keep them in
   * step. `safeGroundColor` (../components/messageBody.ts) decides what
   * may reach the stylesheet, and supplies the fallback when this cannot
   * be read at all.
   *
   * Keyed on `isDark` so a theme change re-reads it — the token's value
   * differs per theme, and this is the moment the document is rebuilt
   * anyway.
   */
  const ground = useMemo(
    () =>
      safeGroundColor(
        typeof window === 'undefined'
          ? null
          : getComputedStyle(document.documentElement).getPropertyValue('--color-card'),
      ),
    [isDark],
  );
  /**
   * Memoised because handing React a fresh `srcDoc` string RELOADS the
   * frame — an unrelated re-render of the reader would otherwise restart
   * the message from its first paint. `isDark` and `ground` belong in the
   * deps for exactly that reason: changing the theme MUST rebuild the
   * document, and nothing else may.
   */
  const doc = useMemo(
    () => srcDocFor(html, isDark ? 'dark' : 'light', ground),
    [html, isDark, ground],
  );
  const height = useMeasuredBodyHeight(frameRef, doc) ?? FALLBACK_BODY_HEIGHT_PX;

  return (
    <div className="flex flex-col gap-2">
      <iframe
        ref={frameRef}
        // Named for what it contains: a screen reader user tabbing into an
        // unlabelled frame is told only "frame".
        title={`Message body: ${subject}`}
        sandbox={IFRAME_SANDBOX}
        srcDoc={doc}
        referrerPolicy="no-referrer"
        // A measured pixel value, so it is an inline style rather than a
        // class — Tailwind cannot emit a utility for a number that only
        // exists at runtime. Everything else stays in classes.
        style={{ height: `${height}px` }}
        // The frame's own ground must match what the document inverts to,
        // or the message flashes white for the frame's first paint before
        // its stylesheet applies. `bg-card` in dark resolves to the same
        // near-black the inversion produces.
        className="block w-full rounded-lg border-0 bg-white shadow-sm dark:bg-card"
      />
      {resolved === 'dark' ? (
        // Dark only: in light mode the message is already rendered exactly
        // as sent, so a control offering to do that would toggle nothing.
        <button
          type="button"
          onClick={() => setShowOriginal((previous) => !previous)}
          className="cursor-pointer touch-manipulation self-start rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {showOriginal ? 'Use dark colours' : 'Show original colours'}
        </button>
      ) : null}
    </div>
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
    <pre className="max-w-[68ch] overflow-x-auto overscroll-x-contain whitespace-pre-wrap break-words px-1 font-sans text-sm leading-relaxed text-neutral-800 dark:text-foreground">
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

interface ReplyActionsProps {
  readonly onReply: (mode: ReplyMode) => void;
  /** False until the body has loaded. The reply needs the PARSED message
   *  — its html to quote and its Message-ID to thread — so a click before
   *  then would open a composer that could neither quote nor thread. */
  readonly isReady: boolean;
}

/**
 * Reply, Reply all, Forward — the three actions Plan 9 exists to make
 * reachable, and the last thing that was still sending the user back to
 * Gmail.
 *
 * **PLACED ABOVE THE BODY, NOT BELOW IT.** Gmail puts them at the bottom
 * of the message, which is fine for a three-line note and useless for the
 * 3000px newsletters this reader routinely shows: the primary action
 * would be a scroll away from the moment the user decides to take it.
 * Above the body they are visible the instant a message opens, at every
 * message length, with no second copy anywhere to drift out of sync.
 *
 * **`flex-wrap`, AND THAT IS THE WHOLE MOBILE STORY.** Three labelled
 * buttons wrap onto two lines at 400px and sit on one line everywhere
 * else. Nothing here is gated to `lg:`, because nothing here is
 * desktop-only — the phone needs these more than the desktop does, since
 * it has no keyboard to press `r` on.
 *
 * DISABLED RATHER THAN ABSENT while the body loads. Rendering them late
 * would move the message down under the user's eyes exactly as it became
 * readable; disabling them costs a moment on a slow fetch and never
 * reflows.
 */
function ReplyActions({ onReply, isReady }: ReplyActionsProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-1">
      <Button variant="outline" size="sm" disabled={!isReady} onClick={() => onReply('reply')} aria-keyshortcuts="r">
        <Reply aria-hidden="true" />
        Reply
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={!isReady}
        onClick={() => onReply('replyAll')}
        aria-keyshortcuts="a"
      >
        <ReplyAll aria-hidden="true" />
        Reply all
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={!isReady}
        onClick={() => onReply('forward')}
        aria-keyshortcuts="f"
      >
        <Forward aria-hidden="true" />
        Forward
      </Button>
    </div>
  );
}

export interface MessageViewProps {
  /** The inbox row that was opened. Supplies the header and every path
   *  segment the body and attachment requests are built from. */
  readonly message: InboxMessage;
  /**
   * The rows either side of this one, in list order — prefetched on open
   * because people read down a list (see ../messagePrefetch.ts).
   *
   * Optional and defaulting to none: the reader is also reachable from a
   * thread row and from the opens rail, where there is no surrounding
   * list to be adjacent IN, and guessing one there would be a fetch spent
   * on a neighbour the user cannot even see.
   */
  readonly neighbours?: readonly InboxMessage[];
  /** The list's shared "now", threaded through to the thread rows so a
   *  row reads the same here as it does in the list. */
  readonly now: Date;
  readonly onBack: () => void;
  /**
   * What Back says it returns to. Defaults to the Inbox, which is where
   * every reader opened from a mail list goes.
   *
   * A prop rather than a fixed string because the reader is no longer
   * reached only from the Inbox: components/FollowupView.tsx opens it
   * over the follow-up queue and Back returns THERE, so a hardcoded
   * "Back to inbox" would name a destination the control does not go to.
   * Small, and exactly the kind of small the rest of this product refuses
   * to ship — a label that is wrong is a label the reader stops trusting.
   */
  readonly backLabel?: string;
  /** Opens a different message — used by the thread rows below. */
  readonly onOpen: (message: InboxMessage) => void;
  /** Whether this message is starred, already resolved through App.tsx's
   *  optimistic overrides (../components/messageFlags.ts's
   *  `resolveStar`) — so a star set one keystroke ago draws the same as
   *  one the last sync brought down. */
  readonly isStarred?: boolean;
  /** Stars or unstars this message. The SAME handler `s` runs, so the
   *  button and the shortcut cannot diverge — and the button is what
   *  makes the feature reachable without a keyboard. */
  readonly onToggleStar?: () => void;
  /**
   * Opens the composer on this message. Same handler `r`/`a`/`f` run, for
   * the same reason `onToggleStar` is shared: one behaviour with two ways
   * in, rather than two implementations that agree today.
   *
   * Optional because the reader is also reachable from the opens rail,
   * where App.tsx has nothing to reply WITH until the row resolves to a
   * message.
   */
  readonly onReply?: (mode: ReplyMode) => void;
  /**
   * Archive / Move to Trash, shared with the list rows and the keyboard
   * for the same reason `onToggleStar` is: one behaviour with three ways
   * in, rather than three implementations that agree today.
   *
   * Omitted where the action makes no sense for the surface — nothing
   * passes it today from a list the message did not come from — in which
   * case the two controls are simply absent rather than present and
   * inert.
   */
  readonly onMailboxMove?: (destination: MoveDestination) => void;
}

export default function MessageView({
  message,
  neighbours = [],
  now,
  onBack,
  backLabel = 'Back to inbox',
  onOpen,
  isStarred = false,
  onToggleStar,
  onReply,
  onMailboxMove,
}: MessageViewProps) {
  const accountId = message.account_id;
  const folder = message.folder;
  const uid = message.uid;

  /**
   * THE WHOLE POINT OF THE CACHE, and the reason this is a `useState`
   * INITIALIZER rather than an effect.
   *
   * App.tsx keys this component on the message, so opening one mounts it
   * fresh and this runs during that first render — before any paint. A
   * message already in the cache is therefore on screen in the first
   * frame after the click, with no loading state in between, which is
   * what "instant" actually means. Reading the cache in an effect instead
   * would paint the skeleton first and replace it a frame later: the same
   * data, and still a visible flash.
   *
   * `readCachedMessage` is a pure read and starts nothing, which is what
   * makes it safe here — React invokes an initializer during render, and
   * twice under StrictMode.
   */
  const [load, setLoad] = useState<LoadState>(() => {
    const cached = readCachedMessage(messageCache, { account_id: accountId, folder, uid });
    return cached === undefined ? { status: 'loading' } : { status: 'ready', parsed: cached };
  });
  const [attempt, setAttempt] = useState(0);
  /**
   * Whether the wait has gone on long enough to be worth telling the user
   * about — see SKELETON_DELAY_MS in src/motion/tokens.ts.
   *
   * Without this, a fetch the server answers from ITS cache in a few
   * milliseconds still flashes a skeleton, which is the app announcing
   * work it did not really do. With it, a genuinely slow fetch still gets
   * its skeleton (and its `role="status"` announcement) after the
   * threshold; only the fast path stays quiet.
   */
  const [isSlow, setIsSlow] = useState(false);
  // The subject heading, for the focus effect below. A direct ref now
  // that the card that used to wrap it (and that the old code reached
  // through with a `querySelector`) is gone.
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const target = { account_id: accountId, folder, uid };

    // A retry must fetch, whatever is cached — the cached copy is what
    // the user is retrying PAST when a previous attempt errored, and on
    // the error path there is nothing cached anyway.
    const outcome =
      attempt === 0
        ? loadMessage(messageCache, target)
        : { kind: 'pending' as const, parsed: refetchMessage(messageCache, target) };

    if (outcome.kind === 'cached') {
      // Already rendered by the initializer above on the mount that
      // matters. This branch is for the case App.tsx's `key` does not
      // remount on — the same account and uid in a different folder,
      // reachable from a thread row — where the identity changed but the
      // component did not. Compared by reference so an unchanged hit
      // costs no render at all.
      setLoad((current) =>
        current.status === 'ready' && current.parsed === outcome.parsed
          ? current
          : { status: 'ready', parsed: outcome.parsed },
      );
      setIsSlow(false);
      return;
    }

    setLoad({ status: 'loading' });
    setIsSlow(false);
    const slowTimer = window.setTimeout(() => {
      if (!cancelled) setIsSlow(true);
    }, SKELETON_DELAY_MS);

    outcome.parsed.then(
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
      window.clearTimeout(slowTimer);
    };
  }, [accountId, folder, uid, attempt]);

  /**
   * Warms the rows either side of this one. People read down a list, so
   * the next row is by a wide margin the most likely next open, and the
   * seconds spent reading THIS message are the free interval to spend on
   * it — see ../messagePrefetch.ts for the concurrency cap and for why
   * this is one row out and not ten.
   */
  useEffect(() => {
    const index = neighbours.findIndex(
      (row) => row.account_id === accountId && row.folder === folder && row.uid === uid,
    );
    if (index === -1) return;
    messagePrefetcher.prefetchAround(neighbours.map(targetFor), index);
  }, [neighbours, accountId, folder, uid]);

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
      {/* The reader's one chrome row: leave, get it out of the inbox, and
          star. Every control here is the same one the keyboard drives
          (`u`/Esc, `e`, `#`, `s`), wired to the same handlers, so there
          is one behaviour with two ways in rather than two
          implementations that agree today.

          `flex-wrap` because five controls plus a "Back to follow-up"
          label do not fit a 375px viewport on one line, and a toolbar
          that overflows off the right edge takes Trash with it. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          {backLabel}
        </Button>

        <span className="flex items-center gap-1">
        {onMailboxMove !== undefined && (
          <>
            {/* ARCHIVE FIRST, and Trash after it, in that order on
                purpose: archive is the safe, common, reversible one and
                trash is the one nobody wants to hit by accident. Putting
                the destructive-looking control under the thumb that was
                aiming for the safe one is how a list of actions becomes a
                hazard. */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onMailboxMove('archive')}
              aria-keyshortcuts="e"
            >
              <Archive aria-hidden="true" />
              Archive
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onMailboxMove('trash')}
              aria-keyshortcuts="#"
            >
              <Trash2 aria-hidden="true" />
              Trash
            </Button>
          </>
        )}

        {onToggleStar !== undefined && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleStar}
            /* `aria-pressed` rather than two labels: this is one toggle
               in two states, and a screen reader announces the state
               from the attribute without the name changing under the
               user mid-session. */
            aria-pressed={isStarred}
            aria-keyshortcuts="s"
          >
            <Star
              className={cn('h-4 w-4', isStarred && 'fill-current text-amber-500 dark:text-amber-400')}
              aria-hidden="true"
            />
            {isStarred ? 'Starred' : 'Star'}
          </Button>
        )}
        </span>
      </div>

      {/* NO CARD AROUND THE HEADER AND BODY any more. They were one
          bordered box split by a hairline; they are now two things
          separated by the `space-y-4` above — quiet chrome, then the
          message as its own raised sheet. See MessageHeader and BodyFrame
          for what replaced the border in each case, including why the
          gap under the header is load-bearing rather than decorative. */}
      <MessageHeader message={message} headingRef={headingRef} />

      {onReply !== undefined && (
        <ReplyActions onReply={onReply} isReady={load.status === 'ready'} />
      )}

      {load.status === 'loading' && isSlow && (
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
