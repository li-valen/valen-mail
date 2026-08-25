import { describe, it, expect } from 'vitest';
import {
  createFixedWindowLimiter,
  SESSION_RATE_LIMIT_MAX_FAILURES,
  SESSION_RATE_LIMIT_WINDOW_MS,
} from '../src/api/rate-limit';

/**
 * The limiter's window semantics, driven by an injected clock so the
 * rollover is actually exercised rather than assumed. The route-level
 * wiring (POST /api/session and nothing else) is proved in
 * session-route.test.ts.
 */

const NOW = 1_800_000_000_000;

describe('fixed-window limiter', () => {
  it('allows attempts until the failure budget is spent', () => {
    const limiter = createFixedWindowLimiter(3, 1000);
    expect(limiter.check(NOW).allowed).toBe(true);
    limiter.recordFailure(NOW);
    limiter.recordFailure(NOW);
    expect(limiter.check(NOW).allowed).toBe(true);
    limiter.recordFailure(NOW);
    expect(limiter.check(NOW).allowed).toBe(false);
  });

  it('charges only failures, so a run of successful sign-ins never locks the user out', () => {
    // The whole point of counting failures rather than attempts: a user
    // setting up several devices in a row must not exhaust their own
    // budget. If `check` consumed budget this would fail.
    const limiter = createFixedWindowLimiter(3, 1000);
    for (let i = 0; i < 50; i += 1) {
      expect(limiter.check(NOW).allowed).toBe(true);
    }
  });

  it('rolls the window over and forgives the earlier failures', () => {
    const limiter = createFixedWindowLimiter(2, 1000);
    limiter.recordFailure(NOW);
    limiter.recordFailure(NOW);
    expect(limiter.check(NOW).allowed).toBe(false);

    // Still inside the window one millisecond early...
    expect(limiter.check(NOW + 999).allowed).toBe(false);
    // ...and forgiven the moment it rolls.
    expect(limiter.check(NOW + 1000).allowed).toBe(true);
  });

  it('reports a Retry-After that shrinks as the window drains, and never reaches zero', () => {
    const limiter = createFixedWindowLimiter(1, 10_000);
    limiter.recordFailure(NOW);
    expect(limiter.check(NOW).retryAfterSeconds).toBe(10);
    expect(limiter.check(NOW + 5_000).retryAfterSeconds).toBe(5);
    // A `Retry-After: 0` reads as "retry immediately", which is the
    // opposite of a refusal.
    expect(limiter.check(NOW + 9_999).retryAfterSeconds).toBe(1);
  });

  it('does not leak budget between independent instances', () => {
    const a = createFixedWindowLimiter(1, 1000);
    const b = createFixedWindowLimiter(1, 1000);
    a.recordFailure(NOW);
    expect(a.check(NOW).allowed).toBe(false);
    expect(b.check(NOW).allowed).toBe(true);
  });

  it('ships defaults sized for a human pasting a token, not for a crawler', () => {
    expect(SESSION_RATE_LIMIT_MAX_FAILURES).toBe(10);
    expect(SESSION_RATE_LIMIT_WINDOW_MS).toBe(15 * 60 * 1000);
  });
});
