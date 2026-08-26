import type { Db } from '../db';
import type { ConnectionPool } from '../imap/pool';
import { json, PRIVATE_NO_STORE } from './http.ts';
import { parsePositiveInt, resolveConnection } from './fetch-part.ts';
import type { MessageCache } from './message-cache';
import {
  FLAG_FIELDS,
  isFlagField,
  setMessageFlag,
  WRITABLE_FLAGS,
  type FlagField,
} from '../imap/flags.ts';

/**
 * PATCH /api/message/{accountId}/{folder}/{uid}/flags — the ONE route in
 * this service that changes state in the user's real Gmail.
 *
 * Body names exactly one change, and exactly one:
 *
 *     { "seen": true }      mark read          (STORE +FLAGS \Seen)
 *     { "seen": false }     mark unread        (STORE -FLAGS \Seen)
 *     { "flagged": true }   star               (STORE +FLAGS \Flagged)
 *     { "flagged": false }  unstar             (STORE -FLAGS \Flagged)
 *
 * Anything else — two keys, zero keys, an unknown key, a non-boolean
 * value, a non-object body — is a 400 that reaches no IMAP call at all.
 * The validation deliberately runs BEFORE the connection is resolved and
 * before any lock is taken, so "rejected" and "wrote something anyway" are
 * not merely unlikely together; there is no code path between them.
 *
 * Kept out of ./routes.ts on purpose, mirroring ./push.ts, ./identities.ts
 * and ./message.ts: routes.ts keeps a thin branch per route and the
 * behaviour lives here. This route sits behind the router's own auth gate,
 * so by the time handleSetFlag runs the caller has already proven a
 * credential — an unauthenticated PATCH is a 401 that never reaches this
 * module.
 *
 * Nothing here is bulk, and nothing here should become bulk. There is no
 * "mark all read", no folder-wide operation and no convenience helper that
 * takes a list of UIDs: one request changes one flag on one message, which
 * is what bounds the damage a bug in this file can do to a live mailbox.
 *
 * The daily byte budget (spec L6) is deliberately NOT consulted. That
 * budget exists because body and attachment fetches pull unbounded
 * megabytes down the connection Gmail meters; a STORE plus its untagged
 * reply is a hundred-odd bytes, two orders of magnitude below the 2 KB
 * ESTIMATE the sync loop charges per header fetch. Refusing an explicit
 * "mark this read" with a 429 because a large download earlier in the day
 * exhausted a bandwidth allowance would break the feature for a cost that
 * rounds to zero against it.
 */

/** The parsed body: which flag, and which direction. */
interface FlagChange {
  readonly field: FlagField;
  readonly value: boolean;
}

/** What a successful PATCH returns. `stored` is the honest report of the
 *  LOCAL half — see handleSetFlag for the partial-failure contract. */
export interface FlagUpdateResult {
  readonly ok: true;
  readonly uid: number;
  readonly flag: FlagField;
  readonly value: boolean;
  readonly stored: boolean;
}

/** Stated once so the 400s and the doc comment above cannot drift apart. */
const INVALID_BODY_ERROR =
  `body must name exactly one of ${FLAG_FIELDS.map((field) => `"${field}"`).join(' or ')} ` +
  `with a boolean value`;

function badRequest(): Response {
  return json({ error: INVALID_BODY_ERROR }, 400, PRIVATE_NO_STORE);
}

/**
 * Parses the JSON body, or returns a ready 400 instead of throwing.
 *
 * The parse error is discarded rather than attached, matching ./push.ts
 * and handleCreateSession in ./routes.ts: V8 embeds surrounding source in
 * "Unexpected token" messages, and this service's policy is that no
 * request body reaches a log line.
 */
async function readJsonBody(request: Request): Promise<unknown | Response> {
  try {
    return await request.json();
  } catch {
    console.error('api: rejected PATCH .../flags — request body was not valid JSON');
    return badRequest();
  }
}

/**
 * Narrows an arbitrary parsed body to one supported flag change, or
 * returns the 400 it earned.
 *
 * "Exactly one own key" rather than "look for a `seen` field": a body of
 * `{"seen": true, "flagged": true}` is two mutations in one request, and
 * accepting it would mean two IMAP writes with no way to report that the
 * first succeeded and the second did not. One request, one flag, one
 * outcome the client can act on.
 *
 * `Object.keys` + `isFlagField`'s `Object.hasOwn` is what makes this
 * prototype-safe. `JSON.parse` materialises `__proto__` as an ORDINARY OWN
 * property (it does not set the prototype), so it arrives here as an
 * unsupported key name and is refused like any other; and an inherited
 * name such as `toString` never appears in `Object.keys` at all.
 *
 * The error message never echoes the submitted key. A rejected name is
 * attacker-controlled text, and reflecting it into a JSON error and a log
 * line buys nothing a static, actionable message does not already give a
 * client author.
 */
function parseFlagChange(body: unknown): FlagChange | Response {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return badRequest();

  const keys = Object.keys(body);
  if (keys.length !== 1) return badRequest();

  const field = keys[0]!;
  if (!isFlagField(field)) return badRequest();

  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== 'boolean') return badRequest();

  return { field, value };
}

/**
 * The local half, run only after the remote write has already committed.
 *
 * Never throws: a Postgres failure here is logged loudly and reported to
 * the client as `stored: false`, because the flag really did change on the
 * server and the route must not claim otherwise. See handleSetFlag.
 */
async function applyStoredFlag(
  db: Db,
  accountId: string,
  folder: string,
  uid: number,
  flag: string,
  value: boolean,
): Promise<boolean> {
  try {
    const updated = await db.updateStoredFlag(accountId, folder, uid, flag, value);
    if (!updated) {
      console.error(
        `api: flag write for account "${accountId}" folder "${folder}" uid ${uid} flag "${flag}" ` +
          'succeeded on the server but matched no stored row',
      );
    }
    return updated;
  } catch (error) {
    console.error(
      `api: flag write for account "${accountId}" folder "${folder}" uid ${uid} flag "${flag}" ` +
        'succeeded on the server but the local row could not be updated',
      error,
    );
    return false;
  }
}

/**
 * PATCH /api/message/{accountId}/{folder}/{uid}/flags.
 *
 * Order of operations, all of it load-bearing:
 *
 *  1. UID validation, then body validation. Both are pure and both precede
 *     any contact with the pool, so a malformed request provably cannot
 *     reach IMAP — tests assert the fake client was never called at all,
 *     because a 400 that still wrote would be the dangerous bug here.
 *  2. Connection resolution: 404 for an unknown account, 503 for one that
 *     is not currently connected (shared with the body, attachment and
 *     parsed-message routes via ./fetch-part.ts, so all four fail the same
 *     way for the same reasons).
 *  3. The IMAP write, inside `pool.withAccountLock` — the same per-account
 *     critical section the sync cycle and the IDLE liveness probe use, so
 *     a STORE can never interleave with either on the shared client. The
 *     lock is entered HERE and only here: ../imap/flags.ts is lock-free by
 *     design because `KeyedMutex` is not re-entrant and a nested acquire
 *     would wedge the account permanently.
 *  4. The local row update, OUTSIDE the lock. It is a Postgres round trip,
 *     not an IMAP one, so it does not need serialising against the sync
 *     cycle — the same reasoning ./routes.ts records for its attachment
 *     metadata lookup.
 *
 * PARTIAL FAILURE. The two halves can disagree, and the two directions are
 * NOT symmetric:
 *
 *  - IMAP write fails (throws, or the server refuses the STORE) → 502, and
 *    the stored row is left exactly as it was. Never an optimistic local
 *    write on a failed remote one: the client un-bolds optimistically, and
 *    a 200 for a write that did not happen is precisely the silent failure
 *    this route exists to make impossible.
 *  - IMAP write succeeds, local update fails or matches no row → 200 with
 *    `stored: false`, plus a loud server-side log. The user's mailbox
 *    really did change; reporting failure would tell them a lie, invite a
 *    retry of something already done, and (with an optimistic client) put
 *    the row back to bold for a message that is genuinely read. The only
 *    consequence of `stored: false` is that the row may render stale until
 *    the next sync cycle re-reads the real flags from the server, which is
 *    a degradation, not a wrong answer. `stored` is on the wire so a
 *    client can surface even that.
 */
export async function handleSetFlag(
  db: Db,
  pool: ConnectionPool,
  request: Request,
  accountId: string,
  folder: string,
  uidRaw: string,
  /** The parsed-message cache this route must invalidate — see the
   *  eviction below, and ./message-cache.ts for the policy. */
  cache: MessageCache,
): Promise<Response> {
  const uid = parsePositiveInt(uidRaw);
  if (uid === null) return json({ error: 'invalid uid' }, 400, PRIVATE_NO_STORE);

  const body = await readJsonBody(request);
  if (body instanceof Response) return body;

  const change = parseFlagChange(body);
  if (change instanceof Response) return change;

  const resolved = resolveConnection(pool, accountId);
  if (resolved instanceof Response) return resolved;

  const flag = WRITABLE_FLAGS[change.field];

  try {
    await pool.withAccountLock(accountId, () =>
      setMessageFlag(resolved, folder, uid, flag, change.value),
    );
  } catch (error) {
    // ../imap/flags.ts has already logged the attempt and its outcome with
    // the account, folder, uid and flag; this line records that the ROUTE
    // refused as a result, and carries no message content either.
    console.error(
      `api: refusing PATCH flags for account "${accountId}" folder "${folder}" uid ${uid} ` +
        `flag "${flag}" — the IMAP write did not succeed`,
      error,
    );
    return json({ error: 'failed to update message flag' }, 502, PRIVATE_NO_STORE);
  }

  // INVALIDATION, immediately after the write we know landed and before
  // anything else can read the route again. ./message-cache.ts holds a
  // SNAPSHOT of this message taken before the STORE; the STORE changed the
  // message on the server, so the snapshot is by definition out of date
  // and the next open must re-read rather than serve it.
  //
  // Ordered before the local row update on purpose: that update is a
  // Postgres round trip that can fail (see applyStoredFlag's contract),
  // and an eviction that only happened on the happy path would leave a
  // stale body cached in exactly the case where local and remote state
  // already disagree. This call cannot fail and cannot throw — it deletes
  // a Map entry — so there is no ordering in which it does less.
  //
  // What this does and does not buy, stated honestly: ParsedMessage
  // carries no flag field today, so the body a stale hit would serve is
  // not visibly wrong — the read/starred state the UI renders comes from
  // the inbox ROW, not from this route. The eviction is here because a
  // route that mutates a message while a cache holds a copy of it must
  // drop that copy, whatever the copy currently happens to contain; the
  // alternative is a correctness bug that arrives silently the day
  // ParsedMessage grows a field the STORE touches.
  cache.evict(accountId, folder, uid);

  const stored = await applyStoredFlag(db, accountId, folder, uid, flag, change.value);

  const result: FlagUpdateResult = {
    ok: true,
    uid,
    flag: change.field,
    value: change.value,
    stored,
  };
  return json(result, 200, PRIVATE_NO_STORE);
}
