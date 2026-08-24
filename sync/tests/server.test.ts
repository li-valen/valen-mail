import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Server, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import {
  startServer,
  writeWebResponse,
  parseAccountsJson,
  onceOnly,
  createShutdown,
  registerShutdownHandlers,
} from '../src/api/server';
import type { ConnectionPool } from '../src/imap/pool';
import type { Db } from '../src/db';

/**
 * No Postgres, no IMAP, no live Gmail. The API_TOKEN cases below throw on
 * the very first line of startServer(), before it reads ACCOUNTS_FILE,
 * calls loadConfig(), opens a database connection, or starts the
 * connection pool. Everything else in this file exercises the shutdown and
 * config-parsing helpers directly against fakes — which is the point:
 * before this round none of the shutdown machinery had a caller at all, so
 * none of it could be tested end to end either.
 */

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('startServer / API_TOKEN fail-closed', () => {
  it('throws when API_TOKEN is unset rather than starting with no auth', async () => {
    delete process.env.API_TOKEN;
    await expect(startServer()).rejects.toThrow(/API_TOKEN/);
  });

  it('throws when API_TOKEN is shorter than 32 characters', async () => {
    process.env.API_TOKEN = 'short-token';
    await expect(startServer()).rejects.toThrow(/API_TOKEN/);
  });
});

// ---------------------------------------------------------------------------
// F6: a JSON syntax error must not carry a credential fragment into the log
// ---------------------------------------------------------------------------

describe('parseAccountsJson', () => {
  it('parses a valid accounts file', () => {
    expect(parseAccountsJson('[{"id":"primary"}]', 'accounts.json')).toEqual([{ id: 'primary' }]);
  });

  it('names the file and nothing else when the JSON is malformed', () => {
    expect(() => parseAccountsJson('[{', '/etc/postbox/accounts.json'))
      .toThrow('/etc/postbox/accounts.json is not valid JSON');
  });

  it('never echoes the surrounding source, which for the realistic failure is the app password', () => {
    // V8 embeds ~20 characters of surrounding source in "Unexpected token"
    // errors. Verified directly:
    //   Unexpected token 'S', ..."assword": SECRETPW12"... is not valid JSON
    // The realistic trigger is exactly the paste mistake config.ts already
    // anticipates — an app password pasted without quotes — and
    // startServer's entry guard console.errors whatever escapes, which
    // systemd writes to the persistent journal.
    const malformed = '[{"id":"primary","appPassword": SECRETPW12}]';

    // Sanity check that this input really does provoke the leaky V8 error,
    // so the assertion below is testing something real rather than passing
    // because the input was harmless all along.
    let v8Message = '';
    try {
      JSON.parse(malformed);
    } catch (error) {
      v8Message = String((error as Error).message);
    }
    expect(v8Message).toContain('SECRETPW12');

    let thrown: Error | null = null;
    try {
      parseAccountsJson(malformed, 'accounts.json');
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).not.toBeNull();
    expect(thrown!.message).not.toContain('SECRETPW12');
    // console.error and Node's default unhandled-rejection handler both
    // print `cause`, so attaching the original would reintroduce the leak
    // through a different channel.
    expect(thrown!.cause).toBeUndefined();
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown)))
      .not.toContain('SECRETPW12');
    expect(String(thrown!.stack)).not.toContain('SECRETPW12');
  });
});

// ---------------------------------------------------------------------------
// F4: shutdown must be reachable, ordered, and idempotent
// ---------------------------------------------------------------------------

interface ShutdownParts {
  readonly order: string[];
  readonly server: Server;
  readonly pool: ConnectionPool;
  readonly db: Db;
  readonly serverCloseCalls: () => number;
}

function makeShutdownParts(): ShutdownParts {
  const order: string[] = [];
  let serverCloseCalls = 0;

  const server = {
    close(callback: (error?: Error) => void) {
      serverCloseCalls += 1;
      order.push('server');
      // Real http.Server resolves the callback asynchronously, once
      // in-flight requests have drained.
      setTimeout(() => callback(), 0);
    },
  } as unknown as Server;

  const pool = {
    async stop() {
      order.push('pool');
    },
  } as unknown as ConnectionPool;

  const db = {
    async close() {
      order.push('db');
    },
  } as unknown as Db;

  return { order, server, pool, db, serverCloseCalls: () => serverCloseCalls };
}

describe('createShutdown', () => {
  it('stops accepting requests before tearing down what requests depend on', async () => {
    // The old order was pool -> db -> server, which left an in-flight HTTP
    // request holding a connection the pool had already disconnected, and
    // could hand a still-running request a closed pg pool.
    const parts = makeShutdownParts();
    await createShutdown(parts.server, parts.pool, parts.db)();
    expect(parts.order).toEqual(['server', 'pool', 'db']);
  });

  it('is idempotent: a second call joins the first rather than closing twice', async () => {
    const parts = makeShutdownParts();
    const close = createShutdown(parts.server, parts.pool, parts.db);

    await Promise.all([close(), close(), close()]);
    await close();

    expect(parts.order).toEqual(['server', 'pool', 'db']);
    expect(parts.serverCloseCalls()).toBe(1);
  });

  it('propagates a server close error instead of swallowing it', async () => {
    const server = {
      close(callback: (error?: Error) => void) {
        setTimeout(() => callback(new Error('not running')), 0);
      },
    } as unknown as Server;
    const parts = makeShutdownParts();
    await expect(createShutdown(server, parts.pool, parts.db)()).rejects.toThrow('not running');
  });
});

describe('onceOnly', () => {
  it('runs the wrapped function exactly once across concurrent callers', async () => {
    let calls = 0;
    const wrapped = onceOnly(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    await Promise.all([wrapped(), wrapped()]);
    await wrapped();

    expect(calls).toBe(1);
  });

  it('does not re-arm after settling — shutdown is terminal', async () => {
    let calls = 0;
    const wrapped = onceOnly(async () => {
      calls += 1;
    });
    await wrapped();
    await wrapped();
    expect(calls).toBe(1);
  });
});

describe('registerShutdownHandlers', () => {
  /** Resolves once `exit` has been called, so a test can await a handler
   *  that an EventEmitter gives it no promise for. */
  function makeExitSpy() {
    const codes: number[] = [];
    let resolveExited!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });
    return {
      codes,
      exited,
      exit: (code: number) => {
        codes.push(code);
        resolveExited();
      },
    };
  }

  it('runs a full shutdown on SIGTERM and exits 0', async () => {
    // Nothing used to call close() at all. Under systemd, SIGTERM's default
    // disposition kills the process immediately, so ConnectionPool.stop(),
    // the connect/disconnect race coordination and the interruptible
    // backoff sleep were all unreachable on the deployed box.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const parts = makeShutdownParts();
    const close = createShutdown(parts.server, parts.pool, parts.db);
    const emitter = new EventEmitter();
    const spy = makeExitSpy();

    registerShutdownHandlers(close, emitter, spy.exit);
    emitter.emit('SIGTERM');
    await spy.exited;

    expect(parts.order).toEqual(['server', 'pool', 'db']);
    expect(spy.codes).toEqual([0]);
  });

  it('runs a full shutdown on SIGINT too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const parts = makeShutdownParts();
    const emitter = new EventEmitter();
    const spy = makeExitSpy();

    registerShutdownHandlers(createShutdown(parts.server, parts.pool, parts.db), emitter, spy.exit);
    emitter.emit('SIGINT');
    await spy.exited;

    expect(parts.order).toEqual(['server', 'pool', 'db']);
  });

  it('ignores a second signal instead of starting a second teardown', async () => {
    // Ctrl-C twice, or systemd sending SIGTERM while a SIGINT shutdown is
    // still draining, must not close an already-closed server.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const parts = makeShutdownParts();
    const emitter = new EventEmitter();
    const spy = makeExitSpy();

    registerShutdownHandlers(createShutdown(parts.server, parts.pool, parts.db), emitter, spy.exit);
    emitter.emit('SIGTERM');
    emitter.emit('SIGTERM');
    emitter.emit('SIGINT');
    await spy.exited;

    expect(parts.serverCloseCalls()).toBe(1);
    expect(parts.order).toEqual(['server', 'pool', 'db']);
    expect(spy.codes).toEqual([0]);
  });

  it('exits non-zero and logs when shutdown itself fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const emitter = new EventEmitter();
    const spy = makeExitSpy();

    registerShutdownHandlers(async () => { throw new Error('pool stuck'); }, emitter, spy.exit);
    emitter.emit('SIGTERM');
    await spy.exited;

    expect(spy.codes).toEqual([1]);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('registers handlers for both signals', () => {
    const emitter = new EventEmitter();
    registerShutdownHandlers(async () => {}, emitter, () => {});
    expect(emitter.listenerCount('SIGTERM')).toBe(1);
    expect(emitter.listenerCount('SIGINT')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// writeWebResponse: stream the body out instead of buffering it a second time
// ---------------------------------------------------------------------------

interface FakeNodeResponse {
  readonly nodeResponse: ServerResponse;
  readonly collected: Promise<Buffer>;
  readonly status: () => number | null;
  readonly headers: () => Record<string, string>;
}

function makeFakeNodeResponse(): FakeNodeResponse {
  const sink = new PassThrough();
  let status: number | null = null;
  let headers: Record<string, string> = {};

  const collected = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    sink.on('data', (chunk: Buffer) => chunks.push(chunk));
    sink.on('end', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
  });

  Object.assign(sink, {
    writeHead(code: number, incoming: Record<string, string>) {
      status = code;
      headers = incoming;
      return sink;
    },
  });

  return {
    nodeResponse: sink as unknown as ServerResponse,
    collected,
    status: () => status,
    headers: () => headers,
  };
}

describe('writeWebResponse', () => {
  it('passes raw binary through byte for byte', async () => {
    // .text() would decode through UTF-8 and corrupt anything that is not
    // valid UTF-8 — which is every attachment. This asserts the bytes
    // survive, including a lone 0xFF that has no UTF-8 interpretation.
    const payload = Buffer.from([0x00, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47]);
    const fake = makeFakeNodeResponse();

    await writeWebResponse(
      new Response(payload, { status: 200, headers: { 'content-type': 'application/pdf' } }),
      fake.nodeResponse,
    );

    expect(await fake.collected).toEqual(payload);
    expect(fake.status()).toBe(200);
    expect(fake.headers()['content-type']).toBe('application/pdf');
  });

  it('carries the status and headers through for a JSON error response', async () => {
    const fake = makeFakeNodeResponse();
    await writeWebResponse(
      new Response(JSON.stringify({ error: 'nope' }), {
        status: 413,
        headers: { 'content-type': 'application/json' },
      }),
      fake.nodeResponse,
    );

    expect(fake.status()).toBe(413);
    expect((await fake.collected).toString()).toBe('{"error":"nope"}');
  });

  it('ends the response cleanly when there is no body at all', async () => {
    const fake = makeFakeNodeResponse();
    await writeWebResponse(new Response(null, { status: 204 }), fake.nodeResponse);
    expect(fake.status()).toBe(204);
    expect((await fake.collected).length).toBe(0);
  });
});
