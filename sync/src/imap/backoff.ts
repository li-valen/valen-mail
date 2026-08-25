/**
 * Exponential backoff with equal jitter for ConnectionPool's reconnect
 * ladder (runAccount's catch block, ./pool.ts).
 *
 * Extracted from pool.ts (fix round 1, Plan 5 Task 2): these three
 * constants and two functions are pure, module-level, already exported
 * where a caller needs them, and touch zero ConnectionPool state — moving
 * them cost pool.ts nothing behaviourally and brought it back under the
 * project's 800-line ceiling, which the two accessors added for Plan 5
 * Task 2 (getDiscoveredFolders) had pushed past. pool.ts re-exports
 * `computeBackoffMs`/`MAX_BACKOFF_MS` so nothing importing them from there
 * needed to change.
 */

const BASE_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 5 * 60 * 1_000;
const MIN_BACKOFF_MS = 500;

/**
 * Ceiling of the exponential curve for a given attempt, before jitter.
 * Doubles per attempt starting from BASE_BACKOFF_MS, capped at MAX_BACKOFF_MS.
 */
function backoffCeilingMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1));
}

/**
 * Exponential backoff with "equal jitter" (ceiling/2 + random(0, ceiling/2)),
 * not "full jitter" (random(0, ceiling)). The jitter itself is not
 * decoration: ten accounts dropped by the same network blip would otherwise
 * reconnect in lockstep, presenting Gmail with a synchronised burst from one
 * user — and unlike full jitter, equal jitter keeps a real spread even once
 * the exponential curve has saturated at MAX_BACKOFF_MS (a long outage does
 * not degrade back into a fixed, lockstep delay).
 *
 * Equal jitter is also what makes attempt-to-attempt growth practically
 * guaranteed rather than a coin flip: full jitter draws from [0, ceiling]
 * every time, so a short attempt-1 draw and a long attempt-2 draw overlap
 * across roughly half their range. Equal jitter draws from
 * [ceiling/2, ceiling], so consecutive attempts' ranges only touch at a
 * single point — attempt N's range starts exactly where attempt N-1's ends.
 */
export function computeBackoffMs(attempt: number): number {
  const ceiling = backoffCeilingMs(attempt);
  const floor = Math.max(MIN_BACKOFF_MS, ceiling / 2);
  const jittered = floor + Math.random() * (ceiling - floor);
  return Math.round(jittered);
}
