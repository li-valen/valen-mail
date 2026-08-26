import { describe, it, expect } from 'vitest';
import { chooseTokenStrategy, TRACKED_SEND_BYTE_BUDGET } from '../src/send/attachments';

/**
 * Spec §5.3.1 (BINDING) — the attachment multiplication rule.
 *
 * Named `send-attachments.test.ts` rather than the plan's
 * `attachments.test.ts` because that name is already taken by the RECEIVE
 * side (../src/attachments.ts, the BODYSTRUCTURE walk). Two unrelated
 * modules sharing one test file would make either one harder to read than
 * the rename costs.
 */

const MB = 1024 * 1024;

describe('TRACKED_SEND_BYTE_BUDGET', () => {
  it('is the 25 MB the spec names', () => {
    expect(TRACKED_SEND_BYTE_BUDGET).toBe(25 * 1024 * 1024);
  });
});

describe('chooseTokenStrategy', () => {
  it('keeps per-recipient tracking when there is nothing to multiply', () => {
    expect(chooseTokenStrategy(0, 25)).toBe('per-recipient');
  });

  it('keeps per-recipient tracking under the budget', () => {
    // 2 MB x 5 = 10 MB, well under 25 MB.
    expect(chooseTokenStrategy(2 * MB, 5)).toBe('per-recipient');
  });

  it('degrades once the MULTIPLIED size exceeds the budget, not the raw size', () => {
    // 10 MB alone is fine; 10 MB x 5 recipients is 50 MB of quota. This is the
    // case the whole rule exists for, and the one a naive size check misses.
    expect(chooseTokenStrategy(10 * MB, 1)).toBe('per-recipient');
    expect(chooseTokenStrategy(10 * MB, 5)).toBe('shared');
  });

  it('is exclusive at the boundary — exactly the budget is still allowed', () => {
    expect(chooseTokenStrategy(5 * MB, 5)).toBe('per-recipient');   // == 25 MB
    expect(chooseTokenStrategy(5 * MB + 1, 5)).toBe('shared');
  });

  it('degrades a modest attachment once the recipient list is long enough', () => {
    // 2 MB is unremarkable and 12 recipients is unremarkable; together they
    // are 24 MB, and one more recipient tips it. Nothing about either input
    // on its own would tell you that, which is the point.
    expect(chooseTokenStrategy(2 * MB, 12)).toBe('per-recipient');
    expect(chooseTokenStrategy(2 * MB, 13)).toBe('shared');
  });

  it('never degrades a plain text message, however many recipients it has', () => {
    // Degrading a message with nothing to multiply would throw away
    // attribution and save nothing at all.
    for (const recipientCount of [1, 2, 25]) {
      expect(chooseTokenStrategy(0, recipientCount)).toBe('per-recipient');
    }
  });
});
