import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
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
 * Writes a Web Response onto a Node ServerResponse via arrayBuffer(), not
 * text(): the attachment route sends raw binary bytes, and decoding those
 * through a UTF-8 string (as .text() would) corrupts anything that isn't
 * valid UTF-8.
 */
async function writeWebResponse(response: Response, nodeResponse: ServerResponse): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer());
  nodeResponse.writeHead(response.status, Object.fromEntries(response.headers));
  nodeResponse.end(body);
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
 */
async function registerAccounts(db: Db, accounts: readonly AccountConfig[]): Promise<void> {
  for (const account of accounts) {
    await db.query(
      `insert into accounts (id, email, is_primary) values ($1,$2,$3)
       on conflict (id) do update set email=excluded.email, is_primary=excluded.is_primary`,
      [account.id, account.email, account.isPrimary],
    );
  }
}

export async function startServer(): Promise<{ close(): Promise<void> }> {
  const apiToken = requireApiToken(process.env);

  const accountsFile = process.env.ACCOUNTS_FILE ?? './accounts.json';
  const config = loadConfig(JSON.parse(readFileSync(accountsFile, 'utf8')), process.env);

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

  return {
    async close(): Promise<void> {
      await pool.stop();
      await db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((error) => {
    console.error('api: failed to start', error);
    process.exit(1);
  });
}
