/**
 * Plan 4 Task 3 — the pure half of the send path: one recipient's copy of
 * a message, rendered.
 *
 * Nothing in this file performs I/O, reads config, or knows what a
 * transport is. That is deliberate and it is what makes spec §5.1
 * testable: the tracking pixel's markup is BINDING, so the thing that
 * emits it has to be a function whose entire output a test can assert as a
 * literal string, not a side effect buried inside an SMTP call.
 */

/**
 * The five characters that can change the meaning of HTML, and nothing
 * else. Hand-written rather than pulled from a package: escaping five
 * characters is not a dependency, and the one thing an escaper must never
 * do — escape its own output — is a property of how it is applied, not of
 * how large the table is.
 */
const HTML_ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapes text for interpolation into HTML character data or a quoted
 * attribute value.
 *
 * ONE pass over a character class, never a chain of five `.replace()`
 * calls. A chain has to handle `&` first or it double-escapes every
 * entity it just produced (`<` → `&lt;` → `&amp;lt;`), and "first" is
 * exactly the kind of ordering constraint that survives review and then
 * dies in a refactor. A single pass cannot get it wrong: each source
 * character is visited once and its replacement is never re-scanned.
 *
 * `'` becomes `&#39;` rather than `&apos;` — the named form is HTML5-only,
 * and mail clients parse a startling range of HTML vintages.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char] ?? char);
}

/**
 * Characters an email ADDRESS may never carry into a header or an SMTP
 * envelope: every character at or below U+0020 — the C0 controls, with
 * CR/LF the injection vector, plus tab and the space itself — and U+007F
 * (DEL), together with the three delimiters that would otherwise close
 * the address and open something else.
 *
 * ASCII only, deliberately: this does NOT strip Unicode whitespace such
 * as U+00A0 or U+2028. Those cannot terminate a header or an SMTP
 * command, so removing them would silently corrupt an address rather
 * than protect anything.
 *
 * Applies to the SENDER address only, which comes from operator config.
 * Recipient addresses are validated — not rewritten — at the route
 * boundary (`isUsableRecipient` in ../api/send.ts), because silently
 * altering an address the user typed would send their mail somewhere they
 * did not ask for; a refusal is the honest answer there.
 */
const UNSAFE_ADDRESS_CHARACTERS = /[\u0000-\u0020"\\<>\u007F]/g;

/**
 * Strips anything from a sending address that could break out of a header
 * or an envelope. Fix round 1: `formatFrom` used to hold the display NAME
 * to this standard while passing the ADDRESS through untouched, which is
 * an asymmetry a module cannot justify while explicitly declining to
 * depend on nodemailer's own sanitising.
 */
export function sanitizeAddress(address: string): string {
  return address.replace(UNSAFE_ADDRESS_CHARACTERS, '');
}

/**
 * The `From` header value for a sending identity.
 *
 * No account carries a display name today (see AccountConfig in
 * ../config.ts — it is id/email/appPassword/isPrimary), so in production
 * this returns the bare address on every call. The optional name is
 * accepted anyway because the From value is exactly where a display name
 * would land the day one is configured, and because a caller passing one
 * must not be able to inject a header: quotes, backslashes and CR/LF are
 * removed rather than escaped. Nodemailer would encode them itself; this
 * function does not depend on that — and, since fix round 1, neither
 * input relies on it.
 */
export function formatFrom(fromName: string | undefined, fromEmail: string): string {
  const address = sanitizeAddress(fromEmail);
  const cleaned = (fromName ?? '').replace(/["\\\r\n]/g, '').trim();
  if (!cleaned) return address;
  return `"${cleaned}" <${address}>`;
}

/**
 * One recipient's copy of a compose action.
 *
 * The addressing fields (`fromName`/`fromEmail`/`to`/`cc`/`subject`) are
 * part of this shape even though only `textBody`, `token` and `pixelBase`
 * shape the bytes `buildTrackedMessage` returns: ./send.ts builds ONE of
 * these per recipient and hands the same object to both this builder and
 * `sendMail`, so the group headers and the body that carries that
 * recipient's own pixel cannot drift apart between the two calls.
 *
 * `to`/`cc` are the FULL group on every copy (spec §5.3) — the per-
 * recipient part is `token`, and the envelope, which ./send.ts sets.
 */
export interface TrackedMessage {
  readonly fromName?: string;
  readonly fromEmail: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly subject: string;
  readonly textBody: string;
  /**
   * The quoted original, as ./quote.ts's single `.gmail_quote` element —
   * absent for a plain compose, which is every message this product sent
   * before Plan 9.
   *
   * ALREADY STRIPPED of any Valen Mail pixel the original carried (spec §5.6)
   * and already escaped where it needed to be: this builder splices it in
   * verbatim. It is html by construction, so escaping it here would show
   * the recipient the quote's own markup as literal text.
   */
  readonly htmlQuote?: string;
  /** This recipient's own opaque 32-hex token, minted by tracking. */
  readonly token: string;
  /** TRACKING_BASE_URL — with or without a trailing slash, both work. */
  readonly pixelBase: string;
}

/** The two alternatives of one outgoing message. */
export interface TrackedMessageBody {
  readonly text: string;
  readonly html: string;
}

/**
 * Builds the tracking pixel's URL: `{pixelBase}/o/{token}.png`.
 *
 * Trailing slashes on the base are stripped rather than trusted, because
 * `TRACKING_BASE_URL` is an operator-typed environment variable and
 * `https://track.example//o/abc.png` is a different path from
 * `https://track.example/o/abc.png` — one of them 404s, and which one
 * depends on the host. `new URL('/o/...', base)` is not used here on
 * purpose: it would silently discard any path prefix on the base
 * (`https://host/px/` + `/o/x.png` → `https://host/o/x.png`).
 */
function pixelUrl(pixelBase: string, token: string): string {
  return `${pixelBase.replace(/\/+$/, '')}/o/${token}.png`;
}

/**
 * Renders the text and html alternatives for one recipient's copy.
 *
 * **text** is `textBody` verbatim — not escaped, and carrying no pixel.
 * That is correct MIME practice rather than a tracking hole: a text/plain
 * part cannot load an image, so there is nothing to embed in it, and
 * escaping HTML entities into plaintext would only show the recipient
 * literal `&amp;` where they typed `&`. Every mail client that can render
 * the html alternative prefers it; the plaintext one exists for those that
 * cannot, and for them there is no tracking to be had by any means.
 *
 * **html** is the escaped body inside `<div dir="auto">` with newlines as
 * `<br>`, followed by the spec §5.1 pixel tag EXACTLY:
 *
 *     <img alt="" src="{PIXEL_BASE}/o/{token}.png">
 *
 * That string is BINDING (spec §5.1) and tests/send-build.test.ts asserts
 * it literally. Do not add `width`, `height`, `style`, `class`, or a
 * descriptive `alt`: the empty alt keeps screen readers silent about a
 * decoration, and every sizing attribute is a fingerprint that mail
 * clients and privacy proxies treat differently from bare markup.
 *
 * `dir="auto"` lets the client pick direction from the first strong
 * character rather than forcing LTR on a body that may be neither.
 *
 * PIXEL PLACEMENT IS BINDING TOO (spec §5.2): when a quote is present the
 * pixel is spliced in BEFORE it, never inside it. Gmail collapses quoted
 * text behind a toggle, and an image inside the collapsed region is not
 * fetched until the reader expands it — so a pixel placed inside a quote
 * reports every tracked reply as "unopened", forever, and does it silently.
 * With no quote the pixel is appended to the body root, which is exactly
 * what this function has always done and must keep doing byte for byte.
 */
export function buildTrackedMessage(message: TrackedMessage): TrackedMessageBody {
  // Normalised before escaping so CRLF, bare CR and LF all become the same
  // single <br> — a body pasted from a Windows editor must not render with
  // doubled line breaks.
  const normalised = message.textBody.replace(/\r\n?/g, '\n');
  const escaped = escapeHtml(normalised).replace(/\n/g, '<br>');

  return {
    text: message.textBody,
    html:
      `<div dir="auto">${escaped}</div>` +
      `<img alt="" src="${pixelUrl(message.pixelBase, message.token)}">` +
      (message.htmlQuote ?? ''),
  };
}
