import { readFileSync } from 'node:fs';
import pg from 'pg';

/** Small fixed pool for the API and sync workers to share; comfortably under
 *  Postgres's default max_connections regardless of how many mail accounts
 *  are configured, since IMAP connections are separate from this pool. */
const MAX_POOL_SIZE = 4;

/** Defensive truncation applied to `snippet` at the write path, independent
 *  of Task 3's own truncation to 280 chars.
 *
 *  NOT YET EXERCISED: `snippet` is always NULL in the shipped service —
 *  normalizeMessage() derives it from `raw.bodyText`, which the only
 *  producer (fetchHeaders) deliberately never fetches. This truncation is
 *  the write-path bound for a future task that does fetch a body prefix.
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
  /** Always null today — see SNIPPET_MAX_LENGTH above. */
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
  readonly lastSeenUid: bigint;
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

export interface Db {
  applySchema(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<any[]>;
  upsertMessage(message: MessageInput): Promise<void>;
  upsertAttachment(attachment: AttachmentInput): Promise<void>;
  getUnifiedInbox(options: {
    limit: number;
    cursor: InboxCursor | null;
    folder: InboxFolderFilter;
    accountId: string | null;
  }): Promise<any[]>;
  getThread(threadId: string): Promise<any[]>;
  /**
   * NOT YET WIRED: no production caller. `sync_state` exists as the
   * storage a future backfill will resume from; ConnectionPool.syncOnce
   * polls the newest 50 UIDs with no cursor instead (see schema.sql's
   * comment on the table, and spec 9 / L9).
   */
  getSyncState(accountId: string, folder: string): Promise<SyncStateInput | null>;
  /** NOT YET WIRED: no production caller. See getSyncState above. */
  setSyncState(accountId: string, folder: string, state: SyncStateInput): Promise<void>;
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
const INBOX_ORDER =
  `order by coalesce(m.date, '-infinity'::timestamptz) desc, m.account_id desc, m.uid desc`;

interface InboxFilter {
  readonly where: string;
  readonly values: readonly unknown[];
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
function pushCursorClause(clauses: string[], values: unknown[], cursor: InboxCursor | null): void {
  if (!cursor) return;

  if (cursor.accountId !== null && cursor.uid !== null) {
    const dateIdx = values.push(cursor.date);
    const acctIdx = values.push(cursor.accountId);
    const uidIdx = values.push(cursor.uid);
    clauses.push(
      `(coalesce(m.date, '-infinity'::timestamptz), m.account_id, m.uid) ` +
      `< (coalesce($${dateIdx}::timestamptz, '-infinity'::timestamptz), $${acctIdx}::text, $${uidIdx}::bigint)`,
    );
    return;
  }

  if (cursor.date !== null) {
    const dateIdx = values.push(cursor.date);
    clauses.push(`coalesce(m.date, '-infinity'::timestamptz) < $${dateIdx}::timestamptz`);
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
function pushFolderClause(clauses: string[], values: unknown[], folder: InboxFolderFilter): void {
  if (folder.kind === 'all') return;

  if (folder.kind === 'starred') {
    // A fixed literal, never derived from request input, so it needs no
    // parameter placeholder — see the 'pairs' branch below for the clause
    // that actually carries user-influenced values.
    clauses.push(`'\\Flagged' = any(m.flags)`);
    return;
  }

  if (folder.kind === 'literal') {
    const idx = values.push(folder.folder);
    clauses.push(`m.folder = $${idx}`);
    return;
  }

  if (folder.pairs.length === 0) {
    clauses.push('false');
    return;
  }
  const accountIds = folder.pairs.map((pair) => pair.accountId);
  const nativeFolders = folder.pairs.map((pair) => pair.folder);
  const acctIdx = values.push(accountIds);
  const folderIdx = values.push(nativeFolders);
  clauses.push(
    `exists (` +
      `select 1 from unnest($${acctIdx}::text[], $${folderIdx}::text[]) as pair(account_id, folder) ` +
      `where pair.account_id = m.account_id and pair.folder = m.folder` +
    `)`,
  );
}

/** Appends the `account` filter (Plan 5 Task 2) — independent of, and
 *  composable with, whichever folder clause pushFolderClause added. */
function pushAccountClause(clauses: string[], values: unknown[], accountId: string | null): void {
  if (accountId === null) return;
  const idx = values.push(accountId);
  clauses.push(`m.account_id = $${idx}`);
}

function buildInboxFilter(
  cursor: InboxCursor | null,
  folder: InboxFolderFilter,
  accountId: string | null,
): InboxFilter {
  const clauses: string[] = [];
  const values: unknown[] = [];

  pushCursorClause(clauses, values, cursor);
  pushFolderClause(clauses, values, folder);
  pushAccountClause(clauses, values, accountId);

  const where = clauses.length > 0 ? `where ${clauses.join(' and ')}` : '';
  return { where, values };
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
           snippet=excluded.snippet, has_attach=excluded.has_attach`,
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

    async getUnifiedInbox({ limit, cursor, folder, accountId }) {
      const filter = buildInboxFilter(cursor, folder, accountId);
      const limitPlaceholder = `$${filter.values.length + 1}`;
      const result = await pool.query(
        `${MESSAGE_SELECT} ${filter.where} ${INBOX_ORDER} limit ${limitPlaceholder}`,
        [...filter.values, limit],
      );
      return result.rows;
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

    async close() {
      await pool.end();
    },
  };
}
