import { readFileSync } from 'node:fs';
import pg from 'pg';

/** Small fixed pool for the API and sync workers to share; comfortably under
 *  Postgres's default max_connections regardless of how many mail accounts
 *  are configured, since IMAP connections are separate from this pool. */
const MAX_POOL_SIZE = 4;

/** Defensive truncation applied to `snippet` at the write path, independent
 *  of Task 3's own truncation to 280 chars. This is NOT a CHECK constraint:
 *  a constraint would reject the whole insert on a caller bug, silently
 *  halting sync for that message; truncating here just bounds storage
 *  unconditionally, with no failure mode. Deliberately larger than 280 so a
 *  future change to the intended limit does not silently get masked by
 *  this one. */
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
  readonly snippet: string | null;
  readonly flags: readonly string[];
  readonly labels: readonly string[];
  readonly hasAttach: boolean;
  readonly sizeBytes: number | null;
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
  getUnifiedInbox(options: { limit: number; before: Date | null }): Promise<any[]>;
  getThread(threadId: string): Promise<any[]>;
  getSyncState(accountId: string, folder: string): Promise<SyncStateInput | null>;
  setSyncState(accountId: string, folder: string, state: SyncStateInput): Promise<void>;
  close(): Promise<void>;
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

    async getUnifiedInbox({ limit, before }) {
      const result = await pool.query(
        `select * from messages
         where ($1::timestamptz is null or date < $1)
         order by date desc limit $2`,
        [before, limit],
      );
      return result.rows;
    },

    async getThread(threadId) {
      const result = await pool.query(
        'select * from messages where thread_id = $1 order by date asc',
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
