import type { Db } from '../db';
import type { ConnectionPool } from '../imap/pool';
import { json, PRIVATE_NO_STORE } from './http.ts';
import { parsePositiveInt, resolveConnection } from './fetch-part.ts';
import type { MessageCache } from './message-cache';
import { folderKindForPath, type AddressableFolderKind } from '../imap/folders.ts';
import {
  moveMessage,
  MoveDestinationUnavailableError,
  MoveWouldNotChangeFolderError,
  type MoveDestination,
} from '../imap/move.ts';

/**
 * POST /api/message/{accountId}/{folder}/{uid}/move — the route that gets
 * mail OUT of the inbox, and the second one in this service that changes
 * state in the user's real Gmail.
 *
 * Body names exactly one thing to do:
 *
 *     { "to": "archive" }   leave INBOX, stay in All Mail   (UID MOVE)
 *     { "to": "trash" }     into the discovered \Trash      (UID MOVE)
 *     { "to": "spam" }      into the discovered \Junk       (UID MOVE)
 *     { "to": "undo", "origin": "inbox" }   put it back     (UID MOVE)
 *
 * **THE DESTINATION IS A CLOSED SET OF LITERALS, AND THAT IS THE WHOLE
 * SECURITY STORY OF THIS FILE.** A `to` that accepted a folder NAME would
 * be an arbitrary-folder-move primitive against a live mailbox, reachable
 * by anything holding a session cookie: move every message in INBOX into
 * a folder the user never looks at, and no client-side care takes that
 * back. The three forward destinations are matched against three exact
 * strings; `undo`'s `origin` against five, and only because undo has to
 * be able to say where the message came FROM. Every one of those eight
 * values is resolved to a real mailbox by ../imap/folders.ts's discovery,
 * never by concatenation, so the caller never names a path at all.
 *
 * Anything else — an unknown `to`, a missing `origin`, an extra key, a
 * non-object body — is a 400 that reaches no IMAP call. The validation
 * runs BEFORE the connection is resolved and before any lock is taken, so
 * "rejected" and "moved something anyway" are not merely unlikely
 * together; there is no code path between them.
 *
 * **NO EXPUNGE, EVER.** Nothing here sets a flag and nothing here
 * deletes. ../imap/move.ts refuses outright on a server that would make
 * imapflow emulate MOVE with COPY + `\Deleted` + EXPUNGE — see its
 * header. Archive in particular is not a delete and not really a move
 * either: on Gmail it removes the INBOX label and the message stays in
 * All Mail permanently, which is precisely what Gmail's own UI does.
 *
 * Kept out of ./routes.ts on purpose, mirroring ./flags.ts, ./push.ts and
 * ./message.ts. Nothing here is bulk and nothing here should become bulk:
 * one request moves one message, which is what bounds the damage a bug in
 * this file can do to a live mailbox.
 *
 * The daily byte budget (spec L6) is deliberately NOT consulted, for the
 * reason ./flags.ts states at length: that budget exists because body and
 * attachment fetches pull unbounded megabytes down the connection Gmail
 * meters, and a MOVE plus its untagged reply is a hundred-odd bytes.
 * Refusing "archive this" with a 429 because a large download earlier in
 * the day exhausted a bandwidth allowance would break the feature for a
 * cost that rounds to zero against it.
 */

/** The three destinations a client may ask for directly. `inbox` and
 *  `sent` are deliberately absent: a client must not be able to file mail
 *  INTO the inbox or into Sent on its own say-so, and undo reaches
 *  `inbox` only through the separate form below. */
const FORWARD_DESTINATIONS: readonly MoveDestination[] = ['archive', 'trash', 'spam'];

/** Where an undo may put a message BACK. The full set of folder kinds this
 *  service can name, because the origin is whatever folder the message was
 *  actually in — and the value is one the SERVER issued in the first
 *  place (see `UndoTicket`), never one a client invented. */
const UNDO_ORIGINS: readonly AddressableFolderKind[] = [
  'inbox',
  'sent',
  'spam',
  'trash',
  'archive',
];

/** What the client sends back to put a message where it was. Every field
 *  is issued by THIS route: the client stores the ticket and replays it,
 *  it never constructs one. */
export interface UndoTicket {
  /** The native path the message now lives in. */
  readonly folder: string;
  /** Its uid THERE — a MOVE renumbers the message, so this is not the uid
   *  the original request carried. */
  readonly uid: number;
  /** The logical kind to move it back to. */
  readonly origin: AddressableFolderKind;
}

/** What a successful move returns. */
export interface MoveResultBody {
  readonly ok: true;
  /** Echoes the request's uid, the way FlagUpdateResult echoes its own. */
  readonly uid: number;
  readonly to: 'archive' | 'trash' | 'spam' | 'undo';
  /** False when the uid no longer resolved — someone archived it from the
   *  Gmail app first. NOT an error: the message is out of the folder
   *  either way, which is what the caller asked for. */
  readonly moved: boolean;
  /**
   * How to take this back, or `null` when it cannot be taken back —
   * the server reported no destination uid (no UIDPLUS), or the source
   * folder is one this service cannot name.
   *
   * A CLIENT MUST NOT OFFER UNDO WHEN THIS IS NULL. Guessing a uid would
   * move an unrelated message into the user's inbox, which is worse than
   * offering nothing.
   */
  readonly undo: UndoTicket | null;
}

/** One parsed request: which move, and (for an undo) where back to. */
interface MoveRequest {
  readonly to: MoveResultBody['to'];
  readonly destination: MoveDestination;
}

const INVALID_BODY_ERROR =
  `body must be {"to": ${FORWARD_DESTINATIONS.map((d) => `"${d}"`).join(' | ')}} ` +
  `or {"to": "undo", "origin": ${UNDO_ORIGINS.map((o) => `"${o}"`).join(' | ')}}`;

function badRequest(): Response {
  return json({ error: INVALID_BODY_ERROR }, 400, PRIVATE_NO_STORE);
}

/**
 * Parses the JSON body, or returns a ready 400 instead of throwing.
 *
 * The parse error is discarded rather than attached, matching ./flags.ts
 * and ./push.ts: V8 embeds surrounding source in "Unexpected token"
 * messages, and this service's policy is that no request body reaches a
 * log line.
 */
async function readJsonBody(request: Request): Promise<unknown | Response> {
  try {
    return await request.json();
  } catch {
    console.error('api: rejected POST .../move — request body was not valid JSON');
    return badRequest();
  }
}

/**
 * Narrows an arbitrary parsed body to one supported move, or returns the
 * 400 it earned.
 *
 * EXACT KEY COUNT, not "look for a `to` field". `{"to":"trash","folder":
 * "…"}` must not be accepted-and-ignored: a body carrying a key this
 * route does not understand is a client built against a different
 * contract, and silently doing something other than what it asked is how
 * a future `folder` override gets added on the client and appears to work.
 *
 * `Object.keys` rather than `in`, for ./flags.ts's reason: `JSON.parse`
 * materialises `__proto__` as an ORDINARY OWN property, so it arrives
 * here as an unsupported key name and is refused like any other, while an
 * inherited name such as `toString` never appears in `Object.keys` at all.
 *
 * The error message never echoes the submitted value. A rejected
 * destination is attacker-controlled text, and reflecting it into a JSON
 * error and a log line buys nothing a static, actionable message does not
 * already give a client author.
 */
function parseMoveRequest(body: unknown): MoveRequest | Response {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return badRequest();

  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  const to = record.to;
  if (typeof to !== 'string') return badRequest();

  if (to === 'undo') {
    if (keys.length !== 2 || !Object.hasOwn(record, 'origin')) return badRequest();
    const origin = record.origin;
    if (typeof origin !== 'string') return badRequest();
    if (!(UNDO_ORIGINS as readonly string[]).includes(origin)) return badRequest();
    return { to: 'undo', destination: origin as MoveDestination };
  }

  if (keys.length !== 1) return badRequest();
  if (!(FORWARD_DESTINATIONS as readonly string[]).includes(to)) return badRequest();
  return { to: to as MoveResultBody['to'], destination: to as MoveDestination };
}

/**
 * Drops the cached row, run only after the remote move has committed.
 *
 * Never throws: a Postgres failure here is logged loudly and does not
 * change the response, because the message really did leave the folder on
 * the server and the route must not claim otherwise. The only consequence
 * is that the row may reappear in the list until the next sync cycle,
 * which is a degradation rather than a wrong answer — the same asymmetry
 * ./flags.ts's `applyStoredFlag` documents.
 */
async function dropStoredRow(
  db: Db,
  accountId: string,
  folder: string,
  uid: number,
): Promise<void> {
  try {
    await db.deleteStoredMessage(accountId, folder, uid);
  } catch (error) {
    console.error(
      `api: move for account "${accountId}" folder "${folder}" uid ${uid} succeeded on the ` +
        'server but the local row could not be dropped',
      error,
    );
  }
}

/**
 * POST /api/message/{accountId}/{folder}/{uid}/move.
 *
 * Order of operations, all of it load-bearing and all of it mirroring
 * ./flags.ts:
 *
 *  1. UID validation, then body validation. Both are pure and both
 *     precede any contact with the pool, so a malformed request provably
 *     cannot reach IMAP — the tests assert the fake client was never
 *     called at all, because a 400 that still moved would be the
 *     dangerous bug here.
 *  2. Connection resolution (404 unknown account / 503 not connected),
 *     then folder discovery. A pool that has not LISTed this account yet
 *     is a 503, not a 500: the account is fine and a retry a moment later
 *     succeeds.
 *  3. The MOVE, inside `pool.withAccountLock` — the same per-account
 *     critical section the sync cycle and the IDLE liveness probe use.
 *     The lock is entered HERE and only here: ../imap/move.ts is
 *     lock-free by design because `KeyedMutex` is not re-entrant.
 *  4. Cache eviction, then the local row drop, both OUTSIDE the lock.
 *
 * PARTIAL FAILURE, and the two directions are NOT symmetric — same
 * contract ./flags.ts states:
 *
 *  - The MOVE fails → 502, and the cached row is left exactly as it was.
 *    Never an optimistic local delete on a failed remote move: the client
 *    removes the row optimistically and rolls back on a non-2xx, and a
 *    200 for a move that did not happen would leave the user with a
 *    message that is gone from the UI and still in their inbox.
 *  - The MOVE succeeds and the row drop fails → 200, plus a loud log. The
 *    mailbox really did change; reporting failure would tell the user a
 *    lie and invite a retry of something already done.
 */
export async function handleMove(
  db: Db,
  pool: ConnectionPool,
  request: Request,
  accountId: string,
  folder: string,
  uidRaw: string,
  /** The parsed-message cache this route must invalidate — the snapshot
   *  it holds is addressed by (account, folder, uid), and after a move
   *  that address names nothing. */
  cache: MessageCache,
): Promise<Response> {
  const uid = parsePositiveInt(uidRaw);
  if (uid === null) return json({ error: 'invalid uid' }, 400, PRIVATE_NO_STORE);

  const body = await readJsonBody(request);
  if (body instanceof Response) return body;

  const parsed = parseMoveRequest(body);
  if (parsed instanceof Response) return parsed;

  const resolved = resolveConnection(pool, accountId);
  if (resolved instanceof Response) return resolved;

  const folders = pool.getDiscoveredFolders(accountId);
  if (folders === undefined) {
    // The pool has not completed this account's first LIST. Transient by
    // definition, so 503 (retry) rather than 500 (we are broken).
    return json({ error: 'account folders are not discovered yet' }, 503, PRIVATE_NO_STORE);
  }

  // Read BEFORE the move, because after it the message is no longer in
  // this folder and the answer would be about the wrong mailbox.
  const originKind = folderKindForPath(folders, folder);

  let outcome;
  try {
    outcome = await pool.withAccountLock(accountId, () =>
      moveMessage(resolved, folders, folder, uid, parsed.destination),
    );
  } catch (error) {
    if (error instanceof MoveDestinationUnavailableError) {
      // The account genuinely cannot do this — its server never flagged a
      // mailbox for that kind. 409, not 502: nothing is broken, and a
      // retry will fail identically. The DESTINATION KIND is named
      // (`"spam"`), never a path — a folder name is mailbox content.
      return json(
        { error: `this account has no "${error.destination}" folder` },
        409,
        PRIVATE_NO_STORE,
      );
    }
    if (error instanceof MoveWouldNotChangeFolderError) {
      return json({ error: 'the message is already there' }, 409, PRIVATE_NO_STORE);
    }
    // ../imap/move.ts has already logged the attempt and its outcome with
    // the account, folder, uid and destination; this line records that the
    // ROUTE refused as a result, and carries no message content either.
    console.error(
      `api: refusing POST move for account "${accountId}" folder "${folder}" uid ${uid} ` +
        `to "${parsed.destination}" — the IMAP move did not succeed`,
      error,
    );
    return json({ error: 'failed to move the message' }, 502, PRIVATE_NO_STORE);
  }

  // Immediately after the write we know landed. ./message-cache.ts holds
  // a SNAPSHOT keyed by (account, folder, uid); after a move that key
  // addresses nothing, so the next open must miss rather than serve a
  // body from a folder the message has left. Ordered before the row drop
  // for ./flags.ts's reason: this cannot fail (it deletes a Map entry),
  // so there is no ordering in which it does less.
  cache.evict(accountId, folder, uid);

  await dropStoredRow(db, accountId, folder, uid);

  const result: MoveResultBody = {
    ok: true,
    uid,
    to: parsed.to,
    moved: outcome.moved,
    // Every condition has to hold: the move happened, the server told us
    // the new uid, and we can name the folder it came from. Any one
    // missing means undo would be a guess — see MoveResultBody.undo.
    undo:
      outcome.moved && outcome.newUid !== null && originKind !== null
        ? { folder: outcome.destination, uid: outcome.newUid, origin: originKind }
        : null,
  };
  return json(result, 200, PRIVATE_NO_STORE);
}
