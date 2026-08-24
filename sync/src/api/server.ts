import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { loadConfig } from '../config.ts';
import type { AccountConfig } from '../config';
import { openDb } from '../db.ts';
import type { Db } from '../db';
import { ConnectionPool } from '../imap/pool.ts';
import { createRouter } from './routes.ts';

/** Amendment 4: a missing or short token must fail the whole startup, not
 *  silently degrade to "no auth required" — that would publish four (soon
 *  up to ten) real mailboxes on the public internet. Mirrors a defect
 *  already found and fixed in Plan 1, where a missing config value
 *  degraded silently instead of refusing to start. */
const MIN_TOKEN_LENGTH = 32;

function requireApiToken(env: NodeJS.ProcessEnv): string {
  const apiToken = env.API_TOKEN;
  if (!apiToken || apiToken.length < MIN_TOKEN_LENGTH) {
    throw new Error(`API_TOKEN must be set and at least ${MIN_TOKEN_LENGTH} characters`);
  }
  return apiToken;
}

/**
 * Parses the accounts file, replacing V8's own SyntaxError with one that
 * names the file and nothing else.
 *
 * This is a credential-leak fix, not cosmetics. V8 embeds roughly twenty
 * characters of surrounding source in "Unexpected token" errors:
 *
 *     Unexpected token 'S', ..."assword": SECRETPW12"... is not valid JSON
 *
 * The realistic trigger is exactly the paste mistake config.ts already
 * anticipates — an app password pasted without quotes. startServer's entry
 * guard console.errors whatever escapes, and under systemd that lands in
 * the persistent journal.
 *
 * The original is deliberately NOT attached as `cause`: an Error's cause is
 * printed by console.error and by Node's default unhandled-rejection
 * handler, so attaching it would reintroduce the exact leak this removes.
 * The file name plus "is not valid JSON" is enough for an operator to open
 * the file and see the problem themselves.
 */
export function parseAccountsJson(contents: string, sourceLabel: string): unknown {
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error(`${sourceLabel} is not valid JSON`);
  }
}

/** Converts Node's IncomingHttpHeaders (string | string[] | undefined) into
 *  a Web Headers instance. A naive cast (rather than this conversion) can
 *  throw at runtime on an array-valued header and silently drops nothing —
 *  every present value is preserved, multi-valued or not. */
function toWebHeaders(nodeHeaders: IncomingMessage['headers']): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
    } else {
      headers.append(key, value);
    }
  }
  return headers;
}

function toWebRequest(nodeRequest: IncomingMessage): Request {
  return new Request(`http://localhost${nodeRequest.url ?? '/'}`, {
    method: nodeRequest.method ?? 'GET',
    headers: toWebHeaders(nodeRequest.headers),
  });
}

/**
 * Streams a Web Response's body onto a Node ServerResponse.
 *
 * This used to be `Buffer.from(await response.arrayBuffer())`, which
 * copied the entire body a second time before writing a single byte: an
 * attachment route response was already one full copy in memory, so peak
 * footprint was roughly 3x the part size on a 1 GB box that also runs
 * Postgres and up to ten IMAP connections. Piping the body through removes
 * that second copy and gets real backpressure instead of one giant
 * end(buffer).
 *
 * Not `.text()`: the attachment route sends raw binary, and decoding it
 * through a UTF-8 string corrupts anything that isn't valid UTF-8. The
 * byte stream is passed through untouched.
 *
 * Exported so tests can prove that byte-for-byte fidelity directly; nothing
 * outside this module calls it.
 */
export async function writeWebResponse(
  response: Response,
  nodeResponse: ServerResponse,
): Promise<void> {
  nodeResponse.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    nodeResponse.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body as never), nodeResponse);
}

/**
 * Handles one request end to end, catching anything the router itself
 * doesn't — a bug here must become a logged 500, never an unhandled
 * rejection that could crash a process serving four other accounts' live
 * connections.
 */
async function handleRequest(
  router: (request: Request) => Promise<Response>,
  nodeRequest: IncomingMessage,
  nodeResponse: ServerResponse,
): Promise<void> {
  try {
    const response = await router(toWebRequest(nodeRequest));
    await writeWebResponse(response, nodeResponse);
  } catch (error) {
    console.error(`api: unhandled error serving ${nodeRequest.method} ${nodeRequest.url}`, error);
    if (!nodeResponse.headersSent) {
      nodeResponse.writeHead(500, { 'content-type': 'application/json' });
    }
    nodeResponse.end(JSON.stringify({ error: 'internal server error' }));
  }
}

/**
 * Registers every configured account in Postgres (id/email/is_primary),
 * upserting rather than inserting so a restart with an unchanged accounts
 * file is a no-op rather than a conflict.
 *
 * The is_primary flag is cleared across the board first. schema.sql now
 * carries a partial unique index (accounts_one_primary, spec 7B.1), so
 * moving the primary from one account to another would otherwise collide
 * mid-loop the moment the new primary is upserted before the old one has
 * been demoted — an ordering that depends purely on the order of the
 * accounts array. Clearing first makes the outcome independent of it.
 *
 * Exported so tests can drive that switch against a real Postgres with the
 * index in place — the failure mode is a constraint violation, which only a
 * real database can demonstrate.
 */
export async function registerAccounts(db: Db, accounts: readonly AccountConfig[]): Promise<void> {
  await db.query('update accounts set is_primary = false where is_primary');
  for (const account of accounts) {
    await db.query(
      `insert into accounts (id, email, is_primary) values ($1,$2,$3)
       on conflict (id) do update set email=excluded.email, is_primary=excluded.is_primary`,
      [account.id, account.email, account.isPrimary],
    );
  }
}

/**
 * Wraps a shutdown routine so repeated calls share one in-flight teardown.
 *
 * Shutdown is terminal, so the promise is cached forever rather than
 * cleared on settle: a second SIGTERM, or a SIGINT arriving while SIGTERM's
 * shutdown is still running, must join the existing teardown rather than
 * start a second one that closes an already-closed server and rejects.
 */
export function onceOnly(fn: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return () => {
    if (!inFlight) inFlight = fn();
    return inFlight;
  };
}

/**
 * Wires SIGTERM and SIGINT to `close`.
 *
 * Without this, none of the shutdown engineering in this service is
 * reachable in production: SIGTERM's default disposition terminates the
 * process immediately, so systemd's `systemctl stop` would kill the process
 * mid-flight and ConnectionPool.stop(), the connect/disconnect race
 * coordination, and the interruptible backoff sleep would all be dead code
 * on the deployed box.
 *
 * `emitter` and `exit` are injectable so a test can drive a signal without
 * actually signalling (or exiting) the test runner's own process.
 */
export function registerShutdownHandlers(
  close: () => Promise<void>,
  emitter: NodeJS.EventEmitter = process,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  let shuttingDown = false;

  const onSignal = (signal: string): void => {
    // A second signal during shutdown is ignored rather than queued: the
    // operator pressing Ctrl-C twice must not start a second teardown.
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`api: received ${signal}, shutting down`);
    void close().then(
      () => exit(0),
      (error) => {
        console.error('api: shutdown failed', error);
        exit(1);
      },
    );
  };

  emitter.on('SIGTERM', () => onSignal('SIGTERM'));
  emitter.on('SIGINT', () => onSignal('SIGINT'));
}

/**
 * Tears the service down in dependency order: stop accepting requests,
 * then release what those requests depend on.
 *
 * The order matters and is the reverse of what it used to be. Closing the
 * IMAP pool first left any in-flight HTTP request holding a connection the
 * pool had already disconnected, and closing the database before the HTTP
 * server meant a request still being served could hit a closed pg pool.
 * server.close() stops new connections and resolves once the in-flight
 * ones have finished, so by the time the pool and the database go away
 * nothing is still using them.
 */
export function createShutdown(
  server: Server,
  pool: ConnectionPool,
  db: Db,
): () => Promise<void> {
  return onceOnly(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await pool.stop();
    await db.close();
  });
}

export async function startServer(): Promise<{ close(): Promise<void> }> {
  const apiToken = requireApiToken(process.env);

  const accountsFile = process.env.ACCOUNTS_FILE ?? './accounts.json';
  const config = loadConfig(
    parseAccountsJson(readFileSync(accountsFile, 'utf8'), accountsFile),
    process.env,
  );

  const db = openDb(config.databaseUrl);
  await db.applySchema();
  await registerAccounts(db, config.accounts);

  const pool = new ConnectionPool(config.accounts, db);
  // Not awaited: start() runs each account's connect/sync/IDLE loop for the
  // life of the process (Task 7). The HTTP server must come up and start
  // serving /api/health immediately, not block on ten IMAP handshakes.
  void pool.start().catch((error) => {
    console.error('api: connection pool stopped unexpectedly', error);
  });

  const router = createRouter(db, pool, apiToken);
  const server = createServer((nodeRequest, nodeResponse) => {
    void handleRequest(router, nodeRequest, nodeResponse);
  });

  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  console.error(`api: postbox-sync listening on ${config.port}, ${config.accounts.length} accounts`);

  const close = createShutdown(server, pool, db);
  registerShutdownHandlers(close);

  return { close };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((error) => {
    console.error('api: failed to start', error);
    process.exit(1);
  });
}
