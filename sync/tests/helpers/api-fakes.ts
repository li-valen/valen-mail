import { vi } from 'vitest';
import type { DiscoveredFolders } from '../../src/imap/folders';

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

/**
 * One `messageFlagsAdd`/`messageFlagsRemove` call the fake IMAP client
 * saw (Plan: flags write path).
 *
 * `operation` is the half that matters most: a test asserting "clearing
 * \Seen used the SUBTRACTIVE op" is asserting that this service never
 * read-modify-writes a whole flag set, which is the property that keeps a
 * concurrent star from the Gmail app from being clobbered. `range` and
 * `flags` are recorded verbatim so a test can prove exactly one UID and
 * exactly one flag crossed the wire.
 */
export interface FakeFlagCall {
  readonly operation: 'add' | 'remove';
  readonly range: unknown;
  readonly flags: readonly string[];
  readonly options: Record<string, unknown> | undefined;
  /** The mailbox that was open when the STORE was issued. */
  readonly mailbox: string | null;
}

export function makeFakeConnection(options: {
  chunks?: readonly Buffer[];
  onDownload?: (call: FakeDownloadCall) => void;
  downloadError?: Error;
  /** Records every flag write this connection is asked to perform. A
   *  suite that expects NO write asserts the array it owns stayed empty. */
  onFlags?: (call: FakeFlagCall) => void;
  /** Every getMailboxLock path, in order — including the ones a flag write
   *  opens, so a test can prove a rejected request opened nothing. */
  onMailboxOpen?: (path: string) => void;
  /** When set, both flag ops reject with it — a STORE that fails on the
   *  wire. */
  flagError?: Error;
  /** What both flag ops RESOLVE to. Defaults true. `false` is how imapflow
   *  reports a STORE the server did not apply (unresolvable UID, mailbox
   *  open read-only) — it does not reject, which is exactly why that case
   *  needs its own coverage. */
  flagResult?: boolean;
  /** accountId the fake reports, mirroring ImapConnection.accountId — read
   *  by src/imap/flags.ts for its audit log. */
  accountId?: string;
}) {
  let openMailbox: string | null = null;

  const applyFlags =
    (operation: 'add' | 'remove') =>
    async (range: unknown, flags: readonly string[], storeOptions?: Record<string, unknown>) => {
      options.onFlags?.({ operation, range, flags, options: storeOptions, mailbox: openMailbox });
      if (options.flagError) throw options.flagError;
      return options.flagResult ?? true;
    };

  return {
    accountId: options.accountId ?? 'acct1',
    rawClient: () => ({
      getMailboxLock: async (path: string) => {
        openMailbox = path;
        options.onMailboxOpen?.(path);
        return { release: () => { openMailbox = null; } };
      },
      download: async (uid: string, partId: string | undefined) => {
        options.onDownload?.({ uid, partId });
        if (options.downloadError) throw options.downloadError;
        return { content: bufferStream(options.chunks ?? [Buffer.from('bytes')]) };
      },
      messageFlagsAdd: applyFlags('add'),
      messageFlagsRemove: applyFlags('remove'),
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
    // Defaults to "a row was updated", which is the ordinary case for a
    // message the client can see. A suite covering the partial-failure
    // contract overrides it to return false or to throw.
    updateStoredFlag: async () => true,
    applySchema: async () => {},
    close: async () => {},
    ...overrides,
  } as never;
}

/**
 * One local flag write the fake store was asked to make, plus a db whose
 * `updateStoredFlag` records into it.
 *
 * Separate from makeFakeDb's default because the flag suite needs to
 * assert BOTH directions: that a successful IMAP write updated the row,
 * and — the case that actually matters — that a FAILED one did not.
 * `matched` stands in for "a row existed"; `error` makes the local write
 * throw, which is the partial-failure path.
 */
export interface FakeStoredFlagCall {
  readonly accountId: string;
  readonly folder: string;
  readonly uid: number;
  readonly flag: string;
  readonly value: boolean;
}

export function makeFlagRecordingDb(options: { matched?: boolean; error?: Error } = {}) {
  const storedFlagCalls: FakeStoredFlagCall[] = [];
  const db = makeFakeDb({
    updateStoredFlag: async (
      accountId: string,
      folder: string,
      uid: number,
      flag: string,
      value: boolean,
    ) => {
      storedFlagCalls.push({ accountId, folder, uid, flag, value });
      if (options.error) throw options.error;
      return options.matched ?? true;
    },
  });
  return { db, storedFlagCalls };
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
 *
 * `discoveredFolders` stands in for ConnectionPool.getDiscoveredFolders
 * (Plan 5 Task 2) — a plain `{accountId: DiscoveredFolders}` map, since the
 * fake pool has no real per-connection discovery to run. An account absent
 * from it gets `undefined` back, exactly like a real pool that has not
 * finished that account's first sync cycle yet.
 */
export function makeFakePool(options: {
  statuses?: readonly (readonly [string, string])[];
  connections?: Record<string, unknown>;
  budgetAllowed?: boolean;
  remaining?: number;
  discoveredFolders?: Readonly<Record<string, DiscoveredFolders>>;
} = {}) {
  const lockKeys: string[] = [];
  const reserved: BudgetCall[] = [];
  const recorded: BudgetCall[] = [];
  const statuses = new Map<string, string>(options.statuses ?? [['primary', 'connected']]);
  const connections = options.connections ?? {};
  const discoveredFolders = options.discoveredFolders ?? {};

  const pool = {
    status: statuses,
    getConnection: (id: string) => connections[id],
    getDiscoveredFolders: (id: string) => discoveredFolders[id],
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
