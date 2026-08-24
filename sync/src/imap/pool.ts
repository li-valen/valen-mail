import type { ImapFlow } from 'imapflow';
import type { AccountConfig } from '../config';
import type { Db } from '../db';
import { ImapConnection } from './connection.ts';
import { fetchHeaders, ESTIMATED_BYTES_PER_HEADER_FETCH } from './fetch.ts';
import { ByteBudget } from '../budget.ts';

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
 *  `upsertMessage`'s idempotent (account, folder, uid) upsert. */
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

/**
 * Rejects if `promise` has not settled within `ms`. Does not cancel the
 * underlying operation (imapflow has no cancellation primitive for an
 * in-flight command) — it only stops this caller from waiting on it
 * forever.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

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
  private readonly budget: ByteBudget;
  private readonly mutex = new KeyedMutex();
  private readonly connections = new Map<string, ImapConnection>();
  private readonly statuses = new Map<string, AccountStatus>();
  private running = false;

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
   */
  constructor(
    accounts: readonly AccountConfig[],
    db: Db,
    createConnection: (account: AccountConfig) => ImapConnection = (account) => new ImapConnection(account),
  ) {
    this.accounts = accounts;
    this.db = db;
    this.createConnection = createConnection;
    this.budget = new ByteBudget(db);
    this.stopRequested = new Promise((resolve) => {
      this.resolveStopRequested = resolve;
    });
  }

  get status(): ReadonlyMap<string, AccountStatus> {
    return this.statuses;
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
        attempt = 0;

        await this.syncOnce(account.id, connection);
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
        await probeLiveness(client);
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
    await this.mutex.run(accountId, async () => {
      const decision = await this.budget.reserve(accountId, RESERVE_BYTES_PER_SYNC);
      if (!decision.allowed) {
        // Amendment 4: a refused reservation skips the fetch entirely
        // (not just a log line) — logged with the account id so an
        // operator can see which account is throttled and why.
        console.error(
          `account "${accountId}": daily byte budget exhausted, skipping sync ` +
            `(requested ${RESERVE_BYTES_PER_SYNC}, remaining ${decision.remaining})`,
        );
        return;
      }

      const result = await fetchHeaders(connection, SYNCED_FOLDER, { limit: HEADER_FETCH_LIMIT });
      for (const message of result.messages) {
        await this.db.upsertMessage(message);
      }
      await this.budget.record(accountId, result.bytesDownloaded);
    });
  }
}
