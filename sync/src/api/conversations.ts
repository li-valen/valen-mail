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
import { parseQueryParam, resolveSearchFolder } from './search.ts';

/**
 * GET /api/conversations — the SAME list as /api/inbox and /api/search,
 * paginated by CONVERSATION instead of by message.
 *
 * ---------------------------------------------------------------------
 * WHY THIS IS A ROUTE AND NOT SOMETHING THE CLIENT DOES TO A PAGE.
 * ---------------------------------------------------------------------
 * A client only ever holds one page. Grouping whatever happens to be in
 * that page produces a conversation whose count GROWS every time the user
 * presses "Load more" — and on this user's real mailbox it would be wrong
 * from the first frame, not merely unstable: their largest inbox thread
 * is 40 messages spread across 25 days, and 50-message pages are hours
 * wide near the top of the list. Page one would collapse those 40 rows
 * into a conversation labelled "(1)". A count that is wrong in the safe
 * direction is still a count the user cannot act on.
 *
 * So the SERVER decides what a conversation is, and pages by them. Every
 * message of every conversation on a page comes back with that page, and
 * `nextCursor` addresses the next CONVERSATION — which is what makes
 * "Load more" append whole threads instead of the tails of ones the
 * client already drew.
 *
 * ---------------------------------------------------------------------
 * THE RESPONSE IS BYTE-SHAPED LIKE /api/inbox'S, DELIBERATELY.
 * ---------------------------------------------------------------------
 * `{ messages, nextCursor }`, flat and newest-first, with `nextCursor` in
 * the identical keyset shape. Two things fall out of that and both are
 * the reason for it:
 *
 *  - the client reuses its existing row validation, cursor parsing and
 *    paging verbatim — one new URL, not a second list implementation;
 *  - because the list is newest-first, the FIRST row of a conversation is
 *    its newest message, so grouping by first appearance recovers the
 *    conversations AND their order without the client carrying a second
 *    copy of INBOX_ORDER's comparator.
 *
 * What differs from /api/inbox is only what `limit` counts. There it is
 * rows; here it is conversations, so `messages.length` is normally a
 * little larger than `limit` and occasionally much larger (one 40-message
 * thread on a page of fifty). That is the payload the collapsed row is
 * drawn from — the count, the participants, the "any of these is unread"
 * — and the set a bulk archive of that row acts on.
 *
 * ---------------------------------------------------------------------
 * `q` MAKES THIS THE GROUPED VIEW OF /api/search INSTEAD.
 * ---------------------------------------------------------------------
 * Including its folder default, which is genuinely different: /api/inbox
 * defaults to INBOX and /api/search defaults to every synced folder (see
 * resolveSearchFolder). Both resolutions are IMPORTED rather than
 * restated, so a grouped request and its ungrouped twin cannot answer
 * from different result sets.
 *
 * Behind the router's auth gate, and PRIVATE_NO_STORE for the reason
 * every mail route is: this is mailbox content.
 */

/** Fixed strings, matching ./inbox.ts's and ./search.ts's own 400 bodies
 *  — never an echo of the caller's (attacker-authored) input back into a
 *  JSON response. Re-declared rather than imported for the reason
 *  ./search.ts re-declares them: they are this route's contract, and a
 *  shared constant would make a change to one route's wording silently
 *  change another's. */
const INVALID_FOLDER_ERROR = 'invalid folder';
const INVALID_ACCOUNT_ERROR = 'invalid account';
const QUERY_TOO_LONG_ERROR = 'query too long';

/**
 * Resolves `folder` the way the UNGROUPED route for this same request
 * would have.
 *
 * Absent `q` -> /api/inbox's rule (missing means INBOX).
 * Present `q` -> /api/search's rule (missing means every synced folder).
 *
 * The dual default looks like a wart and is the opposite: this route
 * stands in for two others, and picking one default for both would make
 * `?q=x` here and `?q=x` on /api/search return different mail with no
 * error anywhere.
 */
function resolveFolder(
  raw: string | null,
  hasQuery: boolean,
  accountFilter: string | null,
  accounts: readonly AccountConfig[],
  pool: ConnectionPool,
): InboxFolderFilter | 'invalid' {
  if (hasQuery) return resolveSearchFolder(raw, accountFilter, accounts, pool);

  const folderParam = parseFolderParam(raw);
  if (folderParam === 'invalid') return 'invalid';
  return resolveFolderFilter(folderParam, accountFilter, accounts, pool);
}

/**
 * The folders a conversation's MEMBERS may come from — the Inbox view's
 * answer to *"reply feature should be sent in the same email chain"*.
 *
 * **ONLY THE INBOX VIEW WIDENS, AND THAT IS A DELIBERATE FLOOR RATHER
 * THAN A HALF-MEASURE.** Two reasons, and the second is the binding one:
 *
 *  - It is where the complaint lives. A user reads mail in the Inbox,
 *    replies, and the reply lands in Sent — so the Inbox is the one list
 *    whose conversations are systematically missing the user's own half.
 *    Browsing Sent already shows nothing but the user's own mail, so a
 *    union with Sent there is a no-op by definition.
 *  - The CLIENT has to be able to tell a widened member from a native
 *    one, because the representative, the list order and every bulk
 *    action must keep coming from the folder actually being browsed
 *    (../db.ts's getConversationPage). `INBOX` is the single mailbox name
 *    RFC 3501 reserves and the one the client can therefore recognise
 *    without being told — see the client's `conversations.ts`. Widening
 *    Archive or All Mail would hand the client members it cannot
 *    classify, because those names are per-account discovery results.
 *
 * A SEARCH IS NEVER WIDENED. Under `q` a conversation is the MATCHING
 * messages of a thread and the count means exactly that; quietly adding
 * non-matching Sent mail would make the number describe something else.
 *
 * An account whose Sent folder was never discovered contributes no pair,
 * so `resolveFolderFilter` hands back an EMPTY 'pairs' — which matches
 * zero rows. Returning `undefined` for that case rather than a union with
 * a false branch keeps the query byte-identical to the un-widened one
 * whenever there is nothing to widen with.
 */
function resolveMemberFolder(
  raw: string | null,
  hasQuery: boolean,
  folder: InboxFolderFilter,
  accountFilter: string | null,
  accounts: readonly AccountConfig[],
  pool: ConnectionPool,
): InboxFolderFilter | undefined {
  if (hasQuery) return undefined;
  if (parseFolderParam(raw) !== 'inbox') return undefined;

  const sent = resolveFolderFilter('sent', accountFilter, accounts, pool);
  if (sent.kind === 'pairs' && sent.pairs.length === 0) return undefined;
  return { kind: 'any', of: [folder, sent] };
}

export async function handleConversations(
  db: Db,
  pool: ConnectionPool,
  accounts: readonly AccountConfig[],
  url: URL,
): Promise<Response> {
  const rawQuery = url.searchParams.get('q');
  // An ABSENT `q` is the ungrouped-inbox request and is not a search at
  // all; an EMPTY-OR-BLANK `q` is a search box the user has cleared, and
  // this route treats it as the former rather than 400ing the way
  // /api/search does — the client debounces its box and would otherwise
  // fire one 400 per cleared query. An over-long one is still refused,
  // because that is a bound on work rather than a spelling of "no
  // search".
  const parsedQuery = rawQuery === null ? null : parseQueryParam(rawQuery);
  if (parsedQuery?.kind === 'too-long') return json({ error: QUERY_TOO_LONG_ERROR }, 400);
  const search = parsedQuery?.kind === 'ok' ? parsedQuery.query : null;

  const accountParam = parseAccountParam(url.searchParams.get('account'), accounts);
  if (accountParam === undefined) return json({ error: INVALID_ACCOUNT_ERROR }, 400);

  const folder = resolveFolder(
    url.searchParams.get('folder'),
    search !== null,
    accountParam,
    accounts,
    pool,
  );
  if (folder === 'invalid') return json({ error: INVALID_FOLDER_ERROR }, 400);

  const limit = parseLimit(url.searchParams.get('limit'));
  const cursor = parseInboxCursor(url);

  const page = await db.getConversationPage({
    limit,
    cursor,
    folder,
    memberFolder: resolveMemberFolder(
      url.searchParams.get('folder'),
      search !== null,
      folder,
      accountParam,
      accounts,
      pool,
    ),
    accountId: accountParam,
    search,
  });

  // FROM `representatives`, NEVER FROM `messages`. The last row of
  // `messages` is the OLDEST message of the last conversation on this
  // page; a cursor built from it would resume paging INSIDE a thread the
  // client already holds whole, and every subsequent page would re-send
  // its tail. `representatives` is one row per conversation in page
  // order, so its last row is exactly the position the next page must
  // start after — and `limit` counts the same things it does, which is
  // what keeps nextCursorFrom's short-page test honest.
  return json(
    { messages: page.messages, nextCursor: nextCursorFrom(page.representatives, limit) },
    200,
    PRIVATE_NO_STORE,
  );
}
