import type { ConnectionPool } from '../imap/pool';
import type { ImapConnection } from '../imap/connection';
import { fetchBodyPart, BodyPartTooLargeError, MAX_BODY_PART_BYTES } from '../imap/fetch.ts';
import { json } from './http.ts';

/**
 * The preamble every route that addresses a message by UID and pulls bytes
 * off a live IMAP connection shares: validate the UID, resolve the
 * connection, then fetch under the account lock and the daily byte budget.
 *
 * Extracted from ./routes.ts, unchanged in behaviour, when ./message.ts
 * became the third route needing it (Plan 6 Task 1) — the same move
 * ./http.ts records for `json()` when ./push.ts became the second module
 * needing that. The alternative was ./message.ts importing from ./routes.ts
 * while ./routes.ts imports ./message.ts, which is a module cycle for no
 * gain.
 */

/**
 * Validates and converts a UID route parameter. Amendment 2: a UID coming
 * out of the database is a string (Postgres bigint), but a UID coming in
 * from a URL path is also a string that has never been validated as a
 * number at all — this is the one deliberate conversion point for that
 * value on the way into fetchBodyPart/db.query, rather than trusting it to
 * already look like the number it claims to be.
 */
export function parsePositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Looks up a live connection for `accountId` and confirms the pool
 * considers it connected before any IMAP call is attempted, returning a
 * ready-to-send Response instead when it can't proceed. Shared by the body,
 * attachment and parsed-message handlers so all three fail the same way for
 * the same reasons.
 */
export function resolveConnection(
  pool: ConnectionPool,
  accountId: string,
): ImapConnection | Response {
  const connection = pool.getConnection(accountId);
  if (!connection) return json({ error: 'unknown account' }, 404);

  const status = pool.status.get(accountId);
  if (status !== 'connected') {
    return json({ error: `account not connected (status: ${status ?? 'unknown'})` }, 503);
  }

  return connection;
}

/**
 * The one path by which the API pulls bytes off an IMAP connection. Three
 * things happen here that must happen together, which is why they are one
 * function rather than duplicated across the handlers:
 *
 *  1. **The account's sync lock is held for the whole fetch.** The API and
 *     the IDLE loop drive the same imapflow client; without this, a
 *     download breaks IDLE, idleLoop's NOOP liveness probe queues behind
 *     the download, and a download longer than the probe's 15s timeout gets
 *     its own connection torn down as "dead". See
 *     ConnectionPool.withAccountLock.
 *  2. **The bytes are charged against the daily budget (spec L6).** These
 *     travel the same connection Gmail meters at ~2.5 GB/day. The sync loop
 *     charges a 2 KB estimate per header fetch; an API that could pull tens
 *     of megabytes unrecorded would make that accounting fiction. The
 *     reservation is the worst case (MAX_BODY_PART_BYTES) because the size
 *     is not known before the fetch; what gets recorded afterwards is the
 *     measured truth.
 *  3. **An oversized part is refused, not served.** fetchBodyPart aborts
 *     above the cap; this maps that to 413 rather than the 502 a generic
 *     IMAP failure gets, so a client can tell "too big" from "broken".
 *
 * Returns the bytes, or a ready-to-send Response for the two refusals.
 * A genuine IMAP error propagates to the caller's own 502 handling.
 *
 * The cap is also what bounds peak memory for ./message.ts: mailparser
 * buffers every attachment it decodes, so the parse costs O(message size),
 * and this is the only thing that makes "message size" a bounded quantity.
 */
export async function fetchBudgetedPart(
  pool: ConnectionPool,
  connection: ImapConnection,
  accountId: string,
  folder: string,
  uid: number,
  partId?: string,
): Promise<Buffer | Response> {
  return pool.withAccountLock(accountId, async () => {
    const decision = await pool.byteBudget.reserve(accountId, MAX_BODY_PART_BYTES);
    if (!decision.allowed) {
      console.error(
        `api: daily byte budget exhausted for account "${accountId}", refusing on-demand ` +
          `fetch of uid ${uid} (requested ${MAX_BODY_PART_BYTES}, remaining ${decision.remaining})`,
      );
      return json({ error: 'daily download budget exhausted for this account' }, 429);
    }

    try {
      const bytes = await fetchBodyPart(connection, folder, uid, partId);
      await pool.byteBudget.record(accountId, bytes.length);
      return bytes;
    } catch (error) {
      if (error instanceof BodyPartTooLargeError) {
        // Those bytes really did cross the wire before the fetch aborted,
        // so charge them. The cap is a conservative floor for how many.
        await pool.byteBudget.record(accountId, error.limitBytes);
        console.error(
          `api: refusing oversized part for account "${accountId}" uid ${uid} ` +
            `part "${partId ?? '<whole message>'}": above ${error.limitBytes} bytes`,
        );
        return json(
          { error: `message part exceeds the ${error.limitBytes}-byte maximum` },
          413,
        );
      }
      throw error;
    }
  });
}
