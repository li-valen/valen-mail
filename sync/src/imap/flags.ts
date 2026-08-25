import type { ImapConnection } from './connection';

/**
 * The FIRST write path this service has to IMAP.
 *
 * Everything else in sync/ reads: headers, previews, bodies, attachments.
 * This module changes state in a live Gmail mailbox, and it is the only
 * module that may. Three properties are structural here rather than
 * conventional, and none of them should be relaxed:
 *
 *  1. **Additive/subtractive, never a whole flag set.** `STORE +FLAGS` /
 *     `STORE -FLAGS` (imapflow's `messageFlagsAdd`/`messageFlagsRemove`)
 *     change exactly the one flag named and leave every other flag on the
 *     message alone. `messageFlagsSet` (`STORE FLAGS`) would replace the
 *     set wholesale, which means a read-modify-write against a snapshot
 *     that Gmail's own app may already have moved on from — starring a
 *     message on the phone while this service was mid-request would be
 *     silently undone. That failure mode is why `messageFlagsSet` is not
 *     imported here and must not be.
 *  2. **One message, never a range.** The UID is stringified into an exact
 *     single-UID sequence set. No `a:b`, no `1:*`, no array, no
 *     SearchObject — the same call shape that would mark one message read
 *     must not be reachable with a range in it. The blast radius of a bug
 *     in this file is bounded by that, not by a reviewer noticing.
 *  3. **Idempotent by construction.** Adding `\Seen` to a message that
 *     already carries it is a no-op at the server, as is removing one that
 *     is already absent. Nothing here reads the current flags to decide
 *     whether to act, so there is no check-then-act window for a
 *     concurrent change from another client to fall into.
 *
 * This module does NOT take the per-account mutex — see setMessageFlag's
 * own doc comment for why that is the caller's job and what happens if it
 * is done here instead.
 */

/**
 * The two flags this service may write, keyed by the name the HTTP layer
 * accepts on the wire.
 *
 * One object, deliberately: "which flags are supported" is a single fact,
 * and splitting the wire names from the IMAP flag strings across two
 * modules is how the API grows a third accepted name that reaches no
 * implementation (or worse, reaches the wrong flag). The types below are
 * derived from it rather than written alongside it, so the allowlist, the
 * validator and the IMAP call can never disagree.
 *
 * `\Deleted` is absent and must stay absent: this service has no expunge
 * path, and a flag whose only effect is to queue a message for permanent
 * deletion is not something a bug in an HTTP handler should be able to
 * reach.
 */
export const WRITABLE_FLAGS = {
  seen: '\\Seen',
  flagged: '\\Flagged',
} as const;

/** The wire name — `"seen"` / `"flagged"` — the API's body names. */
export type FlagField = keyof typeof WRITABLE_FLAGS;

/** The IMAP system flag itself — `"\\Seen"` / `"\\Flagged"`. A union of two
 *  literals, not `string`: an arbitrary flag name cannot be passed to
 *  setMessageFlag without the compiler rejecting it, so the allowlist is
 *  enforced at the type level as well as at the HTTP boundary. */
export type WritableFlag = (typeof WRITABLE_FLAGS)[FlagField];

/** Every wire name this service accepts, for the HTTP layer's own
 *  validation and its error messages. Derived from WRITABLE_FLAGS so a
 *  flag added there is accepted here without a second edit. */
export const FLAG_FIELDS = Object.keys(WRITABLE_FLAGS) as readonly FlagField[];

/**
 * True when `field` is one of the two supported wire names.
 *
 * `Object.hasOwn`, not `in` and not a truthy property read: a body of
 * `{"toString": true}` would satisfy both of those through the prototype
 * chain and reach an undefined flag. Own-property only is what makes an
 * unsupported name a 400 rather than a malformed IMAP command.
 */
export function isFlagField(field: string): field is FlagField {
  return Object.hasOwn(WRITABLE_FLAGS, field);
}

/**
 * Thrown when the server accepted the command but imapflow reports the
 * STORE did not apply — `messageFlagsAdd`/`Remove` resolve `false` rather
 * than rejecting when the UID resolves to nothing or the mailbox is open
 * read-only.
 *
 * A distinct type (rather than a bare Error) so a caller can tell a
 * refused write from a transport failure if it ever needs to, and so this
 * case cannot be mistaken for success by a caller that only checks for a
 * thrown error. A `false` that returned 200 would tell the client the
 * message is read when it is not — the precise defect this whole path
 * exists to remove.
 *
 * Note: explicit field assignment, not a TypeScript parameter property —
 * the service runs under --experimental-strip-types, which rejects those.
 */
export class FlagWriteRefusedError extends Error {
  readonly flag: WritableFlag;
  readonly value: boolean;

  constructor(flag: WritableFlag, value: boolean) {
    super(`IMAP refused to ${value ? 'add' : 'remove'} flag ${flag}`);
    this.name = 'FlagWriteRefusedError';
    this.flag = flag;
    this.value = value;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Adds or removes ONE flag on ONE message, on the connection the caller
 * already holds.
 *
 * **The caller must already be inside that account's mutex.** This mirrors
 * imap/fetch.ts's `fetchBodyPart`, which is likewise lock-free and is
 * wrapped by api/fetch-part.ts's `fetchBudgetedPart`; the API's
 * ./api/flags.ts wraps this one the same way. Two things make that split
 * load-bearing rather than stylistic:
 *
 *  - The API and the IDLE loop drive the SAME imapflow client, and imapflow
 *    serialises commands per connection. A STORE issued outside the lock
 *    breaks the active IDLE and can queue ahead of the liveness probe, and
 *    ConnectionPool tears a connection down when that probe times out.
 *  - `KeyedMutex` is NOT re-entrant. If this function acquired the account
 *    lock itself, any future caller that already holds it — the sync loop,
 *    a batched handler — would deadlock on its own key, and because the
 *    queue is a promise chain that never resolves, that account would be
 *    wedged for the lifetime of the process. Taking the lock in exactly one
 *    layer is what keeps a nested acquire impossible to write by accident.
 *
 * `getMailboxLock(folder)` opens the mailbox read-write (imapflow's
 * default), which a STORE requires. This has no bearing on the preview
 * path's PEEK guarantee: SELECT does not set `\Seen` on anything —
 * only a non-PEEK `FETCH BODY[]` does, and nothing here fetches a body.
 * Reading a preview still never marks mail read; this is an explicit user
 * action, which is a different thing entirely.
 *
 * Resolves on success. Throws FlagWriteRefusedError when the server did
 * not apply the change, or propagates the underlying IMAP error — never
 * resolves quietly on a write that did not happen.
 */
export async function setMessageFlag(
  connection: ImapConnection,
  folder: string,
  uid: number,
  flag: WritableFlag,
  value: boolean,
): Promise<void> {
  const client = connection.rawClient();
  const lock = await client.getMailboxLock(folder);

  // An exact single-UID sequence set. Built here, from a number the HTTP
  // layer has already validated as a positive safe integer, so no caller
  // can hand this function a range string.
  const range = String(uid);

  try {
    const applied = value
      ? await client.messageFlagsAdd(range, [flag], { uid: true })
      : await client.messageFlagsRemove(range, [flag], { uid: true });

    if (!applied) {
      logOutcome(connection.accountId, folder, uid, flag, value, 'refused');
      throw new FlagWriteRefusedError(flag, value);
    }

    logOutcome(connection.accountId, folder, uid, flag, value, 'ok');
  } catch (error) {
    if (!(error instanceof FlagWriteRefusedError)) {
      logOutcome(connection.accountId, folder, uid, flag, value, `error: ${describeError(error)}`);
    }
    throw error;
  } finally {
    // Released unconditionally: these connections live for the lifetime of
    // the process, so a lock leaked on a thrown error would wedge every
    // later operation on this account's mailbox.
    lock.release();
  }
}

/**
 * The audit line for one attempted mutation of the user's real mail.
 *
 * ACCOUNT ID, FOLDER, UID, FLAG, DIRECTION AND OUTCOME ONLY — never a
 * subject, never an address, never any part of a body, and never the flag
 * set read back off the server. This log goes to the same journald stream
 * as every other line this service writes, and mail content does not
 * belong there.
 *
 * It fires for successes as well as failures. This is the only record that
 * the service touched a live mailbox at all, and a log that recorded only
 * failures could not answer "what did this change in my mail".
 *
 * console.error even on success, for the reason ./backfill.ts's logPage
 * records: stderr is this service's only operator channel — the same one
 * folder-cache.ts's missing-folder line and new-mail-marks.ts's
 * UIDVALIDITY line use, neither of which is an error either.
 */
function logOutcome(
  accountId: string,
  folder: string,
  uid: number,
  flag: WritableFlag,
  value: boolean,
  outcome: string,
): void {
  console.error(
    `imap flags: account "${accountId}" folder "${folder}" uid ${uid} ` +
      `${value ? 'add' : 'remove'} ${flag} — ${outcome}`,
  );
}
