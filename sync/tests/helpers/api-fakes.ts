import { vi } from 'vitest';

/**
 * Shared fakes for the API router suites.
 *
 * Every one of them stands in for something the router talks to — never a
 * real Postgres connection or IMAP socket. The fake "connection" objects
 * mimic only the two ImapFlow methods fetchBodyPart actually calls
 * (getMailboxLock/download), which is enough to prove routing, validation,
 * budgeting and error handling without ever dialing Gmail.
 *
 * Extracted from tests/routes.test.ts so the router's test surface can live
 * in more than one focused file without either copying the fakes or pushing
 * a single file past the project's 800-line ceiling.
 */

export const TOKEN = 'x'.repeat(32);
export const AUTH = { authorization: `Bearer ${TOKEN}` };

export function bufferStream(chunks: readonly Buffer[]): AsyncIterable<Buffer> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

export interface FakeDownloadCall {
  readonly uid: string;
  readonly partId: string | undefined;
}

export function makeFakeConnection(options: {
  chunks?: readonly Buffer[];
  onDownload?: (call: FakeDownloadCall) => void;
  downloadError?: Error;
}) {
  return {
    rawClient: () => ({
      getMailboxLock: async () => ({ release: () => {} }),
      download: async (uid: string, partId: string | undefined) => {
        options.onDownload?.({ uid, partId });
        if (options.downloadError) throw options.downloadError;
        return { content: bufferStream(options.chunks ?? [Buffer.from('bytes')]) };
      },
    }),
  } as never;
}

/** `Response.json()` is typed `Promise<unknown>` under this project's
 *  fetch types (no DOM lib); this narrows it at the one place each test
 *  needs a concrete shape, rather than sprinkling `as` casts inline. */
export async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export function makeFakeDb(overrides: Record<string, unknown> = {}) {
  return {
    getUnifiedInbox: async () => [{ subject: 'a', date: new Date('2026-08-01') }],
    getThread: async (id: string) => (id === 't1' ? [{ subject: 'x' }] : []),
    query: async () => [],
    upsertMessage: async () => {},
    upsertAttachment: async () => {},
    getSyncState: async () => null,
    setSyncState: async () => {},
    applySchema: async () => {},
    close: async () => {},
    ...overrides,
  } as never;
}

export interface BudgetCall {
  readonly accountId: string;
  readonly bytes: number;
}

/**
 * Stand-in for the three things routes.ts uses a ConnectionPool for:
 * connection lookup, the per-account lock that keeps an API download from
 * interleaving with the sync loop's liveness probe (F8), and the shared
 * daily byte budget the download must be charged against (F3, spec L6).
 *
 * Every call is recorded so a test can assert the wiring itself, not just
 * the status code — a route that skipped the lock or the budget entirely
 * would still return 200 without these.
 */
export function makeFakePool(options: {
  statuses?: readonly (readonly [string, string])[];
  connections?: Record<string, unknown>;
  budgetAllowed?: boolean;
  remaining?: number;
} = {}) {
  const lockKeys: string[] = [];
  const reserved: BudgetCall[] = [];
  const recorded: BudgetCall[] = [];
  const statuses = new Map<string, string>(options.statuses ?? [['primary', 'connected']]);
  const connections = options.connections ?? {};

  const pool = {
    status: statuses,
    getConnection: (id: string) => connections[id],
    async withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
      lockKeys.push(accountId);
      return fn();
    },
    byteBudget: {
      async reserve(accountId: string, bytes: number) {
        reserved.push({ accountId, bytes });
        return {
          allowed: options.budgetAllowed !== false,
          remaining: options.remaining ?? 1_000_000,
        };
      },
      async record(accountId: string, bytes: number) {
        recorded.push({ accountId, bytes });
      },
    },
  } as never;

  return { pool, lockKeys, reserved, recorded };
}
