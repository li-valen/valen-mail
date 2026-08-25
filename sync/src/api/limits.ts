/**
 * Shared request-limit bounds for the JSON API's paginated GET routes.
 *
 * A client asking for `limit=999999` must not be honoured — this caps how
 * many rows a single /api/inbox or /api/opens request can pull regardless
 * of what the query string asks for. Both routes.ts (parseLimit, for the
 * query string a browser actually sent) and opens.ts (fetchOpens's own
 * defensive clamp, for any direct caller of that module) import these
 * rather than each declaring their own copy — two independently maintained
 * copies of the same two numbers is exactly the kind of drift DRY exists
 * to prevent.
 */
export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 50;
