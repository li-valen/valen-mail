/**
 * Shared request-limit bounds for the JSON API's paginated GET routes.
 *
 * A client asking for `limit=999999` must not be honoured — this caps how
 * many rows a single /api/inbox or /api/opens request can pull regardless
 * of what the query string asks for. Both ./inbox.ts (parseLimit below,
 * for handleInbox's query string) and opens.ts (fetchOpens's own
 * defensive clamp, for any direct caller of that module) import these
 * rather than each declaring their own copy — two independently maintained
 * copies of the same two numbers is exactly the kind of drift DRY exists
 * to prevent.
 */
export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 50;

/**
 * Clamps `limit` to [1, MAX_LIMIT] and falls back to DEFAULT_LIMIT for
 * anything that isn't a usable positive number — a missing param, a
 * non-numeric string, NaN, or a negative value — so a malformed or hostile
 * query string is handled rather than thrown on (Resolution 2).
 *
 * Shared by every paginated GET route's own query-string parsing:
 * ./inbox.ts's handleInbox and ./routes.ts's handleOpens both parse a raw
 * `limit` query param through this one function, which is what keeps "what
 * counts as a valid limit" answered in exactly one place. Originally lived
 * in routes.ts alone; moved here (Plan 5 Task 2) when handleInbox moved out
 * to ./inbox.ts and needed this without either module importing the other.
 */
export function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  const requested = Number(raw);
  if (!Number.isFinite(requested)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(requested)), MAX_LIMIT);
}
