import type { MessageAttachment, ParsedMessage } from '../api';

/**
 * Pure rendering logic for the message reader, split out of
 * MessageView.tsx for the same reason ./inboxDates.ts is split out of
 * InboxList.tsx: client/CLAUDE.md's standing constraint is that no test
 * in this project renders a component, so anything that has to be
 * VERIFIED must be framework-free.
 *
 * What is verified here is the security boundary itself. sync/ returns a
 * message's html exactly as the sender wrote it and deliberately does NOT
 * sanitise it (see sync/src/api/message.ts's own doc comment for why
 * double-sanitising would erode this boundary rather than add one), so
 * `IFRAME_SANDBOX` + the CSP `<meta>` built below are the only things
 * standing between attacker-authored HTML and this origin. Both are
 * constants in this file precisely so a test can assert on them.
 */

/**
 * The `sandbox` attribute value the body iframe carries, verbatim and
 * from exactly one place — tests/message-body.test.ts asserts that every
 * `sandbox=` in client/src/**\/*.tsx is this identifier and nothing else,
 * so a second, laxer iframe cannot appear without failing the suite.
 *
 * WHAT IS ABSENT IS THE POINT.
 *
 *  - **No `allow-scripts`.** Nothing in a message body ever executes: no
 *    `<script>`, no `onclick=`, no `javascript:` href. This is the whole
 *    boundary, and it holds against html nobody inspected, which is why
 *    it is worth more than any sanitiser's blocklist.
 *  - **No `allow-same-origin`.** The frame gets an opaque origin, so even
 *    if script somehow ran it could not reach this document, its cookies,
 *    or the session. The pairing `allow-scripts allow-same-origin` is the
 *    well-known way to accidentally remove the sandbox entirely; neither
 *    half is present here, and adding EITHER changes what this attribute
 *    means.
 *  - **No `allow-forms`, `allow-modals`, `allow-top-navigation`,
 *    `allow-downloads`.** A message cannot post a form, block the UI, or
 *    navigate the app out from under the reader.
 *
 * What IS present, and why: `allow-popups` plus
 * `allow-popups-to-escape-sandbox` make ordinary links work. A link click
 * needs user activation, so no message can open a tab on its own; the
 * `-to-escape-sandbox` half means the tab that DOES open is a normal
 * browsing context rather than a crippled sandboxed copy of the linked
 * site. Without the pair, every link in every email is silently dead —
 * which is not a safer reader, just a broken one.
 */
export const IFRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

/**
 * The `Content-Security-Policy` enforced INSIDE the srcdoc.
 *
 * `default-src 'none'` is the base: no stylesheets, no fonts, no frames,
 * no media, no XHR — nothing loads from anywhere unless a directive below
 * re-permits it. Exactly three do: `style-src 'unsafe-inline'` (email
 * layout is inline `style=` attributes and `<style>` blocks; with no
 * script able to run, inline CSS cannot exfiltrate anything), `font-src
 * data:`, and `img-src`.
 *
 * **`img-src` PERMITS REMOTE HOSTS, and that is a user decision, not an
 * oversight.** This function used to take an `allowRemote` flag, default
 * false, so a reader had to press "Load remote images" per message — the
 * reasoning being that a remote image tells the sender the exact second
 * their mail was opened, which is precisely the mechanism Postbox uses to
 * detect opens on the mail the USER sends. The user reviewed that and
 * overruled it, verbatim: "remove the dont load images thing i dont care
 * if people can track me with the pixels." Mail now renders the way the
 * sender built it, first time, with no bar and no button.
 *
 * WHAT THIS DOES NOT CHANGE, and the distinction matters because the two
 * were argued together in the old comment: remote images were a PRIVACY
 * control. `IFRAME_SANDBOX` above is the XSS boundary, and it is
 * untouched — no `allow-scripts`, no `allow-same-origin`, both still
 * pinned by tests/message-body.test.ts. A sender can now learn that their
 * mail was opened. A sender still cannot run a line of code, read a
 * cookie, or reach this origin. Trading the first away does not soften
 * the second, and nothing in this file should ever be edited as though
 * it did.
 *
 * `cid:` stays in the list beside `data:` and the remote schemes: it
 * costs nothing, and a browser cannot resolve it anyway (see
 * MessageView's note on embedded images).
 */
export function contentSecurityPolicyFor(): string {
  return [
    "default-src 'none'",
    "script-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "style-src 'unsafe-inline'",
    'font-src data:',
    'img-src data: cid: https: http:',
  ].join('; ');
}

/**
 * The stylesheet the srcdoc carries, and the one place this app decides
 * what a message body LOOKS like.
 *
 * **A LIGHT CARD, IN BOTH THEMES, DELIBERATELY.** Every other surface in
 * this client follows the semantic palette into dark mode. This one does
 * not, and must not: an email's own HTML hardcodes its colours against
 * the white background every mail client has ever given it — dark text in
 * an inline `style=`, a logo that is a white-background PNG, a table with
 * `bgcolor="#ffffff"` around half its cells and nothing around the other
 * half. Forcing a dark ground under that produces black-on-black
 * paragraphs and white boxes floating in a dark page: not a dark theme, a
 * broken message. `color-scheme: light` states the same thing to the
 * browser so it does not auto-darken form controls or scrollbars inside
 * the frame either.
 *
 * The reader's own chrome around this frame — header, attachments,
 * thread, every control — IS fully themed, so dark mode still reads as
 * dark mode; the message itself sits on a light card inside it, the way a
 * sheet of paper does. MessageView.tsx frames it as one.
 *
 * **THE REST OF THIS FILE IS THE NO-SIDEWAYS-PAN RULE SET, AND IT
 * REVERSES A PREVIOUS DECISION.** This comment used to end: *"Fixed-width
 * (600px) table layouts are deliberately NOT overridden — squashing them
 * mangles the message, so the frame scrolls horizontally instead."* The
 * user read mail on a phone and overruled it: *"should have no overflow
 * and stuff for some reason i can move left to right on the emails fix
 * that."* Measured against this user's own inbox at a 341px frame, two
 * distinct causes were producing that pan, and each rule below answers
 * one of them:
 *
 *  - **Long unbreakable tokens.** A GitHub notification carrying a code
 *    diff measured 707px wide in a 341px frame with no element wider than
 *    the frame — the overflow was inline content inside `<pre>`, where
 *    `white-space: pre` disables wrapping outright and `overflow-wrap`
 *    never gets a chance. `pre{white-space:pre-wrap}` plus
 *    `overflow-wrap:anywhere` (which, unlike `break-word`, also shrinks
 *    an element's min-content width) takes that message to exactly 341.
 *
 *  - **Fixed-width marketing layouts.** A `<table width="640">` whose
 *    cells hold `<img width="640">`. `max-width:100%` cannot shrink
 *    either: a percentage max-width is treated as `none` while the
 *    browser computes min-content width, which is the very step that
 *    sizes the table. The image cap is therefore expressed as a VIEWPORT
 *    length, which does participate, and that alone dropped one real
 *    message from 4382px to 3617px tall with every image legible.
 *
 * **WHERE A TABLE GENUINELY CANNOT REFLOW, IT SCROLLS IN ITS OWN BOX.**
 * One measured message pins its width at 640 through a single `<tr>` of
 * five `<td>`s (210+140+94+87+109) — a real five-across layout that no
 * stylesheet can stack without destroying it. `body>table` therefore
 * becomes a block-level scroll container: the tbody/tr/td inside keep
 * table layout under an anonymous table box, so the design is untouched,
 * but the overflow is confined to that one element and the DOCUMENT never
 * pans. This is the standard wide-table treatment, and it is applied only
 * to top-level tables — nested ones stay tables, or every multi-column
 * email would collapse into a single column.
 */
const BODY_STYLE = [
  'html{color-scheme:light;background:#ffffff}',
  // Named so the image cap below can be derived from the padding instead
  // of repeating it as a literal, and so the scrollbar allowance is a
  // stated quantity rather than a mystery constant. `--scrollbar` exists
  // because `100vw` includes the frame's own vertical scrollbar: without
  // it, a message long enough to scroll pans sideways by exactly that
  // width. Mobile overlay scrollbars are 0, so the allowance only ever
  // makes an image marginally narrower than it could have been.
  ':root{--pad:16px;--scrollbar:16px}',
  'body{margin:0;padding:var(--pad);background:#ffffff;color:#111827;',
  "font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;",
  // `anywhere`, not `break-word`: the two wrap identically, but only
  // `anywhere` also lowers min-content width, which is what lets a table
  // cell holding a 400-character URL stop forcing the table wide.
  'overflow-wrap:anywhere}',
  'img{max-width:min(100%,calc(100vw - 2 * var(--pad) - var(--scrollbar)));height:auto}',
  'a{color:#1d4ed8}',
  'table{max-width:100%}',
  'pre{white-space:pre-wrap;overflow-wrap:anywhere}',
  'body>table{display:block;max-width:100%;overflow-x:auto}',
].join('');

/** Which ground the message is rendered on. */
export type BodyScheme = 'light' | 'dark';

/**
 * DARK MODE FOR THE MESSAGE ITSELF, by inversion rather than by restyling.
 *
 * **THIS REVERSES THE DECISION ABOVE, AT THE USER'S REQUEST:** *"Fix the
 * dark mode. When you click into emails the email section still white…
 * you can try to also change the background whites to the dark theme."*
 * The reasoning that kept this card light is still correct and is worth
 * restating, because it is exactly what this rule set has to survive: an
 * email hardcodes its colours against the white ground every client has
 * ever given it, so simply setting a dark `background` produces
 * black-on-black paragraphs wherever the sender set `color:#333` inline
 * and no background to go with it. That failure is not cosmetic — the
 * text becomes unreadable, which is worse than a white card.
 *
 * **SO WE INVERT INSTEAD OF RECOLOURING, and the distinction is the whole
 * point.** Recolouring has to guess which of the sender's colours to keep
 * and which to override, and it guesses wrong on any message that sets
 * one half of a foreground/background pair. Inverting cannot: it is a
 * uniform transform over whatever the sender actually specified, so the
 * CONTRAST the sender chose is preserved exactly while the lightness
 * flips. Black-on-white becomes white-on-black; grey-on-white becomes
 * grey-on-black. There is no combination of sender styles that inverts
 * into an unreadable one, which is the property no recolouring rule set
 * can offer. This is what Outlook and Apple Mail do for the same reason.
 *
 * `hue-rotate(180deg)` follows the inversion because `invert()` alone
 * also flips hue — a blue link would come back orange. Rotating the wheel
 * a half turn puts it back, so brand colours stay recognisably themselves
 * at inverted lightness.
 *
 * **MEDIA IS INVERTED A SECOND TIME, back to normal.** A photograph, a
 * logo, a screenshot — anything whose pixels are content rather than
 * styling — must not come out as a negative. Applying the same transform
 * again is exactly self-cancelling, so these elements render as the
 * sender authored them.
 *
 * **WHAT THIS COSTS, stated plainly rather than buried.** Two things it
 * genuinely cannot fix. A CSS `background-image` (common in marketing
 * mail) is not reachable by any selector that names the element carrying
 * it, so it inverts and looks wrong. And a message already authored dark
 * inverts to light — legible, still contrasty, but not what its sender
 * intended. Both are why MessageView.tsx offers a per-message escape back
 * to the original rendering, which is the same mitigation Outlook ships;
 * neither is a reason to hand the user a white rectangle at night.
 *
 * `color-scheme:dark` replaces the `light` set above so the UA's own
 * scrollbars and form controls inside the frame match the inverted page.
 * The `background` stays WHITE deliberately: it is the input to the
 * filter, and inverting white is what produces the near-black ground.
 */
const DARK_BODY_STYLE = [
  'html{color-scheme:dark;filter:invert(1) hue-rotate(180deg)}',
  // Re-inverted so their pixels survive the page-level transform. `svg` is
  // included because inline SVG in mail is nearly always a logo or icon,
  // i.e. content; where it is used as decoration the double inversion is
  // no worse than the single one would have been.
  'img,picture,video,canvas,svg,embed,object{filter:invert(1) hue-rotate(180deg)}',
].join('');

/**
 * Builds the complete document handed to the body iframe's `srcdoc`.
 *
 * `html` is attacker-authored and is embedded VERBATIM, which is safe
 * only because of the two things wrapped around it: `IFRAME_SANDBOX` on
 * the element and the CSP `<meta>` this puts first in `<head>`, before
 * any markup that could trigger a load. Nothing here escapes, strips or
 * rewrites the message — see this file's header, and sync/src/api/
 * message.ts, for why introducing a sanitiser at either end would make
 * this weaker rather than stronger.
 *
 * The result is passed to React's `srcDoc` prop, which sets the attribute
 * through the DOM. It is never concatenated into this app's own markup,
 * so a `"` or a `</iframe>` in a message cannot break out into the parent
 * document — there is no parent-document HTML parse for it to break out
 * of.
 *
 * `<meta name="referrer" content="no-referrer">` survives the
 * remote-image decision and is not part of it: the user chose to let
 * senders learn THAT their mail was opened, not to hand every host a
 * message linked to the URL the reader came from. Kept.
 *
 * There is no longer an options bag. `allowRemote` was its only member
 * and it has one possible value now, so a parameter nothing sets would be
 * a config knob pretending to still be a decision.
 */
export function srcDocFor(html: string, scheme: BodyScheme = 'light'): string {
  const csp = contentSecurityPolicyFor();
  return (
    '<!doctype html><html><head>' +
    '<meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    '<meta name="referrer" content="no-referrer">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    // Target only, no href: links open in a new tab (the sandbox's
    // allow-popups pair is what lets them) instead of navigating the
    // frame away from the message. `base-uri 'none'` above still blocks a
    // message supplying its own <base href> to re-point relative URLs.
    '<base target="_blank">' +
    `<style>${BODY_STYLE}${scheme === 'dark' ? DARK_BODY_STYLE : ''}</style>` +
    '</head><body>' +
    html +
    '</body></html>'
  );
}

/**
 * THE BODY FRAME'S HEIGHT, ESTIMATED FROM THE MESSAGE ITSELF.
 *
 * **WHY AN ESTIMATE AND NOT A MEASUREMENT.** A sandboxed iframe that
 * omits `allow-same-origin` has an opaque origin: from the parent,
 * `iframe.contentDocument` is `null` and `iframe.contentWindow.document`
 * throws `SecurityError`. Verified against the running app, not assumed.
 * The `postMessage` workaround needs `allow-scripts` inside the frame.
 * Both attributes are the XSS boundary (see `IFRAME_SANDBOX`) and neither
 * is on the table, so the frame's height has to be decided from the
 * OUTSIDE, from the one thing the parent does hold: the html string.
 *
 * **WHY NOT JUST ONE GENEROUS FIXED HEIGHT.** That was the first answer,
 * and looking at it in the browser killed it. Every html message in this
 * user's inbox was rendered at a 341px width and measured: heights run
 * from 40px to 8762px — a 200x spread. At the tall end of that spread a
 * fixed frame still scrolls internally; at the short end it is far worse,
 * because a Gmail reply whose entire body is `<div><br></div>` was
 * rendering as **1786px of blank white** — roughly two phone screens of
 * nothing between the message and its attachments. That is not a
 * tradeoff, it is a bug with a tidy explanation.
 *
 * **THE SHAPE OF THE ANSWER.** A cheap structural estimate, CLAMPED at
 * both ends. It is deliberately biased to over-estimate, because the two
 * failure directions are not symmetric:
 *
 *  - Over-estimate → white space below the message. Ugly, bounded by
 *    `MAX_BODY_HEIGHT_PX`.
 *  - Under-estimate → the frame scrolls internally, which is exactly the
 *    behaviour this whole change replaces. Bad, but never WORSE than what
 *    shipped before, so the safety valve is the old bug and not a new one.
 *
 * **THE CONSTANTS ARE MEASURED, NOT INVENTED.** Each was checked against
 * the rendered heights above, at a 341px frame — `REFERENCE_FRAME_WIDTH_PX`.
 *
 * **AND THE WIDTH MATTERS, WHICH IS WHY IT IS A PARAMETER.** The same mail
 * measured at a 960px frame (the desktop reader column) renders 25–50%
 * shorter, because prose reflows into fewer lines. A phone-tuned constant
 * applied at desktop width put ~1000px of white under a 1025px message —
 * the same bug this function exists to kill, just at the other breakpoint.
 * Only the TEXT term is scaled: prose reflows with the column, whereas an
 * image bounded by `img{max-width:…}` and a table row do not shrink in any
 * way worth modelling. The frame's own width is something the parent may
 * read freely — it is our element, not the sandboxed document inside it.
 */

/** The body's own 32px of padding plus a first/last block margin, and the
 *  floor under a message that is structurally empty but not textually so. */
const BASE_BODY_HEIGHT_PX = 160;

/** Roughly 45 characters fit a 22px line at a phone-width column, so a
 *  character costs ~0.5px of column height; real mail adds block margins
 *  between paragraphs, and the measured figure lands near 0.7. */
const PX_PER_TEXT_CHAR = 0.7;

/** A typical email image once `img{max-width:…}` has bounded it. */
const PX_PER_IMAGE = 90;

/** One row of the table layout email HTML is still built out of. */
const PX_PER_TABLE_ROW = 16;

/** The frame width the constants above were measured at: a 375px phone
 *  minus the reader column's gutters. The text term is scaled by
 *  `REFERENCE_FRAME_WIDTH_PX / actualWidth`, so this is the width at which
 *  that scaling is a no-op. */
const REFERENCE_FRAME_WIDTH_PX = 341;

/** Never shorter than this: a one-line message still wants to look like a
 *  sheet rather than a strip, and the estimate is least reliable here. */
const MIN_BODY_HEIGHT_PX = 240;

/** Never taller than this. Past ~2200px the estimate has stopped being
 *  informative and the frame is simply a long one; the remaining ~30% of
 *  mail scrolls internally from here, which is the documented last
 *  resort. */
const MAX_BODY_HEIGHT_PX = 2200;

/** Tags whose content never contributes rendered text. Stripped before
 *  counting so a 40KB `<style>` block does not read as 40KB of prose. */
const NON_RENDERING_TAGS = /<(script|style|head|title)[\s\S]*?<\/\1>/gi;

/** Counts non-overlapping matches without allocating the match array. */
function countMatches(html: string, pattern: RegExp): number {
  let count = 0;
  // `pattern` carries /g, so `exec` walks it; a fresh lastIndex keeps this
  // function pure with respect to a shared literal.
  pattern.lastIndex = 0;
  while (pattern.exec(html) !== null) count += 1;
  pattern.lastIndex = 0;
  return count;
}

const IMG_TAG = /<img\b/gi;
const ROW_TAG = /<tr\b/gi;

/**
 * The height, in CSS pixels, to give the body iframe for this message.
 *
 * Pure and framework-free so the suite can actually assert on it —
 * client/CLAUDE.md's standing constraint is that no test here renders a
 * component, which is precisely why the reader's one piece of arithmetic
 * lives in this file rather than inside MessageView.tsx.
 */
export function estimatedBodyHeightPx(html: string, frameWidthPx: number): number {
  // A zero or nonsense width (an unmounted frame, a display:none column)
  // falls back to the reference rather than dividing by it — the estimate
  // is then simply the phone-width one, which is the safe direction.
  const width = Number.isFinite(frameWidthPx) && frameWidthPx > 0
    ? frameWidthPx
    : REFERENCE_FRAME_WIDTH_PX;
  const rendering = html.replace(NON_RENDERING_TAGS, ' ');
  // Tag-stripping rather than parsing: this only needs an order of
  // magnitude, and DOMParser on attacker HTML for a layout hint would be
  // a parser this feature does not otherwise need.
  const textLength = rendering
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;

  const estimate =
    BASE_BODY_HEIGHT_PX +
    (textLength * PX_PER_TEXT_CHAR * REFERENCE_FRAME_WIDTH_PX) / width +
    countMatches(rendering, IMG_TAG) * PX_PER_IMAGE +
    countMatches(rendering, ROW_TAG) * PX_PER_TABLE_ROW;

  return Math.round(Math.min(MAX_BODY_HEIGHT_PX, Math.max(MIN_BODY_HEIGHT_PX, estimate)));
}

/** The bounds `estimatedBodyHeightPx` clamps to, exported so the guard
 *  test asserts the shipped numbers rather than a copy of them. */
export const BODY_HEIGHT_BOUNDS_PX = {
  min: MIN_BODY_HEIGHT_PX,
  max: MAX_BODY_HEIGHT_PX,
  referenceWidth: REFERENCE_FRAME_WIDTH_PX,
} as const;

/** Which of the three body surfaces the reader should render. */
export type BodyKind = 'html' | 'text' | 'empty';

/**
 * Picks the body to render: html when there is one, the plain-text
 * alternative when there is not, and `'empty'` when the message carries
 * neither — which is a real message, not an error (an attachment-only
 * mail, or a body the size cap in sync/src/api/fetch-part.ts truncated
 * away), and gets an empty state plus its attachment list rather than a
 * failure.
 *
 * Whitespace-only counts as absent on both fields: a body of `"\n\n"` is
 * not content, and treating it as html would render a blank frame with no
 * hint that a perfectly good `text/plain` alternative was sitting next to
 * it.
 */
export function bodyKind(message: Pick<ParsedMessage, 'html' | 'text'>): BodyKind {
  if (typeof message.html === 'string' && message.html.trim() !== '') return 'html';
  if (typeof message.text === 'string' && message.text.trim() !== '') return 'text';
  return 'empty';
}

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * 1024;
const BYTES_PER_GB = BYTES_PER_MB * 1024;

/**
 * A human byte size for one attachment row: `812 B`, `1.5 KB`, `2.3 MB`.
 *
 * **The number this formats is the DECODED size** — what the file is once
 * saved — because that is what sync/src/api/message.ts's ParsedAttachment
 * carries. The `size_bytes` on an inbox row is a DIFFERENT number: the
 * ENCODED size from BODYSTRUCTURE, roughly 4/3 larger for base64. Same
 * name, ~33% apart. Never cross-reference the two; this reader only ever
 * shows the one it is given here.
 *
 * `null` is the honest answer for an attachment whose size the parse did
 * not produce, and reads as such — never `0 B`, which claims an empty
 * file, and never a blank, which reads as a layout bug.
 */
export function formatSize(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < BYTES_PER_KB) return `${Math.round(bytes)} B`;

  const [value, unit] =
    bytes < BYTES_PER_MB
      ? [bytes / BYTES_PER_KB, 'KB']
      : bytes < BYTES_PER_GB
        ? [bytes / BYTES_PER_MB, 'MB']
        : [bytes / BYTES_PER_GB, 'GB'];
  // One decimal, and no trailing `.0`: `1 KB`, not `1.0 KB`.
  return `${Math.round(value * 10) / 10} ${unit}`;
}

/**
 * Whether this attachment can be offered as a download at all.
 *
 * **`partId === ''` means "not addressable", and it is not hypothetical.**
 * mailparser reconstructs part numbers by counting MIME boundaries, IMAP
 * assigns them structurally, and the two disagree for sibling multiparts;
 * sync/src/api/message.ts reconciles against the part numbers already
 * stored from BODYSTRUCTURE and, when it CANNOT establish one, emits an
 * empty string rather than a plausible-looking guess. A guessed part
 * number is the 4th segment of the attachment route, so it downloads the
 * wrong part or 404s.
 *
 * This is therefore the 404-avoidance, and the reason MessageView renders
 * such an entry as a visible but non-downloadable row: the attachment
 * exists and the user should know it does, but there is no honest URL to
 * put behind it. Whitespace is treated as empty for the same reason — it
 * would produce a URL segment that resolves to nothing.
 */
export function isDownloadable(attachment: Pick<MessageAttachment, 'partId'>): boolean {
  return attachment.partId.trim() !== '';
}

/**
 * The download URL for one attachment, matching the route in
 * sync/src/api/routes.ts verbatim:
 * `/api/attachment/{accountId}/{folder}/{uid}/{partId}` — four segments,
 * the last of which is the part id.
 *
 * Every segment is percent-encoded because the server's own pattern is
 * `([^/]+)` per segment and it `decodeURIComponent`s three of them
 * (`decodeSegments`): a Gmail folder like `[Gmail]/Sent Mail` contains a
 * literal `/` and would otherwise split into two segments and miss the
 * route entirely. `uid` is digits in practice, so encoding it is a no-op
 * that costs nothing and removes one thing to remember.
 *
 * Callers must gate on `isDownloadable` first — this function builds
 * whatever it is given, and an empty `partId` produces a URL that cannot
 * resolve.
 */
export function attachmentUrl(
  accountId: string,
  folder: string,
  uid: string,
  partId: string,
): string {
  const segments = [accountId, folder, uid, partId].map(encodeURIComponent);
  return `/api/attachment/${segments.join('/')}`;
}

/**
 * The identity of one inbox row, `accountId:uid` — unique across the
 * merged inbox, where a bare uid is not (uids are per-mailbox, so four
 * accounts routinely share one).
 *
 * One helper for four call sites that must agree: InboxList's React key,
 * the `data-message-key` MessageRow puts on its button, App's focus
 * restore when the reader closes, and MessageView's thread list dropping
 * the message already being read. Those last two are the ones that break
 * silently if a copy drifts.
 */
export function messageKey(message: { readonly account_id: string; readonly uid: string }): string {
  return `${message.account_id}:${message.uid}`;
}
