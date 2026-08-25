/**
 * Constant-time comparison built only on Web-standard APIs. `node:crypto`'s
 * `timingSafeEqual` — the pattern `sync/src/api/routes.ts` uses for its own
 * bearer token — is not an option here: both callers of this module
 * (`api/opens.ts`, `api/tokens.ts`) run on Vercel Edge, and Edge's
 * documented "Compatible Node.js modules" list is exactly `async_hooks`,
 * `events`, `buffer`, `assert`, `util` (vercel.com/docs/functions/runtimes/
 * edge) — `crypto` is not on it. `Buffer` is dropped too: it's a
 * Vercel-specific global, not a Web standard, and having removed one
 * non-standard dependency there's no reason to keep the other.
 * `TextEncoder` is already used elsewhere in this service (`src/db.ts`'s
 * `hashIp`) and is unambiguously Edge-safe.
 *
 * A plain `===` short-circuits on the first differing byte, leaking token
 * length and prefix through response timing. The length check below is
 * exempt from that concern — it leaks only the length of the caller's own
 * input, which they already know, the same property `timingSafeEqual`
 * itself relies on by throwing on a length mismatch rather than comparing.
 *
 * The byte comparison is deliberately a `reduce`, not a `for` loop, and
 * that choice is the actual security property, not a style preference: a
 * `for` loop lets a future edit slip in `if (diff) return false;` as an
 * innocuous-looking "optimization," which would reintroduce exactly the
 * timing leak this function exists to prevent — just moved from "did the
 * whole token match" down to "how many leading bytes matched before the
 * first difference." `reduce` has no `break`/early-return equivalent: it
 * always visits every index up to `a.length`, so skipping the tail would
 * require ripping out the fold and rewriting this as an imperative loop —
 * a visible structural change a reviewer would see, not a one-line edit
 * that's easy to wave through. Every byte pair is XORed into one
 * accumulator across the *entire* length no matter where they first
 * diverge, and only the final accumulator — zero if and only if every byte
 * pair was equal — is checked once, after the fold completes.
 *
 * Originally lived in `api/opens.ts` (Plan 3 Task 1); extracted here in
 * Plan 4 Task 1 so `api/tokens.ts` can share it without duplicating the
 * reasoning above. `api/opens.ts` re-exports this so its own test file's
 * `tokenMatches` import keeps working unchanged.
 */
export function tokenMatches(provided: string, expected: string): boolean {
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;

  const diff = a.reduce((acc, byte, i) => acc | (byte ^ b[i]!), 0);
  return diff === 0;
}
