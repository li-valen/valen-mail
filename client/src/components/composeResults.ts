import { ApiError } from '../api';
import { SendRejection } from '../composeApi';
import type { SendResult } from '../composeApi';

/**
 * What the composer is allowed to tell the user after a send, and how
 * certain it is allowed to sound.
 *
 * TWO RULES, and collapsing either one is the defect this file exists to
 * prevent.
 *
 * 1. **A 200 is not blanket success.** POST /api/send sends one SMTP copy
 *    per recipient and answers 200 with per-recipient `results` even when
 *    some of those copies failed (sync/src/api/send.ts). Closing the
 *    composer on a message that reached two of five people, and saying it
 *    went out, is a confident wrong answer about mail the user cannot get
 *    back.
 * 2. **Some failures are genuinely unknown.** A 502 or a 429 is refused
 *    before a single socket opens, so "nothing was sent" is a fact. A 500
 *    or a dropped connection is not: the request may have reached SMTP
 *    before the answer was lost. `certainty` is what keeps those two
 *    apart, so the copy for the second case sends the user to their Sent
 *    mail instead of promising them nothing happened.
 */

/** all-ok = every copy went out. partial = some did, some did not (the
 *  composer stays open). none = nobody was reached. */
export type SendOutcome = 'all-ok' | 'partial' | 'none';

export interface ResultSummary {
  readonly outcome: SendOutcome;
  readonly sentCount: number;
  readonly failedCount: number;
  /** Addresses whose copy did NOT go out, in the order the server
   *  reported them. Rendered as text — never as markup. */
  readonly failed: readonly string[];
}

/**
 * Folds the per-recipient results into the one distinction the UI turns
 * on.
 *
 * An EMPTY list is `none`, not `all-ok`. "Every copy succeeded" is
 * vacuously true of no copies, and the honest reading of a send that
 * produced no results at all is that nobody was reached.
 */
export function summarizeResults(results: readonly SendResult[]): ResultSummary {
  const failed = results.filter((result) => !result.ok).map((result) => result.recipientEmail);
  const sentCount = results.length - failed.length;

  const outcome: SendOutcome =
    sentCount === 0 ? 'none' : failed.length === 0 ? 'all-ok' : 'partial';

  return { outcome, sentCount, failedCount: failed.length, failed };
}

/**
 * The line shown after a send where every copy went out.
 *
 * States the tracking plainly rather than burying it, because tracking is
 * what this product IS: the user is told, at the moment it becomes true,
 * that a pixel is now live for each person they wrote to. A confirmation
 * that said only "Sent" would be hiding the whole feature behind a word
 * that means something else in every other mail client.
 */
export function sentNoticeMessage(sentCount: number): string {
  if (sentCount === 1) {
    return 'Sent. Its tracking pixel is live — opens show up under Opens.';
  }
  return `Sent to ${sentCount} recipients. Each copy carries its own tracking pixel, so opens show up under Opens per person.`;
}

/** Whether the failure is one where nothing at all left the building, or
 *  one where Postbox genuinely cannot tell. */
export type DeliveryCertainty = 'not-sent' | 'unknown';

export interface SendFailure {
  readonly message: string;
  readonly certainty: DeliveryCertainty;
}

const SECONDS_PER_MINUTE = 60;

/**
 * Turns a `Retry-After` seconds count into the tail of a sentence:
 * "in 45 seconds", "in 2 minutes", or "later" when the server sent
 * nothing usable.
 *
 * Rounds UP to the next whole minute, deliberately: advice that is early
 * sends the user straight back into the same 429.
 */
export function formatRetryDelay(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return 'later';
  if (seconds <= 0) return 'in a moment';
  if (seconds < SECONDS_PER_MINUTE) {
    return `in ${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  const minutes = Math.ceil(seconds / SECONDS_PER_MINUTE);
  return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** Nothing left the building, and Postbox can say so. */
function notSent(message: string): SendFailure {
  return { message, certainty: 'not-sent' };
}

/** Postbox cannot tell. The only honest instruction is "go and look". */
function uncertain(message: string): SendFailure {
  return { message, certainty: 'unknown' };
}

const CHECK_SENT_MAIL = 'check your Sent mail before sending it again.';

/**
 * Turns whatever `sendMail` threw into one sentence for the user.
 *
 * Builds every string from the STATUS, never from `error.message` — the
 * thrown message is written by this client and stays free of recipients
 * and subjects (see ../composeApi.ts), but a failure string is also the
 * thing most likely to end up pasted into a bug report, so it is composed
 * here from known-safe parts rather than forwarded.
 */
export function describeSendFailure(error: unknown): SendFailure {
  if (!(error instanceof ApiError)) {
    return uncertain(
      `Postbox could not reach the sync service, so it cannot tell whether the message went out — ${CHECK_SENT_MAIL}`,
    );
  }

  switch (error.status) {
    case 400:
      return notSent(
        'Not sent — the sync service refused this message. Check the recipients, the subject and the message size, then try again.',
      );
    case 401:
      return notSent(
        'Not sent — your session has expired. Copy your message somewhere safe, reload Postbox to sign in again, then send it.',
      );
    case 404:
      return notSent(
        'Not sent — that sending account is no longer configured. Pick another account and try again.',
      );
    case 429: {
      const retryAfterSeconds = error instanceof SendRejection ? error.retryAfterSeconds : null;
      return notSent(
        `Not sent — Postbox allows 30 sends an hour and that is spent. Try again ${formatRetryDelay(retryAfterSeconds)}.`,
      );
    }
    case 502:
      // Fail-closed, on purpose: the product IS the tracking, so a send
      // that quietly went out untracked would be Postbox lying about what
      // it did (Plan 4 Task 3).
      return notSent(
        'Not sent — tracking is unavailable. Postbox will not send a message it cannot track, so nothing went out.',
      );
    case 503:
      return notSent('Not sent — sending is not configured on the sync service.');
    default:
      return uncertain(
        `The sync service answered ${error.status}. Postbox cannot tell whether the message went out — ${CHECK_SENT_MAIL}`,
      );
  }
}
