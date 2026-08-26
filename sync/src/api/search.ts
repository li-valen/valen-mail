import type { AccountConfig } from '../config';
import type { Db, InboxFolderFilter } from '../db';
import type { ConnectionPool } from '../imap/pool';
import { json, PRIVATE_NO_STORE } from './http.ts';
import { parseLimit } from './limits.ts';
import {
  nextCursorFrom,
  parseAccountParam,
  parseFolderParam,
  parseInboxCursor,
  resolveFolderFilter,
} from './inbox.ts';

/**
 * GET /api/search — free-text search across the unified inbox (Plan 7
 * Task 1), for the Gmail-shaped search bar in the client's top bar.
 *
 * Its own module, and a thin branch in ./routes.ts, for the same reason
 * ./inbox.ts is: routes.ts stays a router. Everything this route shares
 * with /api/inbox — cursor parsing, the emitted next cursor, folder and
 * account validation, logical-to-native folder resolution, the limit
 * clamp — is IMPORTED from ./inbox.ts and ./limits.ts rather than
 * reimplemented, and the WHERE clause itself is built by the same
 * buildInboxFilter in ../db.ts. A search is the unified inbox with one
 * more filter on it, so it had better paginate and order identically;
 * sharing the code is what makes that true rather than aspirational.
 *
 * Behind the router's auth gate, and answers with PRIVATE_NO_STORE — a
 * result set is mailbox content, and a search query in a URL is a
 * particularly bad thing for a shared cache to keep.
 */

/**
 * Hard cap on `q`.
 *
 * 200 characters is comfortably longer than any real search and shorter
 * than the two longest columns this searches (`subject` and the 280-char
 * `snippet`), so nothing a user could usefully look for is refused, while
 * a multi-kilobyte query string cannot turn into a multi-kilobyte ILIKE
 * pattern scanned across four columns of every row.
 *
 * Refused with a 400 rather than silently truncated: quietly searching for
 * something other than what the caller asked for is the kind of wrong
 * answer that looks like a correct one.
 */
export const MAX_QUERY_LENGTH = 200;

/** Fixed strings, matching ./inbox.ts's own 400 bodies — never an echo of
 *  the caller's (attacker-authored) query back into a JSON response. */
const EMPTY_QUERY_ERROR = 'missing query';
const QUERY_TOO_LONG_ERROR = 'query too long';

/**
 * The three outcomes of reading `q`, as a discriminated union rather than
 * string sentinels — for the reason ./inbox.ts's parseAccountParam
 * documents at length: `q` is free-form user text, and any string sentinel
 * ('empty', 'invalid') is something a user could genuinely search for.
 */
export type QueryParseResult =
  | { readonly kind: 'ok'; readonly query: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'too-long' };

/**
 * Parses and validates `q`.
 *
 * Trimmed before the emptiness check, so a whitespace-only query is
 * rejected rather than turned into an ILIKE `%   %` that matches most of
 * the mailbox — the specific failure mode a debounced search-as-you-type
 * box produces constantly, since a user pressing space is one keystroke
 * away from it.
 *
 * The length cap is applied to the RAW value, before trimming: the cost
 * this bounds is what the caller sent, not what survived normalisation.
 */
export function parseQueryParam(raw: string | null): QueryParseResult {
  if (raw !== null && raw.length > MAX_QUERY_LENGTH) return { kind: 'too-long' };

  const query = (raw ?? '').trim();
  if (query.length === 0) return { kind: 'empty' };
  return { kind: 'ok', query };
}

/**
 * The folder filter for a search.
 *
 * Absent `folder` means EVERY synced folder, not INBOX — deliberately
 * different from GET /api/inbox, whose default is 'inbox'. A search box
 * that silently ignored Sent and Trash would be wrong in the way users
 * notice immediately ("I know I sent that"), and Gmail's own search spans
 * the mailbox. A caller that wants a scoped search passes `folder=inbox`
 * explicitly and gets byte-identical resolution to /api/inbox's, since
 * this delegates to the same two functions for every present value.
 *
 * Exported for ./conversations.ts, which serves the GROUPED view of both
 * this route and /api/inbox and must resolve `folder` exactly as whichever
 * one it is standing in for — a grouped search that silently defaulted to
 * INBOX would return a different result set from the ungrouped search of
 * the same query, which is the kind of divergence nobody would think to
 * look for.
 */
export function resolveSearchFolder(
  raw: string | null,
  accountFilter: string | null,
  accounts: readonly AccountConfig[],
  pool: ConnectionPool,
): InboxFolderFilter | 'invalid' {
  if (raw === null) return { kind: 'all' };

  const folderParam = parseFolderParam(raw);
  if (folderParam === 'invalid') return 'invalid';
  return resolveFolderFilter(folderParam, accountFilter, accounts, pool);
}

/** Fixed strings, re-declared here rather than exported from ./inbox.ts:
 *  these are this route's contract, and a shared constant would make a
 *  future change to one route's wording silently change the other's. */
const INVALID_FOLDER_ERROR = 'invalid folder';
const INVALID_ACCOUNT_ERROR = 'invalid account';

/**
 * PAGINATION: the same keyset cursor as GET /api/inbox, not a separate
 * scheme and not "no pagination".
 *
 * It costs nothing to reuse — the ORDER BY is unchanged, buildInboxFilter
 * already accepts a cursor, and nextCursorFrom derives the next one purely
 * from the last returned ROW, so it is already correct under any
 * additional filter without knowing that filter exists. The alternative
 * (a hard limit with no cursor) would silently truncate a broad query at
 * MAX_LIMIT with no way for the client to tell a complete result set from
 * a clipped one, and would leave the client unable to reuse the paging it
 * already has for the inbox list. A client that does not want to page
 * simply ignores `nextCursor`.
 */
export async function handleSearch(
  db: Db,
  pool: ConnectionPool,
  accounts: readonly AccountConfig[],
  url: URL,
): Promise<Response> {
  const parsed = parseQueryParam(url.searchParams.get('q'));
  if (parsed.kind === 'empty') return json({ error: EMPTY_QUERY_ERROR }, 400);
  if (parsed.kind === 'too-long') return json({ error: QUERY_TOO_LONG_ERROR }, 400);

  const accountParam = parseAccountParam(url.searchParams.get('account'), accounts);
  if (accountParam === undefined) return json({ error: INVALID_ACCOUNT_ERROR }, 400);

  const folder = resolveSearchFolder(url.searchParams.get('folder'), accountParam, accounts, pool);
  if (folder === 'invalid') return json({ error: INVALID_FOLDER_ERROR }, 400);

  const limit = parseLimit(url.searchParams.get('limit'));
  const cursor = parseInboxCursor(url);

  const messages = await db.getUnifiedInbox({
    limit,
    cursor,
    folder,
    accountId: accountParam,
    search: parsed.query,
  });

  return json({ messages, nextCursor: nextCursorFrom(messages, limit) }, 200, PRIVATE_NO_STORE);
}
