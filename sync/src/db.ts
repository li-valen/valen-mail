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

export interface Db {
  applySchema(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<any[]>;
  upsertMessage(message: MessageInput): Promise<void>;
  upsertAttachment(attachment: AttachmentInput): Promise<void>;
  getUnifiedInbox(options: { limit: number; cursor: InboxCursor | null }): Promise<any[]>;
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

function buildInboxFilter(cursor: InboxCursor | null): InboxFilter {
  if (!cursor) return { where: '', values: [] };

  if (cursor.accountId !== null && cursor.uid !== null) {
    return {
      where:
        `where (coalesce(m.date, '-infinity'::timestamptz), m.account_id, m.uid) ` +
        `< (coalesce($1::timestamptz, '-infinity'::timestamptz), $2::text, $3::bigint)`,
      values: [cursor.date, cursor.accountId, cursor.uid],
    };
  }

  if (cursor.date !== null) {
    return {
      where: `where coalesce(m.date, '-infinity'::timestamptz) < $1::timestamptz`,
      values: [cursor.date],
    };
  }

  return { where: '', values: [] };
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

    async getUnifiedInbox({ limit, cursor }) {
      const filter = buildInboxFilter(cursor);
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
