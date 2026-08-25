import type { ImapFlow } from 'imapflow';
import type { AccountConfig } from '../config';
import type { Db, MessageInput } from '../db';
import type { AttachmentMeta } from '../attachments';
import { ImapConnection } from './connection.ts';
import { fetchHeaders, ESTIMATED_BYTES_PER_HEADER_FETCH } from './fetch.ts';
import { ByteBudget } from '../budget.ts';
import { withTimeout } from '../timeout.ts';

const BASE_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 5 * 60 * 1_000;
const MIN_BACKOFF_MS = 500;

/**
 * Ceiling of the exponential curve for a given attempt, before jitter.
 * Doubles per attempt starting from BASE_BACKOFF_MS, capped at MAX_BACKOFF_MS.
 */
function backoffCeilingMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1));
}

/**
 * Exponential backoff with "equal jitter" (ceiling/2 + random(0, ceiling/2)),
 * not "full jitter" (random(0, ceiling)). The jitter itself is not
 * decoration: ten accounts dropped by the same network blip would otherwise
 * reconnect in lockstep, presenting Gmail with a synchronised burst from one
 * user — and unlike full jitter, equal jitter keeps a real spread even once
 * the exponential curve has saturated at MAX_BACKOFF_MS (a long outage does
 * not degrade back into a fixed, lockstep delay).
 *
 * Equal jitter is also what makes attempt-to-attempt growth practically
 * guaranteed rather than a coin flip: full jitter draws from [0, ceiling]
 * every time, so a short attempt-1 draw and a long attempt-2 draw overlap
 * across roughly half their range. Equal jitter draws from
 * [ceiling/2, ceiling], so consecutive attempts' ranges only touch at a
 * single point — attempt N's range starts exactly where attempt N-1's ends.
 */
export function computeBackoffMs(attempt: number): number {
  const ceiling = backoffCeilingMs(attempt);
  const floor = Math.max(MIN_BACKOFF_MS, ceiling / 2);
  const jittered = floor + Math.random() * (ceiling - floor);
  return Math.round(jittered);
}

export type AccountStatus = 'connected' | 'reconnecting' | 'stopped';

const SYNCED_FOLDER = 'INBOX';

/** Bounded page size for each sync cycle. Amendment 3: no UID cursor here —
 *  `resolveUidSpan` (fetch.ts) does not validate `sinceUid`, so a 0 or
 *  negative cursor would build a malformed IMAP range. This pool instead
 *  relies on repeated bounded polls of the newest messages plus
 *  `upsertMessage`'s idempotent (account, folder, uid) upsert.
 *
 *  KNOWN LIMITATION (spec 9 / L9): this is a poll of the newest 50, not a
 *  backfill. If more than 50 messages arrive at an account while the
 *  service is down, everything older than the newest 50 is never fetched
 *  and never appears in the unified inbox — and nothing detects the gap.
 *  The `sync_state` table exists for the resume point a real backfill
 *  would need, but nothing reads or writes it today. */
const HEADER_FETCH_LIMIT = 50;

/** Pre-fetch reservation charged against the daily byte budget before each
 *  sync cycle. Derived from fetch.ts's own per-message estimate so the two
 *  numbers cannot silently drift apart. */
const RESERVE_BYTES_PER_SYNC = HEADER_FETCH_LIMIT * ESTIMATED_BYTES_PER_HEADER_FETCH;

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
 * Serialises async work by key while leaving different keys fully
 * concurrent. Amendment 2: `ByteBudget.reserve()`/`record()` are
 * check-then-act with no transaction, so two concurrent fetch cycles for
 * the same account could both reserve against the same stale snapshot and
 * both proceed — overspending the daily budget and eating the safety
 * margin between our 2 GB target and Gmail's ~2.5 GB suspension ceiling.
 * Keying by account id (rather than a single pool-wide lock) is what keeps
 * ten accounts running fully concurrently with each other; only calls that
 * share a key ever queue behind one another.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    // Wait for the previous task regardless of whether it succeeded or
    // failed — a failed task must not permanently wedge the queue for
    // every later caller sharing this key.
    const previousSettled = previous.catch(() => undefined);
    const result = previousSettled.then(fn);
    this.tails.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }
}

/**
 * Injected hook for genuinely new mail (Task 7 / Amendment 3). The pool
 * calls this with the messages `trackNewMessages` decided are new since
 * the account's own previous cycle — never on an account's first cycle,
 * no matter how many messages that cycle fetches (see trackNewMessages's
 * own comment for why).
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

  // Amendment 3's backfill guard state, per account. Deliberately
  // in-memory, not persisted: that is exactly what makes "a fresh service
  // start against an existing mailbox produces zero new-mail
  // notifications" hold on every restart, not just the very first one —
  // see trackNewMessages().
  private readonly firstCycleDone = new Set<string>();
  private readonly maxSeenUid = new Map<string, number>();

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
   *   trackNewMessages() still runs every cycle to keep its bookkeeping
   *   current, but dispatchNewMessages() no-ops immediately without a
   *   handler to call.
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

  private async idleLoop(accountId: string, connection: ImapConnection): Promise<void> {
    const client = connection.rawClient();
    while (this.running) {
      const reason = await waitForIdleWake(client, IDLE_LIVENESS_CHECK_INTERVAL_MS);
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
    const newMessages = await this.mutex.run(accountId, async (): Promise<readonly MessageInput[]> => {
      const decision = await this.budget.reserve(accountId, RESERVE_BYTES_PER_SYNC);
      if (!decision.allowed) {
        // Amendment 4: a refused reservation skips the fetch entirely
        // (not just a log line) — logged with the account id so an
        // operator can see which account is throttled and why.
        console.error(
          `account "${accountId}": daily byte budget exhausted, skipping sync ` +
            `(requested ${RESERVE_BYTES_PER_SYNC}, remaining ${decision.remaining})`,
        );
        return [];
      }

      const result = await fetchHeaders(connection, SYNCED_FOLDER, { limit: HEADER_FETCH_LIMIT });
      for (const message of result.messages) {
        await this.db.upsertMessage(message);
        // Attachment metadata is written AFTER its message row: the
        // attachments table has a foreign key onto
        // messages(account_id, folder, uid), so the reverse order would
        // fail on a message this cycle is seeing for the first time.
        //
        // Dropping result.attachments (which is what this loop used to do)
        // left the table permanently empty, which in turn made
        // lookupAttachmentMeta a guaranteed miss — every attachment served
        // as application/octet-stream with no filename — and left a client
        // with no way to discover a partId at all, so
        // /api/attachment/:account/:folder/:uid/:partId was unreachable.
        await this.persistAttachments(accountId, message.uid, result.attachments.get(message.uid));
      }
      await this.budget.record(accountId, result.bytesDownloaded);

      return this.trackNewMessages(accountId, result.messages);
    });

    // Deliberately outside the mutex.run() above: dispatchNewMessages()
    // may call a hook that reaches a push service over the network, and
    // holding the same per-account key syncOnce()/withAccountLock()/the
    // liveness probe all share for that long would delay an on-demand API
    // fetch or the next liveness probe behind a slow or hung push send,
    // for a reason unrelated to any of them.
    await this.dispatchNewMessages(accountId, newMessages);
  }

  /**
   * Amendment 3 (backfill guard). Decides which of this cycle's fetched
   * messages are genuinely new — arrived since the last cycle THIS PROCESS
   * observed for this account — and returns only those. An account's
   * first cycle always returns an empty array, no matter how many
   * messages it fetched: that cycle only establishes the high-water mark,
   * it never reports anything as new. This is what makes "a fresh service
   * start against an existing mailbox produces zero new-mail
   * notifications" true — the ~50 newest messages a brand-new process
   * finds already in the mailbox are indistinguishable at this layer from
   * "have always been there" (which, restart after restart, they are).
   *
   * `firstCycleDone`/`maxSeenUid` are in-memory and reset on every process
   * restart BY DESIGN — this pool has no durable resume point today (spec
   * 9 / L9's known limitation: the newest-50 poll, not a backfill), so
   * there is no reliable persisted watermark to compare against anyway.
   * The in-memory guard turns that same limitation into the correct
   * behaviour for notifications specifically: every restart re-earns "new"
   * from a clean baseline instead of trusting stale state.
   *
   * On a LATER cycle, only messages whose UID exceeds the account's
   * previous high-water mark count as new. This is also what stops the
   * same ~50-newest poll from re-notifying every cycle: a liveness-probe
   * -triggered re-poll (every IDLE_LIVENESS_CHECK_INTERVAL_MS at most) or
   * a flag change re-fetches UIDs already at or below the mark, and they
   * are filtered out here rather than by whatever the hook does with them.
   *
   * Runs unconditionally, whether or not a hook is configured — the
   * bookkeeping itself must stay correct so that installing a hook later
   * in the process's life (there is no such caller today, but nothing
   * here assumes there won't be) sees an accurate baseline rather than one
   * that stopped updating.
   */
  private trackNewMessages(
    accountId: string,
    messages: readonly MessageInput[],
  ): readonly MessageInput[] {
    const isFirstCycle = !this.firstCycleDone.has(accountId);
    this.firstCycleDone.add(accountId);

    const previousMax = this.maxSeenUid.get(accountId) ?? -Infinity;
    const currentMax = messages.reduce((max, message) => Math.max(max, message.uid), previousMax);
    this.maxSeenUid.set(accountId, currentMax);

    if (isFirstCycle) return [];
    return messages.filter((message) => message.uid > previousMax);
  }

  /**
   * Invokes the injected new-mail hook, if any, for the messages
   * trackNewMessages() decided are genuinely new. This pool has no idea
   * what the hook does — Task 7 wires it to push/dispatch.ts's
   * `notifyNewMail`, but nothing here imports push/ or knows a
   * notification is involved — and a failure in it must never be mistaken
   * for a sync failure.
   *
   * This is the sanctioned use of catch-and-continue: the error IS
   * handled — logged with the account id, with the sync work for this
   * cycle already fully committed before this method is even called — not
   * silently discarded. Letting it reject uncaught would surface as
   * syncOnce() rejecting, and runAccount()'s outer catch would then treat
   * a dead push subscription (or any other hook failure) exactly like a
   * dead IMAP connection: mark the account 'reconnecting' and corrupt the
   * backoff ladder F1 exists to protect, over a fault that has nothing to
   * do with IMAP at all.
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

  private async persistAttachments(
    accountId: string,
    uid: number,
    parts: readonly AttachmentMeta[] | undefined,
  ): Promise<void> {
    if (!parts) return;
    for (const part of parts) {
      await this.db.upsertAttachment({
        accountId,
        folder: SYNCED_FOLDER,
        uid,
        partId: part.partId,
        filename: part.filename,
        mimeType: part.mimeType,
        sizeBytes: part.sizeBytes,
      });
    }
  }
}
