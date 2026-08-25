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

/**
 * The whole pipeline: raw partial-fetch bytes -> decoded text -> plain text
 * -> new content only. The result still carries line breaks and runs of
 * whitespace; normalize.ts's makeSnippet() is what collapses those and
 * applies SNIPPET_CHARS. Keeping the two apart is load-bearing rather than
 * stylistic — collapsing whitespace first would destroy the line structure
 * every quoting and signature rule above depends on.
 *
 * Returns '' when nothing survives (an all-quoted fragment, an HTML part
 * whose first 512 bytes were entirely stylesheet); the caller treats that
 * as "no snippet" rather than storing an empty string.
 */
export function previewTextFrom(raw: Buffer, part: TextPart): string {
  const decoded = decodeTransferEncoding(raw, part.encoding);
  const plain = part.mimeType === 'text/html' ? stripHtmlFragment(decoded) : decoded;
  return stripQuotedAndSignature(plain).trim();
}
