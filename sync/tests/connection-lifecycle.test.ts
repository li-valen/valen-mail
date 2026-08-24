import { describe, it, expect, vi } from 'vitest';
import { ImapConnection, LOGOUT_TIMEOUT_MS } from '../src/imap/connection';
import type { ImapFlow } from 'imapflow';

/**
 * These tests drive ImapConnection's connect/disconnect coordination
 * without a socket: a fake client stands in for imapflow, with a
 * manually-resolved gate on connect() so the test can force the exact
 * interleaving that a live Gmail round-trip could not reliably reproduce.
 * No network access, no live account — safe to run every time and immune
 * to Gmail rate limiting.
 */

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Minimal stand-in for the subset of ImapFlow this class actually calls. */
function createFakeClient() {
  const connectGate = createDeferred<void>();
  let usable = false;
  let logoutCalls = 0;

  const fake = {
    connect: vi.fn(async () => {
      await connectGate.promise;
      usable = true;
    }),
    logout: vi.fn(async () => {
      logoutCalls += 1;
      usable = false;
    }),
    get usable() {
      return usable;
    },
  };

  return {
    client: fake as unknown as ImapFlow,
    resolveConnect: () => connectGate.resolve(undefined),
    rejectConnect: (error: unknown) => connectGate.reject(error),
    logoutCallCount: () => logoutCalls,
    connectCallCount: () => fake.connect.mock.calls.length,
  };
}

const ACCOUNT = { id: 'test', email: 'a@example.com', appPassword: 'x'.repeat(16), isPrimary: true };

describe('ImapConnection lifecycle (no network)', () => {
  it('disconnect() called during an in-flight connect() leaves nothing connected', async () => {
    const fake = createFakeClient();
    const factory = vi.fn(() => fake.client);
    const connection = new ImapConnection(ACCOUNT, factory);

    const connectPromise = connection.connect();
    // At this point connect() is suspended inside client.connect(), and
    // this.client is still null — the exact window the finding describes.
    const disconnectPromise = connection.disconnect();

    // Let the in-flight connect() actually finish.
    fake.resolveConnect();

    await connectPromise;
    await disconnectPromise;

    expect(fake.logoutCallCount()).toBe(1);
    expect(connection.isConnected).toBe(false);
  });

  it('disconnect() awaits a connect() that ultimately fails without throwing', async () => {
    const fake = createFakeClient();
    const connection = new ImapConnection(ACCOUNT, () => fake.client);

    const connectPromise = connection.connect();
    const disconnectPromise = connection.disconnect();

    fake.rejectConnect(new Error('auth failed'));

    await expect(connectPromise).rejects.toThrow('auth failed');
    // disconnect() must not throw just because the connect() it waited on did.
    await expect(disconnectPromise).resolves.toBeUndefined();
    expect(fake.logoutCallCount()).toBe(0);
    expect(connection.isConnected).toBe(false);
  });

  it('double-disconnect is safe when called sequentially', async () => {
    const fake = createFakeClient();
    const connection = new ImapConnection(ACCOUNT, () => fake.client);

    fake.resolveConnect();
    await connection.connect();

    await connection.disconnect();
    await connection.disconnect();

    expect(fake.logoutCallCount()).toBe(1);
    expect(connection.isConnected).toBe(false);
  });

  it('double-disconnect is safe when called concurrently', async () => {
    const fake = createFakeClient();
    const connection = new ImapConnection(ACCOUNT, () => fake.client);

    fake.resolveConnect();
    await connection.connect();

    await Promise.all([connection.disconnect(), connection.disconnect()]);

    expect(fake.logoutCallCount()).toBe(1);
    expect(connection.isConnected).toBe(false);
  });

  it('concurrent connect() calls open exactly one client', async () => {
    const fake = createFakeClient();
    const factory = vi.fn(() => fake.client);
    const connection = new ImapConnection(ACCOUNT, factory);

    const first = connection.connect();
    const second = connection.connect();
    fake.resolveConnect();

    await Promise.all([first, second]);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(fake.connectCallCount()).toBe(1);
    expect(connection.isConnected).toBe(true);
  });

  // -------------------------------------------------------------------------
  // F4: a hung LOGOUT must not wedge shutdown
  // -------------------------------------------------------------------------

  it('gives up on a logout() that never returns instead of hanging forever', async () => {
    // logout() writes a command and waits for the server's reply. On a
    // half-open socket that write succeeds into a dead TCP window and the
    // reply never arrives. ConnectionPool.stop() awaits Promise.all over
    // every connection's disconnect(), so ONE hung logout wedged the entire
    // shutdown — and under systemd that ends in SIGKILL once the stop grace
    // period expires.
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const hangingClient = {
        connect: vi.fn(async () => {}),
        logout: vi.fn(() => new Promise<void>(() => {})), // never settles
        get usable() {
          return true;
        },
      } as unknown as ImapFlow;
      const connection = new ImapConnection(ACCOUNT, () => hangingClient);
      await connection.connect();

      const disconnectPromise = connection.disconnect();
      await vi.advanceTimersByTimeAsync(LOGOUT_TIMEOUT_MS + 1);

      // disconnect() must RESOLVE, not reject: a failed logout must never
      // stop shutdown, it is only logged with the account id.
      await expect(disconnectPromise).resolves.toBeUndefined();
      expect(connection.isConnected).toBe(false);

      const loggedAccount = errorSpy.mock.calls.some((call) =>
        call.some((arg) => typeof arg === 'string' && arg.includes('"test"')),
      );
      expect(loggedAccount).toBe(true);
    } finally {
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('leaves no pending timer behind when logout() succeeds normally', async () => {
    // The timeout guard must not itself become the thing that keeps the
    // event loop alive after a clean shutdown.
    vi.useFakeTimers();
    try {
      const fake = createFakeClient();
      const connection = new ImapConnection(ACCOUNT, () => fake.client);
      fake.resolveConnect();
      await connection.connect();
      await connection.disconnect();

      expect(vi.getTimerCount()).toBe(0);
      expect(fake.logoutCallCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});