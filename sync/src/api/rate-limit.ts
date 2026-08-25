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
 * accepted trade — and the reason the window is only 60 seconds: the worst
 * an attacker can do with it is make the owner wait a minute, against a
 * route whose credential is 256 bits and cannot be guessed anyway.
 *
 * Do not "fix" this into a per-IP limiter. The only address this process
 * can see is the one the client puts in `X-Forwarded-For`, so per-IP would
 * be bypassable by rotating a string AND would grow an unbounded map while
 * being bypassed.
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
  /**
   * Spends one unit of the current window's budget.
   *
   * The name is POST /api/session's, which was the only caller when this
   * was written and charges FAILED attempts only — successful sign-ins
   * never spend budget there. POST /api/send (Plan 4 Task 3) is a second
   * caller with its own instance, and charges EVERY attempt, successes
   * included (see SEND_RATE_LIMIT_MAX_ATTEMPTS in ./send.ts). What the
   * method does is unchanged either way: spend one unit.
   */
  readonly recordFailure: (nowMs: number) => void;
}

/**
 * 60 seconds.
 *
 * The window length is chosen entirely for availability, because against a
 * 256-bit token it buys **no security at all**. Ten attempts per minute
 * and ten per fifteen minutes are the same number when the search space is
 * 2^256: both are the heat death of the universe. What the limiter
 * actually does here is stop a flood from burning CPU and filling the
 * journal on a 955 MB box, and a 60-second window does that identically to
 * a 15-minute one.
 *
 * Availability, meanwhile, degrades **linearly** with the window. This
 * counter is global (see the header comment for why per-IP is not an
 * option here), so anyone who knows the URL can spend the budget and hold
 * the owner out of their own mailbox. At 15 minutes that costs an attacker
 * ten requests and buys them a quarter of an hour per burst, indefinitely.
 * At 60 seconds the same ten requests buy them a minute.
 *
 * So the trade runs one way only: shorten the window until it stops doing
 * its actual job. It does not stop doing it at 60 seconds.
 */
export const SESSION_RATE_LIMIT_WINDOW_MS = 60 * 1000;

/**
 * 10 failed attempts per window.
 *
 * A person pasting a token gets it right the first time or the second;
 * ten is roughly five times the worst realistic run of fumbles, including
 * setting up two devices back to back.
 *
 * The threshold, not the window, is what bounds a flood: it is the number
 * of requests that reach the constant-time compare before the cheap
 * refusal takes over. Nothing about it is load-bearing for brute-force
 * resistance — the key length is — so it is set for the human, and the
 * window (above) is set for the human too.
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
