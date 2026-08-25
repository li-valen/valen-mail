import type { AccountConfig } from '../config';
import type { Db, InboxCursor, InboxFolderFilter, NativeFolderPair } from '../db';
import type { ConnectionPool } from '../imap/pool';
import { INBOX_FOLDER, type OptionalFolderKind } from '../imap/folders.ts';
import { parsePositiveInt } from './fetch-part.ts';
import { json, PRIVATE_NO_STORE } from './http.ts';
import { parseLimit } from './limits.ts';

/**
 * GET /api/inbox — the unified inbox, its keyset pagination, and (Plan 5
 * Task 2) its `folder`/`account` filters.
 *
 * Kept out of ./routes.ts on purpose, mirroring ./message.ts, ./opens.ts,
 * ./push.ts and ./identities.ts: that file is already large, and every
 * route added since Task 8 lands as a thin branch delegating to its own
 * module rather than growing it further. This route sits behind the
 * router's own auth gate, so by the time handleInbox runs the caller has
 * already proven a valid credential — see createRouter in ./routes.ts.
 *
 * Query construction itself stays in ../db.ts (buildInboxFilter and
 * friends) — this module's job stops at turning a query string into the
 * validated, already-resolved arguments that function needs. In
 * particular, `folder=sent` never becomes a literal folder name anywhere
 * in this file: it becomes an `InboxFolderFilter`, and for 'sent' | 'spam'
 * | 'trash' that means asking ConnectionPool.getDiscoveredFolders — the
 * SAME per-account discovery imap/folders.ts produced for the sync loop —
 * rather than guessing or hardcoding a `[Gmail]/…` name.
 */

/** Ignores an unparsable `before` value rather than throwing — an
 *  unfiltered inbox read is a safe fallback for a malformed date. */
function parseBeforeDate(raw: string | null): Date | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Builds the unified inbox's keyset cursor from the query string.
 *
 * Two accepted shapes, deliberately:
 *  - `before` + `beforeAccount` + `beforeUid` — the full compound cursor.
 *    Lossless: it addresses an exact position in the total order, so rows
 *    that share a second-resolution Gmail timestamp with the previous
 *    page's last row are still returned.
 *  - `before` alone — backward tolerance for a client written against the
 *    old bare-timestamp API. It still filters correctly; it just remains
 *    tie-lossy, which is what that client already had.
 *
 * `beforeAccount`/`beforeUid` with no `before` is the NULL-date tail: those
 * rows sort last and have no timestamp to key on, so the cursor carries a
 * null date and the row comparison substitutes '-infinity'.
 *
 * Unchanged by Plan 5 Task 2: a folder/account filter changes the query's
 * WHERE clause, never its ORDER BY or the cursor's own tiebreak, so the
 * cursor a client got from a filtered page is built and consumed exactly
 * the same way as an unfiltered one — see resolveFolderFilter below for
 * the filter half.
 */
export function parseInboxCursor(url: URL): InboxCursor | null {
  const date = parseBeforeDate(url.searchParams.get('before'));
  const accountId = url.searchParams.get('beforeAccount');
  const uidRaw = url.searchParams.get('beforeUid');
  const uid = uidRaw === null ? null : parsePositiveInt(uidRaw);

  if (accountId && uid !== null) return { date, accountId, uid };
  if (date !== null) return { date, accountId: null, uid: null };
  return null;
}

export interface NextCursor {
  readonly before: string | null;
  readonly beforeAccount: string;
  readonly beforeUid: string;
}

/**
 * The cursor a client should send to get the next page, or null when this
 * page is the last one. Emitting it (rather than expecting the client to
 * reconstruct it from the final row) is what makes lossless pagination the
 * default rather than something a client has to know to opt into.
 *
 * A short page means there is nothing after it. A full page might also be
 * the last one, in which case the client makes one extra request that
 * returns zero messages — the standard keyset trade, and strictly better
 * than the alternative of over-fetching by one row on every page.
 *
 * Derived purely from the last returned ROW, never from the request's own
 * filter — which is exactly what keeps it correct under a folder/account
 * filter without this function needing to know filters exist at all: the
 * client echoes `folder`/`account` back on the next request itself (see
 * ./routes.ts's dispatch), and every row this function could ever see
 * already satisfied that filter, so the emitted cursor addresses a
 * position that is only ever reached again from inside the same filter.
 */
export function nextCursorFrom(rows: readonly Record<string, unknown>[], limit: number): NextCursor | null {
  if (rows.length < limit) return null;
  const last = rows[rows.length - 1];
  if (!last || last.account_id === undefined || last.uid === undefined) return null;
  const date = last.date;
  return {
    before: date instanceof Date ? date.toISOString() : null,
    beforeAccount: String(last.account_id),
    beforeUid: String(last.uid),
  };
}

/** The five folder values GET /api/inbox understands (Plan 5's contract).
 *  'sent' | 'spam' | 'trash' are reused directly from imap/folders.ts's
 *  own OptionalFolderKind rather than redeclared — those three strings
 *  mean the same thing in both places (a folder discovered by special-use
 *  attribute), so this is DRY, not a coincidence. */
export type InboxFolderParam = 'inbox' | OptionalFolderKind | 'starred';

const FOLDER_PARAM_VALUES: readonly InboxFolderParam[] = ['inbox', 'sent', 'spam', 'trash', 'starred'];

/** Fixed strings, not per-value messages — Plan 5 Task 2's contract asks
 *  for a fixed 400 body rather than one that echoes the caller's (possibly
 *  hostile) input back into a JSON response. */
const INVALID_FOLDER_ERROR = 'invalid folder';
const INVALID_ACCOUNT_ERROR = 'invalid account';

/**
 * Parses and validates the `folder` query param. Absent -> the default,
 * `'inbox'` (Plan 5's contract). Present but not one of the five values
 * this API understands -> `'invalid'`, which handleInbox turns into a
 * fixed 400 — never a silent fallback to the default, because a typo'd
 * folder name quietly returning INBOX's mail instead of the caller's
 * actual request is worse than an obvious error.
 */
export function parseFolderParam(raw: string | null): InboxFolderParam | 'invalid' {
  if (raw === null) return 'inbox';
  return (FOLDER_PARAM_VALUES as readonly string[]).includes(raw)
    ? (raw as InboxFolderParam)
    : 'invalid';
}

/**
 * Parses and validates the `account` query param against the CONFIGURED
 * accounts — never against the pool's live connection status, since an
 * account that is merely reconnecting is still a perfectly valid filter
 * target, just one whose folders (see resolveFolderFilter) may not be
 * discovered yet.
 *
 * Three outcomes, and they use `null`/`undefined` rather than a string
 * sentinel deliberately: `parseFolderParam` can safely return the fixed
 * string `'invalid'` because its value set is closed (five known
 * literals), but account ids are free-form and config.ts only requires
 * one be non-empty — nothing stops a real account from being named
 * "invalid", which would make a string sentinel collide with a legitimate
 * id and make that one account permanently unfilterable.
 *
 *  - absent -> `null` ("all accounts", today's only behaviour);
 *  - present and configured -> the account id itself (always a non-empty
 *    string — see config.ts's parseAccount — so it can never be confused
 *    with either of the other two outcomes);
 *  - present but not a configured id -> `undefined`: a typo'd id must
 *    400, not silently return an empty-but-200 response that reads
 *    exactly like "this account genuinely has no mail" — that is the
 *    specific failure mode Plan 5 Task 2's contract calls out as worth a
 *    dedicated status code.
 */
export function parseAccountParam(
  raw: string | null,
  accounts: readonly AccountConfig[],
): string | null | undefined {
  if (raw === null) return null;
  return accounts.some((account) => account.id === raw) ? raw : undefined;
}

/**
 * The accounts a 'sent' | 'spam' | 'trash' filter should resolve native
 * folders for: just the one named by an `account` filter, or every
 * configured account when there is none. Narrowing here — rather than
 * always resolving every account and filtering the pairs afterwards — is
 * what keeps an `account`+`folder` request from ever depending on any
 * OTHER account's discovery state (an account whose Trash 500'd, timed
 * out, or was simply never asked about cannot affect a request that named
 * a different account).
 */
function accountsToResolve(
  accounts: readonly AccountConfig[],
  accountFilter: string | null,
): readonly AccountConfig[] {
  if (accountFilter === null) return accounts;
  return accounts.filter((account) => account.id === accountFilter);
}

/**
 * Translates a logical folder into the filter shape ../db.ts's query
 * builder understands. This is the one place the API's "sent" / "spam" /
 * "trash" meets what each account's own IMAP LIST actually discovered:
 * ConnectionPool.getDiscoveredFolders returns the SAME DiscoveredFolders
 * imap/folders.ts produced for the sync loop, per account — see that
 * module's own doc comment for why the native name cannot be a hardcoded
 * `[Gmail]/…` string (Gmail localises it to the account owner's language).
 *
 * An account whose kind was never discovered — Trash disabled by policy,
 * or this process simply has not finished that account's first sync cycle
 * yet — contributes no pair. That is not an error: db.ts's 'pairs' filter
 * with zero pairs matches zero rows, which is the honest "no mail known in
 * that folder right now" answer, and is deliberately indistinguishable
 * from a genuinely empty Trash — see getDiscoveredFolders's own doc
 * comment for why collapsing those two cases together is intentional.
 */
export function resolveFolderFilter(
  folder: InboxFolderParam,
  accountFilter: string | null,
  accounts: readonly AccountConfig[],
  pool: ConnectionPool,
): InboxFolderFilter {
  if (folder === 'inbox') return { kind: 'literal', folder: INBOX_FOLDER };
  if (folder === 'starred') return { kind: 'starred' };

  const pairs: NativeFolderPair[] = [];
  for (const account of accountsToResolve(accounts, accountFilter)) {
    const discovered = pool.getDiscoveredFolders(account.id);
    const native = discovered?.[folder] ?? null;
    if (native !== null) pairs.push({ accountId: account.id, folder: native });
  }
  return { kind: 'pairs', pairs };
}

export async function handleInbox(
  db: Db,
  pool: ConnectionPool,
  accounts: readonly AccountConfig[],
  url: URL,
): Promise<Response> {
  const folderParam = parseFolderParam(url.searchParams.get('folder'));
  if (folderParam === 'invalid') return json({ error: INVALID_FOLDER_ERROR }, 400);

  const accountParam = parseAccountParam(url.searchParams.get('account'), accounts);
  if (accountParam === undefined) return json({ error: INVALID_ACCOUNT_ERROR }, 400);

  const limit = parseLimit(url.searchParams.get('limit'));
  const cursor = parseInboxCursor(url);
  const folder = resolveFolderFilter(folderParam, accountParam, accounts, pool);

  const messages = await db.getUnifiedInbox({ limit, cursor, folder, accountId: accountParam });
  return json({ messages, nextCursor: nextCursorFrom(messages, limit) }, 200, PRIVATE_NO_STORE);
}
