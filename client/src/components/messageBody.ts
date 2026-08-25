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
 * Everything else here is the minimum that keeps a real email from
 * overflowing its column, and no more: images bounded to the frame width,
 * long unbroken URLs allowed to wrap. Fixed-width (600px) table layouts
 * are deliberately NOT overridden — squashing them mangles the message,
 * so the frame scrolls horizontally instead.
 */
const BODY_STYLE = [
  'html{color-scheme:light;background:#ffffff}',
  'body{margin:0;padding:16px;background:#ffffff;color:#111827;',
  "font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;",
  'overflow-wrap:break-word}',
  'img{max-width:100%;height:auto}',
  'a{color:#1d4ed8}',
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
export function srcDocFor(html: string): string {
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
    `<style>${BODY_STYLE}</style>` +
    '</head><body>' +
    html +
    '</body></html>'
  );
}

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
