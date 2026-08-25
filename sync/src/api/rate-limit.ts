/**
 * A fixed-window counter for the one unauthenticated route this service
 * exposes, POST /api/session.
 *
 * **Scope is the design.** This is applied to that route and nothing else.
 * Every other /api route is authenticated and serves exactly one human,
 * and a limiter across /api/* would eventually throttle the user's own
 * inbox polling — a self-inflicted outage in exchange for no security at
 * all, since a caller who can pass the gate already holds the credential.
 *
 * **Global, not per-IP, and that is deliberate.** The obvious key would be
 * the client address, but this process sits behind Caddy on loopback and
 * only ever sees `X-Forwarded-For`, a header the client controls. Keying
 * on it would let an attacker step around the limiter by rotating a string,
 * and would grow an unbounded map while doing it — turning a rate limiter
 * into a memory-exhaustion vector. There is exactly one legitimate user
 * here, so a single global budget is both simpler and strictly harder to
 * evade. It cannot isolate one abuser from the real user, which is the
 * accepted trade: the failure mode is "the owner waits a few minutes",
 * against a route whose credential is 256 bits and cannot be guessed.
 *
 * **Only failures count.** Successful sign-ins never consume budget, so a
 * user setting up several devices in a row is never locked out by their
 * own success, and the window measures exactly the thing it exists to
 * bound.
 *
 * In-memory on purpose: one instance, and a restart clearing the window is
 * fine at this threat level. No dependency, no store, no $ per month.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Seconds until the current window rolls over. Only meaningful when
   *  `allowed` is false; sent as `Retry-After`. */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Whether another attempt may be made at `nowMs`. Does not consume
   *  budget — `recordFailure` does. */
  readonly check: (nowMs: number) => RateLimitDecision;
  /** Charges one failed attempt against the current window. */
  readonly recordFailure: (nowMs: number) => void;
}

/**
 * 15 minutes.
 *
 * Long enough that a scripted attempt gets a genuinely small budget per
 * day, short enough that a user who really did fumble their token several
 * times is not locked out for an evening.
 */
export const SESSION_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * 10 failed attempts per window.
 *
 * A person pasting a token gets it right the first time or the second;
 * ten is roughly five times the worst realistic run of fumbles, including
 * setting up two devices back to back. It caps an attacker at 960 attempts
 * per day against a 256-bit credential, which is not what makes brute
 * force infeasible — the key length is — but it does bound the
 * unauthenticated front door and keeps a scripted attempt from filling the
 * journal with rejection lines on a 955 MB box.
 */
export const SESSION_RATE_LIMIT_MAX_FAILURES = 10;

/**
 * Builds one independent counter. Callers create their own instance, so
 * two routers (or two tests) never share a window.
 */
export function createFixedWindowLimiter(
  maxFailures: number = SESSION_RATE_LIMIT_MAX_FAILURES,
  windowMs: number = SESSION_RATE_LIMIT_WINDOW_MS,
): RateLimiter {
  let windowStartedAt = 0;
  let failures = 0;

  /** Rolls the window forward if `nowMs` has left the current one. Returns
   *  the millisecond at which the (possibly new) window ends. */
  function currentWindowEnd(nowMs: number): number {
    if (nowMs - windowStartedAt >= windowMs) {
      windowStartedAt = nowMs;
      failures = 0;
    }
    return windowStartedAt + windowMs;
  }

  return {
    check(nowMs: number): RateLimitDecision {
      const endsAt = currentWindowEnd(nowMs);
      if (failures < maxFailures) return { allowed: true, retryAfterSeconds: 0 };
      // At least 1: a `Retry-After: 0` reads as "try immediately", which
      // is the opposite of what a refusal means.
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((endsAt - nowMs) / 1000)) };
    },

    recordFailure(nowMs: number): void {
      currentWindowEnd(nowMs);
      failures += 1;
    },
  };
}
