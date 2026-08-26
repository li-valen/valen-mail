import type { ImapConnection } from './connection';
import {
  folderKindForPath,
  type AddressableFolderKind,
  type DiscoveredFolders,
} from './folders.ts';

/**
 * The SECOND write path this service has to IMAP, and the one that gets
 * mail out of the inbox: archive, trash and spam.
 *
 * ./flags.ts is the first, and everything its header says about bounding
 * the blast radius applies here unchanged — one message, never a range;
 * the caller owns the account mutex; nothing reads state to decide
 * whether to act. Three things are specific to this module:
 *
 *  1. **ARCHIVE IS A MOVE OUT OF INBOX, NOT A DELETE.** On Gmail every
 *     folder is a label, and "archive" means removing the INBOX label.
 *     The message keeps every other label it has and stays in All Mail
 *     permanently — which is why the destination for an archive is the
 *     All Mail mailbox: MOVE-ing there is COPY (a no-op, it is already
 *     there) plus removal from INBOX. This is exactly what Gmail's own
 *     web UI does when you press `e`. Nothing is deleted, and nothing
 *     here can delete.
 *
 *  2. **NO EXPUNGE, EVER, AND THE LIBRARY IS NOT TRUSTED TO HONOUR IT.**
 *     ./flags.ts records that `\Deleted` is absent from WRITABLE_FLAGS and
 *     must stay absent. This module adds no flag at all. But imapflow
 *     EMULATES a missing MOVE extension with COPY + `messageDelete` +
 *     EXPUNGE (node_modules/imapflow/lib/commands/move.js), so on a
 *     server that does not advertise MOVE the destructive path would be
 *     entered by a library call rather than by any line of ours.
 *     `assertMoveSupported` below refuses before the command is issued.
 *     That check is not defensive dressing: it is the only thing standing
 *     between this feature and a permanent deletion, and it is asserted
 *     in tests/move.test.ts.
 *
 *  3. **THE DESTINATION IS DISCOVERED, NEVER NAMED.** `[Gmail]/Trash`
 *     does not exist on an account whose language is not English —
 *     ./folders.ts has the full case. Every destination here comes out of
 *     `DiscoveredFolders`, which the pool has already resolved from
 *     special-use attributes on the same connection, so this costs no
 *     extra round trip.
 *
 * This module does NOT take the per-account mutex — see moveMessage's own
 * doc comment, and ./flags.ts's, for why that is the caller's job and
 * what happens if it is done here instead.
 */

/** The IMAP capability that makes a MOVE a MOVE rather than an emulated
 *  copy-and-delete. Gmail advertises it; a server that does not is
 *  refused rather than served through imapflow's fallback. */
const MOVE_CAPABILITY = 'MOVE';

/**
 * Where a message can be moved TO, as a logical kind rather than a path.
 *
 * The whole set, deliberately, rather than the three the UI offers:
 * `inbox` is what an UNDO moves back to, and expressing undo as an
 * ordinary move in the other direction is what keeps this module a single
 * primitive instead of two near-copies. ../api/move.ts is where the
 * narrowing happens — its request body accepts exactly the three forward
 * destinations, and reaches `inbox` only through its own explicit undo
 * form. A client can never name a folder path.
 */
export type MoveDestination = AddressableFolderKind;

/** What a completed move reports back. */
export interface MoveOutcome {
  /**
   * False when the server moved nothing because the uid no longer
   * resolves — someone archived it from the Gmail app, or a retry
   * arrived after the first attempt succeeded. NOT an error: the message
   * is out of the folder either way, which is what the user asked for.
   */
  readonly moved: boolean;
  /** The native path resolved from discovery, for the caller's log. */
  readonly destination: string;
  /**
   * The uid the message now carries in `destination`, read from the
   * server's own COPYUID (RFC 4315 UIDPLUS) response — a MOVE renumbers
   * the message, so the uid the caller passed in addresses nothing after
   * this returns.
   *
   * `null` when the server did not report one. That is the honest answer
   * on a server without UIDPLUS, and the route turns it into "no undo
   * offered" rather than guessing a uid: an undo that moved an unrelated
   * message back into the inbox would be far worse than no undo at all.
   */
  readonly newUid: number | null;
}

/**
 * The account's server never flagged a mailbox for this destination —
 * a Trash disabled by policy, an account with no Junk folder.
 *
 * A distinct type, like ./flags.ts's FlagWriteRefusedError, so the route
 * can answer 409 (this account cannot do that) rather than 502 (we broke)
 * and name the folder that is missing.
 *
 * Note: explicit field assignment, not a TypeScript parameter property —
 * the service runs under --experimental-strip-types, which rejects those.
 */
export class MoveDestinationUnavailableError extends Error {
  readonly destination: MoveDestination;

  constructor(destination: MoveDestination) {
    super(`this account has no discovered folder for "${destination}"`);
    this.name = 'MoveDestinationUnavailableError';
    this.destination = destination;
  }
}

/**
 * The message is already in the folder it was asked to move to.
 *
 * Refused rather than treated as a success, because the two ways to
 * reach it are both bugs worth surfacing: a client offering Archive on a
 * message already in All Mail, or an undo ticket replayed after the
 * message has already been put back. `UID MOVE 42 INBOX` with INBOX
 * selected is also not a defined no-op at the protocol level.
 */
export class MoveWouldNotChangeFolderError extends Error {
  readonly folder: string;

  constructor(folder: string) {
    super(`the message is already in "${folder}"`);
    this.name = 'MoveWouldNotChangeFolderError';
    this.folder = folder;
  }
}

/**
 * The server did not perform the move.
 *
 * imapflow's `messageMove` RESOLVES `false` on a command error and
 * `undefined` when its own preconditions are unmet — neither rejects. A
 * caller that only watched for a thrown error would report a move that
 * never happened, telling the user their mail left the inbox when it is
 * still sitting in it. Same reasoning, same shape, as
 * ./flags.ts's FlagWriteRefusedError.
 */
export class MoveRefusedError extends Error {
  readonly destination: string;

  constructor(destination: string) {
    super(`IMAP refused to move the message to ${destination}`);
    this.name = 'MoveRefusedError';
    this.destination = destination;
  }
}

/** The native path for a logical destination, or the refusal it earned. */
function resolveDestination(
  folders: DiscoveredFolders,
  destination: MoveDestination,
): string {
  const path = destination === 'inbox' ? folders.inbox : folders[destination];
  if (path === null || path.length === 0) {
    throw new MoveDestinationUnavailableError(destination);
  }
  return path;
}

/**
 * Refuses a connection whose server does not advertise MOVE.
 *
 * See rule 2 in this file's header: without this, imapflow silently
 * substitutes COPY + `\Deleted` + EXPUNGE, and a feature documented
 * end-to-end as "never destructive" would permanently delete the user's
 * mail on the first server that lacks the extension. Checked at the
 * moment of use rather than at connect time, because `capabilities` is
 * repopulated on every reconnect.
 */
function assertMoveSupported(client: { capabilities: Map<string, boolean | number> }): void {
  if (client.capabilities?.get(MOVE_CAPABILITY) !== true) {
    // The message deliberately avoids naming the destructive IMAP verbs:
    // tests/move.test.ts sweeps this whole source tree for them, and a
    // log string is not worth carving an exception into a guard whose
    // value is that it has none. The header above says what the fallback
    // does, at length.
    throw new Error(
      'refusing to move: this server does not advertise the MOVE capability, and imapflow ' +
        'would emulate it with a destructive copy-and-remove this service must never perform',
    );
  }
}

/**
 * Reads the destination uid out of a COPYUID response.
 *
 * `uidMap` is present only when the server has UIDPLUS; when it IS
 * present, an entry for our source uid means the message really moved and
 * its ABSENCE means the server matched nothing. Those are two different
 * facts and the caller acts differently on each, so they are distinguished
 * here rather than collapsed into a truthiness test.
 */
function readMoveResponse(
  response: { uidMap?: Map<number, number> },
  uid: number,
): { moved: boolean; newUid: number | null } {
  const uidMap = response.uidMap;
  if (!(uidMap instanceof Map)) {
    // No UIDPLUS. The command succeeded, so the move happened; we simply
    // cannot say under which uid. See MoveOutcome.newUid.
    return { moved: true, newUid: null };
  }
  const newUid = uidMap.get(uid);
  if (newUid === undefined) return { moved: false, newUid: null };
  return { moved: true, newUid };
}

/**
 * Moves ONE message out of ONE folder, on the connection the caller
 * already holds.
 *
 * **The caller must already be inside that account's mutex** — ../api/
 * move.ts wraps this in `pool.withAccountLock` exactly as ../api/flags.ts
 * wraps `setMessageFlag`. `KeyedMutex` is not re-entrant, so acquiring it
 * here would wedge the account permanently for any caller that already
 * holds the key. ./flags.ts's doc comment has the full reasoning; it
 * applies verbatim.
 *
 * `getMailboxLock(folder)` opens the SOURCE mailbox read-write, which a
 * MOVE requires. As with a STORE, this has no bearing on the preview
 * path's PEEK guarantee: SELECT sets `\Seen` on nothing, and nothing here
 * fetches a body.
 *
 * Resolves with what happened. Throws for every case in which the move
 * did NOT happen — an unavailable destination, an unsupported server, a
 * refused command, a transport failure — and never resolves quietly on a
 * move that did not occur. The single non-throwing "nothing changed"
 * outcome is `moved: false`, which means the uid was already gone, i.e.
 * the state the caller wanted is the state that exists.
 */
export async function moveMessage(
  connection: ImapConnection,
  folders: DiscoveredFolders,
  folder: string,
  uid: number,
  destination: MoveDestination,
): Promise<MoveOutcome> {
  // Both refusals run BEFORE the mailbox is opened, so a request that
  // cannot be satisfied provably touches nothing on the live connection.
  const target = resolveDestination(folders, destination);
  if (target === folder || folderKindForPath(folders, folder) === destination) {
    throw new MoveWouldNotChangeFolderError(folder);
  }

  const client = connection.rawClient();
  assertMoveSupported(client as unknown as { capabilities: Map<string, boolean | number> });

  const lock = await client.getMailboxLock(folder);

  // An exact single-UID sequence set, built here from a number the HTTP
  // layer has already validated as a positive safe integer — so no caller
  // can hand this function a range string. Same construction, same
  // reason, as ./flags.ts.
  const range = String(uid);

  try {
    const response = await client.messageMove(range, target, { uid: true });
    if (!response || typeof response !== 'object') {
      logOutcome(connection.accountId, folder, uid, target, 'refused');
      throw new MoveRefusedError(target);
    }

    const outcome = readMoveResponse(response, uid);
    logOutcome(
      connection.accountId,
      folder,
      uid,
      target,
      outcome.moved ? `ok uid=${outcome.newUid ?? 'unknown'}` : 'nothing matched',
    );
    return { ...outcome, destination: target };
  } catch (error) {
    if (!(error instanceof MoveRefusedError)) {
      logOutcome(connection.accountId, folder, uid, target, `error: ${describeError(error)}`);
    }
    throw error;
  } finally {
    // Released unconditionally: these connections live for the lifetime
    // of the process, so a lock leaked on a thrown error would wedge
    // every later operation on this account's mailbox.
    lock.release();
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The audit line for one attempted move of the user's real mail.
 *
 * ACCOUNT ID, FOLDER, UID, DESTINATION AND OUTCOME ONLY — never a
 * subject, never an address, never any part of a body. Identical policy
 * to ./flags.ts's logOutcome, and for the identical reason: this stream
 * is the only record that the service moved anything at all, and mail
 * content does not belong in it.
 *
 * console.error even on success, matching ./flags.ts and ./backfill.ts:
 * stderr is this service's only operator channel.
 */
function logOutcome(
  accountId: string,
  folder: string,
  uid: number,
  destination: string,
  outcome: string,
): void {
  console.error(
    `imap move: account "${accountId}" folder "${folder}" uid ${uid} ` +
      `-> "${destination}" — ${outcome}`,
  );
}
