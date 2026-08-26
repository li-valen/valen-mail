import { readFileSync } from 'node:fs';
import pg from 'pg';

/** Small fixed pool for the API and sync workers to share; comfortably under
 *  Postgres's default max_connections regardless of how many mail accounts
 *  are configured, since IMAP connections are separate from this pool. */
const MAX_POOL_SIZE = 4;

/** Defensive truncation applied to `snippet` at the write path, independent
 *  of normalize.ts's own truncation to SNIPPET_CHARS (280).
 *
 *  LIVE as of Plan 7 Task 1, which added the bounded partial PEEK fetch
 *  that finally populates this column.
 *
 *  It is NOT a CHECK constraint: a constraint would reject the whole insert
 *  on a caller bug, silently halting sync for that message; truncating here
 *  just bounds storage unconditionally, with no failure mode. Deliberately
 *  larger than 280 so a future change to the intended limit does not
 *  silently get masked by this one. */
const SNIPPET_MAX_LENGTH = 500;

export interface MessageInput {
  readonly accountId: string;
  readonly uid: number;
  readonly folder: string;
  readonly messageId: string | null;
  readonly threadId: string | null;
  readonly subject: string | null;
  readonly fromName: string | null;
  readonly fromEmail: string | null;
  readonly toEmails: readonly string[];
  readonly ccEmails: readonly string[];
  readonly date: Date | null;
  /** The message preview, or null when one could not be produced (no text
   *  part, a failed preview fetch, or a fragment that stripped down to
   *  nothing). Null NEVER erases a snippet a previous cycle stored — see
   *  upsertMessage's ON CONFLICT. */
  readonly snippet: string | null;
  readonly flags: readonly string[];
  readonly labels: readonly string[];
  readonly hasAttach: boolean;
  readonly sizeBytes: number | null;
}

/**
 * One row of attachment METADATA. Content is never stored: `partId` is the
 * IMAP BODYSTRUCTURE part number the API's attachment route uses to fetch
 * the bytes on demand. Without these rows a client has no way to discover a
 * partId, which makes /api/attachment/:account/:folder/:uid/:partId
 * unreachable — so persisting them is what turns the BODYSTRUCTURE walk
 * into a usable feature rather than discarded work.
 */
export interface AttachmentInput {
  readonly accountId: string;
  readonly folder: string;
  readonly uid: number;
  readonly partId: string;
  readonly filename: string | null;
  readonly mimeType: string;
  readonly sizeBytes: number | null;
}

/**
 * Keyset cursor for the unified inbox.
 *
 * `date` alone is not a usable pagination key: Gmail timestamps are
 * second-resolution and bulk deliveries share them, so a strict `date < $1`
 * silently drops every row that ties with the last row of the previous
 * page. `date` is also nullable, and a NULL sorts into its own tail that a
 * timestamp comparison can never address at all.
 *
 * - `accountId`/`uid` null => date-only cursor. Backward-tolerant handling
 *   for a client that still sends only a `before` timestamp; it filters
 *   correctly but remains tie-lossy, exactly as it always did.
 * - `date` null with `accountId`/`uid` set => the cursor is inside the
 *   NULL-date tail, which sorts last.
 */
export interface InboxCursor {
  readonly date: Date | null;
  readonly accountId: string | null;
  readonly uid: number | null;
}

export interface SyncStateInput {
  readonly uidValidity: bigint | null;
  /**
   * A watermark whose MEANING belongs to whichever subsystem owns the row,
   * not to this type — the column is one bigint and two callers use it
   * differently, so pinning a single meaning in the name would make one of
   * them a lie:
   *
   *  - imap/backfill.ts (a real account + folder) stores the lowest UID
   *    its backwards walk has covered. Everything at or above it is
   *    synced; the next page is the span immediately below it.
   *  - push/opens-poll.ts (its own reserved `__opens_poll__` pseudo-row)
   *    stores a millisecond timestamp instead, and says so.
   *
   * The two never collide: an account id is a configured mail account, and
   * `__opens_poll__` is not one.
   */
  readonly lastSeenUid: bigint;
  /**
   * True once imap/backfill.ts has walked this folder down to UID 1 and
   * there is no history left below it. Terminal: a folder marked done is
   * never paged again.
   */
  readonly backfillDone: boolean;
}

/**
 * One (account, native folder) pair — the output of translating a logical
 * folder name ('sent') into what `messages.folder` actually holds for ONE
 * account. Plain data: this module has no idea what 'sent' means or where
 * the native name came from (that is ./api/inbox.ts's job, one layer up,
 * reading the discovery imap/folders.ts produced) — it only knows how to
 * match rows against a list of these.
 */
export interface NativeFolderPair {
  readonly accountId: string;
  readonly folder: string;
}

/**
 * Resolved folder filter for getUnifiedInbox (Plan 5 Task 2), already
 * translated from the API's logical folder name ('inbox' | 'sent' |
 * 'spam' | 'trash' | 'starred') into whatever this query actually needs
 * to match against `messages`:
 *
 *  - 'all': no folder restriction at all — every synced folder. This is
 *    NOT one of the API's five logical values; it exists for callers that
 *    pre-date folder filtering (this module's own pre-Plan-5 tests) and
 *    genuinely want the old unfiltered behaviour. The live API always
 *    resolves to one of the three kinds below instead.
 *  - 'literal': `messages.folder = folder` exactly. Used for 'inbox' —
 *    INBOX is the one folder name RFC 3501 lets this service hardcode
 *    (see imap/folders.ts's own doc comment), so it needs no per-account
 *    resolution at all.
 *  - 'pairs': `(account_id, folder)` must match one of the given pairs.
 *    Used for 'sent' | 'spam' | 'trash': Gmail localises these names per
 *    account (`[Gmail]/Sent Mail` vs `[Gmail]/Отправленные`), so which
 *    native folder means "sent" can only be answered per account, from
 *    what that account's own IMAP LIST discovered. An account absent from
 *    `pairs` — its kind was never discovered, or an `account` filter
 *    excluded it — simply contributes no rows; an empty `pairs` array
 *    matches zero rows rather than being treated as "no filter".
 *  - 'starred': not a folder at all — matches the `\Flagged` flag across
 *    every synced folder instead (Plan 5: Starred is virtual and is never
 *    synced as its own mailbox — see imap/folders.ts).
 */
export type InboxFolderFilter =
  | { readonly kind: 'all' }
  | { readonly kind: 'literal'; readonly folder: string }
  | { readonly kind: 'pairs'; readonly pairs: readonly NativeFolderPair[] }
  | { readonly kind: 'starred' };

/**
 * One page of conversations, as two views of the same page.
 *
 * `messages` is FLAT and newest-first — byte-for-byte the ordering
 * GET /api/inbox already emits — because that is what lets the client
 * recover the conversations by first appearance without carrying a second
 * copy of INBOX_ORDER's comparator: in a newest-first list, the first row
 * of a conversation IS its newest message, so first-appearance order is
 * exactly conversation-by-recency order.
 *
 * `representatives` is one row per conversation, in the same order, and
 * exists for exactly one reason: the next cursor must address the next
 * CONVERSATION, so `nextCursorFrom` is handed this and never `messages`
 * (whose last row is the OLDEST message of the last conversation, and
 * would page the client back into a thread it has already been given).
 */
export interface ConversationPage {
  readonly messages: readonly any[];
  readonly representatives: readonly any[];
}

export interface Db {
  applySchema(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<any[]>;
  upsertMessage(message: MessageInput): Promise<void>;
  upsertAttachment(attachment: AttachmentInput): Promise<void>;
  /**
   * The subset of `uids` that ALREADY have a preview stored, in one round
   * trip on the primary key's own (account_id, folder, uid) prefix.
   *
   * This is what keeps the sync loop's re-poll of the newest 50 UIDs from
   * re-fetching 50 previews every cycle forever: the pool asks for the
   * complement of this set and nothing else. Asking Postgres rather than
   * tracking it in memory is deliberate — an in-memory set would forget
   * across a restart and re-fetch (and re-charge the byte budget for)
   * every visible message on the first cycle after every deploy.
   */
  findUidsWithSnippet(
    accountId: string,
    folder: string,
    uids: readonly number[],
  ): Promise<ReadonlySet<number>>;
  getUnifiedInbox(options: {
    limit: number;
    cursor: InboxCursor | null;
    folder: InboxFolderFilter;
    accountId: string | null;
    /** Plan 7 Task 1: GET /api/search's free-text filter, applied on top
     *  of — never instead of — the folder/account/cursor filters above, so
     *  a search inherits the inbox's exact ordering and pagination. Absent
     *  or null for an ordinary inbox read. */
    search?: string | null;
  }): Promise<any[]>;
  /**
   * ONE PAGE OF CONVERSATIONS, whole — the query behind
   * GET /api/conversations.
   *
   * The difference from getUnifiedInbox above is what `limit` counts.
   * There it is messages; here it is CONVERSATIONS, and every message of
   * every conversation on the page comes back with it. That is the whole
   * point: a client that paginated by message could never draw a
   * collapsed conversation honestly, because the page boundary would cut
   * threads in half and the count beside a row would grow every time the
   * user pressed "Load more".
   *
   * A CONVERSATION IS SCOPED BY THE FILTER, not by the mailbox. Under
   * `folder=inbox` it is the messages of one thread that are IN THE
   * INBOX; the same thread's Sent copies are a different conversation in
   * a different list, and are neither counted here nor archived when the
   * user archives this one. Under a search it is the MATCHING messages of
   * one thread, so the result count means what it says.
   */
  getConversationPage(options: {
    /** How many CONVERSATIONS, not how many messages. */
    limit: number;
    cursor: InboxCursor | null;
    folder: InboxFolderFilter;
    accountId: string | null;
    search?: string | null;
  }): Promise<ConversationPage>;
  getThread(threadId: string): Promise<any[]>;
  /**
   * The lowest UID currently stored for one (account, folder), or null
   * when nothing has been synced there yet.
   *
   * This is where the historical backfill starts its FIRST page (Plan 8
   * Task 1): live sync's newest-50 poll has already covered
   * [oldest, newest], so the walk backwards begins immediately below the
   * oldest row and leaves no gap. Every later page uses the persisted
   * watermark instead — see imap/backfill.ts's backfillFloor.
   *
   * A `min()` on the primary key's own (account_id, folder, uid) prefix,
   * so it is an index probe rather than a scan however deep the mailbox
   * eventually gets.
   */
  getOldestSyncedUid(accountId: string, folder: string): Promise<number | null>;
  /**
   * The per-(account, folder) resume point. LIVE as of Plan 8 Task 1,
   * which finally reads and writes it: imap/backfill.ts persists a
   * watermark after every page so a restart resumes the walk instead of
   * restarting it, and flips `backfillDone` when the walk reaches UID 1.
   */
  getSyncState(accountId: string, folder: string): Promise<SyncStateInput | null>;
  /** See getSyncState above. */
  setSyncState(accountId: string, folder: string, state: SyncStateInput): Promise<void>;
  /**
   * Applies ONE already-committed IMAP flag change to the stored row, so
   * the change survives until the next sync cycle re-reads the real flags
   * off the server.
   *
   * Called only AFTER the IMAP write succeeded (see api/flags.ts) — this
   * is a cache repair, never the source of truth, and it must never run
   * optimistically ahead of the remote write. Without it the row reverts
   * to bold on the next poll and the user watches a message they just
   * opened mark itself unread again.
   *
   * Idempotent in both directions, and deliberately not a
   * read-modify-write: adding a flag the row already carries and removing
   * one it does not are both no-ops inside a single UPDATE, so there is no
   * window between reading the array and writing it back for a concurrent
   * sync cycle's `upsertMessage` to fall into.
   *
   * Returns true when a row was updated, false when none matched — a
   * message the API can address on the server but which this store has
   * never synced (an old UID below the backfill watermark) is a real,
   * non-exceptional case, and the remote write still stands.
   */
  updateStoredFlag(
    accountId: string,
    folder: string,
    uid: number,
    flag: string,
    value: boolean,
  ): Promise<boolean>;
  /**
   * Drops the CACHED ROW for a message that has been moved out of a
   * folder — not the message, which is untouched on the server and, for
   * an archive, is still sitting in All Mail.
   *
   * **This is a cache repair, and it is not optional.** The sync loop
   * only ever fetches the newest UIDs per folder and upserts them
   * (imap/fetch.ts); nothing in it notices that a message has LEFT a
   * folder, so without this the archived message would come back into the
   * list on the next page load and stay there permanently. The client
   * removes the row optimistically; this is what makes the removal
   * survive a refresh.
   *
   * Called only AFTER the IMAP move succeeded (see api/move.ts), exactly
   * like `updateStoredFlag` above: never optimistically ahead of the
   * remote write, because a row deleted for a move that did not happen is
   * a message the user can no longer see and no longer act on.
   *
   * `attachments` cascades from `messages` on this key (see schema.sql),
   * so the attachment metadata for the moved message goes with it and
   * comes back on the next sync of whichever folder now holds it.
   *
   * Returns true when a row was removed, false when none matched — a
   * message the API can address on the server but which this store never
   * synced (an old UID below the backfill watermark) is a real,
   * non-exceptional case, and the remote move still stands.
   */
  deleteStoredMessage(accountId: string, folder: string, uid: number): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Message columns plus the message's attachment metadata as a JSON array,
 * so /api/inbox and /api/thread hand a client the `partId` values it needs
 * to address the attachment route. LEFT JOIN LATERAL rather than a second
 * round trip: a page is at most MAX_LIMIT rows, and the aggregate probes
 * `attachments` on its primary-key prefix (account_id, folder, uid).
 *
 * `coalesce(..., '[]'::json)` matters — json_agg over zero rows returns
 * NULL, and a client should see an empty array for a message with no
 * attachments, not a null.
 */
const MESSAGE_SELECT = `
  select m.*, coalesce(agg.attachments, '[]'::json) as attachments
  from messages m
  left join lateral (
    select json_agg(
             json_build_object(
               'partId', att.part_id,
               'filename', att.filename,
               'mimeType', att.mime_type,
               'sizeBytes', att.size_bytes
             ) order by att.part_id
           ) as attachments
    from attachments att
    where att.account_id = m.account_id
      and att.folder = m.folder
      and att.uid = m.uid
  ) agg on true`;

/**
 * Total order for the unified inbox. Three things are load-bearing here:
 *
 *  - `coalesce(date, '-infinity')` puts NULL-date messages LAST. A bare
 *    `order by date desc` defaults to NULLS FIRST in Postgres, which pinned
 *    every message with an unparseable `Date:` header above all real mail,
 *    permanently.
 *  - `account_id, uid` break ties. Gmail timestamps are second-resolution
 *    and bulk deliveries share one, so without a tiebreaker the row order
 *    within a second is undefined and a paginated client can miss rows.
 *  - Every column descends, so the cursor below can be a single row-value
 *    comparison rather than a hand-expanded OR chain.
 *
 * Must stay identical to messages_unified_keyset in schema.sql.
 */
export const INBOX_ORDER =
  `order by coalesce(m.date, '-infinity'::timestamptz) desc, m.account_id desc, m.uid desc`;

interface InboxFilter {
  readonly where: string;
  readonly values: readonly unknown[];
}

/**
 * Which table alias a clause is written against, and how many bound
 * parameters already exist in the statement it is being appended to.
 *
 * BOTH EXIST FOR ONE CALLER: getConversationPage, which composes TWO
 * filters into a SINGLE statement — one over the candidate row (`m`) and
 * one over its own thread siblings (`sib`) inside a correlated
 * subquery. Without `alias` the sibling test would silently be written
 * against the outer row and match everything; without `offset` the second
 * filter's placeholders would restart at $1 and read the FIRST filter's
 * values. Both failures produce a query that runs and returns wrong rows,
 * which is why the two are one type and always travel together.
 *
 * Defaulted (`m`, 0) so every pre-existing caller is unchanged — see
 * buildInboxFilter.
 */
interface FilterContext {
  readonly alias: string;
  readonly offset: number;
}

/**
 * Appends the cursor's clause (if any) to `clauses`/`values` in place.
 *
 * Placeholder numbers are derived from `values.push(...)`'s own return
 * value (the new array length) rather than hardcoded — Plan 5 Task 2 added
 * two more clauses that can each contribute a variable number of
 * parameters ahead of or behind this one, so a hardcoded $1/$2/$3 here
 * would silently misnumber the moment folder/account filtering also
 * pushed values. Reading the index off `push`'s return immediately after
 * each push is what keeps every clause correct regardless of what runs
 * before or after it.
 */
function pushCursorClause(
  clauses: string[],
  values: unknown[],
  cursor: InboxCursor | null,
  ctx: FilterContext,
): void {
  if (!cursor) return;
  const { alias, offset } = ctx;

  if (cursor.accountId !== null && cursor.uid !== null) {
    const dateIdx = offset + values.push(cursor.date);
    const acctIdx = offset + values.push(cursor.accountId);
    const uidIdx = offset + values.push(cursor.uid);
    clauses.push(
      `(coalesce(${alias}.date, '-infinity'::timestamptz), ${alias}.account_id, ${alias}.uid) ` +
      `< (coalesce($${dateIdx}::timestamptz, '-infinity'::timestamptz), $${acctIdx}::text, $${uidIdx}::bigint)`,
    );
    return;
  }

  if (cursor.date !== null) {
    const dateIdx = offset + values.push(cursor.date);
    clauses.push(`coalesce(${alias}.date, '-infinity'::timestamptz) < $${dateIdx}::timestamptz`);
  }
}

/**
 * Appends the folder clause (Plan 5 Task 2) to `clauses`/`values` in
 * place. Every branch is fully parameterized — including the 'pairs'
 * branch's (account_id, folder) mapping, which is exactly the
 * logical-to-native-folder translation this task exists to make real
 * rather than hardcoded. See InboxFolderFilter's own doc comment for what
 * each kind means.
 *
 * `unnest($n::text[], $m::text[])` zips the two arrays positionally into
 * (account_id, folder) rows — standard Postgres, not string-built SQL: the
 * number of accounts never changes the SHAPE of the query, only the
 * length of the two array parameters, which is what keeps this safe
 * against however many accounts are configured (bounded by
 * config.ts's MAX_ACCOUNTS regardless).
 *
 * An empty `pairs` array (no account has a discovered native folder for
 * this kind) renders as the literal `false` — the query still runs and
 * still returns 200 with zero rows, not a WHERE-less scan of the whole
 * table and not a thrown error.
 */
function pushFolderClause(
  clauses: string[],
  values: unknown[],
  folder: InboxFolderFilter,
  ctx: FilterContext,
): void {
  const { alias, offset } = ctx;
  if (folder.kind === 'all') return;

  if (folder.kind === 'starred') {
    // Bound, not inlined, even though this value is a compile-time
    // constant with no injection surface: an inlined `'\Flagged'` string
    // literal's meaning depends on the `standard_conforming_strings` GUC
    // (on by default, but not guaranteed) — if it were ever off, the
    // backslash would be read as an escape-string escape character
    // instead of a literal one, and this clause would silently stop
    // matching any row (starred returns empty, not an error). A bound
    // parameter's value is never subject to that parsing at all, which is
    // what makes this immune to the GUC rather than dependent on it.
    const idx = offset + values.push('\\Flagged');
    clauses.push(`$${idx} = any(${alias}.flags)`);
    return;
  }

  if (folder.kind === 'literal') {
    const idx = offset + values.push(folder.folder);
    clauses.push(`${alias}.folder = $${idx}`);
    return;
  }

  if (folder.pairs.length === 0) {
    clauses.push('false');
    return;
  }
  const accountIds = folder.pairs.map((pair) => pair.accountId);
  const nativeFolders = folder.pairs.map((pair) => pair.folder);
  const acctIdx = offset + values.push(accountIds);
  const folderIdx = offset + values.push(nativeFolders);
  clauses.push(
    `exists (` +
      `select 1 from unnest($${acctIdx}::text[], $${folderIdx}::text[]) as pair(account_id, folder) ` +
      `where pair.account_id = ${alias}.account_id and pair.folder = ${alias}.folder` +
    `)`,
  );
}

/** Appends the `account` filter (Plan 5 Task 2) — independent of, and
 *  composable with, whichever folder clause pushFolderClause added. */
function pushAccountClause(
  clauses: string[],
  values: unknown[],
  accountId: string | null,
  ctx: FilterContext,
): void {
  if (accountId === null) return;
  const idx = ctx.offset + values.push(accountId);
  clauses.push(`${ctx.alias}.account_id = $${idx}`);
}

/** The columns GET /api/search looks in. Snippet is one of them, which is
 *  what makes previews searchable and not merely decorative — and also why
 *  a row synced before Plan 7 Task 1 (snippet still NULL) can only ever
 *  match on the other three. */
const SEARCH_COLUMNS = ['subject', 'from_name', 'from_email', 'snippet'] as const;

/**
 * Escapes the three characters LIKE/ILIKE treat as syntax, so a user
 * searching for `100%` gets messages containing "100%" rather than every
 * message in the mailbox, and `a_b` does not also match `axb`.
 *
 * Backslash is escaped FIRST — reversing the order would double-escape the
 * backslashes this function itself just introduced.
 *
 * No `ESCAPE` clause accompanies this in the SQL, deliberately: backslash
 * is LIKE's default escape character regardless of any GUC, and writing
 * `escape '\'` would put a backslash inside a SQL STRING LITERAL, whose
 * meaning genuinely does depend on `standard_conforming_strings` (the same
 * hazard pushFolderClause documents for '\Flagged'). The pattern itself
 * travels as a bound parameter and is never parsed as a literal at all.
 */
export function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Appends the free-text search clause (Plan 7 Task 1): a case-insensitive
 * substring match across SEARCH_COLUMNS.
 *
 * ILIKE rather than a tsvector column, a GIN index or an extension — at
 * 461 rows on a personal mailbox a sequential scan is microseconds, and a
 * migration for full-text search nobody asked for would cost more than it
 * buys. Revisit if this mailbox ever grows two orders of magnitude.
 *
 * ONE bound parameter referenced four times, not four copies: the pattern
 * is identical for every column, and a single placeholder makes it
 * impossible for the escaping to be applied to three of them and forgotten
 * on the fourth.
 *
 * A NULL column yields NULL from ILIKE, which the surrounding OR treats as
 * "no match" — the correct answer for a message with no subject, and the
 * reason no coalesce is needed here.
 */
function pushSearchClause(
  clauses: string[],
  values: unknown[],
  search: string | null,
  ctx: FilterContext,
): void {
  if (search === null) return;
  const idx = ctx.offset + values.push(`%${escapeLikePattern(search)}%`);
  clauses.push(
    `(${SEARCH_COLUMNS.map((column) => `${ctx.alias}.${column} ilike $${idx}`).join(' or ')})`,
  );
}

/**
 * Builds the WHERE clause and bound values shared by GET /api/inbox and
 * GET /api/search. Exported for tests/db-filter.test.ts, which asserts the
 * generated SQL and parameters directly — the only way to prove
 * parameterization and wildcard escaping without a live Postgres, since
 * every db.test.ts case is skipped when TEST_DATABASE_URL is unset.
 *
 * Every clause derives its placeholder number from `values.push()`'s
 * return, so the four are composable in any combination without any of
 * them knowing what the others pushed.
 */
export function buildInboxFilter(options: {
  readonly cursor: InboxCursor | null;
  readonly folder: InboxFolderFilter;
  readonly accountId: string | null;
  readonly search?: string | null;
  /** The table alias these clauses address. Defaults to `m`, which is
   *  what MESSAGE_SELECT names the `messages` table. */
  readonly alias?: string;
  /** How many parameters the surrounding statement has already bound, so
   *  this filter's placeholders continue from there rather than
   *  restarting at $1. Defaults to 0. */
  readonly offset?: number;
}): InboxFilter {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const ctx: FilterContext = { alias: options.alias ?? 'm', offset: options.offset ?? 0 };

  pushCursorClause(clauses, values, options.cursor, ctx);
  pushFolderClause(clauses, values, options.folder, ctx);
  pushAccountClause(clauses, values, options.accountId, ctx);
  pushSearchClause(clauses, values, options.search ?? null, ctx);

  const where = clauses.length > 0 ? `where ${clauses.join(' and ')}` : '';
  return { where, values };
}

/**
 * Appends one more clause to a WHERE built by buildInboxFilter, whether
 * or not it produced any clauses of its own.
 *
 * A three-line helper rather than an inline ternary at each call site
 * because the empty case is the one that breaks: `'' + ' and (…)'` is
 * `" and (…)"`, which is a syntax error, and it only happens for a
 * request with no folder, no account, no search and no cursor — i.e. the
 * one shape a hand-written test is least likely to cover.
 */
function andClause(where: string, clause: string): string {
  return where === '' ? `where ${clause}` : `${where} and ${clause}`;
}

/**
 * THE CONVERSATION KEY, IN SQL — and the `account_id` beside it in every
 * comparison is not decoration.
 *
 * `thread_id` is Gmail's own X-GM-THRID, a decimal counter allocated
 * PER MAILBOX. Two of this user's four accounts can therefore hold the
 * same thread id for two entirely unrelated conversations, and a grouping
 * keyed on `thread_id` alone would merge a Harvard advising thread into a
 * personal one — then archive both together when the user archived what
 * looked like one row. Every use of this expression is paired with an
 * `account_id` equality; there is no code path where it stands alone.
 *
 * A NULL `thread_id` becomes the message's OWN key rather than joining
 * one giant null bucket: a message the sync path never learned a thread
 * for is a conversation of one, not a conversation with every other
 * unthreaded message in the mailbox. The `t`/`u` prefix makes the two
 * spaces disjoint, so no real thread id can ever collide with a
 * synthesised one.
 */
function conversationKey(alias: string): string {
  return `(case when ${alias}.thread_id is null then 'u' || ${alias}.uid else 't' || ${alias}.thread_id end)`;
}

export function openDb(databaseUrl: string): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: MAX_POOL_SIZE });

  // A dropped connection on an otherwise-idle pooled client surfaces as an
  // 'error' event; without a listener that is an unhandled event that
  // crashes the whole process. Log it with context instead of letting the
  // service die on a transient network blip.
  pool.on('error', (err) => {
    console.error('[sync/db] unexpected error on idle client', err);
  });

  return {
    async applySchema() {
      const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
      await pool.query(sql);
    },

    async query(text, values = []) {
      const result = await pool.query(text, values as unknown[]);
      return result.rows;
    },

    async upsertMessage(m) {
      await pool.query(
        `insert into messages (account_id, uid, folder, message_id, thread_id, subject,
           from_name, from_email, to_emails, cc_emails, date, snippet, flags, labels,
           has_attach, size_bytes)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,left($12, ${SNIPPET_MAX_LENGTH}),$13,$14,$15,$16)
         on conflict (account_id, folder, uid) do update set
           subject=excluded.subject, flags=excluded.flags, labels=excluded.labels,
           -- coalesce, NOT excluded.snippet: the sync loop re-polls the
           -- newest 50 UIDs every cycle, and only asks for a preview for a
           -- message that has none stored yet (see findUidsWithSnippet), so
           -- every one of those re-polls arrives here carrying snippet=NULL.
           -- A plain excluded.snippet would wipe a perfectly good preview on
           -- the very next cycle and leave the column empty forever. This
           -- also makes a FAILED preview fetch harmless: it writes NULL,
           -- which now means "no new preview", not "erase the old one".
           snippet=coalesce(excluded.snippet, messages.snippet),
           -- synced_at is deliberately absent from this SET list. It
           -- records when this row was FIRST written — the moment Postbox
           -- learned the message existed — and the newest 50 UIDs arrive
           -- here again every cycle, so touching it would overwrite the
           -- one measurement it exists to preserve.
           has_attach=excluded.has_attach`,
        [m.accountId, m.uid, m.folder, m.messageId, m.threadId, m.subject, m.fromName,
         m.fromEmail, m.toEmails, m.ccEmails, m.date, m.snippet, m.flags, m.labels,
         m.hasAttach, m.sizeBytes],
      );
    },

    async upsertAttachment(a) {
      // Idempotent on the composite key so a re-poll of the same UID (the
      // sync loop re-fetches the newest 50 every cycle) rewrites the row
      // rather than conflicting. The FK to messages means the message row
      // must be written first — see ConnectionPool.syncOnce.
      await pool.query(
        `insert into attachments (account_id, folder, uid, part_id, filename, mime_type, size_bytes)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (account_id, folder, uid, part_id) do update set
           filename=excluded.filename, mime_type=excluded.mime_type,
           size_bytes=excluded.size_bytes`,
        [a.accountId, a.folder, a.uid, a.partId, a.filename, a.mimeType, a.sizeBytes],
      );
    },

    async findUidsWithSnippet(accountId, folder, uids) {
      if (uids.length === 0) return new Set();
      const result = await pool.query(
        `select uid from messages
         where account_id = $1 and folder = $2 and uid = any($3::bigint[]) and snippet is not null`,
        [accountId, folder, uids],
      );
      // pg hands bigint columns back as strings to avoid silent precision
      // loss; UIDs are uint32 by RFC 3501, so Number() is lossless here and
      // keeps the returned set comparable to the numeric uids the caller
      // holds.
      return new Set(result.rows.map((row) => Number(row.uid)));
    },

    async getUnifiedInbox({ limit, cursor, folder, accountId, search }) {
      const filter = buildInboxFilter({ cursor, folder, accountId, search });
      const limitPlaceholder = `$${filter.values.length + 1}`;
      const result = await pool.query(
        `${MESSAGE_SELECT} ${filter.where} ${INBOX_ORDER} limit ${limitPlaceholder}`,
        [...filter.values, limit],
      );
      return result.rows;
    },

    async getConversationPage({ limit, cursor, folder, accountId, search }) {
      // Two filters over the SAME statement. The first narrows the
      // candidate rows (`m`); the second re-applies the folder and search
      // narrowing to the sibling probe (`sib`), and leaving it off is a
      // data-loss bug rather than a slow query: a thread whose newest
      // message sits in Sent would disqualify its INBOX messages one by
      // one and the whole conversation would vanish from the inbox.
      //
      // `offset` continues the sibling filter's placeholders past the
      // first filter's, which is what lets both live in one `values`
      // array. `accountId` is deliberately NOT re-applied to `sib` — the
      // subquery already joins on `sib.account_id = m.account_id`, so a
      // second copy would bind a parameter for a clause that can never
      // change the answer.
      const rowFilter = buildInboxFilter({ cursor, folder, accountId, search });
      const siblingFilter = buildInboxFilter({
        cursor: null,
        folder,
        accountId: null,
        search,
        alias: 'sib',
        offset: rowFilter.values.length,
      });

      /*
       * THE REPRESENTATIVE TEST, and why it is an anti-join rather than a
       * GROUP BY.
       *
       * A row is its conversation's representative exactly when no OTHER
       * message of the same conversation is newer. Written that way the
       * query never aggregates: it walks messages_unified_keyset in the
       * order it is already stored, probes messages_thread once per
       * candidate (an index seek into that one thread), and stops as soon
       * as it has `limit` survivors. Measured against this user's real
       * 41,151-row inbox: 5ms for page one, 0.24ms for a page ten months
       * deep. The GROUP BY formulation has to aggregate and sort all
       * 40,216 conversations before it can return the first fifty, on
       * every page, forever.
       *
       * It also composes with the existing cursor for free. The
       * conversation's sort key IS its representative's own row sort key,
       * so `nextCursorFrom` needs no new shape and the client's paging
       * code needs no change at all.
       *
       * A NULL thread_id short-circuits: such a message is a conversation
       * of one (see conversationKey), so it is always its own
       * representative and needs no probe.
       */
      const isRepresentative =
        `(m.thread_id is null or not exists (` +
          `select 1 from messages sib ` +
          `where sib.account_id = m.account_id and sib.thread_id = m.thread_id ` +
            (siblingFilter.where === ''
              ? ''
              : `and ${siblingFilter.where.slice('where '.length)} `) +
            `and (coalesce(sib.date, '-infinity'::timestamptz), sib.uid) ` +
              `> (coalesce(m.date, '-infinity'::timestamptz), m.uid)` +
        `))`;

      const repValues = [...rowFilter.values, ...siblingFilter.values];
      const repResult = await pool.query(
        `select m.account_id, m.folder, m.uid, m.thread_id, m.date from messages m ` +
          `${andClause(rowFilter.where, isRepresentative)} ${INBOX_ORDER} ` +
          `limit $${repValues.length + 1}`,
        [...repValues, limit],
      );
      const representatives = repResult.rows;
      if (representatives.length === 0) return { messages: [], representatives };

      // The members, in ONE round trip keyed on the page's own
      // (account_id, thread_key) pairs. Zipped positionally by unnest
      // rather than built into the SQL text — the number of conversations
      // changes the LENGTH of two bound arrays and never the shape of the
      // statement, which is the same discipline pushFolderClause uses for
      // (account, folder) pairs.
      //
      // The cursor is deliberately absent from this filter: a
      // conversation's older messages are exactly the rows a cursor would
      // exclude, and excluding them is what a partial thread IS.
      const memberFilter = buildInboxFilter({ cursor: null, folder, accountId, search });
      const accountIds = representatives.map((row: any) => String(row.account_id));
      const threadKeys = representatives.map((row: any) =>
        row.thread_id === null ? `u${row.uid}` : `t${row.thread_id}`,
      );
      const acctIdx = memberFilter.values.length + 1;
      const keyIdx = memberFilter.values.length + 2;
      const memberResult = await pool.query(
        `${MESSAGE_SELECT} ` +
          andClause(
            memberFilter.where,
            `exists (` +
              `select 1 from unnest($${acctIdx}::text[], $${keyIdx}::text[]) as conv(account_id, thread_key) ` +
              `where conv.account_id = m.account_id and conv.thread_key = ${conversationKey('m')}` +
            `)`,
          ) +
          ` ${INBOX_ORDER}`,
        [...memberFilter.values, accountIds, threadKeys],
      );

      return { messages: memberResult.rows, representatives };
    },

    async getThread(threadId) {
      // Ascending (oldest first) is the reading order for a conversation.
      // The same (account_id, uid) tiebreaker as the inbox keeps rows that
      // share a second in a stable order across requests.
      const result = await pool.query(
        `${MESSAGE_SELECT} where m.thread_id = $1
         order by coalesce(m.date, '-infinity'::timestamptz) asc, m.account_id asc, m.uid asc`,
        [threadId],
      );
      return result.rows;
    },

    async getOldestSyncedUid(accountId, folder) {
      const result = await pool.query(
        'select min(uid) as oldest from messages where account_id = $1 and folder = $2',
        [accountId, folder],
      );
      const oldest = result.rows[0]?.oldest;
      // min() over zero rows is SQL NULL, which is the "nothing synced
      // here yet" answer rather than an error. pg hands bigint back as a
      // string; UIDs are uint32 by RFC 3501, so Number() is lossless.
      return oldest === null || oldest === undefined ? null : Number(oldest);
    },

    async getSyncState(accountId, folder) {
      const result = await pool.query(
        'select uid_validity, last_seen_uid, backfill_done from sync_state where account_id=$1 and folder=$2',
        [accountId, folder],
      );
      const row = result.rows[0];
      if (!row) return null;
      // Postgres bigint columns come back from the driver as strings (to
      // avoid silent precision loss above 2^53); convert to bigint here, at
      // the one boundary where the string touches application code, so
      // nothing downstream ever sees a numeric string typed as a number.
      return {
        uidValidity: row.uid_validity === null ? null : BigInt(row.uid_validity),
        lastSeenUid: BigInt(row.last_seen_uid),
        backfillDone: row.backfill_done,
      };
    },

    async setSyncState(accountId, folder, state) {
      await pool.query(
        `insert into sync_state (account_id, folder, uid_validity, last_seen_uid, backfill_done, updated_at)
         values ($1,$2,$3,$4,$5,now())
         on conflict (account_id, folder) do update set
           uid_validity=excluded.uid_validity, last_seen_uid=excluded.last_seen_uid,
           backfill_done=excluded.backfill_done, updated_at=now()`,
        [accountId, folder, state.uidValidity?.toString() ?? null,
         state.lastSeenUid.toString(), state.backfillDone],
      );
    },

    async updateStoredFlag(accountId, folder, uid, flag, value) {
      // Fully parameterized, including the flag itself — never string-built
      // SQL from a route parameter. The flag is already constrained to two
      // literals by ../imap/flags.ts's WRITABLE_FLAGS, and it is bound here
      // anyway for the same reason pushFolderClause binds '\Flagged': an
      // inlined backslash literal's meaning depends on the
      // `standard_conforming_strings` GUC, and a bound parameter is never
      // subject to that parsing at all.
      //
      // The CASE is what makes this idempotent without a prior read:
      // array_append only when the flag is absent (so a repeat add cannot
      // produce `{\Seen,\Seen}`), array_remove unconditionally (already a
      // no-op when the flag is absent).
      const result = await pool.query(
        `update messages
            set flags = case
              when $5::boolean then
                case when $4::text = any(coalesce(flags, '{}'::text[]))
                     then flags
                     else array_append(coalesce(flags, '{}'::text[]), $4::text) end
              else array_remove(coalesce(flags, '{}'::text[]), $4::text)
            end
          where account_id = $1 and folder = $2 and uid = $3
          returning uid`,
        [accountId, folder, uid, flag, value],
      );
      return result.rows.length > 0;
    },

    async deleteStoredMessage(accountId, folder, uid) {
      // Parameterised, like every other statement here — never string-built
      // SQL from a route parameter, and `folder` on this path IS a route
      // parameter (Resolution 4).
      //
      // The three-column key is the whole predicate: this deletes ONE
      // message's row in ONE folder for ONE account, and there is no shape
      // of this call that can widen. No `folder = any(...)`, no uid range.
      const result = await pool.query(
        `delete from messages
          where account_id = $1 and folder = $2 and uid = $3
          returning uid`,
        [accountId, folder, uid],
      );
      return result.rows.length > 0;
    },

    async close() {
      await pool.end();
    },
  };
}
