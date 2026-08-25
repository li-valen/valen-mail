import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api';
import { SendRejection } from '../src/composeApi';
import type { SendResult } from '../src/composeApi';
import {
  describeSendFailure,
  formatRetryDelay,
  sentNoticeMessage,
  summarizeResults,
} from '../src/components/composeResults';

/**
 * POST /api/send answers **200 even when some copies failed** — the
 * per-recipient `results` carry the truth (sync/src/api/send.ts). Reading
 * that 200 as blanket success is the defect this file exists to prevent:
 * it would close the composer on a message that reached two of five
 * people and tell the user it went out.
 */

function ok(recipientEmail: string): SendResult {
  return { recipientEmail, ok: true };
}

function failed(recipientEmail: string): SendResult {
  return { recipientEmail, ok: false };
}

describe('summarizeResults', () => {
  it('reports all-ok when every copy went out', () => {
    const summary = summarizeResults([ok('a@x.com'), ok('b@y.com')]);
    expect(summary.outcome).toBe('all-ok');
    expect(summary.sentCount).toBe(2);
    expect(summary.failedCount).toBe(0);
    expect(summary.failed).toEqual([]);
  });

  it('reports partial when some copies went out and some did not', () => {
    const summary = summarizeResults([ok('a@x.com'), failed('b@y.com'), ok('c@z.com')]);
    expect(summary.outcome).toBe('partial');
    expect(summary.sentCount).toBe(2);
    expect(summary.failedCount).toBe(1);
    expect(summary.failed).toEqual(['b@y.com']);
  });

  it('reports none when every copy failed', () => {
    const summary = summarizeResults([failed('a@x.com'), failed('b@y.com')]);
    expect(summary.outcome).toBe('none');
    expect(summary.sentCount).toBe(0);
    expect(summary.failedCount).toBe(2);
    expect(summary.failed).toEqual(['a@x.com', 'b@y.com']);
  });

  it('reports none for an empty result list — nobody was reached', () => {
    const summary = summarizeResults([]);
    expect(summary.outcome).toBe('none');
    expect(summary.sentCount).toBe(0);
    expect(summary.failedCount).toBe(0);
    expect(summary.failed).toEqual([]);
  });

  it('reports all-ok for a single successful recipient', () => {
    expect(summarizeResults([ok('a@x.com')]).outcome).toBe('all-ok');
  });

  it('reports none for a single failed recipient', () => {
    expect(summarizeResults([failed('a@x.com')]).outcome).toBe('none');
  });

  it('lists failed addresses in the order the server returned them', () => {
    const summary = summarizeResults([
      failed('c@z.com'),
      ok('a@x.com'),
      failed('b@y.com'),
    ]);
    expect(summary.failed).toEqual(['c@z.com', 'b@y.com']);
  });

  it('never mutates the results array it was given', () => {
    const results = [ok('a@x.com'), failed('b@y.com')];
    summarizeResults(results);
    expect(results.map((result) => result.recipientEmail)).toEqual(['a@x.com', 'b@y.com']);
  });
});

describe('formatRetryDelay', () => {
  it('says "later" when the server sent no Retry-After', () => {
    expect(formatRetryDelay(null)).toBe('later');
  });

  it('says "in a moment" for a non-positive delay', () => {
    expect(formatRetryDelay(0)).toBe('in a moment');
    expect(formatRetryDelay(-5)).toBe('in a moment');
  });

  it('uses singular seconds for one second', () => {
    expect(formatRetryDelay(1)).toBe('in 1 second');
  });

  it('uses seconds under a minute', () => {
    expect(formatRetryDelay(45)).toBe('in 45 seconds');
  });

  it('uses singular minutes at exactly a minute', () => {
    expect(formatRetryDelay(60)).toBe('in 1 minute');
  });

  it('rounds UP to the next whole minute, so the advice is never early', () => {
    expect(formatRetryDelay(61)).toBe('in 2 minutes');
    expect(formatRetryDelay(599)).toBe('in 10 minutes');
  });

  it('handles a full-hour window', () => {
    expect(formatRetryDelay(3600)).toBe('in 60 minutes');
  });
});

describe('describeSendFailure — what the user is told, and whether it is certain', () => {
  it('reads 502 as tracking unavailable and NOTHING sent', () => {
    const failure = describeSendFailure(new SendRejection(502, '/api/send returned 502'));
    expect(failure.certainty).toBe('not-sent');
    expect(failure.message).toMatch(/tracking/i);
    expect(failure.message).toMatch(/not sent/i);
  });

  it('reads 429 as nothing sent, and says when to try again from Retry-After', () => {
    const failure = describeSendFailure(new SendRejection(429, '/api/send returned 429', 600));
    expect(failure.certainty).toBe('not-sent');
    expect(failure.message).toContain('in 10 minutes');
  });

  it('still answers for a 429 with no usable Retry-After', () => {
    const failure = describeSendFailure(new SendRejection(429, '/api/send returned 429', null));
    expect(failure.certainty).toBe('not-sent');
    expect(failure.message).toContain('later');
  });

  it('reads 400 as a refused request with nothing sent', () => {
    const failure = describeSendFailure(new SendRejection(400, '/api/send returned 400'));
    expect(failure.certainty).toBe('not-sent');
  });

  it('reads 401 as an expired session with nothing sent', () => {
    const failure = describeSendFailure(new SendRejection(401, '/api/send returned 401'));
    expect(failure.certainty).toBe('not-sent');
    expect(failure.message).toMatch(/sign in|session/i);
  });

  it('reads 404 as an unknown sending account with nothing sent', () => {
    const failure = describeSendFailure(new SendRejection(404, '/api/send returned 404'));
    expect(failure.certainty).toBe('not-sent');
    expect(failure.message).toMatch(/account/i);
  });

  it('reads 503 as sending not configured, with nothing sent', () => {
    const failure = describeSendFailure(new SendRejection(503, '/api/send returned 503'));
    expect(failure.certainty).toBe('not-sent');
  });

  /**
   * The honest half. A 500 or a dropped connection means the request may
   * have reached SMTP before the answer was lost, so "nothing was sent"
   * would be a confident wrong answer — the one thing this product exists
   * to refuse. Both must send the user to their Sent mail instead.
   */
  it('refuses to claim anything about an unexpected 5xx', () => {
    const failure = describeSendFailure(new SendRejection(500, '/api/send returned 500'));
    expect(failure.certainty).toBe('unknown');
    expect(failure.message).toContain('500');
    expect(failure.message).toMatch(/sent mail/i);
  });

  it('refuses to claim anything about a network failure', () => {
    const failure = describeSendFailure(new TypeError('Failed to fetch'));
    expect(failure.certainty).toBe('unknown');
    expect(failure.message).toMatch(/sent mail/i);
  });

  it('handles a plain ApiError that is not a SendRejection', () => {
    const failure = describeSendFailure(new ApiError(502, '/api/send returned 502'));
    expect(failure.certainty).toBe('not-sent');
    expect(failure.message).toMatch(/tracking/i);
  });

  it('handles a thrown value that is not an Error at all', () => {
    const failure = describeSendFailure('something odd');
    expect(failure.certainty).toBe('unknown');
    expect(failure.message.length).toBeGreaterThan(0);
  });

  it('never echoes a recipient address or a subject into the message', () => {
    // Failure copy is rendered as text, but it is also the string most
    // likely to be pasted into a bug report — it must stay free of the
    // one thing this route refuses to log.
    const failure = describeSendFailure(new SendRejection(500, 'boom sending to victim@z.com'));
    expect(failure.message).not.toContain('victim@z.com');
  });
});

describe('sentNoticeMessage — the all-ok confirmation', () => {
  it('names the tracking rather than saying only "Sent"', () => {
    expect(sentNoticeMessage(1)).toMatch(/tracking pixel/i);
  });

  it('counts the recipients when there is more than one', () => {
    const message = sentNoticeMessage(4);
    expect(message).toContain('4 recipients');
    expect(message).toMatch(/own tracking pixel/i);
  });

  it('does not say "1 recipients"', () => {
    expect(sentNoticeMessage(1)).not.toContain('1 recipients');
  });
});
