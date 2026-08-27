/**
 * Every decision the composer's attachment row makes, as pure functions.
 *
 * A sibling of ./components/composeValidation.ts and ./followupCopy.ts,
 * and for the same reason both of those exist: client/CLAUDE.md's
 * standing constraint is that no test in this client renders a component,
 * so anything that lives inside JSX is a rule nothing can assert. The
 * size accounting, spec §5.3.1's degrade predicate and every word of the
 * copy live here; components/Compose.tsx is left with layout.
 *
 * THE VOICE, from the user's own direction: "i dont need any liek side
 * notes." Nothing below explains how the product works. The notice says
 * what the user will see instead — and it says it BEFORE the send, while
 * they can still remove a file or a recipient.
 */

/**
 * sync/src/send/attachments.ts TRACKED_SEND_BYTE_BUDGET — 25 MB.
 *
 * A DUPLICATE of a server constant, like every number in
 * ./components/composeValidation.ts, and the duplication is the point:
 * the server decides, and this is what lets the composer say so in
 * advance instead of the user finding out afterwards. If one side moves
 * and the other does not, the composer promises one thing and the route
 * does another — tests/attachment-picker.test.ts pins the value so that
 * drift fails there rather than in front of the user.
 */
export const TRACKED_SEND_BYTE_BUDGET = 25 * 1024 * 1024;

/** sync/src/send/attachments.ts MAX_ATTACHMENT_COUNT. */
export const MAX_ATTACHMENT_COUNT = 10;

/** sync/src/send/attachments.ts MAX_ATTACHMENT_TOTAL_BYTES — DECODED
 *  bytes, which is exactly what `File.size` reports. */
export const MAX_ATTACHMENT_TOTAL_BYTES = 10 * 1024 * 1024;

/** sync/src/send/attachments.ts MAX_ATTACHMENT_FILENAME_CHARS. */
export const MAX_ATTACHMENT_FILENAME_CHARS = 255;

/** What the route accepts as a media type: a bare `type/subtype`, no
 *  parameters. sync/src/send/attachments.ts CONTENT_TYPE_PATTERN. */
const CONTENT_TYPE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;

/** The type a file gets when the browser could not work one out — `File.type`
 *  is the empty string for an unrecognised extension, and the route needs a
 *  real one. */
const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

/** Below this code point are the C0 controls, CR and LF among them. */
const FIRST_PRINTABLE_CODE_POINT = 0x20;
const DELETE_CODE_POINT = 0x7f;

const DOTS_ONLY_FILENAME = /^\.+$/;

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * 1024;

/** One file the user has picked, in the only shape this module needs.
 *  Compose.tsx keeps the real `File` alongside it. */
export interface PickedFile {
  readonly id: string;
  readonly name: string;
  /** DECODED bytes — `File.size`, never a base64 length. */
  readonly size: number;
  readonly type: string;
}

/** Only `size` is read, so every predicate below works on a bare shape as
 *  well as on a PickedFile. */
type Sized = { readonly size: number };

/** Total DECODED bytes across the picked files.
 *
 *  DECODED is not a detail. The wire carries base64, which is 4/3 the
 *  size, and feeding the encoded length into the budget below would make
 *  the notice fire 33% early — on messages that would have kept full
 *  attribution. */
export function totalBytes(files: readonly Sized[]): number {
  return files.reduce((sum, file) => sum + file.size, 0);
}

/**
 * SPEC §5.3.1 — will this send lose per-person attribution?
 *
 * Valen Mail sends one copy per recipient, so the attachments cost
 * `bytes x recipients`, not `bytes`. A 10 MB deck to five people is
 * 50 MB. Above the budget the send falls back to a single shared marker
 * and the message can no longer say WHO opened it — only that somebody
 * did.
 *
 * THE MULTIPLIER IS THE RULE, and the same comparison
 * sync/src/send/attachments.ts's `chooseTokenStrategy` makes. A predicate
 * that looked at the file size alone would stay silent on exactly the
 * case this exists for: an ordinary attachment sent to an ordinary number
 * of people.
 *
 * Exclusive at the boundary, matching the server: a message landing on
 * exactly the budget keeps its attribution.
 */
export function willDegradeTracking(
  files: readonly Sized[],
  recipientCount: number,
): boolean {
  return totalBytes(files) * recipientCount > TRACKED_SEND_BYTE_BUDGET;
}

/**
 * What the composer says when tracking is about to degrade.
 *
 * ONE SHORT SENTENCE, and it is shown BEFORE the send while the user can
 * still drop a file or a recipient — spec §7A.2 requires the honest state
 * to be visible at the moment it can still be acted on, not reported
 * afterwards.
 *
 * It names the CONSEQUENCE and stops. No token, no pixel, no quota, no
 * explanation of why one copy per person costs what it costs — the user's
 * standing direction is that they do not want the side notes, and
 * tests/attachment-picker.test.ts asserts none of those words appear.
 *
 * "someone", never a name: that is precisely what the degraded state can
 * support, and naming a person on this evidence is the overclaim this
 * product exists to refuse.
 */
export function degradationNotice(): string {
  return 'Too much attached for this many people — you’ll see that someone opened this, not who.';
}

/**
 * True when a filename is one the route will accept.
 *
 * Mirrors sync/src/send/attachments.ts's own guard: no C0 control (a CR
 * or LF would break the header the name lands in), no path separator, not
 * a bare `.` or `..`, not blank, not over-long.
 *
 * A browser will not normally produce any of these, so this is FEEDBACK
 * rather than defence — the server is the only thing that decides. What
 * it buys is that a file which cannot be sent says so beside the file,
 * instead of coming back as an opaque refusal after the user pressed
 * Send.
 *
 * Refused, never rewritten. A silently renamed attachment looks like a
 * working one until the recipient cannot find what they were promised.
 */
export function isSendableFilename(name: string): boolean {
  if (name.trim().length === 0) return false;
  if (name.length > MAX_ATTACHMENT_FILENAME_CHARS) return false;
  if (DOTS_ONLY_FILENAME.test(name)) return false;
  for (const character of name) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < FIRST_PRINTABLE_CODE_POINT || codePoint === DELETE_CODE_POINT) return false;
    if (character === '/' || character === '\\') return false;
  }
  return true;
}

/**
 * The media type to send for a picked file.
 *
 * `File.type` is the empty string whenever the browser cannot map the
 * extension, and it can carry a `; charset=` parameter the route refuses.
 * Both become the generic binary type rather than a 400 on an otherwise
 * ordinary file — the type is a hint to the recipient's mail client, so
 * guessing generically is a smaller harm than refusing to attach.
 */
export function contentTypeFor(type: string): string {
  const bare = type.split(';')[0]?.trim() ?? '';
  return CONTENT_TYPE_PATTERN.test(bare) ? bare : FALLBACK_CONTENT_TYPE;
}

/**
 * The base64 payload out of a `FileReader.readAsDataURL` result.
 *
 * `readAsDataURL` always produces `data:{type};base64,{payload}`, and an
 * EMPTY file produces that with nothing after the comma — which is a
 * valid zero-byte attachment, not a failure, so `''` is a real answer and
 * null is reserved for a URL that carried no base64 marker at all.
 */
export function base64FromDataUrl(dataUrl: string): string | null {
  const marker = ';base64,';
  const at = dataUrl.indexOf(marker);
  if (at === -1 || !dataUrl.startsWith('data:')) return null;
  return dataUrl.slice(at + marker.length);
}

/**
 * A size as a person would say it: `512 B`, `1.5 KB`, `10 MB`.
 *
 * One decimal at most, and never a trailing `.0` — "2.0 MB" reads as a
 * measurement, "2 MB" reads as a fact. Total on nonsense input (NaN, a
 * negative) rather than throwing, the same discipline
 * ./components/inboxDates.ts applies to timestamps: one bad file must not
 * blank the whole row.
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < BYTES_PER_KB) return `${Math.round(bytes)} B`;

  const [value, unit] =
    bytes < BYTES_PER_MB ? [bytes / BYTES_PER_KB, 'KB'] : [bytes / BYTES_PER_MB, 'MB'];
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ${unit}`;
}

/**
 * The one thing wrong with this list, or undefined when nothing is.
 *
 * Mirrors the route's caps so the user hears about them beside the files
 * rather than as a refusal after pressing Send (the route answers one
 * fixed string for every malformed body, deliberately, because the body
 * is a recipient list). Names the limit, never the machinery.
 *
 * Order is deliberate: count, then size, then the individual filenames.
 * The first two are about the list as a whole and are what a user is most
 * likely to have done; a bad filename is vanishingly rare from a real
 * file picker and would be noise ahead of them.
 */
export function attachmentError(files: readonly PickedFile[]): string | undefined {
  if (files.length > MAX_ATTACHMENT_COUNT) {
    return `You can attach up to ${MAX_ATTACHMENT_COUNT} files.`;
  }
  if (totalBytes(files) > MAX_ATTACHMENT_TOTAL_BYTES) {
    // "more than", not "up to", and the wording is load-bearing rather
    // than stylistic. Found in the browser: a 10 MiB file plus a 1.5 KB
    // one is over the cap by a rounding error, so the running total beside
    // it reads "10 MB" and a message saying the limit is "10 MB" looks
    // like the app contradicting itself. No rounding can separate those
    // two numbers on screen — the sentence has to.
    return `These add up to more than ${formatFileSize(MAX_ATTACHMENT_TOTAL_BYTES)}, which is all Valen Mail can attach.`;
  }
  const unsendable = files.find((file) => !isSendableFilename(file.name));
  if (unsendable) return 'One of these files has a name Valen Mail cannot send.';
  return undefined;
}

/** True when two picks are the same file — same name, same size. Two
 *  genuinely different files can collide here, which is why the size is
 *  part of it; a false match would silently drop an attachment. */
function isSamePick(left: PickedFile, right: PickedFile): boolean {
  return left.name === right.name && left.size === right.size;
}

/**
 * Adds newly picked files to the list, skipping ones already there.
 *
 * Picking a file, reopening the picker and picking it again is an
 * ordinary slip, and two copies of one attachment is never what was
 * meant. Returns a NEW array; the input is only read.
 */
export function mergePicked<T extends PickedFile>(
  existing: readonly T[],
  incoming: readonly T[],
): readonly T[] {
  const added = incoming.filter(
    (candidate) => !existing.some((already) => isSamePick(already, candidate)),
  );
  return [...existing, ...added];
}

/** Removes one file by index. Returns a NEW array, and is a no-op for an
 *  index that is not there. */
export function withoutPickedAt<T extends PickedFile>(
  files: readonly T[],
  index: number,
): readonly T[] {
  if (index < 0 || index >= files.length) return [...files];
  return files.filter((_, position) => position !== index);
}
