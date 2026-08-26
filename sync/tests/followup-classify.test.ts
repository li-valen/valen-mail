import { describe, it, expect } from 'vitest';
import {
  classify,
  classifyWithEvidence,
  UNVERIFIABLE_GRACE_MS,
  type ClassifyInput,
  type OpensEvidence,
} from '../src/followup/classify';

/**
 * The whole product idea, reduced to one pure function (Plan 10 Task 1).
 *
 * `nowMs: 10 * 60 * 1000` against `sentAtMs: 0` is deliberately INSIDE
 * the grace window: every test that spreads BASE without overriding the
 * clock is asserting about a message where the absence of an open proves
 * nothing, so any test whose expectation is NOT `unverifiable` is
 * asserting that positive evidence (an open, a reply) outranks the
 * grace period — which is exactly the ordering the queue depends on.
 */
const BASE: ClassifyInput = {
  openCount: 0,
  distinctRecipientOpens: 0,
  hasReply: false,
  sentAtMs: 0,
  nowMs: 10 * 60 * 1000,
};

/** Tracking answered, and the window it answered with reaches back far
 *  enough to cover every message these tests ask about. */
const FULL_EVIDENCE: OpensEvidence = { available: true, visibleSinceMs: null };

describe('classify', () => {
  it('opened once with no reply is the follow-up queue', () => {
    expect(classify({ ...BASE, openCount: 1, distinctRecipientOpens: 1 })).toBe('opened-no-reply');
  });

  it('a reply resolves it even when it was opened many times', () => {
    expect(classify({ ...BASE, openCount: 9, distinctRecipientOpens: 3, hasReply: true })).toBe(
      'opened-replied',
    );
  });

  it('a reply resolves it even when no open was ever recorded', () => {
    // Answering the mail is stronger evidence of a read than a pixel is.
    // A resolved thread is not a queue item however the pixel behaved.
    expect(classify({ ...BASE, hasReply: true })).toBe('opened-replied');
  });

  it('repeat opens outrank a single open', () => {
    expect(classify({ ...BASE, openCount: 5, distinctRecipientOpens: 2 })).toBe('opened-repeatedly');
  });

  it('one recipient reading twice is repeat engagement too', () => {
    expect(classify({ ...BASE, openCount: 2, distinctRecipientOpens: 1 })).toBe('opened-repeatedly');
  });

  it('two recipients reading once each is repeat engagement too', () => {
    expect(classify({ ...BASE, openCount: 2, distinctRecipientOpens: 2 })).toBe('opened-repeatedly');
  });

  it('just-sent mail is unverifiable, NOT never-opened (spec 7A.2)', () => {
    // Sent 5 seconds ago. Claiming "never opened" here is the lie the spec forbids.
    expect(classify({ ...BASE, sentAtMs: 0, nowMs: 5_000 })).toBe('unverifiable');
  });

  it('mail sent one millisecond inside the grace window is still unverifiable', () => {
    expect(classify({ ...BASE, sentAtMs: 0, nowMs: UNVERIFIABLE_GRACE_MS - 1 })).toBe('unverifiable');
  });

  it('old mail with no open is honestly never-opened', () => {
    expect(classify({ ...BASE, sentAtMs: 0, nowMs: 48 * 60 * 60 * 1000 })).toBe('never-opened');
  });

  it('an open inside the grace window is believed — the grace gates absence, not evidence', () => {
    expect(classify({ ...BASE, openCount: 1, distinctRecipientOpens: 1, nowMs: 5_000 })).toBe(
      'opened-no-reply',
    );
  });

  it('a clock that runs backwards degrades to unverifiable, never to never-opened', () => {
    expect(classify({ ...BASE, sentAtMs: 10_000, nowMs: 0 })).toBe('unverifiable');
  });
});

describe('classifyWithEvidence', () => {
  it('reports unverifiable for every row when tracking could not be reached', () => {
    const old = { ...BASE, sentAtMs: 0, nowMs: 48 * 60 * 60 * 1000 };
    expect(classifyWithEvidence(old, { available: false, visibleSinceMs: null })).toBe('unverifiable');
  });

  it('still resolves a replied thread when tracking could not be reached', () => {
    // A reply is a fact from our OWN mailbox — it does not depend on the
    // tracking service being up.
    const replied = { ...BASE, hasReply: true };
    expect(classifyWithEvidence(replied, { available: false, visibleSinceMs: null })).toBe(
      'opened-replied',
    );
  });

  it('will not call a message never-opened when it was sent before the opens window begins', () => {
    // The tracking service returned a FULL page, so the oldest event we
    // can see is a horizon, not the beginning of history: an open of this
    // message could have happened below it and be invisible to us.
    const old = { ...BASE, sentAtMs: 1_000, nowMs: 48 * 60 * 60 * 1000 };
    expect(classifyWithEvidence(old, { available: true, visibleSinceMs: 5_000 })).toBe('unverifiable');
  });

  it('does call a message never-opened when the opens window covers its whole life', () => {
    const old = { ...BASE, sentAtMs: 9_000, nowMs: 48 * 60 * 60 * 1000 };
    expect(classifyWithEvidence(old, { available: true, visibleSinceMs: 5_000 })).toBe('never-opened');
  });

  it('agrees with classify whenever the evidence is complete', () => {
    const cases: readonly ClassifyInput[] = [
      { ...BASE, openCount: 1, distinctRecipientOpens: 1 },
      { ...BASE, openCount: 5, distinctRecipientOpens: 2 },
      { ...BASE, hasReply: true },
      { ...BASE, sentAtMs: 0, nowMs: 48 * 60 * 60 * 1000 },
      { ...BASE, sentAtMs: 0, nowMs: 5_000 },
    ];
    for (const input of cases) {
      expect(classifyWithEvidence(input, FULL_EVIDENCE)).toBe(classify(input));
    }
  });
});

describe('the grace period itself', () => {
  it('is long enough that nothing sent in the current conversation is called unopened', () => {
    // Ten minutes ago is "we were just talking about this", not "they
    // never opened it".
    expect(UNVERIFIABLE_GRACE_MS).toBeGreaterThanOrEqual(10 * 60 * 1000);
  });

  it('is short enough that same-day mail still resolves', () => {
    expect(UNVERIFIABLE_GRACE_MS).toBeLessThan(6 * 60 * 60 * 1000);
  });
});
