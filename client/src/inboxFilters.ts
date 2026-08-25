import type { InboxCursor } from './api';

/**
 * Folder + account filtering for GET /api/inbox (Plan 5 Task 3): what a
 * folder IS to this client, and the one function that turns a selection
 * into a query string.
 *
 * The server's half of this contract lives in sync/src/api/inbox.ts
 * (`parseFolderParam`, `parseAccountParam`, `resolveFolderFilter`). Three
 * things about it shape everything below, and each one fails SILENTLY —
 * no exception, no non-2xx, just the wrong mail — if the client gets it
 * wrong:
 *
 *  1. **`nextCursor` carries no filter identity.** It is derived purely
 *     from the last returned row (`nextCursorFrom`), so following one
 *     without re-sending `folder` and `account` pages into a DIFFERENT
 *     result set: `folder` defaults back to `inbox`, the response is a
 *     perfectly ordinary 200, and page 2 of Sent is page 2 of Inbox.
 *     That is why `buildInboxParams` takes the cursor and the filter in
 *     ONE argument — there is no way to encode a cursor here without
 *     encoding the filter it belongs to, so the mistake is not available
 *     to a call site rather than merely discouraged.
 *  2. **`?account=` (empty string) is a 400, not "all accounts".**
 *     `parseAccountParam` reads only an ABSENT param as "all"; the empty
 *     string matches no configured id and is refused. So the reflexive
 *     `params.set('account', selected ?? '')` breaks the DEFAULT view on
 *     first paint. The param is omitted entirely instead.
 *  3. **`folder` absent means `inbox`.** `parseFolderParam(null)` returns
 *     'inbox', so this module OMITS the default rather than sending it —
 *     one wire spelling per selection, and the commonest request is the
 *     shortest. Stated here because "omitted or explicit" is a real fork
 *     and consistency is the only thing that makes the query strings in
 *     tests/inbox-filters.test.ts predictable.
 */

/** The five values GET /api/inbox understands, in the order the sidebar
 *  lists them. Mirrors sync/src/api/inbox.ts's FOLDER_PARAM_VALUES; the
 *  ORDER here is a UI decision (Starred sits second, where a mail client
 *  reader expects it), the SET is the wire contract. */
export const FOLDER_IDS = ['inbox', 'starred', 'sent', 'spam', 'trash'] as const;

export type FolderId = (typeof FOLDER_IDS)[number];

/** The server's own default, and therefore the value this module omits. */
export const DEFAULT_FOLDER: FolderId = 'inbox';

export const FOLDER_LABELS: Readonly<Record<FolderId, string>> = {
  inbox: 'Inbox',
  starred: 'Starred',
  sent: 'Sent',
  spam: 'Spam',
  trash: 'Trash',
};

/**
 * The two selections that together decide which mail the list shows. They
 * are ORTHOGONAL: `{ folder: 'sent', account: 'harvard' }` is a valid and
 * expected combination, and changing one must never reset the other.
 *
 * `account: null` is "all accounts merged" — the default, and the one
 * value that must reach the wire as an ABSENT param rather than an empty
 * one (trap 2 above).
 */
export interface InboxFilter {
  readonly folder: FolderId;
  readonly account: string | null;
}

export const DEFAULT_FILTER: InboxFilter = { folder: DEFAULT_FOLDER, account: null };

/** A filter plus the request-shaped extras GET /api/inbox also takes.
 *  Every field optional so the default selection is `buildInboxParams({})`. */
export interface InboxQuery {
  readonly folder?: FolderId;
  readonly account?: string | null;
  readonly cursor?: InboxCursor | null;
  readonly limit?: number;
}

/**
 * Encodes one inbox request as a query string (no leading `?`).
 *
 * Param order is fixed — limit, folder, account, then the three cursor
 * fields — purely so the output is a stable string a test can assert on
 * whole rather than by substring.
 *
 * The cursor's three fields are forwarded exactly as received and never
 * reconstructed from a row: `before` is null on the NULL-date tail (rows
 * with no Date header, which sort last) and that shape has to survive the
 * round trip or those rows become unreachable by paging. See api.ts's
 * `InboxCursor` for the full contract.
 */
export function buildInboxParams(query: InboxQuery = {}): string {
  const params = new URLSearchParams();

  if (query.limit !== undefined) params.set('limit', String(query.limit));

  const folder = query.folder ?? DEFAULT_FOLDER;
  if (folder !== DEFAULT_FOLDER) params.set('folder', folder);

  // Trap 2: `null` AND `''` both mean "all accounts" and both omit the
  // param. The empty string is checked explicitly rather than trusted not
  // to arrive — it is exactly what the `?? ''` idiom this comment exists
  // to prevent would hand us, and a 400 on the default view is the
  // costliest possible place to find out.
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

/**
 * What the view is currently showing, as one line — AppShell's `<h1>` and,
 * below `lg:` where the sidebar is a closed drawer, the only visible
 * answer to "which folder am I in?".
 */
export function headingFor(folder: FolderId, account: string | null): string {
  const label = FOLDER_LABELS[folder];
  return account === null ? label : `${label} — ${account}`;
}
