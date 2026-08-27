import { isValidRecipient } from './composeRecipients';

/**
 * The composer's client-side mirror of every cap POST /api/send enforces
 * (sync/src/api/send.ts).
 *
 * THIS IS NOT DEFENCE — the server validates its own boundary and is the
 * only thing that decides what gets sent. It is FEEDBACK. That route
 * answers one fixed string, `{"error":"invalid request body"}`, for every
 * malformed body, deliberately: it must never echo a recipient list or a
 * subject back into a log or an error message. Which means without this
 * file the user's only signal for a subject two characters too long is an
 * opaque 400 that names nothing at all.
 *
 * Every constant below is therefore a DUPLICATE of a server constant, and
 * the duplication is the point — but it is also the risk. If one side
 * moves and the other does not, a draft the composer says is fine comes
 * back a 400. client/tests/compose-validation.test.ts checks each
 * threshold at the boundary and one past it so a drift fails there rather
 * than in front of the user.
 */

/** sync/src/api/send.ts MAX_SUBJECT_CHARS. */
export const MAX_SUBJECT_CHARS = 500;

/**
 * sync/src/api/send.ts MAX_TEXT_BODY_BYTES — 100 KiB of BODY, measured in
 * UTF-8 BYTES rather than characters. A cap counted in `String.length`
 * lets 100,000 four-byte emoji through as a ~400 KB message, four times
 * the limit anyone reading the number would expect.
 */
export const MAX_TEXT_BODY_BYTES = 100 * 1024;

/** sync/src/api/send.ts MAX_RECIPIENTS — To and Cc TOGETHER. Each
 *  recipient costs one minted token and one SMTP send, so the cap is on
 *  the total, never per field. */
export const MAX_RECIPIENTS = 25;

/** sync/src/api/send.ts MAX_IDENTITY_ID_CHARS. */
export const MAX_IDENTITY_ID_CHARS = 64;

/** A CR or an LF anywhere in the subject — the server refuses both. */
const SUBJECT_LINE_BREAK = /[\r\n]/;

/** One compose action, as the user has it on screen. */
export interface ComposeDraft {
  readonly identityId: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  readonly textBody: string;
}

/**
 * Per-field messages. An absent key means that field is fine.
 *
 * `recipients` is deliberately its own key rather than being folded into
 * `to` or `cc`: the combined-total cap belongs to neither field on its
 * own (13 in To plus 13 in Cc is over, and neither field is over), so
 * blaming one of them would be a lie the user then tries to act on.
 */
export interface ComposeErrors {
  readonly identityId?: string;
  readonly to?: string;
  readonly cc?: string;
  readonly recipients?: string;
  readonly subject?: string;
  readonly textBody?: string;
}

export interface ComposeValidation {
  readonly isValid: boolean;
  readonly errors: ComposeErrors;
}

/**
 * UTF-8 byte length, via the platform's own encoder rather than a
 * hand-rolled code-point walk. `TextEncoder` is a global in every browser
 * this app runs in and in Node, so this needs no dependency and no
 * `Buffer` (which would drag in @types/node, outside this project's fixed
 * dependency list).
 */
export function textBodyBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Names the count, never the addresses. The offending chips are already
 *  marked on screen — that is the "which"; this is the "what is wrong". */
function invalidAddressMessage(count: number): string {
  return count === 1
    ? 'One address is not usable. Fix or remove the highlighted chip.'
    : `${count} addresses are not usable. Fix or remove the highlighted chips.`;
}

/** Every entry of `addresses` that would not survive the server's own
 *  recipient check. */
export function invalidRecipients(addresses: readonly string[]): readonly string[] {
  return addresses.filter((address) => !isValidRecipient(address));
}

/**
 * Checks a draft against every cap the send route enforces, reporting
 * ALL of them at once rather than stopping at the first — a form that
 * surfaces one problem per submit makes the user pay a round trip for
 * each mistake.
 *
 * Reads the draft and returns a new object; it never touches what it was
 * given.
 */
export function validateCompose(draft: ComposeDraft): ComposeValidation {
  const errors: {
    -readonly [Key in keyof ComposeErrors]: ComposeErrors[Key];
  } = {};

  if (draft.identityId === '') {
    errors.identityId = 'Choose an account to send from.';
  } else if (draft.identityId.length > MAX_IDENTITY_ID_CHARS) {
    errors.identityId = 'That sending account is not one Valen Mail can use.';
  }

  const badTo = invalidRecipients(draft.to);
  if (draft.to.length === 0) {
    errors.to = 'Add at least one recipient.';
  } else if (badTo.length > 0) {
    errors.to = invalidAddressMessage(badTo.length);
  }

  const badCc = invalidRecipients(draft.cc);
  if (badCc.length > 0) {
    errors.cc = invalidAddressMessage(badCc.length);
  }

  const recipientCount = draft.to.length + draft.cc.length;
  if (recipientCount > MAX_RECIPIENTS) {
    errors.recipients =
      `Valen Mail sends to at most ${MAX_RECIPIENTS} people at once — To and Cc together. ` +
      `This message has ${recipientCount}.`;
  }

  if (SUBJECT_LINE_BREAK.test(draft.subject)) {
    errors.subject = 'The subject cannot contain a line break.';
  } else if (draft.subject.length > MAX_SUBJECT_CHARS) {
    errors.subject =
      `The subject is ${draft.subject.length} characters. The limit is ${MAX_SUBJECT_CHARS}.`;
  }

  const bodyBytes = textBodyBytes(draft.textBody);
  if (bodyBytes > MAX_TEXT_BODY_BYTES) {
    errors.textBody =
      `The message is ${bodyBytes} bytes — over the ${MAX_TEXT_BODY_BYTES}-byte (100 KB) limit. ` +
      'Emoji and accented characters each cost more than one byte.';
  }

  return { isValid: Object.keys(errors).length === 0, errors };
}

/**
 * True when closing the composer would throw away work.
 *
 * Wider than the brief's "the body is non-empty" on purpose: a typed
 * subject and a hand-assembled list of twenty recipients are both work,
 * and losing either to a stray Esc is the same unacceptable outcome. The
 * chosen identity is NOT work — picking an account costs one click and is
 * restored by the default on the next open.
 */
export function hasDraftContent(draft: ComposeDraft): boolean {
  return (
    draft.to.length > 0 ||
    draft.cc.length > 0 ||
    draft.subject.trim() !== '' ||
    draft.textBody.trim() !== ''
  );
}
