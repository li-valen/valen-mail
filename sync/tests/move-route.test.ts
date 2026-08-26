import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRouter } from '../src/api/routes';
import type { MoveResultBody } from '../src/api/move.ts';
import type { DiscoveredFolders } from '../src/imap/folders';
import {
  AUTH as auth,
  TOKEN,
  makeFakeConnection,
  makeFakeDb,
  makeFakePool,
  readJson,
  type FakeMoveCall,
} from './helpers/api-fakes.ts';

/**
 * POST /api/message/{accountId}/{folder}/{uid}/move — how mail leaves the
 * inbox, and the SECOND route in this service that changes state in the
 * user's real Gmail.
 *
 * The body names one destination out of a CLOSED SET of literals. This is
 * the property the whole file is built around: a route that took a folder
 * name would be an arbitrary-folder-move primitive against a live
 * mailbox, reachable by anyone holding a session cookie, and no amount of
 * client-side care would take that back. `to` is matched against four
 * exact strings and an undo's `origin` against five; anything else is a
 * 400 that reaches no IMAP call at all.
 *
 * Validation runs BEFORE the connection is resolved and before any lock
 * is taken, exactly as ../src/api/flags.ts does — so "rejected" and
 * "moved something anyway" are not merely unlikely together; there is no
 * code path between them, and the cases below assert the fake client was
 * never called rather than only checking a status code.
 */

const ENGLISH: DiscoveredFolders = {
  inbox: 'INBOX',
  sent: '[Gmail]/Sent Mail',
  spam: '[Gmail]/Spam',
  trash: '[Gmail]/Trash',
  archive: '[Gmail]/All Mail',
};

interface DeleteCall {
  readonly accountId: string;
  readonly folder: string;
  readonly uid: number;
}

interface Harness {
  readonly router: (request: Request) => Promise<Response>;
  readonly moves: readonly FakeMoveCall[];
  readonly deleted: readonly unknown[];
  readonly flagsAdded: readonly string[][];
  readonly rowDeletes: readonly DeleteCall[];
  readonly lockKeys: readonly string[];
}

function harness(
  options: {
    /** `null` means "the pool has not discovered this account's folders
     *  yet", which is a different state from any particular folder being
     *  absent. Omitted means the English fixture. */
    folders?: DiscoveredFolders | null;
    moveResult?: unknown;
    moveError?: Error;
    movedUid?: number;
    capabilities?: readonly string[];
    status?: string;
    rowDeleteError?: Error;
    rowDeleteMatched?: boolean;
  } = {},
): Harness {
  const moves: FakeMoveCall[] = [];
  const deleted: unknown[] = [];
  const flagsAdded: string[][] = [];
  const rowDeletes: DeleteCall[] = [];
  const connection = makeFakeConnection({
    accountId: 'acct1',
    onMove: (call) => { moves.push(call); },
    onDelete: (range) => { deleted.push(range); },
    onFlags: (call) => { flagsAdded.push([...call.flags]); },
    moveResult: options.moveResult,
    moveError: options.moveError,
    movedUid: options.movedUid,
    capabilities: options.capabilities,
  });
  const folders = options.folders === undefined ? ENGLISH : options.folders;
  const { pool, lockKeys } = makeFakePool({
    statuses: [['acct1', options.status ?? 'connected']],
    connections: { acct1: connection },
    discoveredFolders: folders === null ? {} : { acct1: folders },
  });
  const db = makeFakeDb({
    deleteStoredMessage: async (accountId: string, folder: string, uid: number) => {
      rowDeletes.push({ accountId, folder, uid });
      if (options.rowDeleteError) throw options.rowDeleteError;
      return options.rowDeleteMatched ?? true;
    },
  });
  return { router: createRouter(db, pool, TOKEN), moves, deleted, flagsAdded, rowDeletes, lockKeys };
}

interface PostOptions {
  uid?: string;
  folder?: string;
  headers?: Readonly<Record<string, string>>;
  raw?: boolean;
  method?: string;
}

function post(
  router: (request: Request) => Promise<Response>,
  body: unknown,
  { uid = '42', folder = 'INBOX', headers = auth, raw = false, method = 'POST' }: PostOptions = {},
): Promise<Response> {
  return router(
    new Request(`http://x/api/message/acct1/${encodeURIComponent(folder)}/${uid}/move`, {
      method,
      headers: { ...headers, 'content-type': 'application/json' },
      body: raw ? (body as string) : JSON.stringify(body),
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('move route / the happy path', () => {
  it('archives: MOVE out of INBOX into the discovered All Mail', async () => {
    const h = harness({ movedUid: 4242 });

    const response = await post(h.router, { to: 'archive' });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');

    // The op itself, not merely the status: one uid, addressed BY uid,
    // out of INBOX, into the DISCOVERED archive.
    expect(h.moves).toHaveLength(1);
    expect(h.moves[0]!.range).toBe('42');
    expect(h.moves[0]!.options).toEqual({ uid: true });
    expect(h.moves[0]!.mailbox).toBe('INBOX');
    expect(h.moves[0]!.destination).toBe('[Gmail]/All Mail');

    const body = await readJson<MoveResultBody>(response);
    expect(body.ok).toBe(true);
    expect(body.moved).toBe(true);
    expect(body.to).toBe('archive');
    expect(body.uid).toBe(42);
  });

  it('trashes into the discovered Trash, and marks spam into the discovered Junk', async () => {
    const trash = harness();
    await post(trash.router, { to: 'trash' });
    expect(trash.moves[0]!.destination).toBe('[Gmail]/Trash');

    const spam = harness();
    await post(spam.router, { to: 'spam' });
    expect(spam.moves[0]!.destination).toBe('[Gmail]/Spam');
  });

  it('holds the per-account lock for the move', async () => {
    // The API and the IDLE loop drive the SAME imapflow client — a MOVE
    // outside the lock breaks IDLE and can queue ahead of the liveness
    // probe, which tears the connection down. Same reasoning, same lock,
    // as the flags route.
    const h = harness();
    await post(h.router, { to: 'trash' });
    expect(h.lockKeys).toEqual(['acct1']);
  });

  it('drops the cached row so the message does not come back on refresh', async () => {
    // The sync loop never notices a message LEAVING a folder, so without
    // this the archived message reappears in the list on the next page
    // load, forever.
    const h = harness();
    await post(h.router, { to: 'archive' });
    expect(h.rowDeletes).toEqual([{ accountId: 'acct1', folder: 'INBOX', uid: 42 }]);
  });

  it('still reports success when the local row could not be dropped', async () => {
    // The mailbox really did change. Reporting failure would tell the
    // user a lie and invite a retry of something already done — the same
    // partial-failure contract the flags route documents.
    const h = harness({ rowDeleteError: new Error('postgres down') });

    const response = await post(h.router, { to: 'archive' });

    expect(response.status).toBe(200);
    expect((await readJson<MoveResultBody>(response)).moved).toBe(true);
  });
});

describe('move route / undo', () => {
  it('hands back a ticket naming where the message went and where it came from', async () => {
    const h = harness({ movedUid: 4242 });

    const body = await readJson<MoveResultBody>(await post(h.router, { to: 'trash' }));

    expect(body.undo).toEqual({ folder: '[Gmail]/Trash', uid: 4242, origin: 'inbox' });
  });

  it('offers NO ticket when the server reported no new uid', async () => {
    // Without COPYUID there is nothing to address the message by in its
    // new folder. An invented uid would move an unrelated message back
    // into the inbox, so the honest answer is no undo at all.
    const h = harness({ moveResult: { path: 'INBOX', destination: '[Gmail]/Trash' } });

    const body = await readJson<MoveResultBody>(await post(h.router, { to: 'trash' }));

    expect(body.moved).toBe(true);
    expect(body.undo).toBeNull();
  });

  it('offers NO ticket when the source folder is one this service cannot name', async () => {
    // A user label. There is no logical kind to move back TO, and
    // defaulting to INBOX would file the message somewhere it never was.
    const h = harness({ movedUid: 4242 });

    const body = await readJson<MoveResultBody>(
      await post(h.router, { to: 'trash' }, { folder: 'Receipts' }),
    );

    expect(body.undo).toBeNull();
  });

  it('moves the message BACK when the ticket is played', async () => {
    const h = harness();

    const response = await post(
      h.router,
      { to: 'undo', origin: 'inbox' },
      { folder: '[Gmail]/Trash', uid: '4242' },
    );

    expect(response.status).toBe(200);
    expect(h.moves).toHaveLength(1);
    expect(h.moves[0]!.mailbox).toBe('[Gmail]/Trash');
    expect(h.moves[0]!.destination).toBe('INBOX');
    expect(h.moves[0]!.range).toBe('4242');
  });

  it('resolves an undo origin through DISCOVERY, never a name', async () => {
    const localised: DiscoveredFolders = { ...ENGLISH, spam: '[Gmail]/Correo no deseado' };
    const h = harness({ folders: localised });

    await post(h.router, { to: 'undo', origin: 'spam' }, { folder: '[Gmail]/Trash', uid: '7' });

    expect(h.moves[0]!.destination).toBe('[Gmail]/Correo no deseado');
  });

  it('refuses an undo whose origin is not one of the known kinds', async () => {
    const h = harness();

    const response = await post(
      h.router,
      { to: 'undo', origin: 'Receipts' },
      { folder: '[Gmail]/Trash', uid: '7' },
    );

    expect(response.status).toBe(400);
    expect(h.moves).toEqual([]);
  });

  it('refuses an undo with no origin at all', async () => {
    const h = harness();
    const response = await post(h.router, { to: 'undo' }, { folder: '[Gmail]/Trash', uid: '7' });
    expect(response.status).toBe(400);
    expect(h.moves).toEqual([]);
  });
});

describe('move route / the destination is a closed set', () => {
  /**
   * THE MUTATION TARGET. Widening this validation to accept any string
   * turns the route into "move any message in any folder to any folder",
   * which is a primitive nobody should be able to reach through a web
   * session. Each case asserts the fake client was NEVER CALLED, not just
   * that a 400 came back.
   */
  const REJECTED: readonly unknown[] = [
    { to: '[Gmail]/Trash' },
    { to: 'INBOX' },
    { to: 'Receipts' },
    { to: 'sent' },
    { to: 'inbox' },
    { to: '' },
    { to: 'ARCHIVE' },
    { to: ' trash' },
    { to: 42 },
    { to: null },
    { to: ['trash'] },
    { to: { archive: true } },
    {},
    { destination: 'trash' },
    { to: 'trash', extra: 1 },
    [],
    'trash',
    null,
    42,
  ];

  for (const body of REJECTED) {
    it(`refuses ${JSON.stringify(body)} without touching IMAP`, async () => {
      const h = harness();

      const response = await post(h.router, body);

      expect(response.status).toBe(400);
      expect(h.moves).toEqual([]);
      expect(h.lockKeys).toEqual([]);
      expect(h.rowDeletes).toEqual([]);
    });
  }

  it('refuses a body that is not JSON at all', async () => {
    const h = harness();
    const response = await post(h.router, '{oops', { raw: true });
    expect(response.status).toBe(400);
    expect(h.moves).toEqual([]);
  });

  it('never echoes the rejected value back', async () => {
    // A rejected destination is attacker-controlled text; reflecting it
    // into a JSON error and a log line buys nothing a static message does
    // not already give a client author.
    const h = harness();
    const response = await post(h.router, { to: '<script>alert(1)</script>' });
    expect(await response.text()).not.toContain('script');
  });

  it('refuses a non-numeric uid before anything else', async () => {
    const h = harness();
    const response = await post(h.router, { to: 'trash' }, { uid: 'abc' });
    expect(response.status).toBe(400);
    expect(h.moves).toEqual([]);
  });

  it('is not reachable by GET', async () => {
    const h = harness();
    const response = await h.router(
      new Request('http://x/api/message/acct1/INBOX/42/move', { headers: auth }),
    );
    expect(response.status).toBe(404);
    expect(h.moves).toEqual([]);
  });

  it('is not reachable without a credential', async () => {
    const h = harness();
    const response = await post(h.router, { to: 'trash' }, { headers: {} });
    expect(response.status).toBe(401);
    expect(h.moves).toEqual([]);
  });
});

describe('move route / refusals that are not the caller\'s fault', () => {
  it('404s an unknown account and 503s one that is not connected', async () => {
    const unknown = harness();
    const response = await unknown.router(
      new Request('http://x/api/message/nope/INBOX/42/move', {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'trash' }),
      }),
    );
    expect(response.status).toBe(404);

    const offline = harness({ status: 'reconnecting' });
    expect((await post(offline.router, { to: 'trash' })).status).toBe(503);
    expect(offline.moves).toEqual([]);
  });

  it('503s when this account has not finished discovering its folders', async () => {
    // Not a 500: the account is fine, the pool simply has not LISTed yet.
    // A retry a moment later succeeds, which is what 503 means.
    const h = harness({ folders: null });
    const response = await post(h.router, { to: 'trash' });
    expect(response.status).toBe(503);
    expect(h.moves).toEqual([]);
  });

  it('409s when the account has no such folder, and names it', async () => {
    const h = harness({ folders: { ...ENGLISH, spam: null } });

    const response = await post(h.router, { to: 'spam' });

    expect(response.status).toBe(409);
    expect(await response.text()).toMatch(/spam/i);
    expect(h.moves).toEqual([]);
  });

  it('409s a move into the folder the message is already in', async () => {
    const h = harness();
    const response = await post(
      h.router,
      { to: 'trash' },
      { folder: '[Gmail]/Trash', uid: '7' },
    );
    expect(response.status).toBe(409);
    expect(h.moves).toEqual([]);
  });

  it('502s a move the server refused, and leaves the cached row alone', async () => {
    // The message is still in the inbox. Deleting the row would hide a
    // message the user can no longer see and no longer act on.
    const h = harness({ moveResult: false });

    const response = await post(h.router, { to: 'trash' });

    expect(response.status).toBe(502);
    expect(h.rowDeletes).toEqual([]);
  });

  it('502s a transport failure and leaves the cached row alone', async () => {
    const h = harness({ moveError: new Error('socket closed') });

    expect((await post(h.router, { to: 'trash' })).status).toBe(502);
    expect(h.rowDeletes).toEqual([]);
  });

  it('reports moved:false — not an error — for a uid that is already gone', async () => {
    const h = harness({
      moveResult: { path: 'INBOX', destination: '[Gmail]/Trash', uidValidity: 1n, uidMap: new Map() },
    });

    const response = await post(h.router, { to: 'trash' });
    const body = await readJson<MoveResultBody>(response);

    expect(response.status).toBe(200);
    expect(body.moved).toBe(false);
    expect(body.undo).toBeNull();
    // The row is dropped anyway: the message is not in this folder, which
    // is the state the client's optimistic removal already shows.
    expect(h.rowDeletes).toHaveLength(1);
  });
});

describe('move route / no expunge path is reachable', () => {
  it('never sets a flag and never deletes a message on the server', async () => {
    for (const to of ['archive', 'trash', 'spam'] as const) {
      const h = harness();
      await post(h.router, { to });
      expect(h.flagsAdded).toEqual([]);
      expect(h.deleted).toEqual([]);
    }
  });

  it('refuses rather than letting imapflow emulate MOVE with \\Deleted + EXPUNGE', async () => {
    const h = harness({ capabilities: ['IDLE', 'UIDPLUS'] });

    const response = await post(h.router, { to: 'trash' });

    expect(response.status).toBe(502);
    expect(h.deleted).toEqual([]);
    expect(h.flagsAdded).toEqual([]);
  });
});
