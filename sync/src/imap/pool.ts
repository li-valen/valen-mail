import type { ImapFlow } from 'imapflow';
import type { AccountConfig } from '../config';
import type { Db, MessageInput } from '../db';
import type { AttachmentMeta } from '../attachments';
import { ImapConnection } from './connection.ts';
import { fetchHeaders, ESTIMATED_BYTES_PER_HEADER_FETCH } from './fetch.ts';
import { collectPreviews } from './previews.ts';
import { runBackfillCycle } from './backfill.ts';
import { applySnippet } from '../normalize.ts';
import { folderSyncOrder, type DiscoveredFolders, type FolderKind } from './folders.ts';
import { FolderCache } from './folder-cache.ts';
import { KeyedMutex } from './keyed-mutex.ts';
import { NewMailMarks } from './new-mail-marks.ts';
import { UidValidityLog } from './uid-validity.ts';
import { ByteBudget } from '../budget.ts';
import { withTimeout } from '../timeout.ts';
import { computeBackoffMs, MAX_BACKOFF_MS } from './backoff.ts';

// Re-exported so every existing import of these two names from './pool'
// (tests/pool.test.ts) keeps working unchanged — fix round 1 moved the
// implementation itself to ./backoff.ts (see that module's own doc
// comment for why) without moving where callers reach for it.
export { computeBackoffMs, MAX_BACKOFF_MS };

export type AccountStatus = 'connected' | 'reconnecting' | 'stopped';

/** Bounded page size for each folder's sync each cycle. Amendment 3: no UID cursor here —
 *  `resolveUidSpan` (fetch.ts) does not validate `sinceUid`, so a 0 or
 *  negative cursor would build a malformed IMAP range. This pool instead
 *  relies on repeated bounded polls of the newest messages plus
 *  `upsertMessage`'s idempotent (account, folder, uid) upsert.
 *
 *  This poll deliberately remains a poll of the newest 50 and nothing
 *  more. Reaching further back is Plan 8 Task 1's ./backfill.ts, which
 *  runs AFTER this loop in the same cycle, on the same connection, and
 *  walks backwards from the oldest UID this poll has reached — with its
 *  own budget share, its own resume point in `sync_state`, and no path to
 *  the new-mail hook. Widening this constant instead would have made
 *  every cycle pay for history forever and handed months of old mail to
 *  the dispatcher as "new". */
const HEADER_FETCH_LIMIT = 50;

/** Pre-fetch reservation charged against the daily byte budget before each
 *  FOLDER's fetch (four per cycle at most, not one — see the budget maths
 *  above syncOnce's folder loop). Derived from fetch.ts's own per-message
 *  estimate so the two numbers cannot silently drift apart. */
const RESERVE_BYTES_PER_FOLDER_SYNC = HEADER_FETCH_LIMIT * ESTIMATED_BYTES_PER_HEADER_FETCH;

/**
 * How long an account's connection sits in IDLE before this pool breaks it
 * to run a liveness probe. `ImapConnection.isConnected` mirrors imapflow's
 * `usable` flag, which only turns false on a socket `close`/`end`/`error` —
 * it cannot detect a half-open TCP connection (peer vanished without a FIN
 * or RST) until the next read or write. Without a bounded wait, a silently
 * dead connection would sit in IDLE forever: it never wakes (no data is
 * arriving) and never reconnects (no error ever fires).
 *
 * 3 minutes is comfortably under Gmail's own minimum 29-minute IDLE drop —
 * so this timer, not Gmail's, is what normally paces the liveness check —
 * while being short enough that a half-open connection is caught and
 * replaced well within a user's expectation of "new mail shows up soon".
 * It is also infrequent enough (at most ~10 extra NOOP round trips per
 * Gmail-forced 29-minute IDLE cycle) not to matter against the connection
 * budget.
 */
export const IDLE_LIVENESS_CHECK_INTERVAL_MS = 3 * 60 * 1_000;

/** Upper bound on the liveness probe itself (NOOP). A half-open socket
 *  would otherwise let this hang exactly as long as IDLE did — the probe
 *  needs its own, much shorter timeout to actually prove something. */
export const LIVENESS_PROBE_TIMEOUT_MS = 15_000;

export type IdleWakeReason = 'mail' | 'timeout' | 'idle-ended';

/**
 * One line of IDLE state for the operator log, and nothing else — this is
 * diagnostics, so it must never be able to throw into the loop it is
 * describing.
 *
 * Every field answers a hypothesis that has already been raised about why
 * the 'mail' wake does not fire in production:
 *  - `mailbox`  — is IDLE armed on INBOX, or did a folder-loop or backfill
 *                 leave another mailbox selected?
 *  - `exists`   — imapflow only emits `'exists'` when the untagged count
 *                 DIFFERS from `mailbox.exists` (untaggedExists() in
 *                 imap-flow.js), so a count that moves between two wakes
 *                 with no event in between is the signature of a
 *                 suppressed notification rather than a missing one.
 *  - `idling`   — `ImapFlow#idle()` returns immediately when the library's
 *                 own auto-IDLE already owns the connection, so an
 *                 'idle-ended' wake with `idling=true` at arm time is the
 *                 library short-circuit, not a dead socket.
 *
 * ACCOUNT/MAILBOX METADATA ONLY — never a subject, address or body, for
 * the reason backfill.ts's logPage documents.
 */
export function describeIdleState(client: ImapFlow): string {
  try {
    const mailbox = client.mailbox;
    const open = typeof mailbox === 'object' && mailbox !== null;
    return [
      `mailbox=${open ? mailbox.path : 'none'}`,
      `exists=${open ? mailbox.exists : 'n/a'}`,
      `idling=${client.idling}`,
      `usable=${client.usable}`,
    ].join(' ');
  } catch {
    return 'mailbox=? exists=? idling=? usable=?';
  }
}

/**
 * Waits for one of three things, whichever happens first:
 *  - the server pushes a mailbox change ('mail') — imapflow's `idle()`
 *    promise does NOT resolve on new mail by itself; new mail only ever
 *    surfaces as an `'exists'` event on the client while IDLE stays active
 *    underneath. Listening for the event, rather than awaiting `idle()`, is
 *    what actually makes the pool wake promptly on new mail.
 *  - `timeoutMs` elapses ('timeout') — the bounded wait from Amendment 1.
 *  - the underlying `idle()` call itself settles ('idle-ended') — in normal
 *    operation nothing here breaks IDLE while this function is waiting, so
 *    this firing first almost always means the socket died (error or
 *    close), which is itself worth reacting to immediately rather than
 *    waiting out the rest of the timeout.
 *
 * Does not itself decide whether the connection is alive; the caller acts
 * on the returned reason (see ConnectionPool.idleLoop).
 */
export async function waitForIdleWake(client: ImapFlow, timeoutMs: number): Promise<IdleWakeReason> {
  return await new Promise<IdleWakeReason>((resolve) => {
    let settled = false;

    const finish = (reason: IdleWakeReason): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.removeListener('exists', onExists);
      resolve(reason);
    };

    const onExists = (): void => finish('mail');
    const timer = setTimeout(() => finish('timeout'), timeoutMs);

    client.on('exists', onExists);
    // Not awaited: this promise settling is one of the three signals raced
    // above, not something the caller needs the resolved value of. Both
    // branches route to the same reason — by the time IDLE ends on its own,
    // whether the library reports it as success or failure carries no
    // extra information for a caller who did not ask it to end.
    client.idle().then(
      () => finish('idle-ended'),
      () => finish('idle-ended'),
    );
  });
}

/**
 * Cheap liveness round trip. `ImapFlow#run()` breaks any active IDLE
 * automatically before running the next command, so this both ends IDLE and
 * proves the socket is actually alive — a NOOP that hangs (or errors) means
 * the connection is dead even though `isConnected` still reads true.
 */
export async function probeLiveness(
  client: ImapFlow,
  timeoutMs: number = LIVENESS_PROBE_TIMEOUT_MS,
): Promise<void> {
  await withTimeout(client.noop(), timeoutMs, 'liveness probe (NOOP)');
}

/**
 * Injected hook for genuinely new mail (Task 7 / Amendment 3). The pool
 * calls this with the messages `NewMailMarks.track()` decided are new
 * since the account's own previous cycle — never on a folder's first
 * cycle, no matter how many messages that cycle fetches (see
 * new-mail-marks.ts for why).
 *
 * Plan 5: the pool syncs four folders per account but only ever calls this
 * for INBOX's new messages (see syncOnce's INBOX-only dispatch guard), so
 * a hook may assume every message it receives is an inbox message.
 *
 * This type is the ENTIRE surface the pool knows about push: a function
 * from (accountId, messages) to void or a promise of void. server.ts
 * wires this to push/dispatch.ts's `notifyNewMail`; this module never
 * imports anything from push/ and has no idea what the hook does with
 * what it's given.
 */
export type OnNewMessagesHandler = (
  accountId: string,
  messages: readonly MessageInput[],
) => void | Promise<void>;

/**
 * One long-lived IMAP connection per configured account: connects, runs a
 * bounded header sync, then sits in IDLE — waking on new mail, waking on a
 * bounded timeout to prove the connection is still alive (Amendment 1), and
 * reconnecting with jittered backoff whenever any of that fails.
 *
 * Note: parameter properties are avoided project-wide because the service
 * runs under --experimental-strip-types, which does not support them.
 */
export class ConnectionPool {
  private readonly accounts: readonly AccountConfig[];
  private readonly db: Db;
  private readonly createConnection: (account: AccountConfig) => ImapConnection;
  private readonly onNewMessages: OnNewMessagesHandler | undefined;
  private readonly budget: ByteBudget;
  private readonly mutex = new KeyedMutex();
  private readonly connections = new Map<string, ImapConnection>();
  private readonly statuses = new Map<string, AccountStatus>();
  private running = false;

  // Amendment 3's backfill guard, keyed per (account, folder) since Plan 5
  // — see imap/new-mail-marks.ts for the whole rationale, including why
  // the state is deliberately in-memory and why one mark per account
  // stopped being correct once four folders shared it.
  private readonly marks = new NewMailMarks();

  // Folder discovery, its two differently-keyed caches, and the
  // missing-folder log policy — see ./folder-cache.ts.
  private readonly folderCache = new FolderCache();

  // Last observed UIDVALIDITY per (account, folder) — see
  // ./uid-validity.ts, including why this is NOT syncOnce()'s own
  // per-cycle map and who reads it.
  private readonly uidValidity = new UidValidityLog();

  // Fix round 2, Fix A: every detached dispatch chain currently running
  // (Fix round 1, Fix 5 made dispatch fire-and-forget from syncOnce(), so
  // more than one of these can be live per account at once during a mail
  // burst). Added when a chain is launched, removed once it settles —
  // see trackDispatch(). stop() drains this set so a chain can never be
  // left racing db.close() against the account it dispatched for.
  private readonly inFlightDispatches = new Set<Promise<void>>();

  // Lets a backoff sleep (up to MAX_BACKOFF_MS) be cut short the instant
  // stop() is called, instead of stop() having to wait out whatever delay
  // a reconnecting account happened to be in the middle of.
  private stopRequested: Promise<void>;
  private resolveStopRequested: () => void = () => {};

  /**
   * @param createConnection Test-only seam, defaulting to a real
   *   `ImapConnection` per account. Tests inject one that wraps a fake
   *   imapflow client (see ImapConnection's own `createClient` parameter
   *   from Task 5) so the pool's backoff, status, serialisation and
   *   stop-safety behaviour can be driven deterministically without a
   *   socket or a live Gmail account.
   * @param onNewMessages Optional (Task 7). When absent, this pool's
   *   behaviour is byte-identical to before this parameter existed —
   *   NewMailMarks.track() still runs every cycle, for every folder, to
   *   keep its bookkeeping current, but dispatchNewMessages() no-ops
   *   immediately without a handler to call.
   */
  constructor(
    accounts: readonly AccountConfig[],
    db: Db,
    createConnection: (account: AccountConfig) => ImapConnection = (account) => new ImapConnection(account),
    onNewMessages?: OnNewMessagesHandler,
  ) {
    this.accounts = accounts;
    this.db = db;
    this.createConnection = createConnection;
    this.onNewMessages = onNewMessages;
    this.budget = new ByteBudget(db);
    this.stopRequested = new Promise((resolve) => {
      this.resolveStopRequested = resolve;
    });
  }

  get status(): ReadonlyMap<string, AccountStatus> {
    return this.statuses;
  }

  /**
   * Returns the live connection for one account, or undefined if the
   * account id is unknown to this pool or has never connected. Nothing
   * inside this class needs this — it exists for Task 8's API, which reads
   * a specific account's connection on demand to serve the body and
   * attachment routes (fetchBodyPart), never as part of the sync loop
   * itself.
   */
  getConnection(accountId: string): ImapConnection | undefined {
    return this.connections.get(accountId);
  }

  /** The API layer's read of this pool's own folder discovery, so it need
   *  not issue a second LIST — see FolderCache.forAccount for the contract,
   *  including why "never discovered" and "discovered but absent" are
   *  deliberately indistinguishable to the caller. */
  getDiscoveredFolders(accountId: string): DiscoveredFolders | undefined {
    return this.folderCache.forAccount(accountId);
  }

  /** The API layer's read of the UIDVALIDITY this pool has already
   *  observed, so it need not SELECT the mailbox itself once per request
   *  on the connection the sync loop is sharing — see ./uid-validity.ts
   *  for the contract and ../api/message-cache.ts for who asks. */
  getUidValidity(accountId: string, folder: string): bigint | null {
    return this.uidValidity.get(accountId, folder);
  }

  /**
   * Runs `fn` inside the same per-account critical section syncOnce() and
   * idleLoop()'s liveness probe use.
   *
   * The API and the IDLE loop drive the SAME imapflow client. An on-demand
   * download breaks the active IDLE, so waitForIdleWake() returns
   * 'idle-ended' and idleLoop() runs probeLiveness() — and imapflow
   * serialises commands per connection, so an uncoordinated NOOP would
   * queue behind an in-flight download. A download that outlasted
   * LIVENESS_PROBE_TIMEOUT_MS (15s — a large attachment on a slow link)
   * would then time the probe out, and runAccount() would tear down a
   * perfectly healthy connection, killing the download with it.
   *
   * What this key actually guarantees: syncOnce(), the idleLoop() probe,
   * and any caller of withAccountLock() (the API's on-demand fetches) are
   * mutually exclusive per account — whichever acquires the key first runs
   * to completion, success or failure, before the next one is even
   * started. They can never interleave or race the same client.
   *
   * What it does NOT guarantee is a bounded wait. KeyedMutex has no
   * timeout of its own, and the API's fetchBodyPart() (the only caller of
   * this method) has no independent deadline either — it is bounded by
   * MAX_BODY_PART_BYTES, not by time. A slow-but-still-progressing
   * download can therefore hold this key for as long as the transfer
   * takes, and both the next liveness probe and the next sync cycle for
   * that account simply queue behind it rather than running on schedule.
   * IDLE_LIVENESS_CHECK_INTERVAL_MS is a target cadence under sustained
   * on-demand traffic, not a hard bound — late is the only failure mode
   * left; racing the download is not.
   *
   * It also gives the API a place to do reserve -> fetch -> record as one
   * atomic unit against the same budget snapshot the sync loop uses.
   */
  async withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    return this.mutex.run(accountId, fn);
  }

  /**
   * The per-account daily byte budget (spec L6). Exposed because the API's
   * on-demand body and attachment fetches pull bytes down the SAME
   * connection Gmail meters — the sync loop charging a 2 KB estimate per
   * header fetch while the API pulls tens of megabytes unrecorded would
   * make the accounting fiction.
   */
  get byteBudget(): ByteBudget {
    return this.budget;
  }

  async start(): Promise<void> {
    this.running = true;
    // One connection per account, run concurrently with each other. Gmail
    // allows ~15 concurrent connections per account; this pool holds
    // exactly one, so ten accounts stay comfortably inside that ceiling.
    // A per-account failure (bad password, repeated reconnect failures)
    // is caught inside runAccount() and never propagates out of this
    // Promise.all — one bad account must never stop the other nine.
    await Promise.all(this.accounts.map((account) => this.runAccount(account)));
  }

  async stop(): Promise<void> {
    this.running = false;
    this.resolveStopRequested();
    // Disconnect every currently-tracked connection before dropping this
    // pool's own reference to it. ImapConnection.disconnect() awaits any
    // in-flight connect() on that same instance (Task 5), so this is safe
    // even when an account is mid-reconnect — but only if we still hold
    // the reference to call disconnect() on; clearing the map first would
    // defeat that guarantee for no reason.
    const connections = [...this.connections.values()];
    await Promise.all(connections.map((connection) => connection.disconnect()));
    this.connections.clear();

    // Fix round 2, Fix A: drain any detached dispatch chains (Fix round 1,
    // Fix 5) AFTER disconnecting IMAP, not before — dispatch does not
    // touch IMAP at all, so ordering it after preserves the existing
    // disconnect-first shutdown shape rather than inventing a new one.
    //
    // Without this, server.ts's createShutdown() closes `db` right after
    // this method resolves (server -> pool/poll -> db), and Fix 5 made
    // dispatch detached from syncOnce() specifically so MULTIPLE chains
    // per account can be in flight at once during a mail burst against a
    // slow push service — any of them still running at that moment would
    // read push_subscriptions or write a prune against a closing/closed
    // db, and (per notifyNewMail's documented at-most-once semantics) that
    // failure is silently dropped, not retried.
    //
    // allSettled, not all: dispatchNewMessages() is structurally
    // never-rejecting (its own try/catch swallows and logs), so this is
    // belt-and-braces protection against stop() itself rejecting if that
    // contract were ever accidentally broken — today's behaviour does not
    // depend on the choice either way.
    //
    // This drain is unbounded, so sync/deploy/postbox-sync.service's
    // TimeoutStopSec must stay >= the ~250s worst case documented below or
    // systemd SIGKILLs the process mid-drain, before db.close() ever runs.
    await Promise.allSettled([...this.inFlightDispatches]);
  }

  /**
   * Registers a detached dispatch chain so stop() can drain it, and
   * removes it once it settles. `dispatchNewMessages()` never rejects, so
   * the `.finally()` below is the only cleanup needed — there is no
   * rejection branch to route separately.
   */
  private trackDispatch(promise: Promise<void>): void {
    this.inFlightDispatches.add(promise);
    void promise.finally(() => {
      this.inFlightDispatches.delete(promise);
    });
  }

  private async sleepInterruptible(ms: number): Promise<void> {
    // The timer must be captured and cleared on the winning branch, not
    // just left to fire on its own: when stopRequested wins this race
    // (stop() called mid-backoff), an uncleared setTimeout stays queued in
    // Node's timer list for up to MAX_BACKOFF_MS (5 minutes) after this
    // function has already returned. Under systemd that is the difference
    // between an ordered shutdown and a SIGKILL once the unit's stop grace
    // period elapses with the process still alive for no operational
    // reason.
    let timer!: NodeJS.Timeout;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    await Promise.race([timeout, this.stopRequested]);
    clearTimeout(timer);
  }

  private async runAccount(account: AccountConfig): Promise<void> {
    let attempt = 0;
    while (this.running) {
      // createConnection is a caller-supplied factory (tests inject one
      // that wraps a fake client). It stays inside the try along with
      // everything that depends on its result: a factory that throws
      // synchronously must be handled exactly like a failed connect() —
      // logged, backed off, retried — never left to escape runAccount and
      // reject start()'s Promise.all, which would take down every other
      // account's loop along with it.
      let connection: ImapConnection | null = null;
      try {
        connection = this.createConnection(account);
        // Registered before connect() is even attempted, not after it
        // succeeds. This account's connect() call, and this loop's ability
        // to notice stop() at all, race stop() the moment it is called: if
        // registration waited until connect() succeeded, a connect() that
        // completed just after stop() had already taken its disconnect
        // snapshot would leave this exact instance connected and completely
        // unaccounted for — a leaked socket stop() genuinely can't find.
        // Registering first means ImapConnection.disconnect() (Task 5) can
        // always find this instance and await its in-flight connect() before
        // deciding whether there is anything to close.
        this.connections.set(account.id, connection);

        await connection.connect();
        if (!this.running) break; // stop() raced this connect(); it already owns cleanup for this instance.
        this.statuses.set(account.id, 'connected');
        this.watchExists(account.id, connection.rawClient());

        // NOTE: `attempt` is deliberately NOT reset here. A successful TCP
        // + auth handshake proves only that Gmail accepted the credential;
        // it says nothing about whether this account can make progress.
        // Resetting on connect success made the backoff ladder unreachable
        // for every post-handshake failure — a Postgres restart or OOM-kill
        // (budget.reserve queries the db), a mailbox that fails to open, or
        // an account already IMAP-suspended where AUTH succeeds but SELECT
        // INBOX does not. Each of those threw below, the catch incremented
        // `attempt` from 0 to 1, and the loop slept only computeBackoffMs(1)
        // — 500-1000ms — forever. Measured against this pool with a Db whose
        // every query throws: 8 connect attempts in 6 seconds, sustained
        // indefinitely. That turns the byte-budget lockout this subsystem
        // exists to prevent into something the subsystem itself causes.
        await this.syncOnce(account.id, connection);

        // A full cycle completed — reserve, fetch, upsert, record all
        // succeeded — so this account is genuinely healthy and the ladder
        // is safe to reset. This is the ONLY place `attempt` returns to 0.
        attempt = 0;

        await this.idleLoop(account.id, connection);
        // idleLoop only returns once `running` has been cleared by stop();
        // the outer while re-checks that and exits below without going
        // through the catch block.
      } catch (error) {
        // Logged with the account id so a single bad credential (or a
        // single flaky connection) among ten is identifiable. The error
        // itself is already redacted of secrets by ImapConnection.
        console.error(`account "${account.id}": sync loop failed`, error);
        this.statuses.set(account.id, 'reconnecting');
        attempt += 1;

        // Best-effort cleanup of a connection that failed or was found
        // dead by the liveness probe. Not awaited: a hung logout() on a
        // half-open socket must not block this account's own retry loop
        // (the whole reason this connection is being discarded). Guarded
        // on `connection` because createConnection() itself may have been
        // what threw, in which case there is nothing to clean up.
        if (connection) {
          const failedConnection = connection;
          void failedConnection.disconnect().catch((cleanupError) => {
            console.error(`account "${account.id}": cleanup disconnect failed`, cleanupError);
          });
        }

        if (!this.running) break;
        await this.sleepInterruptible(computeBackoffMs(attempt));
      }
    }
    this.statuses.set(account.id, 'stopped');
  }

  /**
   * INSTRUMENTATION (push-latency investigation). A second, permanent
   * `'exists'` listener that only logs.
   *
   * `waitForIdleWake` attaches and detaches its own listener around each
   * wait, so an `'exists'` the library emits while a sync cycle is running
   * — or while nothing is waiting at all — is invisible. That ambiguity is
   * exactly what has to be resolved: it separates "imapflow never emitted
   * the event" (IDLE is not actually armed, or the event is being
   * suppressed below us) from "it emitted and the wait did not return
   * 'mail'" (the bug is in our own wait).
   *
   * Attached once per connection, right after connect(), so it lives and
   * dies with the client — a reconnect builds a new ImapFlow and this is
   * re-attached to that one. Two listeners at most, well under Node's
   * default max, and the handler does nothing but write a line.
   */
  private watchExists(accountId: string, client: ImapFlow): void {
    client.on('exists', (event) => {
      console.error(
        `account "${accountId}": imapflow emitted 'exists' ` +
          `path=${event.path} count=${event.count} prevCount=${event.prevCount}`,
      );
    });
  }

  private async idleLoop(accountId: string, connection: ImapConnection): Promise<void> {
    const client = connection.rawClient();
    while (this.running) {
      // INSTRUMENTATION (push-latency investigation). The wake reason has
      // always been read and branched on here and never logged, which left
      // "does the 'mail' wake fire in production?" unanswerable from the
      // outside — the only visible proxy was backfill's own page cadence.
      // One line per wake, carrying the reason, the measured wait and the
      // connection's IDLE state before and after, is the whole diagnostic:
      // an 'idle-ended' at ~0.0s is the imapflow short-circuit, an
      // 'idle-ended' at 180.0s is a real timeout, and 'mail' at all is the
      // thing that is supposedly never happening.
      const armedAt = Date.now();
      const armedState = describeIdleState(client);
      const reason = await waitForIdleWake(client, IDLE_LIVENESS_CHECK_INTERVAL_MS);
      console.error(
        `account "${accountId}": idle wake reason=${reason} ` +
          `waited=${((Date.now() - armedAt) / 1_000).toFixed(1)}s ` +
          `armed[${armedState}] woke[${describeIdleState(client)}]`,
      );
      if (!this.running) break;

      if (reason !== 'mail') {
        // 'timeout' or 'idle-ended': isConnected/`usable` is not proof of
        // liveness against a half-open TCP peer (Amendment 1). A failed or
        // hung probe here throws, which is caught by runAccount() and
        // turned into a reconnect with backoff.
        //
        // Routed through the same per-account key syncOnce() and
        // withAccountLock() use (F8): an on-demand API download and this
        // probe drive the same imapflow client, and imapflow serialises
        // commands per connection, so an un-keyed probe could queue behind
        // an in-flight download and time out against a perfectly healthy
        // connection. Taking this key here is safe from self-deadlock: by
        // the time idleLoop() runs, the syncOnce() call that preceded it
        // has already released this same key, and the syncOnce() call
        // below only runs after this one resolves — sequential, not
        // nested.
        await this.mutex.run(accountId, () => probeLiveness(client));
      }
      if (!this.running) break;

      await this.syncOnce(accountId, connection);
    }
  }

  private async syncOnce(accountId: string, connection: ImapConnection): Promise<void> {
    // Amendment 2: reserve -> fetch -> record is serialised per account so
    // two overlapping cycles can never both reserve against the same
    // stale budget snapshot. Different accounts use different keys, so
    // this never serialises across accounts.
    //
    // Plan 5: EVERY discovered folder is synced inside this one critical
    // section, on this one connection, sequentially — deliberately not a
    // per-folder mutex, and deliberately never released between folders.
    // The key is what stops an on-demand API download (withAccountLock) or
    // the liveness probe from interleaving with a cycle on the shared
    // imapflow client; a cycle that let go halfway would reopen exactly
    // that race, with the mailbox left pointing at Sent.
    const newMessages = await this.mutex.run(accountId, async (): Promise<readonly MessageInput[]> => {
      const folders = await this.folderCache.resolve(accountId, connection);

      // BYTE BUDGET, worst case, stated here because this loop is what
      // multiplied it by four: 50 headers x 2 KB
      // (ESTIMATED_BYTES_PER_HEADER_FETCH) = 100 KB per folder-fetch;
      // x 4 folders = 400 KB per account per full cycle; x 4 accounts =
      // ~1.6 MB per full cycle across the deployment. IDLE-driven cycles
      // have no upper rate bound, but the FLOOR cadence of one per
      // IDLE_LIVENESS_CHECK_INTERVAL_MS (180s) = 480/day puts a quiet
      // account at ~187 MB/day — under 10% of DAILY_BYTE_LIMIT (2 GiB,
      // per account per day). The budget machinery is unchanged and still
      // the real enforcement: each folder reserves and records separately,
      // so a busy account hits reserve()'s refusal exactly as it did with
      // one folder, just up to four times per cycle instead of once.
      //
      // PREVIEWS (Plan 7 Task 1) add a SECOND, smaller reserve/record per
      // folder — see ESTIMATED_BYTES_PER_PREVIEW_FETCH in ./fetch.ts for
      // that arithmetic and why it is one-time rather than recurring.
      const newByFolder = new Map<FolderKind, readonly MessageInput[]>();
      // Each folder's UIDVALIDITY as observed by the fetch below, for
      // ./backfill.ts's terminal-flag invalidation (fix round 1). Collected
      // here because live sync has already paid for it — the alternative is
      // opening every finished folder's mailbox once per cycle, forever.
      const liveUidValidity = new Map<string, bigint>();

      for (const target of folderSyncOrder(folders)) {
        try {
          const synced = await this.syncFolder(accountId, connection, target.path);
          newByFolder.set(target.kind, synced.newMessages);
          if (synced.uidValidity !== null) liveUidValidity.set(target.path, synced.uidValidity);
          this.uidValidity.record(accountId, target.path, synced.uidValidity);
        } catch (error) {
          // INBOX keeps its existing semantics: its failure IS the
          // connection's health signal (a mailbox that will not open on an
          // authenticated connection is how an IMAP-suspended account
          // presents), so it propagates to runAccount()'s reconnect ladder
          // exactly as before Plan 5.
          if (target.kind === 'inbox') throw error;
          // Every other folder is best-effort: a Trash disabled by policy,
          // a folder deleted between LIST and SELECT, a per-folder server
          // error — none of those justify abandoning the rest of the cycle
          // or tearing down a healthy connection. Account id and folder
          // name only.
          console.error(
            `account "${accountId}": folder "${target.path}" failed to sync, continuing with the rest`,
            error,
          );
        }
      }

      // HISTORICAL BACKFILL (Plan 8 Task 1) — after live sync, inside this
      // same critical section, on this same connection, and before the
      // INBOX re-select below (it opens other mailboxes).
      //
      // SUPPRESSION, at the one place a reader would look for it: this is
      // awaited for its side effects and returns nothing that can feed
      // `newByFolder`. Backfilled messages are written to Postgres and go
      // no further — never through marks.track(), never into the map the
      // INBOX-only dispatch guard below reads. Backfilling a year of mail
      // must not produce a year of buzzes; backfill.ts's own SUPPRESSION
      // note explains why that is structural, not conditional.
      await runBackfillCycle(
        { db: this.db, budget: this.budget, accountId, connection }, folders, liveUidValidity,
      );

      // The cycle must END with INBOX selected: imapflow leaves the last
      // locked mailbox selected after release(), so a cycle ending on
      // Trash would arm IDLE against Trash — and IDLE is INBOX-only by
      // design (one connection per account, Gmail's ~15 ceiling), so the
      // account would simply stop waking on new mail. Unconditional
      // because getMailboxLock short-circuits on an already-open mailbox
      // (zero round trips in the INBOX-only case) and because it then also
      // repairs the state after a folder that threw mid-open.
      await connection.openMailbox(folders.inbox);

      // NOTIFICATIONS ARE INBOX-ONLY (Plan 5 global constraint). Every
      // folder's high-water mark advanced above — syncFolder() called
      // marks.track() for all of them — but only INBOX's genuinely-new
      // messages reach the dispatch hook. A message the user just sent
      // themselves, or spam Gmail just filed, must not buzz a phone.
      //
      // Read by key, not accumulated in the loop: an accumulator's
      // correctness would depend on iteration order (the last folder
      // visited wins, possibly overwriting with an empty array), and this
      // guarantee must not rest on trash happening to be last.
      return newByFolder.get('inbox') ?? [];
    });

    // Deliberately outside the mutex.run() above, AND deliberately NOT
    // awaited (Fix round 1, Fix 5). Both matter for the same underlying
    // reason: dispatchNewMessages() may call a hook that reaches a push
    // service over the network, and this pool has no idea how long that
    // takes.
    //
    // Not holding the mutex here was already true before this fix — it's
    // what keeps a slow push send from queuing an on-demand API fetch or
    // the next liveness probe behind it (they share this account's mutex
    // key with syncOnce()).
    //
    // NOT AWAITING is the fix: awaiting here made the IDLE loop's
    // time-to-next-IDLE scale directly with push-service latency. Each
    // cycle fetches at most HEADER_FETCH_LIMIT (50) messages, and
    // sendPush bounds each individual send to REQUEST_TIMEOUT_MS (send.ts,
    // 5s) — so with even one stored subscription and a hung push service,
    // a fully-awaited dispatch could take up to 50 x 5s = ~250s, well past
    // IDLE_LIVENESS_CHECK_INTERVAL_MS (180s). That would starve the
    // liveness probe and delay noticing genuinely new mail for a reason
    // that has nothing to do with push at all — the exact kind of coupling
    // this pool's own backoff/liveness machinery exists to avoid.
    //
    // Detaching it is safe because the marks every folder's syncFolder()
    // computed are already committed inside NewMailMarks by this point, and
    // dispatchNewMessages() never throws (its own try/catch) — so `void`
    // here drops nothing but the wait. Per-cycle dispatch work stays
    // individually bounded (50 messages x each send's own 5s cap) even
    // when a slow cycle's dispatch is still running while the NEXT cycle's
    // dispatch starts; they just don't block each other or the sync loop
    // any more.
    //
    // Fix round 2, Fix A: routed through trackDispatch() rather than a
    // bare `void` — detaching multiple chains per account (exactly what
    // this comment describes above) means stop() needs a way to find and
    // drain every one of them, not just fire them and lose track. See
    // trackDispatch()'s and stop()'s own comments for why.
    this.trackDispatch(this.dispatchNewMessages(accountId, newMessages));
  }

  /**
   * One folder's share of a sync cycle: reserve, fetch the newest
   * HEADER_FETCH_LIMIT headers, upsert them with their attachment
   * metadata, record the bytes, and return the messages that are genuinely
   * new for THIS folder.
   *
   * No new sync logic lives here — this is the body syncOnce() used to run
   * inline against a hardcoded INBOX, with `folder` threaded through the
   * three places that were pinned to it (fetchHeaders, the attachment
   * rows' folder column, the high-water mark's key). The machinery was
   * already folder-agnostic: resolveUidSpan() knows nothing about folders,
   * and messages/sync_state have been keyed on (account, folder) since
   * Plan 2.
   *
   * Returning the new messages rather than dispatching them keeps the
   * INBOX-only notification guard in ONE place (syncOnce's call site)
   * instead of duplicating `if (folder === INBOX)` down every path.
   *
   * The mailbox's UIDVALIDITY rides along (fix round 1) so the backfill
   * pass can invalidate a watermark — and a terminal `backfill_done` —
   * computed against a numbering the server has since replaced. Nothing
   * about this fetch changed to produce it: FetchResult already carried
   * the field and this method used to drop it.
   */
  private async syncFolder(
    accountId: string,
    connection: ImapConnection,
    folder: string,
  ): Promise<{ readonly newMessages: readonly MessageInput[]; readonly uidValidity: bigint | null }> {
    const decision = await this.budget.reserve(accountId, RESERVE_BYTES_PER_FOLDER_SYNC);
    if (!decision.allowed) {
      // Amendment 4: a refused reservation skips the fetch entirely
      // (not just a log line) — logged with the account id and folder so
      // an operator can see which account is throttled and why.
      console.error(
        `account "${accountId}" folder "${folder}": daily byte budget exhausted, skipping sync ` +
          `(requested ${RESERVE_BYTES_PER_FOLDER_SYNC}, remaining ${decision.remaining})`,
      );
      // No fetch, so no UIDVALIDITY observed — null, which backfill reads
      // as "cannot tell" rather than "renumbered".
      return { newMessages: [], uidValidity: null };
    }

    const result = await fetchHeaders(connection, folder, { limit: HEADER_FETCH_LIMIT });

    // Recorded BEFORE previews and before the upserts, both of which used
    // to come first — ./previews.ts's collectPreviews reserves against
    // this same budget and would otherwise be measured against a snapshot
    // pretending this fetch never happened. Also strictly more
    // conservative: these bytes crossed the wire whether or not the
    // writes below succeed.
    await this.budget.record(accountId, result.bytesDownloaded);

    const previews = await collectPreviews({
      db: this.db, budget: this.budget, accountId, connection, folder, result,
    });

    for (const message of result.messages) {
      await this.db.upsertMessage(applySnippet(message, previews.get(message.uid) ?? null));
      // AFTER its message row, never before — see persistAttachments()
      // for the foreign key that requires this order and for what dropping
      // result.attachments entirely used to cost.
      await this.persistAttachments(accountId, folder, message.uid, result.attachments.get(message.uid));
    }

    return {
      newMessages: this.marks.track(accountId, folder, result.messages, result.uidValidity),
      uidValidity: result.uidValidity,
    };
  }

  /**
   * Invokes the injected new-mail hook, if any, for the INBOX messages
   * NewMailMarks.track() decided are genuinely new. This pool has no idea
   * what the hook does — Task 7 wires it to push/dispatch.ts's
   * `notifyNewMail`, but nothing here imports push/ or knows a
   * notification is involved — and a failure in it must never be mistaken
   * for a sync failure.
   *
   * This is the sanctioned use of catch-and-continue: the error IS
   * handled — logged with the account id, with the sync work for this
   * cycle already fully committed before this method is even called — not
   * silently discarded. Letting it reject uncaught would surface as an
   * unhandled rejection: syncOnce() (Fix round 1, Fix 5) deliberately does
   * NOT await this method any more — see its call site's own comment —
   * so nothing propagates this failure anywhere for runAccount()'s outer
   * catch to even see. That is what this try/catch actually guards
   * against now: not "corrupting the backoff ladder" (that was only a
   * risk while this WAS awaited by syncOnce), but an unhandled promise
   * rejection with no caller left to observe it at all.
   *
   * Always returns a resolved promise, never a rejected one — which is
   * what makes calling this without `await` at the syncOnce() call site
   * safe.
   *
   * This makes the new-mail path AT-MOST-ONCE: a message the marks
   * already decided was "new" and then failed to dispatch for (the hook
   * threw, or its own network call failed) is never retried — the
   * high-water mark has already moved past its UID by the time this
   * method even runs, so no later cycle will ever re-offer it. Contrast
   * push/opens-poll.ts's `notifyOpens` call site, which is deliberately
   * AT-LEAST-ONCE instead (persists its watermark only after a successful
   * send, so a crash between the two re-notifies on the next tick) — the
   * two paths made opposite choices for reasons specific to each: opens
   * has a durable, restart-safe watermark to re-derive "did this already
   * send" from; new mail's watermark is in-memory only (Amendment 3) and
   * has no such recovery story to lean on.
   */
  private async dispatchNewMessages(
    accountId: string,
    messages: readonly MessageInput[],
  ): Promise<void> {
    if (!this.onNewMessages || messages.length === 0) return;
    try {
      await this.onNewMessages(accountId, messages);
    } catch (error) {
      console.error(`account "${accountId}": new-mail notification hook failed`, error);
    }
  }

  /**
   * Called AFTER the message's own row: `attachments` has a foreign key
   * onto messages(account_id, folder, uid), so the reverse order fails
   * outright on a message a cycle is seeing for the first time. (F5:
   * dropping result.attachments instead of writing it left the table
   * permanently empty, made lookupAttachmentMeta a guaranteed miss — every
   * attachment served as application/octet-stream with no filename — and
   * left a client no way to discover a partId at all.)
   *
   * `folder` is a parameter rather than the old hardcoded INBOX constant
   * because of that same FK: a Sent message's attachment rows written
   * under 'INBOX' would violate it outright.
   */
  private async persistAttachments(
    accountId: string,
    folder: string,
    uid: number,
    parts: readonly AttachmentMeta[] | undefined,
  ): Promise<void> {
    if (!parts) return;
    for (const part of parts) {
      await this.db.upsertAttachment({
        accountId,
        folder,
        uid,
        partId: part.partId,
        filename: part.filename,
        mimeType: part.mimeType,
        sizeBytes: part.sizeBytes,
      });
    }
  }
}
