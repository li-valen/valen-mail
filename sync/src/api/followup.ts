import type { AccountConfig, TrackingConfig } from '../config';
import type { Db } from '../db';
import type { ConnectionPool } from '../imap/pool';
import { fetchOpens } from './opens.ts';
import { json, PRIVATE_NO_STORE } from './http.ts';
import { MAX_LIMIT } from './limits.ts';
import { parseLimit } from './limits.ts';
import { parseAccountParam, parseInboxCursor, resolveFolderFilter } from './inbox.ts';
import { queryFollowup } from '../followup/query.ts';

/**
 * GET /api/followup — spec §7A's "Sent & Waiting" and "Opened, no reply",
 * which are one list with a state on every row rather than two endpoints.
 *
 * A sibling of GET /api/inbox, not a variant of it: same auth gate (the
 * router proves the credential before this runs), same `account` filter,
 * same keyset cursor, same limit. What differs is the folder — always the
 * user's SENT mail, never a caller-chosen one — and the open events
 * folded in per row.
 *
 * Thin by construction, exactly like ./inbox.ts and ./search.ts: this
 * file turns a query string into validated arguments and performs the one
 * network call this feature needs. Every decision lives in
 * ../followup/query.ts and ../followup/classify.ts.
 */

/**
 * The logical folder this view is ABOUT. Not a caller parameter: a
 * follow-up queue over the Inbox would be a queue of other people's mail,
 * which is not a thing. Resolved per account through the pool's own IMAP
 * discovery — Gmail localises the Sent folder's name, so it can never be
 * a hardcoded `[Gmail]/…` string (see imap/folders.ts).
 */
const SENT = 'sent' as const;

/**
 * How many open events to ask the tracking service for.
 *
 * MAX_LIMIT (200) — the largest single page it will serve — because this
 * number IS the evidence horizon: a message sent before the oldest event
 * in the page cannot honestly be called never-opened (see
 * `opensEvidenceFrom`). Asking for the biggest page pushes that horizon
 * as far back as one request can, and the same request answers for the
 * whole page of sends rather than one call per row.
 */
const OPENS_FETCH_LIMIT = MAX_LIMIT;

/** Fixed string rather than one echoing the caller's input back into a
 *  JSON body — the same rule ./inbox.ts's own 400s follow. */
const INVALID_ACCOUNT_ERROR = 'invalid account';

/**
 * `deps` is the test-injection seam, matching the shape ./opens.ts and
 * ./routes.ts already established. Production passes neither: `fetchImpl`
 * defaults to the global fetch, and `nowMs` to the real clock.
 *
 * `nowMs` is resolved ONCE per request and threaded to every row, so a
 * page classified either side of the grace-period boundary cannot
 * disagree with itself about what "now" is.
 */
export interface FollowupDeps {
  readonly fetchImpl?: typeof fetch;
  readonly nowMs?: number;
}

export async function handleFollowup(
  db: Db,
  pool: ConnectionPool,
  accounts: readonly AccountConfig[],
  tracking: TrackingConfig | null,
  url: URL,
  deps: FollowupDeps = {},
): Promise<Response> {
  const accountParam = parseAccountParam(url.searchParams.get('account'), accounts);
  if (accountParam === undefined) return json({ error: INVALID_ACCOUNT_ERROR }, 400);

  const limit = parseLimit(url.searchParams.get('limit'));
  const cursor = parseInboxCursor(url);
  const folder = resolveFolderFilter(SENT, accountParam, accounts, pool);

  // A tracking service that was never configured is handled exactly like
  // one that is down: no network call, and every row honestly reads as
  // unknown rather than as "nobody opened it". Same reasoning as
  // ./routes.ts's handleOpens, and the reason this answers 200 either
  // way — a sent-mail list is still worth showing without open data, and
  // a non-2xx here would read to the client as a failed page load.
  const opens = tracking
    ? await fetchOpens(OPENS_FETCH_LIMIT, {
        baseUrl: tracking.baseUrl,
        token: tracking.readToken,
        fetchImpl: deps.fetchImpl,
      })
    : ({ ok: false, reason: 'upstream_error' } as const);

  const page = await queryFollowup(db, {
    ownAddresses: accounts.map((account) => account.email),
    limit,
    cursor,
    folder,
    accountId: accountParam,
    opens,
    opensLimit: OPENS_FETCH_LIMIT,
    nowMs: deps.nowMs ?? Date.now(),
  });

  return json(page, 200, PRIVATE_NO_STORE);
}
