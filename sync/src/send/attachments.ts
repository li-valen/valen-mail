/**
 * Plan 11 Task 1 — spec §5.3.1's attachment multiplication rule, and
 * nothing else yet.
 *
 * This module performs no I/O, reads no config and knows nothing about
 * MIME. That is deliberate, and it is the whole reason the file exists
 * before any nodemailer code does: §5.3.1 is BINDING, and a binding rule
 * whose decision is tangled up with a MIME builder is a rule that gets
 * quietly re-derived every time the builder is refactored.
 */

/**
 * The point of the rule, stated once so nobody has to reconstruct it from
 * the arithmetic.
 *
 * Postbox sends ONE tokenized copy per recipient (spec §5.3) — that is
 * what makes "Kate opened this" true rather than "someone opened this".
 * Gmail files every one of those copies into Sent and the client cannot
 * suppress it, so a message with an attachment costs the sending account
 * `attachmentBytes x recipientCount` of a 15 GB quota, not
 * `attachmentBytes`. A 10 MB deck to five people is 50 MB.
 *
 * Above the budget the message therefore falls back to a SINGLE SHARED
 * TOKEN: one token in every copy, so the attachment is still stored N
 * times by Gmail but the product stops claiming per-person attribution it
 * would be spending the quota to buy. Attribution degrades to "someone
 * opened" and the composer says so BEFORE the send, while the user can
 * still decide (§7A.2) — see client/src/attachmentPicker.ts.
 *
 * 25 MB is Gmail's own per-message attachment ceiling, which makes it the
 * largest number that can ever be a single legitimate send, and 0.17% of
 * the free quota — small enough that a user who ignores the notice every
 * time still has to do it hundreds of times to notice.
 */
export const TRACKED_SEND_BYTE_BUDGET = 25 * 1024 * 1024;

/**
 * `'per-recipient'` — one token each, full attribution (spec §5.3).
 * `'shared'`        — one token for the whole message, "someone opened".
 */
export type TokenStrategy = 'per-recipient' | 'shared';

/**
 * The §5.3.1 decision: does this message's attachment weight, MULTIPLIED
 * by the number of copies that will actually be sent, exceed the budget?
 *
 * THE MULTIPLIER IS THE RULE. Comparing `attachmentBytes` alone would
 * pass every case a naive size check was ever going to catch and miss the
 * only one that matters — a file well under any per-message limit, sent
 * to enough people to cost several times its own size. sync/tests/
 * send-attachments.test.ts mutation-checks exactly that: drop
 * `* recipientCount` and "degrades once the MULTIPLIED size exceeds the
 * budget" fails.
 *
 * EXCLUSIVE at the boundary — a message landing on exactly the budget is
 * allowed. The budget is the largest acceptable cost, not the first
 * unacceptable one, and `>=` would make the constant read as one number
 * while behaving as one byte less.
 *
 * `attachmentBytes` is DECODED bytes, at this hop and every other one.
 * Base64 inflates by 4/3, so feeding this the encoded length would
 * degrade messages 33% earlier than the spec says and make the constant a
 * lie about what it enforces.
 *
 * Zero attachments always yield `'per-recipient'`: a plain text message
 * has nothing to multiply, and degrading it would throw away attribution
 * for no saving whatsoever. That falls out of the arithmetic rather than
 * being special-cased, and the test pins it so it stays that way.
 */
export function chooseTokenStrategy(
  attachmentBytes: number,
  recipientCount: number,
): TokenStrategy {
  return attachmentBytes * recipientCount > TRACKED_SEND_BYTE_BUDGET
    ? 'shared'
    : 'per-recipient';
}

/**
 * The recipient address recorded against a SHARED token.
 *
 * A shared token is minted once for the whole message, so there is no
 * person to attribute it to — and tracking's mint route requires a
 * non-empty `recipientEmail` on every send. Writing the first recipient's
 * address there would be the exact lie §7A.2 forbids: the product would
 * report "Kate opened this" on evidence that says only that somebody did.
 *
 * So the honest value goes in instead, and it is a WORD rather than an
 * address on purpose. Everything downstream already renders this field
 * verbatim — the opens feed says `{recipientEmail} opened "{subject}"`,
 * push says `{recipientEmail} opened your mail` — so a shared-token open
 * reads as "someone opened …" with no change to the tracking service, the
 * opens route, or the feed. The degraded state renders itself.
 *
 * It cannot collide with a real recipient: it has no `@`, so
 * ../addresses.ts's own-address comparison never matches it and a shared
 * open is counted as a genuine recipient open rather than suppressed as
 * the sender reading their own Sent copy. The follow-up tally then
 * reports ONE distinct opener however many people actually opened, which
 * under-claims rather than over-claims — the only direction §7A.2 permits
 * uncertainty to fall.
 */
export const SHARED_TOKEN_RECIPIENT = 'someone';

/** How many files may ride on one message. Ten is past any message a
 *  person composes by hand, and few enough that the per-attachment
 *  metadata stays a rounding error against the payload. */
export const MAX_ATTACHMENT_COUNT = 10;

/**
 * Total DECODED attachment bytes on one message — 10 MiB.
 *
 * Deliberately BELOW Gmail's own 25 MB per-message ceiling, and the
 * reason is memory rather than mail. ../api/server.ts buffers a request
 * body whole before this route sees it, so this number sets what an
 * authenticated caller can make this process hold: at 10 MiB decoded the
 * transport reserve lands at 16 MiB (see MAX_SEND_REQUEST_BODY_BYTES),
 * and the 30-per-hour send cap bounds the pessimistic case where all 30
 * are in flight at once at 480 MiB — large, but survivable on this box.
 * At Gmail's 25 MB the same arithmetic is 1.2 GB, which is not.
 *
 * DECODED, not base64. The wire carries base64, which is 4/3 the size;
 * capping the encoded length instead would make this constant claim 10
 * MiB while enforcing 7.5.
 */
export const MAX_ATTACHMENT_TOTAL_BYTES = 10 * 1024 * 1024;

/** One filename. 255 is the limit every filesystem a recipient might save
 *  this onto shares, so a name that fits here fits where it lands. */
export const MAX_ATTACHMENT_FILENAME_CHARS = 255;

/** One media type. Far past `application/vnd.openxmlformats-…`, which is
 *  the longest type anybody actually attaches. */
export const MAX_ATTACHMENT_CONTENT_TYPE_CHARS = 255;

/** Below this code point are the C0 controls, CR and LF among them. */
const FIRST_PRINTABLE_CODE_POINT = 0x20;
/** DEL, the one control character above the printable range. */
const DELETE_CODE_POINT = 0x7f;

/**
 * True when a filename carries a character it may never carry.
 *
 * TWO distinct dangers, checked together because they arrive in the same
 * field:
 *
 *  1. C0 controls and DEL. The name becomes a `Content-Disposition`
 *     parameter, and a CR or LF there TERMINATES the header — everything
 *     after it becomes a header of the caller's choosing, `Bcc:` being
 *     the one that matters, since it copies the user's mail somewhere
 *     they never asked for. Nodemailer would encode these; a boundary
 *     check must not depend on the library behind it, which is the same
 *     call ../api/send.ts already made for recipients and subjects.
 *  2. Both path separators. `/` and `\` are what turn a filename into a
 *     path, and every mail client and every future piece of code that
 *     writes this file down is a place where `../../etc/passwd` could
 *     escape the directory it was meant for. Nothing legitimate needs a
 *     separator in a filename: the name is a leaf, by definition.
 *
 * Written as a code-point walk rather than a character class because the
 * range this refuses is most of what a regex would have to spell in
 * escapes, and an escape typo in a security check fails open silently.
 */
function hasUnsafeFilenameCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < FIRST_PRINTABLE_CODE_POINT || codePoint === DELETE_CODE_POINT) return true;
    if (character === '/' || character === '\\') return true;
  }
  return false;
}

/**
 * A filename made of nothing but dots — `.` and `..` themselves.
 *
 * No separator for the rule above to catch, and yet these ARE the
 * traversal tokens. Refused rather than rewritten, for the same reason
 * every other malformed field here is: a silently renamed attachment is
 * indistinguishable from a working one until the recipient cannot find
 * the file.
 */
const DOTS_ONLY_FILENAME = /^\.+$/;

/**
 * A conservative `type/subtype`, and nothing else.
 *
 * RFC 6838's restricted-name grammar, minus parameters: no `; charset=`,
 * no quoted strings, no whitespace. Parameters are where a media type
 * stops being a token and starts being a small language, and this route
 * has no use for one — nodemailer sets the transfer encoding itself, and
 * a charset on an attachment is decoration.
 *
 * The value is never echoed raw anywhere: it reaches nodemailer only
 * after matching this, so what lands in the `Content-Type` header is by
 * construction a bare token pair with no separator, control character or
 * delimiter in it.
 */
const CONTENT_TYPE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;

/**
 * Anything outside the standard base64 alphabet and its padding
 * character.
 *
 * A single negated character class with NO quantifier and no group,
 * deliberately. The obvious way to write this check is
 * `/^(?:[A-Za-z0-9+/]{4})*(?:..)?$/` — and that expression overflows
 * V8's stack on a multi-megabyte input, which this field is by design.
 * It was written that way first and `parseAttachments` threw a
 * RangeError on a payload at the size cap, which would have escaped the
 * route as a 500 on a request an attacker controls the length of. A
 * repetition over the whole string is not something a validator applied
 * to megabytes may contain.
 *
 * Standard alphabet only: `-`/`_` are the URL-safe variant, which no
 * `FileReader` produces and which `Buffer` decodes to different bytes.
 * Whitespace is refused rather than stripped for the same reason — a
 * payload carrying newlines inside its base64 is not one this client
 * sent.
 */
const NON_BASE64_CHARACTER = /[^A-Za-z0-9+/=]/;

/**
 * Canonical base64: whole 4-character groups, with at most one correctly
 * padded tail of one or two `=`.
 *
 * REQUIRED, because `Buffer.from(value, 'base64')` does not fail. It
 * silently discards every character outside the alphabet and decodes
 * whatever is left, so `'not!base64'` becomes six bytes of garbage rather
 * than an error — a corrupt file the recipient cannot open, sent with no
 * error raised anywhere in the system. That is precisely the partial send
 * this validation exists to make impossible.
 *
 * Three linear passes and no allocation over the payload itself: a length
 * check, one scan for a foreign character, and a look at the two-byte
 * tail. See NON_BASE64_CHARACTER for why it is not one regex.
 */
function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  if (NON_BASE64_CHARACTER.test(value)) return false;

  const firstPad = value.indexOf('=');
  if (firstPad === -1) return true;

  const padLength = value.length - firstPad;
  if (padLength === 1) return true;
  return padLength === 2 && value.endsWith('==');
}

/** One attachment as it arrives in the JSON send body. */
export interface SendAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly contentBase64: string;
}

/** One attachment as nodemailer takes it: bytes, not text. */
export interface DecodedAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Buffer;
}

/**
 * Why an attachment list was refused. A CODE, never the value that
 * failed: the route logs this, and the value is a filename the user
 * chose.
 */
export type AttachmentRejection =
  | 'not_a_list'
  | 'too_many'
  | 'malformed_entry'
  | 'unsafe_filename'
  | 'unsupported_content_type'
  | 'undecodable_content'
  | 'too_large';

export type AttachmentParse =
  | {
      readonly ok: true;
      readonly attachments: readonly DecodedAttachment[];
      /** DECODED bytes, summed — what chooseTokenStrategy must be fed. */
      readonly totalBytes: number;
    }
  | { readonly ok: false; readonly reason: AttachmentRejection };

const NO_ATTACHMENTS: AttachmentParse = { ok: true, attachments: [], totalBytes: 0 };

function isUsableFilename(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_ATTACHMENT_FILENAME_CHARS &&
    !hasUnsafeFilenameCharacter(value) &&
    !DOTS_ONLY_FILENAME.test(value)
  );
}

function isUsableContentType(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_ATTACHMENT_CONTENT_TYPE_CHARS &&
    CONTENT_TYPE_PATTERN.test(value)
  );
}

/**
 * Validates and decodes the `attachments` field of a send request.
 *
 * ABSENT IS NOT AN ERROR — a missing or null field is an empty list, so
 * every message this product sent before Plan 11 takes exactly the path
 * it always did. Requiring the field instead would break every client
 * that has not shipped yet.
 *
 * Refuses the WHOLE list on any single bad entry. There is no partial
 * accept, deliberately: a send that quietly dropped one of three files
 * would look successful to the sender and arrive incomplete to the
 * recipient, which is worse than a refusal while somebody is watching.
 *
 * Never throws, and never mutates its argument.
 */
export function parseAttachments(value: unknown): AttachmentParse {
  if (value === undefined || value === null) return NO_ATTACHMENTS;
  if (!Array.isArray(value)) return { ok: false, reason: 'not_a_list' };
  if (value.length === 0) return NO_ATTACHMENTS;
  if (value.length > MAX_ATTACHMENT_COUNT) return { ok: false, reason: 'too_many' };

  const decoded: DecodedAttachment[] = [];
  let totalBytes = 0;

  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: 'malformed_entry' };
    }
    const record = entry as Record<string, unknown>;

    if (!isUsableFilename(record.filename)) return { ok: false, reason: 'unsafe_filename' };
    if (!isUsableContentType(record.contentType)) {
      return { ok: false, reason: 'unsupported_content_type' };
    }

    const contentBase64 = record.contentBase64;
    if (typeof contentBase64 !== 'string' || !isCanonicalBase64(contentBase64)) {
      return { ok: false, reason: 'undecodable_content' };
    }

    const content = Buffer.from(contentBase64, 'base64');
    totalBytes += content.length;
    // Checked inside the loop rather than after it, so a hostile list
    // stops allocating the moment it is over budget instead of decoding
    // all ten entries and only then deciding they were too big.
    if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) return { ok: false, reason: 'too_large' };

    decoded.push({ filename: record.filename, contentType: record.contentType, content });
  }

  return { ok: true, attachments: decoded, totalBytes };
}
