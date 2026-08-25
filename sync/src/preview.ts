/**
 * Turns the ~512 raw bytes of a message's first text part into the plain,
 * new-content-only text that normalize.ts's makeSnippet() then collapses
 * and caps.
 *
 * Everything here is PURE and IMAP-free on purpose: imap/fetch.ts owns the
 * bounded PEEK fetch, this module owns what the bytes mean. That split is
 * what lets the quoted-text, signature, HTML and transfer-encoding rules
 * below be tested against fixtures without a live Gmail connection.
 *
 * WHY HAND-ROLLED RATHER THAN `mailparser` (already a dependency): what
 * arrives here is a FRAGMENT — the first N bytes of one MIME part's body,
 * with no headers, no boundary, and usually cut mid-line. `simpleParser`
 * wants a whole RFC822 document and would have to be fed a synthesized
 * envelope to accept this, which is a more elaborate lie than decoding
 * one known Content-Transfer-Encoding ourselves. The encoding and MIME
 * type are already known from the BODYSTRUCTURE the header fetch pulled,
 * so nothing has to be guessed.
 */

/**
 * The one body part a preview is taken from, resolved from BODYSTRUCTURE
 * rather than assumed. `encoding` and `mimeType` come from the same walk,
 * which is what makes decoding and HTML-stripping decisions rather than
 * guesses.
 */
export interface TextPart {
  /** IMAP part number, e.g. '1' or '1.1'. */
  readonly partId: string;
  /** Lowercased Content-Type, e.g. 'text/plain'. */
  readonly mimeType: string;
  /** Lowercased Content-Transfer-Encoding, or null when unstated. */
  readonly encoding: string | null;
}

interface StructureNode {
  readonly part?: string;
  readonly type?: string;
  readonly encoding?: string;
  readonly disposition?: string;
  readonly childNodes?: readonly StructureNode[];
}

/** Node budget for the BODYSTRUCTURE walk, matching attachments.ts's own
 *  bound and for the same reason: a hostile or malformed structure from an
 *  untrusted sender must not turn a preview into unbounded work. */
const MAX_STRUCTURE_NODES = 1000;

/**
 * RFC 3501 §6.4.5: "Non-multipart messages ... only have a part 1." So a
 * singlepart message's root node — which imapflow reports with NO `part`
 * field, since part numbers are built from the path down from the root —
 * is addressed as BODY[1].
 */
const SINGLEPART_PART_ID = '1';

function isTextNode(node: StructureNode): boolean {
  return typeof node.type === 'string' && node.type.toLowerCase().startsWith('text/');
}

function toTextPart(node: StructureNode): TextPart {
  return {
    partId: node.part ?? SINGLEPART_PART_ID,
    mimeType: (node.type ?? '').toLowerCase(),
    encoding: typeof node.encoding === 'string' ? node.encoding.toLowerCase() : null,
  };
}

/**
 * Finds the part a preview should be taken from: the first text/plain leaf
 * in document order, or the first text/* leaf when the message carries no
 * plain-text alternative at all (HTML-only mail, which is common enough
 * that falling back to it rather than giving up is the difference between
 * a preview and a blank row).
 *
 * Resolved from BODYSTRUCTURE rather than hardcoding `BODY[1]` because for
 * the very common `multipart/mixed( multipart/alternative(text/plain,
 * text/html), application/pdf )` shape, part 1 is the multipart/alternative
 * NODE — fetching it returns MIME boundaries and per-part headers, so the
 * "preview" would read `--000000000000abc Content-Type: text/plain;`. The
 * structure is already in hand from the header fetch (BODYSTRUCTURE is one
 * of HEADER_FETCH_OPTIONS' existing fields), so resolving the real text
 * part costs no extra bytes and no extra round trip.
 *
 * Returns null when the message has no text part at all (a bare image, a
 * calendar invite with no text alternative) — the caller then skips the
 * fetch entirely rather than pulling bytes it cannot render.
 *
 * Never throws, for the same reason extractAttachments() does not: a cyclic
 * or absurdly wide structure is malformed input, not an exceptional
 * condition.
 */
export function firstTextPart(bodyStructure: unknown): TextPart | null {
  let htmlFallback: TextPart | null = null;

  const visited = new Set<object>();
  const stack: unknown[] = [bodyStructure];
  let nodeCount = 0;

  while (stack.length > 0) {
    const raw = stack.pop();
    if (typeof raw !== 'object' || raw === null) continue;
    if (visited.has(raw)) continue;
    visited.add(raw);

    nodeCount += 1;
    if (nodeCount > MAX_STRUCTURE_NODES) break;

    const node = raw as StructureNode;

    if (Array.isArray(node.childNodes) && node.childNodes.length > 0) {
      // Reversed so pop() yields children in document order — "first text
      // part" has to mean the first one the sender wrote, not whichever
      // one a LIFO happened to surface.
      for (let i = node.childNodes.length - 1; i >= 0; i -= 1) stack.push(node.childNodes[i]);
      continue;
    }

    // A text/plain part the sender attached as a FILE is not the body, and
    // showing readme.txt's first line as the message preview would be
    // wrong in exactly the way a reader would notice.
    if (!isTextNode(node) || node.disposition === 'attachment') continue;

    const part = toTextPart(node);
    if (part.mimeType === 'text/plain') return part;
    htmlFallback ??= part;
  }

  return htmlFallback;
}

// ---------------------------------------------------------------------------
// Content-Transfer-Encoding
// ---------------------------------------------------------------------------

/**
 * Decodes a base64 PREFIX. The fetch is deliberately partial, so the last
 * 4-character group is usually cut in half; base64 decoding stops making
 * sense at a non-multiple of 4, so the remainder is dropped rather than
 * decoded into a byte that was never sent. Non-alphabet bytes (the CRLFs
 * base64 bodies are wrapped at) are stripped first.
 */
function decodeBase64Prefix(raw: Buffer): string {
  const compact = raw.toString('ascii').replace(/[^A-Za-z0-9+/=]/g, '');
  const usable = compact.slice(0, compact.length - (compact.length % 4));
  return Buffer.from(usable, 'base64').toString('utf8');
}

/**
 * Decodes quoted-printable, the encoding Gmail uses for most text/plain
 * parts that contain any non-ASCII character at all (a single curly
 * apostrophe is enough).
 *
 * Decoded to BYTES first and only then read as UTF-8 — `=E2=80=99` is one
 * three-byte UTF-8 sequence, and turning each `=XX` straight into a
 * character would produce three mojibake characters instead of the
 * apostrophe the sender typed.
 */
function decodeQuotedPrintable(raw: Buffer): string {
  const text = raw.toString('latin1').replace(/=\r?\n/g, '');
  const bytes: number[] = [];

  for (let i = 0; i < text.length; i += 1) {
    const hex = text.slice(i + 1, i + 3);
    if (text[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
      continue;
    }
    bytes.push(text.charCodeAt(i) & 0xff);
  }

  return Buffer.from(bytes).toString('utf8');
}

/**
 * A partial fetch cuts at a byte boundary, which lands mid-sequence for
 * any multi-byte character often enough to matter; Buffer.toString('utf8')
 * renders that tail as U+FFFD. Dropping trailing replacement characters
 * keeps a stray black diamond off the end of every other preview.
 */
function trimTruncatedTail(text: string): string {
  return text.replace(/�+$/, '');
}

function decodeTransferEncoding(raw: Buffer, encoding: string | null): string {
  if (encoding === 'base64') return trimTruncatedTail(decodeBase64Prefix(raw));
  if (encoding === 'quoted-printable') return trimTruncatedTail(decodeQuotedPrintable(raw));
  // 7bit / 8bit / binary / unstated: the bytes are the text.
  return trimTruncatedTail(raw.toString('utf8'));
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/** The five XML/HTML entities plus the two that show up constantly in mail
 *  bodies. Deliberately not a full entity table: this is a preview, and an
 *  undecoded `&hellip;` is a cosmetic miss, not a correctness bug. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Unicode's highest code point. A numeric entity above it (or in the
 *  surrogate range) is not a character at all, and String.fromCodePoint
 *  THROWS on one — so a malformed `&#9999999;` in a hostile mail body
 *  would otherwise take down the whole preview. Left as literal text
 *  instead. */
const MAX_CODE_POINT = 0x10ffff;

function fromCodePoint(value: number, original: string): string {
  if (!Number.isInteger(value) || value < 0 || value > MAX_CODE_POINT) return original;
  if (value >= 0xd800 && value <= 0xdfff) return original;
  return String.fromCodePoint(value);
}

/**
 * Looks up a named entity WITHOUT consulting Object.prototype.
 *
 * A bare `NAMED_ENTITIES[name]` inherits from Object.prototype, so a
 * sender could write `&constructor;` in an HTML body and have
 * `function Object() { [native code] }` written into the stored,
 * searchable snippet — attacker-controlled text reaching a column the
 * user reads. (`&toString;` and `&hasOwnProperty;` happen to be saved
 * today only because `.toLowerCase()` mangles them into keys that are not
 * on the prototype; that is an accident of casing, not a guard.)
 *
 * Object.hasOwn closes the whole class rather than the one instance.
 */
function namedEntity(name: string, original: string): string {
  const key = name.toLowerCase();
  return Object.hasOwn(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key]! : original;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]{1,6});/gi, (match, hex: string) =>
      fromCodePoint(Number.parseInt(hex, 16), match))
    .replace(/&#(\d{1,7});/g, (match, digits: string) => fromCodePoint(Number(digits), match))
    .replace(/&([a-z]+);/gi, (match, name: string) => namedEntity(name, match));
}

/**
 * Crude tag stripping for an HTML FRAGMENT — not a parser, and not trying
 * to be one. The input is the first ~512 bytes of a text/html part, so it
 * is routinely cut in the middle of a tag, in the middle of a `<style>`
 * block, or before any of it closes; every rule below is written to cope
 * with that rather than to be correct HTML.
 *
 * `<script>`/`<style>` go first and take their CONTENT with them: an
 * HTML-only newsletter's first 512 bytes are very often nothing but a
 * stylesheet, and stripping only the tags would leave the CSS itself as
 * the "preview". The unterminated variants matter for the same reason —
 * the truncation point is usually inside that block.
 *
 * Entities are decoded LAST, after every tag is gone, so that a body
 * containing the text `&lt;b&gt;` cannot be turned into a tag and then
 * stripped as one.
 */
function stripHtmlFragment(html: string): string {
  const withoutBlocks = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(script|style)\b[\s\S]*$/i, ' ');

  const withBreaks = withoutBlocks
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)\s*>/gi, '\n');

  const withoutTags = withBreaks
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    // A tag the 512-byte cut left unterminated: without this the preview
    // ends in a half-written `<a href="https://…`.
    .replace(/<[^>]*$/, ' ');

  return decodeEntities(withoutTags);
}

// ---------------------------------------------------------------------------
// Quoted text and signatures
// ---------------------------------------------------------------------------

/** RFC 3676's signature separator is exactly `"-- "`, but enough clients
 *  (and enough transports, which strip trailing whitespace) emit a bare
 *  `--` that matching both is the only version that works on real mail.
 *  Everything from this line down is the signature block. */
const SIGNATURE_DELIMITER = /^--\s?$/;

/** A quoted line, in the one form every mail client agrees on. */
const QUOTED_LINE = /^\s*>/;

/** The attribution line a reply puts directly above the quoted block
 *  ("On Mon, 3 Aug 2026 at 16:12, Sarah Chen <sarah@example.com> wrote:").
 *  Only dropped when a quoted line actually follows it — see below. */
const QUOTE_ATTRIBUTION = /^\s*On\b.*\bwrote:\s*$/;

function nextNonEmptyLine(lines: readonly string[], from: number): string | null {
  for (let i = from; i < lines.length; i += 1) {
    const line = lines[i];
    if (line !== undefined && line.trim().length > 0) return line;
  }
  return null;
}

/**
 * Drops quoted text and the signature block so the preview shows what the
 * sender actually wrote this time, the way Gmail's does.
 *
 * Three rules, all deliberately crude:
 *  - a line beginning with `>` is quoted and goes;
 *  - `-- ` (or `--`) ends the message; everything after it is a signature;
 *  - an `On … wrote:` attribution goes ONLY when a quoted line follows it.
 *    Unconditional removal would eat a perfectly ordinary sentence that
 *    happened to end in "wrote:", and the guard costs one lookahead.
 *
 * A reply written UNDER the quote (bottom-posting) legitimately strips to
 * nothing — the first 512 bytes really are all quoted text. The caller
 * stores no snippet in that case, which is the honest answer and matches
 * what Gmail shows for the same message.
 */
function stripQuotedAndSignature(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;

    if (SIGNATURE_DELIMITER.test(line)) break;
    if (QUOTED_LINE.test(line)) continue;

    if (QUOTE_ATTRIBUTION.test(line)) {
      const following = nextNonEmptyLine(lines, i + 1);
      if (following !== null && QUOTED_LINE.test(following)) continue;
    }

    kept.push(line);
  }

  return kept.join('\n');
}

// ---------------------------------------------------------------------------
// Pre-header boilerplate
// ---------------------------------------------------------------------------
//
// Marketing mail routinely leads with chrome rather than content: a "View
// this email in your browser" fallback link, a "trouble viewing this
// email?" disclaimer, an unsubscribe/preferences block, a decorative run
// of dots or dashes drawn as a visual rule, or invisible padding
// characters some ESPs insert specifically to push their OWN hidden
// preheader text out past Gmail's ~100-character inbox preview window.
// None of that is what stripQuotedAndSignature above is for — there are
// no ">" lines and no "-- " delimiter — so it survives untouched into what
// was, before this section existed, the stored snippet.
//
// Every rule below is EDGE-anchored: it only ever removes a match that
// starts at the leading edge of the (remaining) text or ends at its
// trailing edge, never a match found by searching the middle. That is
// what lets "you can view in browser if that's easier" survive — "view in
// browser" sits in the middle of that sentence, with real words on both
// sides, so no edge-anchored rule ever reaches in that far to find it.

/**
 * Whitespace and the pipe/bullet/dash marks a template uses to visually
 * separate a pre-header phrase or a tracking link from real content, or
 * from the string's edge — e.g. the " — " between a marketer's custom
 * teaser and an auto-appended "View in browser" link, or the " | "
 * between short links in a footer.
 *
 * `\n` is deliberately whitespace here too: this runs on
 * stripQuotedAndSignature's output, which still has real line breaks in
 * it (collapsing them is normalize.ts's makeSnippet(), one step later), so
 * a phrase and a tracking link that a template put on separate lines of
 * the same hidden preheader div still read as adjacent.
 *
 * Deliberately NOT ".,!?:;" or quote marks, even though those often sit
 * right next to a stripped phrase too: sentence-terminal punctuation reads
 * as ending whatever comes BEFORE it, so letting stripTrailingBoilerplate
 * eat backwards through it would turn "Your invoice is attached. Having
 * trouble viewing this email?" into "Your invoice is attached" — correct
 * content, but with a real, complete, kept sentence's own final period
 * gone. Each phrase pattern that can legitimately be followed by "?" (see
 * LEADING_PHRASE_PATTERNS / TRAILING_PHRASE_PATTERNS) already spells that
 * out itself with a trailing `\??`, which only ever consumes a "?" that is
 * actually part of THAT match — a more precise tool than a generic glue
 * class for the one case that needed it.
 *
 * Consulted only to find where an ALREADY-matched phrase or URL begins or
 * ends (see stripLeadingBoilerplate / stripTrailingBoilerplate) — never to
 * strip glue on its own when nothing on the other side of it matched.
 * That distinction is what keeps a message that happens to start with an
 * em dash untouched when no boilerplate follows it.
 */
const EDGE_GLUE_CHARS = new Set(' \t\n\r\f\v|•·–—-');

function isGlueChar(ch: string): boolean {
  return EDGE_GLUE_CHARS.has(ch);
}

/** First index at or after `from` that is not a glue character. */
function skipGlueForward(text: string, from: number): number {
  let i = from;
  while (i < text.length && isGlueChar(text[i]!)) i += 1;
  return i;
}

/** One past the last index before `from` that is not a glue character. */
function skipGlueBackward(text: string, from: number): number {
  let i = from;
  while (i > 0 && isGlueChar(text[i - 1]!)) i -= 1;
  return i;
}

/** Whether `text` has anything in it worth showing — at least one letter
 *  or digit in any script. Used both to tell "pure separators/padding"
 *  input apart from real content, and to decide whether a bare URL has
 *  real content on the far side of it. */
function hasSubstance(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * Phrases stripped ONLY at the leading edge: a leading "Unsubscribe" /
 * "Manage preferences" / "Add us to your address book" block is dropped
 * unconditionally, but showing up mid-message is not credible for these
 * (nobody legitimately writes "unsubscribe" as a sentence) — restricting
 * them to leading position matches how every ESP template actually places
 * them, in the hidden preheader div before the real body, rather than
 * relying on that implausibility alone.
 */
const LEADING_ONLY_PHRASE_PATTERNS: readonly RegExp[] = [
  /^unsubscribe/i,
  /^manage\s+(?:your\s+|email\s+)?preferences/i,
  /^add\s+us\s+to\s+your\s+address\s+book/i,
];

/** The named pre-header phrases plus near variants, ^-anchored for
 *  leading use. Kept as an ARRAY of small independent patterns rather
 *  than one combined alternation on purpose: each is individually a
 *  short, linear, non-backtracking scan, so the worst case across all of
 *  them is additive, not the multiplicative blowup a mis-cast subgroup in
 *  one giant `(?:a|b|c|...)+` can produce by accident. */
const LEADING_PHRASE_PATTERNS: readonly RegExp[] = [
  /^view\s+(?:this\s+|the\s+)?(?:email|message)?\s*(?:online|in\s+(?:your\s+|a\s+)?browser)/i,
  /^(?:having\s+)?trouble\s+viewing\s+this\s+(?:email|message)\??/i,
  /^if\s+you\s+(?:cannot|can['’]?t)\s+(?:see|view|read)\s+this\s+(?:message|email)/i,
  /^can['’]?t\s+see\s+(?:the\s+)?images?\??/i,
  /^images?\s+not\s+display\w*\??/i,
  ...LEADING_ONLY_PHRASE_PATTERNS,
];

/** The same phrase family, $-anchored for trailing use — everything
 *  except the leading-only unsubscribe/preferences block above. */
const TRAILING_PHRASE_PATTERNS: readonly RegExp[] = [
  /view\s+(?:this\s+|the\s+)?(?:email|message)?\s*(?:online|in\s+(?:your\s+|a\s+)?browser)$/i,
  /(?:having\s+)?trouble\s+viewing\s+this\s+(?:email|message)\??$/i,
  /if\s+you\s+(?:cannot|can['’]?t)\s+(?:see|view|read)\s+this\s+(?:message|email)$/i,
  /can['’]?t\s+see\s+(?:the\s+)?images?\??$/i,
  /images?\s+not\s+display\w*\??$/i,
];

/** A "bare" URL: not the human-authored kind that would have been wrapped
 *  in an `<a>` the HTML strip above already unwrapped down to its link
 *  text, just "http(s):// then anything but whitespace or a quote/angle
 *  bracket" — the same greedy-until-a-clear-terminator shape web clients
 *  use, because a full RFC 3986 grammar is not worth it for a fragment
 *  this size (see the module doc for why this is hand-rolled at all). */
const LEADING_URL_PATTERN = /^https?:\/\/[^\s<>"']+/i;
const TRAILING_URL_PATTERN = /https?:\/\/[^\s<>"']+$/i;

/** Bounds the leading/trailing strip loops below. Real mail resolves in
 *  1-2 passes — a phrase, maybe a tracking URL right after it — so this
 *  is a generous backstop against a crafted input chaining many short
 *  matches, not a count expected to be reached in practice. Combined with
 *  each pass doing bounded, linear-in-the-remaining-text work, the loop
 *  as a whole stays O(iterations x text length) with a small constant
 *  iteration cap, never unbounded. */
const MAX_EDGE_STRIP_ITERATIONS = 8;

/** The LENGTH of the leading phrase match, if any — how far into `text`
 *  the match reaches, since it always starts at index 0 by construction
 *  (every pattern in LEADING_PHRASE_PATTERNS is `^`-anchored). */
function matchLeadingPhrase(text: string): number | null {
  for (const pattern of LEADING_PHRASE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match[0].length;
  }
  return null;
}

/** The START INDEX of the trailing phrase match, if any — where in `text`
 *  it begins, since it always reaches the end by construction (every
 *  pattern in TRAILING_PHRASE_PATTERNS is `$`-anchored). That start index
 *  is also exactly the boundary stripTrailingBoilerplate needs: everything
 *  before it is kept, everything from it onward is the phrase. */
function matchTrailingPhrase(text: string): number | null {
  for (const pattern of TRAILING_PHRASE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match.index;
  }
  return null;
}

/**
 * Repeatedly removes a recognized pre-header phrase, or a leading bare
 * URL, from the front of `text`. A phrase is dropped unconditionally —
 * "view in browser" is never legitimate standalone content — but a
 * leading URL is dropped only when real text remains after it, so
 * "here's the link: https://…", where the URL IS the message, survives
 * untouched.
 *
 * Stops the moment nothing matches at the current leading edge. That is
 * what makes this leading-ANCHORED rather than a global search: whatever
 * remains from that point on, matching or not, is left alone rather than
 * scanned into.
 */
function stripLeadingBoilerplate(text: string): string {
  let result = text;

  for (let i = 0; i < MAX_EDGE_STRIP_ITERATIONS; i += 1) {
    const bodyStart = skipGlueForward(result, 0);
    const candidate = result.slice(bodyStart);

    const phraseLen = matchLeadingPhrase(candidate);
    if (phraseLen !== null) {
      result = result.slice(skipGlueForward(result, bodyStart + phraseLen));
      continue;
    }

    const urlMatch = LEADING_URL_PATTERN.exec(candidate);
    if (urlMatch) {
      const afterUrl = result.slice(skipGlueForward(result, bodyStart + urlMatch[0].length));
      if (!hasSubstance(afterUrl)) break; // the URL IS the message; keep it
      result = afterUrl;
      continue;
    }

    break;
  }

  return result;
}

/** Mirror of stripLeadingBoilerplate, anchored to the trailing edge
 *  instead: a recognized phrase or a trailing bare URL is peeled off the
 *  back of `text` for as long as one keeps matching. No unsubscribe /
 *  preferences pattern here — that block is leading-only, see
 *  LEADING_ONLY_PHRASE_PATTERNS. */
function stripTrailingBoilerplate(text: string): string {
  let result = text;

  for (let i = 0; i < MAX_EDGE_STRIP_ITERATIONS; i += 1) {
    const bodyEnd = skipGlueBackward(result, result.length);
    const candidate = result.slice(0, bodyEnd);

    const phraseStart = matchTrailingPhrase(candidate);
    if (phraseStart !== null) {
      result = result.slice(0, skipGlueBackward(result, phraseStart));
      continue;
    }

    const urlMatch = TRAILING_URL_PATTERN.exec(candidate);
    if (urlMatch) {
      const beforeUrl = result.slice(0, skipGlueBackward(result, urlMatch.index));
      if (!hasSubstance(beforeUrl)) break; // the URL IS the message; keep it
      result = beforeUrl;
      continue;
    }

    break;
  }

  return result;
}

/** Visual-rule and padding characters a template repeats to draw a
 *  separator line, or to push a hidden second preheader past Gmail's
 *  inbox preview window: ASCII separator punctuation, non-breaking space,
 *  and the zero-width family (word joiner, ZWSP/ZWNJ/ZWJ, the BOM). 4+ IN
 *  A ROW — in any combination, not necessarily the same character twice,
 *  since the padding trick some ESPs use alternates two of these — is the
 *  threshold: a real ellipsis is 3 dots and RFC 3676's signature
 *  delimiter is exactly "--", so this can never reach either. Replaced
 *  with a single space rather than deleted outright, so the words on
 *  either side of a removed rule do not glue together. */
const NOISE_CHAR_RUN = /[.\-_=\u00A0\u200B\u200C\u200D\u2060\uFEFF]{4,}/g;

/**
 * Strips marketing pre-header chrome that survives HTML- and
 * quote/signature-stripping: "view this email in your browser" fallback
 * links, "trouble viewing this email" disclaimers, leading unsubscribe /
 * preference-centre blocks, decorative separator runs, invisible padding
 * characters, and a bare tracking URL adjacent to real content. Gmail's
 * inbox strips exactly this class of text from its preview line; this is
 * aimed at the same bar.
 *
 * Under-strips ON PURPOSE. If every rule above still leaves nothing, the
 * ORIGINAL `text` — not the noise-collapsed intermediate — is returned
 * instead, on the theory that a preview showing slightly awkward real
 * text (even an unstripped "View in browser", in the degenerate case
 * where that is genuinely all there was) beats one that ate the actual
 * message. The one exception: if `text` had no letters or digits in it AT
 * ALL, it really was only separators and invisible padding, and '' is the
 * honest answer — previewTextFrom's caller already treats '' as "no
 * snippet" for an entirely-quoted reply, so this reuses that contract
 * rather than inventing a second one.
 */
function stripPreheaderBoilerplate(text: string): string {
  const withoutNoise = text.replace(NOISE_CHAR_RUN, ' ');
  if (!hasSubstance(withoutNoise)) return '';

  const stripped = stripTrailingBoilerplate(stripLeadingBoilerplate(withoutNoise));
  return hasSubstance(stripped) ? stripped : text;
}

/**
 * The whole pipeline: raw partial-fetch bytes -> decoded text -> plain text
 * -> new content only -> pre-header chrome gone. The result still carries
 * line breaks and runs of whitespace; normalize.ts's makeSnippet() is what
 * collapses those and applies SNIPPET_CHARS. Keeping the two apart is
 * load-bearing rather than stylistic — collapsing whitespace first would
 * destroy the line structure every quoting, signature and pre-header rule
 * above depends on.
 *
 * Pre-header stripping runs AFTER quote/signature stripping, not before:
 * it needs only look at text already confirmed to be this message's own
 * new content, which is both less text to scan and means a quoted line or
 * a signature block that is about to be deleted anyway can never be
 * mistaken for a pre-header phrase. It runs AFTER HTML stripping for the
 * more obvious reason that `<a>View in browser</a>` has to become the
 * text "View in browser" before a text-level rule can see it at all.
 *
 * Returns '' when nothing survives (an all-quoted fragment, an HTML part
 * whose first 512 bytes were entirely stylesheet, a pre-header that was
 * only separators and invisible padding); the caller treats that as "no
 * snippet" rather than storing an empty string.
 */
export function previewTextFrom(raw: Buffer, part: TextPart): string {
  const decoded = decodeTransferEncoding(raw, part.encoding);
  const plain = part.mimeType === 'text/html' ? stripHtmlFragment(decoded) : decoded;
  const newContent = stripQuotedAndSignature(plain);
  return stripPreheaderBoilerplate(newContent).trim();
}
