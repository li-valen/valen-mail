import { timingSafeEqual } from 'node:crypto';
import { listRecentOpens, type OpenRow } from '../src/db';

export const config = { runtime: 'edge' };

/** Below this, READ_API_TOKEN is treated as unset — see the module doc below. */
const MIN_TOKEN_LENGTH = 32;
/** A client asking for `limit=999999` must not be honoured. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * Only 'open' is a demonstrated human read. Apple's Mail Privacy Protection
 * ('mpp') prefetches images for every message whether or not a human looked;
 * 'prefetch' is Gmail's own proxy fetching at delivery time; 'scanner' is a
 * corporate mail gateway; 'self' is the sender viewing their own Sent
 * folder. The user's own calibration run measured four of six real events
 * as machine prefetches, not human reads (see src/classify.ts).
 *
 * `c` is untyped `string`, not `Classification`, on purpose: this must
 * degrade to "not confirmed" for a classification value it has never seen
 * (a future classifier addition, a hand-edited row, anything), never
 * default to a false green. The `=== 'open'` equality check already has
 * that property for free — every unrecognised input takes the `false`
 * branch — but the untyped signature makes it impossible to accidentally
 * lose that property by exhaustively switching over `Classification` later
 * and forgetting a case.
 */
export function classificationIsConfirmed(c: string): boolean {
  return c === 'open';
}

/**
 * Constant-time comparison, reusing the exact pattern `sync/src/api/routes.ts`
 * uses for its own bearer token. A plain `===` short-circuits on the first
 * differing byte, leaking token length and prefix through response timing.
 * `timingSafeEqual` throws on a length mismatch, so the length check must
 * happen first — and that check itself leaks nothing the caller doesn't
 * already know (their own input's length).
 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * RFC 7235 makes the auth-scheme token case-insensitive ("Bearer", "bearer"
 * and "BEARER" are the same scheme) and allows more than one space between
 * the scheme and the credential. Matches `sync/src/api/routes.ts`'s
 * `extractBearerToken` exactly, including `\S+` for the credential (a
 * bearer token cannot contain whitespace, so trailing whitespace is
 * stripped rather than folded into the comparison).
 */
function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  const match = /^\s*bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1]! : null;
}

/**
 * Pure so it can be unit-tested without a live database — same reasoning as
 * `extractToken` being exported from `api/o/[token].ts`. A non-finite or
 * non-numeric `raw` (missing, empty, garbage) falls back to DEFAULT_LIMIT
 * rather than propagating NaN into the query.
 */
export function resolveLimit(raw: string | null): number {
  const parsed = Number(raw);
  if (raw === null || raw === '' || !Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.trunc(parsed)), MAX_LIMIT);
}

function toResponseBody(rows: readonly OpenRow[]): { opens: readonly OpenRow[] } {
  return { opens: rows };
}

export default async function handler(request: Request): Promise<Response> {
  const expected = process.env.READ_API_TOKEN;
  if (!expected || expected.length < MIN_TOKEN_LENGTH) {
    // Fail closed. This route's data is a list of who opened which of the
    // user's emails — an absent or too-short token must never be read as
    // "no auth required." Never log the value itself, only that it's
    // missing/short, so a misconfigured deploy can't leak a partial secret
    // into log output.
    console.error('opens: READ_API_TOKEN missing or too short; refusing to serve');
    return json({ error: 'unavailable' }, 503);
  }

  const provided = extractBearerToken(request);
  if (!provided || !tokenMatches(provided, expected)) {
    return json({ error: 'unauthorized' }, 401);
  }

  const url = new URL(request.url);
  const limit = resolveLimit(url.searchParams.get('limit'));

  try {
    const rows = await listRecentOpens(limit);
    return json(toResponseBody(rows));
  } catch (error) {
    console.error('opens: query failed', error);
    return json({ error: 'query failed' }, 500);
  }
}
