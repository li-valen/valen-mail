import nodemailer from 'nodemailer';
import type { SmtpTransportOptions, Transport } from 'nodemailer';
import type { AccountConfig } from '../config';
import { errorCode } from './error-code.ts';

/**
 * Plan 4 Task 2 — one lazy, per-account SMTP transport.
 *
 * `nodemailer` is the one new dependency this task takes (see
 * types/nodemailer.d.ts for why it is hand-declared rather than
 * `@types/nodemailer`). Every account sends over the same fixed
 * host/port — Gmail's SMTP-over-implicit-TLS endpoint — authenticated
 * with that account's own address and app password, exactly the
 * configuration tracking/scripts/send-test.mjs already proved against
 * these four real accounts.
 *
 * Transports are built lazily and cached, never eagerly for every
 * configured account: most sends over the life of this process will use
 * the primary identity, and opening a socket (or even constructing a
 * pooled connection object) for nine accounts that may never send a
 * single message would be pure waste on a 955 MB box already running ten
 * IMAP connections.
 */

/** Gmail's SMTP-over-implicit-TLS endpoint — the exact host/port pair
 *  send-test.mjs proved against these accounts. Not configurable: this
 *  service only ever sends from Gmail addresses via app passwords, so
 *  there is nothing for an operator to point elsewhere. */
const SMTP_HOST = 'smtp.gmail.com';
const SMTP_PORT = 465;

/**
 * `nodemailer.createTransport`, isolated behind a type so a test can
 * inject a stub — the same shape as push/send.ts's `SendImpl` and
 * opens.ts's `fetchImpl`. Production always uses the default.
 *
 * NEVER let a test exercise the real default: Gmail throttles repeated
 * SMTP connections, and this repo has already paid for that lesson once
 * (see tracking/scripts/send-test.mjs's own calibration-script comments).
 * Every transports.test.ts case injects a fake `createTransport` instead.
 */
export type CreateTransportFn = (options: SmtpTransportOptions) => Transport;

const defaultCreateTransport: CreateTransportFn = (options) => nodemailer.createTransport(options);

/**
 * `get` returns `undefined` — never throws — for an account id this
 * instance was not built from, mirroring ConnectionPool.getConnection's
 * own contract. Task 3's send route validates "identity exists" against
 * GET /api/identities' own account list before ever calling `get`, so
 * this is a defensive default, not the primary guard.
 */
export interface Transports {
  readonly get: (accountId: string) => Transport | undefined;
  readonly closeAll: () => void;
}

/**
 * Builds one `Transports` instance over `accounts`. Callers create their
 * own instance — production builds exactly one, in startServer(), and
 * wires its `closeAll` into createShutdown (see ../api/server.ts).
 *
 * `get(accountId)`:
 *  - Returns the cached transport on every call after the first for the
 *    same id — one `createTransport` call per account, ever, no matter
 *    how many messages are sent through it.
 *  - Returns `undefined`, and creates nothing, for an id absent from
 *    `accounts`.
 *
 * `closeAll()` calls `.close()` on exactly the transports that were
 * actually created — never on every configured account. An account whose
 * identity was listed but never sent through never opened a socket, so
 * there is nothing for shutdown to close on its behalf.
 *
 * Each close is isolated (Task 2 review finding, landed with Task 3, which
 * is what first populates this cache): one transport whose `close()`
 * throws must not skip the transports after it, and — the sharper half —
 * must not escape synchronously out of ../api/server.ts's
 * `Promise.all([...])` ARGUMENT LIST, which is still being evaluated when
 * `closeAll()` runs. A throw there never reaches a rejected promise: it
 * unwinds past the `await db.close()` on the following line and turns an
 * orderly shutdown into exit(1). Same belt-and-braces reasoning
 * `pool.stop()` already documents.
 */
export function createTransports(
  accounts: readonly AccountConfig[],
  createTransport: CreateTransportFn = defaultCreateTransport,
): Transports {
  const cache = new Map<string, Transport>();

  function get(accountId: string): Transport | undefined {
    const cached = cache.get(accountId);
    if (cached) return cached;

    const account = accounts.find((candidate) => candidate.id === accountId);
    if (!account) return undefined;

    const transport = createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: true,
      auth: { user: account.email, pass: account.appPassword },
    });
    cache.set(accountId, transport);
    return transport;
  }

  function closeAll(): void {
    for (const [accountId, transport] of cache) {
      try {
        transport.close();
      } catch (error) {
        // Account id and an error CODE — never the raw error object, which
        // is the discipline ./send.ts's own failure path follows and the
        // only place in this module that could break it (see
        // ./error-code.ts). Closing a socket the far end already dropped
        // is the ordinary case here, and not worth failing a shutdown over.
        console.error(
          `send: transport close failed for account ${accountId} (code=${errorCode(error)})`,
        );
      }
    }
  }

  return { get, closeAll };
}
