import { ImapFlow } from 'imapflow';
import type { AccountConfig } from '../config';
import { withTimeout } from '../timeout.ts';

/** Gmail's IMAP endpoint. There is exactly one supported host/port pair, so
 *  no per-account override exists — connecting to anything else is not a
 *  configuration this service needs to support. */
const GMAIL_IMAP_HOST = 'imap.gmail.com';
const GMAIL_IMAP_PORT = 993;

/**
 * Upper bound on the IMAP LOGOUT round trip during disconnect().
 *
 * logout() writes a command and waits for the server's reply. On a
 * half-open socket (peer vanished without FIN or RST) that write succeeds
 * into a dead TCP window and the reply never arrives, so an unbounded
 * logout() hangs forever — and ConnectionPool.stop() awaits Promise.all
 * over every connection, so ONE hung logout wedges the entire shutdown.
 * Under systemd that ends in SIGKILL once the stop grace period expires.
 *
 * 5 seconds is far longer than a healthy LOGOUT (a single round trip to
 * Gmail) and far shorter than any plausible systemd TimeoutStopSec, so a
 * dead connection is abandoned quickly while a live one always completes
 * its clean logout.
 */
export const LOGOUT_TIMEOUT_MS = 5_000;

/**
 * NOT YET WIRED: no production caller. Only openMailbox() below returns
 * this shape, and openMailbox() itself has no production caller — the sync
 * path opens mailboxes through fetchHeaders()'s own getMailboxLock. Kept
 * for a future task that needs uidValidity/uidNext (a UID-cursor backfill,
 * spec 9 / L9).
 */
export interface MailboxInfo {
  readonly path: string;
  readonly uidValidity: bigint;
  readonly uidNext: bigint;
  readonly exists: number;
}

/**
 * Builds the real imapflow client for an account. Factored out of the class
 * so tests can substitute a fake client (see connection-lifecycle.test.ts)
 * and drive the connect/disconnect race without a socket.
 */
type ClientFactory = (account: AccountConfig) => ImapFlow;

function createGmailClient(account: AccountConfig): ImapFlow {
  return new ImapFlow({
    host: GMAIL_IMAP_HOST,
    port: GMAIL_IMAP_PORT,
    secure: true,
    auth: { user: account.email, pass: account.appPassword },
    // imapflow logs at debug level by default, and its log records can
    // include the raw auth payload. This service holds up to ten Gmail
    // app passwords, so logging must be explicitly disabled rather than
    // left to whatever the library's default happens to be — this is a
    // security requirement, not a style preference.
    logger: false,
  });
}

/**
 * Strips any literal occurrence of a secret from a string before it is
 * thrown or logged. IMAP auth failures are reported by the server, not by
 * echoing the client's own credential back, so in practice this should
 * never fire — it exists as defense-in-depth against a future error path
 * (or a bug in imapflow or one of its dependencies) that includes request
 * context verbatim in a message.
 */
function redactSecret(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join('[redacted]');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wraps a single imapflow client for one Gmail account. Opens exactly one
 * connection — Gmail allows roughly 15 concurrent IMAP connections per
 * account, and the Task 7 connection pool is what keeps a 10-account
 * deployment well under that ceiling by holding one of these per account
 * rather than one per operation.
 *
 * connect() and disconnect() are both idempotent under concurrency: each
 * caches its own in-flight promise so concurrent callers share one attempt
 * rather than racing separate ones, and disconnect() always waits out a
 * connect() that is still in flight before deciding whether there is
 * anything to close. Task 7 shuts all ten account connections down
 * concurrently, so a disconnect() that raced a still-connecting account and
 * silently no-opped (because this.client was still null) would leak a live,
 * untracked socket — exactly the failure mode this coordination closes.
 *
 * Note: parameter properties are avoided project-wide because the service
 * runs under --experimental-strip-types, which does not support them.
 */
export class ImapConnection {
  private readonly account: AccountConfig;
  private readonly createClient: ClientFactory;
  private client: ImapFlow | null = null;
  private connectPromise: Promise<void> | null = null;
  private disconnectPromise: Promise<void> | null = null;
  readonly accountId: string;

  /**
   * @param createClient Test-only seam. Production code never passes this —
   *   it defaults to opening a real socket to Gmail. Tests pass a fake
   *   client so the connect/disconnect race can be driven deterministically
   *   without a network call.
   */
  constructor(account: AccountConfig, createClient: ClientFactory = createGmailClient) {
    this.account = account;
    this.accountId = account.id;
    this.createClient = createClient;
  }

  get isConnected(): boolean {
    return this.client?.usable === true;
  }

  async connect(): Promise<void> {
    // Concurrent callers share one in-flight attempt instead of each
    // opening their own socket. The promise is cleared once it settles
    // (success or failure) so a later connect() — after a disconnect(), or
    // as a retry following a failed attempt — starts a fresh one.
    if (!this.connectPromise) {
      this.connectPromise = this.performConnect().finally(() => {
        this.connectPromise = null;
      });
    }
    return this.connectPromise;
  }

  private async performConnect(): Promise<void> {
    const client = this.createClient(this.account);

    try {
      await client.connect();
    } catch (error) {
      // Name the account so an operator can tell which of ten accounts
      // failed, but never let the credential itself reach the message.
      const reason = redactSecret(describeError(error), this.account.appPassword);
      throw new Error(`account "${this.accountId}": IMAP connect failed: ${reason}`);
    }

    this.client = client;
  }

  private getClient(): ImapFlow {
    if (!this.client) throw new Error(`account "${this.accountId}": not connected`);
    return this.client;
  }

  /**
   * Escape hatch that returns the underlying imapflow client. The Task 6
   * fetch module and the Task 7 IDLE/pool module need protocol-level
   * operations (partial body fetch, IDLE) that this wrapper deliberately
   * does not expose; routing those call sites through here keeps this
   * class the single owner of the connection's lifecycle while still
   * letting later tasks reach the client directly. Throws the same "not
   * connected" error as every other method on this class.
   */
  rawClient(): ImapFlow {
    return this.getClient();
  }

  /**
   * NOT YET WIRED: no production caller. The service syncs exactly one
   * folder (INBOX, see SYNCED_FOLDER in imap/pool.ts), so nothing needs to
   * enumerate mailboxes yet. Retained for multi-folder sync.
   */
  async listMailboxes(): Promise<readonly string[]> {
    const list = await this.getClient().list();
    return list.map((box) => box.path);
  }

  /**
   * NOT YET WIRED: no production caller. fetchHeaders() takes its own
   * mailbox lock and reads client.mailbox directly, so this wrapper is
   * exercised only by tests/connection.test.ts (live, opt-in). Retained
   * because a UID-cursor backfill needs uidValidity, which is exactly what
   * this returns.
   */
  async openMailbox(path: string): Promise<MailboxInfo> {
    const client = this.getClient();
    const lock = await client.getMailboxLock(path);
    try {
      const mailbox = client.mailbox;
      if (typeof mailbox === 'boolean') {
        throw new Error(`account "${this.accountId}": failed to open mailbox "${path}"`);
      }
      return {
        path: mailbox.path,
        uidValidity: BigInt(mailbox.uidValidity),
        uidNext: BigInt(mailbox.uidNext),
        exists: mailbox.exists,
      };
    } finally {
      // Released unconditionally so a thrown error above can never leave
      // the mailbox locked — a leaked lock would wedge every later
      // operation on this connection.
      lock.release();
    }
  }

  async disconnect(): Promise<void> {
    // Concurrent callers share one in-flight teardown rather than each
    // calling logout() on the same client.
    if (!this.disconnectPromise) {
      this.disconnectPromise = this.performDisconnect().finally(() => {
        this.disconnectPromise = null;
      });
    }
    return this.disconnectPromise;
  }

  private async performDisconnect(): Promise<void> {
    // A connect() may still be in flight on this instance — Task 7 shuts
    // down all ten accounts concurrently, and one may be mid-reconnect at
    // that moment. Wait for it to settle before deciding whether there is
    // a client to close: otherwise this method would see this.client as
    // still null, return immediately, and the in-flight connect() would go
    // on to assign this.client afterwards — a live socket that nothing is
    // tracking any more.
    if (this.connectPromise) {
      await this.connectPromise.catch(() => {
        // connect() failed on its own; nothing was assigned, nothing to close.
      });
    }

    if (!this.client) return;
    const client = this.client;
    this.client = null;
    try {
      // Bounded: an unbounded logout() on a half-open socket hangs forever
      // and ConnectionPool.stop() awaits every connection's disconnect().
      // withTimeout does not cancel the underlying command — it only stops
      // shutdown from waiting on a reply that is never coming.
      await withTimeout(client.logout(), LOGOUT_TIMEOUT_MS, 'IMAP LOGOUT');
    } catch (error) {
      // A failed logout must not prevent shutdown, but it is logged with
      // the account id rather than swallowed: with ten connections, a
      // silently hung logout is otherwise impossible to attribute.
      const reason = redactSecret(describeError(error), this.account.appPassword);
      console.error(`account "${this.accountId}": logout failed:`, reason);
    }
  }
}
