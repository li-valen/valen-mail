import { DEFAULT_FOLDER } from './inboxFilters';
import type { FolderId } from './inboxFilters';
import { clampSearchQuery } from './searchQuery';
import type { InboxCursor } from './api';

/**
 * The wire half of the collapsed list: how a {query, folder, account,
 * cursor} selection becomes GET /api/conversations's query string.
 *
 * **WHY THIS IS A THIRD BUILDER AND NOT A FLAG ON EITHER OF THE OTHER
 * TWO.** /api/conversations stands in for /api/inbox AND /api/search, and
 * those two disagree about exactly one thing, in the direction that fails
 * silently: an absent `folder` means INBOX to one and EVERY FOLDER to the
 * other (see ./searchQuery.ts's header). The route inherits that dual
 * default — it has to, or a grouped search would answer from a different
 * result set than the ungrouped one.
 *
 * So this builder **always sends `folder`**, default included, exactly as
 * `buildSearchParams` does and unlike `buildInboxParams`, which omits the
 * default because it is redundant on its own route. Sending it explicitly
 * means this client never depends on which default applies, and adding
 * `q` to a request can never silently widen it from the Inbox to the
 * whole mailbox.
 *
 * The two traps ./inboxFilters.ts documents apply here unchanged, because
 * the route calls the same `parseAccountParam` and the same
 * `parseInboxCursor`: an empty `account` is a 400, and a cursor carries
 * no memory of the filter it came from, so the two always travel
 * together.
 */

/** A conversation-page request. `q` absent (or blank) is the ordinary
 *  list; present, it is the grouped view of a search. */
export interface ConversationQuery {
  readonly q?: string;
  readonly folder?: FolderId;
  /** `null`/omitted/`''` = all accounts merged, and NEVER reaches the
   *  wire as an empty param. */
  readonly account?: string | null;
  readonly cursor?: InboxCursor | null;
  /** How many CONVERSATIONS — not messages. The response carries every
   *  message of each, so `messages.length` is normally larger. */
  readonly limit?: number;
}

/**
 * Encodes one conversation-page request as a query string (no leading
 * `?`).
 *
 * `q` is clamped by ./searchQuery.ts's `clampSearchQuery` — the same
 * function `buildSearchParams` uses, so an over-long paste is narrowed
 * identically on both routes — and is OMITTED when it clamps to nothing.
 * Omitting is right rather than sending `q=`: the route reads a blank
 * query as "not a search", and leaving the param off says the same thing
 * without depending on that leniency.
 *
 * Param order is fixed (q, limit, folder, account, then the three cursor
 * fields) purely so the output is a stable string a test can assert on
 * whole rather than by substring.
 */
export function buildConversationParams(query: ConversationQuery = {}): string {
  const params = new URLSearchParams();

  const search = clampSearchQuery(query.q ?? '');
  if (search !== '') params.set('q', search);

  if (query.limit !== undefined) params.set('limit', String(query.limit));

  // ALWAYS, default included — see this file's header. This is the one
  // line standing between "search the Inbox" and "search Spam and Trash
  // too", and the difference is answered with an ordinary 200.
  params.set('folder', query.folder ?? DEFAULT_FOLDER);

  const account = query.account ?? null;
  if (account !== null && account !== '') params.set('account', account);

  const cursor = query.cursor ?? null;
  if (cursor !== null) {
    if (cursor.before !== null) params.set('before', cursor.before);
    if (cursor.beforeAccount !== null) params.set('beforeAccount', cursor.beforeAccount);
    if (cursor.beforeUid !== null) params.set('beforeUid', cursor.beforeUid);
  }

  return params.toString();
}
