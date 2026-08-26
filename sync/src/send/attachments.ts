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
