import { ImapFlow } from 'imapflow';
import type { AccountConfig } from '../config';

/** Gmail's IMAP endpoint. There is exactly one supported host/port pair, so
 *  no per-account override exists — connecting to anything else is not a
 *  configuration this service needs to support. */
const GMAIL_IMAP_HOST = 'imap.gmail.com';
const GMAIL_IMAP_PORT = 993;

export interface MailboxInfo {
  readonly path: string;
  readonly uidValidity: bigint;
  readonly uidNext: bigint;
  readonly exists: number;
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
 * Note: parameter properties are avoided project-wide because the service
 * runs under --experimental-strip-types, which does not support them.
 */
export class ImapConnection {
  private readonly account: AccountConfig;
  private client: ImapFlow | null = null;
  readonly accountId: string;

  constructor(account: AccountConfig) {
    this.account = account;
    this.accountId = account.id;
  }

  get isConnected(): boolean {
    return this.client?.usable === true;
  }

  async connect(): Promise<void> {
    const client = new ImapFlow({
      host: GMAIL_IMAP_HOST,
      port: GMAIL_IMAP_PORT,
      secure: true,
      auth: { user: this.account.email, pass: this.account.appPassword },
      // imapflow logs at debug level by default, and its log records can
      // include the raw auth payload. This service holds up to ten Gmail
      // app passwords, so logging must be explicitly disabled rather than
      // left to whatever the library's default happens to be — this is a
      // security requirement, not a style preference.
      logger: false,
    });

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

  async listMailboxes(): Promise<readonly string[]> {
    const list = await this.getClient().list();
    return list.map((box) => box.path);
  }

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
    if (!this.client) return;
    const client = this.client;
    try {
      await client.logout();
    } catch (error) {
      // A failed logout must not prevent shutdown, but it is logged with
      // the account id rather than swallowed: with ten connections, a
      // silently hung logout is otherwise impossible to attribute.
      const reason = redactSecret(describeError(error), this.account.appPassword);
      console.error(`account "${this.accountId}": logout failed:`, reason);
    } finally {
      this.client = null;
    }
  }
}
