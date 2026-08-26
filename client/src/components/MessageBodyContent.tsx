import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { FileText } from 'lucide-react';

import type { ParsedMessage } from '../api';
import { EmptyState } from '../ui/EmptyState';
import { TOUCH_MIN_HEIGHT } from '../ui/touchTarget';
import { useTheme } from '../useTheme';
import {
  FALLBACK_BODY_HEIGHT_PX,
  IFRAME_SANDBOX,
  applySchemeTo,
  bodyKind,
  measuredBodyHeightPx,
  safeGroundColor,
  srcDocFor,
} from './messageBody';
import type { BodyScheme } from './messageBody';

/**
 * HOW A MESSAGE BODY IS PUT ON SCREEN — the sandboxed frame for html, the
 * plain block for text, and the empty state for neither.
 *
 * Lifted out of MessageView.tsx when the reader learned to show a whole
 * conversation. It was private to that file while exactly one body was ever
 * rendered; a stacked thread renders one PER MESSAGE, so it had to become
 * something two callers can share rather than something one file owns.
 *
 * SECURITY, restated here because it now travels with the code rather than
 * with the reader: `parsed.html` is the sender's markup, unsanitised on
 * purpose all the way from sync/src/api/message.ts. It reaches the DOM
 * through exactly one path — `srcDocFor` into the `srcDoc` of the sandboxed
 * iframe below — and this file contains no `dangerouslySetInnerHTML`. Every
 * other attacker-controlled string (subject, filename, mime type) is a JSX
 * text child, which React escapes.
 */

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
/**
 * Keeps a loaded message document's scheme in step with the app's theme,
 * WITHOUT rebuilding it — see the note on `doc` in `BodyFrame` for what a
 * rebuild costs, and `applySchemeTo` for why writing into the frame is not a
 * loosening of the boundary it sits behind.
 *
 * The document normally already carries the right scheme, because
 * `srcDocFor` stamps it on the root element at build time; this exists for
 * the case that string does NOT cover, which is the theme changing while a
 * message is open. `doc` is in the deps so a genuinely new message re-arms
 * the load listener rather than writing into the outgoing document.
 */
function useSchemeSync(
  ref: RefObject<HTMLIFrameElement | null>,
  doc: string,
  scheme: BodyScheme,
  ground: string,
): void {
  useEffect(() => {
    const frame = ref.current;
    if (frame === null) return;

    const apply = () => applySchemeTo(frame.contentDocument, scheme, ground);
    // Reached it: nothing more to arrange. Only when the document is not
    // parsed yet does this need to wait, and then exactly once.
    if (apply()) return;

    frame.addEventListener('load', apply, { once: true });
    return () => frame.removeEventListener('load', apply);
  }, [ref, doc, scheme, ground]);
}

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

export function BodyFrame({ html, subject }: BodyFrameProps) {
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
  const scheme: BodyScheme = isDark ? 'dark' : 'light';
  //
  // `html` IS THE ONLY DEPENDENCY, AND THE OMISSIONS ARE THE POINT.
  //
  // Handing React a new `srcDoc` string reloads the frame, and a reload is
  // not free: it re-fetches every remote image in the message. Mail's remote
  // images are overwhelmingly tracking pixels — this app's own Opens feature
  // is built on that — so a rebuild reports a fresh open to the sender.
  // Measured with a no-store 1x1: one open plus five ordinary theme
  // interactions produced SIX hits. It also re-parsed 5875px of document and
  // left the previous theme's document painted inside the new frame for a
  // frame or two.
  //
  // So `scheme` and `ground` are read here for the FIRST paint — which must
  // be correct, or the flicker simply moves — and every change after that is
  // applied to the live document by `useSchemeSync` below. They are
  // deliberately absent from the dependency list; the memo closes over the
  // current render's values, so a genuine message change still builds with
  // the theme in force at that moment.
  const doc = useMemo(() => srcDocFor(html, scheme, ground), [html]);
  useSchemeSync(frameRef, doc, scheme, ground);
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
          className={`${TOUCH_MIN_HEIGHT} inline-flex cursor-pointer touch-manipulation items-center self-start rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
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
export function MessageBody({ parsed, subject }: MessageBodyProps) {
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
