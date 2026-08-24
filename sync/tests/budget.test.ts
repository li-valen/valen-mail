import { describe, it, expect } from 'vitest';
import { checkBudget, DAILY_BYTE_LIMIT, BACKFILL_SHARE } from '../src/budget';

describe('checkBudget', () => {
  it('allows a request that fits inside the limit', () => {
    const d = checkBudget(0, 1_000_000);
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(DAILY_BYTE_LIMIT - 1_000_000);
  });

  it('refuses a request that would exceed the limit', () => {
    expect(checkBudget(DAILY_BYTE_LIMIT - 100, 500).allowed).toBe(false);
  });

  it('allows a request landing exactly on the limit', () => {
    expect(checkBudget(DAILY_BYTE_LIMIT - 500, 500).allowed).toBe(true);
  });

  it('reports zero remaining rather than a negative number when over', () => {
    expect(checkBudget(DAILY_BYTE_LIMIT + 1_000, 1).remaining).toBe(0);
  });

  it('honours an explicit lower limit for backfill', () => {
    const backfillLimit = Math.floor(DAILY_BYTE_LIMIT * BACKFILL_SHARE);
    expect(checkBudget(backfillLimit, 1, backfillLimit).allowed).toBe(false);
    expect(checkBudget(backfillLimit - 10, 5, backfillLimit).allowed).toBe(true);
  });

  it('reserves headroom for live sync — backfill share is below 1', () => {
    expect(BACKFILL_SHARE).toBeGreaterThan(0);
    expect(BACKFILL_SHARE).toBeLessThan(1);
  });

  it('treats a zero-byte request as allowed', () => {
    expect(checkBudget(DAILY_BYTE_LIMIT, 0).allowed).toBe(true);
  });
});
