import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  moveMessage,
  MoveDestinationUnavailableError,
  MoveRefusedError,
  MoveWouldNotChangeFolderError,
} from '../src/imap/move.ts';
import type { DiscoveredFolders } from '../src/imap/folders';
import { makeFakeConnection, type FakeMoveCall } from './helpers/api-fakes.ts';

/**
 * Archive, trash and spam — the ONLY way mail leaves the inbox in this
 * product, and the second write path this service has to a live Gmail.
 *
 * THE THREE PROPERTIES THIS FILE EXISTS TO PIN:
 *
 *  1. **The destination comes from DISCOVERY.** `[Gmail]/Trash` is wrong
 *     on a non-English account (../src/imap/folders.ts has the full
 *     case), so every destination here is resolved from special-use
 *     attributes. The localised fixtures below fail loudly the moment a
 *     literal folder name is spliced in.
 *  2. **NOTHING sets \Deleted and nothing expunges.** ../src/imap/flags.ts
 *     records that `\Deleted` is absent from WRITABLE_FLAGS and must stay
 *     absent. A MOVE reaches the same user-visible result — it is exactly
 *     what Gmail's own UI does for Archive and Trash — with no
 *     destructive path anywhere. The fake records `messageFlagsAdd` and
 *     `messageDelete`, and every case asserts both stayed untouched.
 *  3. **Archive is a MOVE OUT OF INBOX, not a delete.** On Gmail
 *     "archive" means removing the INBOX label, and the mailbox that then
 *     holds the message is All Mail. The message stays in All Mail
 *     forever; nothing here removes it from anywhere else.
 *
 * Nothing in this file touches a real IMAP connection. Gmail throttles
 * repeated connections and this repo has a reconnect-storm history, so
 * every case drives the same fake client tests/flags-route.test.ts uses.
 */

/** An English-locale Gmail account, as discovery resolves it. */
const ENGLISH: DiscoveredFolders = {
  inbox: 'INBOX',
  sent: '[Gmail]/Sent Mail',
  spam: '[Gmail]/Spam',
  trash: '[Gmail]/Trash',
  archive: '[Gmail]/All Mail',
};

/**
 * The SAME account with its language set to Spanish. Not one optional
 * path here matches ENGLISH above. Any implementation that names a
 * folder instead of resolving one fails against this fixture and passes
 * against the other, which is precisely what makes the discovery
 * assertions non-vacuous.
 */
const SPANISH: DiscoveredFolders = {
  inbox: 'INBOX',
  sent: '[Gmail]/Enviados',
  spam: '[Gmail]/Spam',
  trash: '[Gmail]/Papelera',
  archive: '[Gmail]/Todos',
};

interface Harness {
  readonly connection: ReturnType<typeof makeFakeConnection>;
  readonly moves: readonly FakeMoveCall[];
  readonly flagsAdded: readonly string[][];
  readonly deleted: readonly unknown[];
  readonly openedMailboxes: readonly string[];
}

function harness(
  options: {
    moveResult?: unknown;
    moveError?: Error;
    movedUid?: number;
    capabilities?: readonly string[];
  } = {},
): Harness {
  const moves: FakeMoveCall[] = [];
  const flagsAdded: string[][] = [];
  const deleted: unknown[] = [];
  const openedMailboxes: string[] = [];
  const connection = makeFakeConnection({
    accountId: 'acct1',
    onMove: (call) => { moves.push(call); },
    onFlags: (call) => { flagsAdded.push([...call.flags]); },
    onDelete: (range) => { deleted.push(range); },
    onMailboxOpen: (path) => { openedMailboxes.push(path); },
    ...options,
  });
  return { connection, moves, flagsAdded, deleted, openedMailboxes };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('moveMessage / the destination comes from discovery', () => {
  it('trashes into the DISCOVERED trash, never a hardcoded name', async () => {
    const h = harness();

    await moveMessage(h.connection, SPANISH, 'INBOX', 42, 'trash');

    expect(h.moves).toHaveLength(1);
    expect(h.moves[0]!.destination).toBe('[Gmail]/Papelera');
    // Named separately so the failure message says which regression
    // happened rather than only "strings differ".
    expect(h.moves[0]!.destination).not.toBe('[Gmail]/Trash');
  });

  it('archives into the DISCOVERED archive, never a hardcoded name', async () => {
    const h = harness();

    await moveMessage(h.connection, SPANISH, 'INBOX', 42, 'archive');

    expect(h.moves[0]!.destination).toBe('[Gmail]/Todos');
    expect(h.moves[0]!.destination).not.toBe('[Gmail]/All Mail');
  });

  it('marks spam into the DISCOVERED junk folder', async () => {
    const h = harness();

    await moveMessage(h.connection, SPANISH, 'INBOX', 42, 'spam');

    expect(h.moves[0]!.destination).toBe('[Gmail]/Spam');
  });

  it('moves BACK to INBOX for an undo', async () => {
    const h = harness();

    await moveMessage(h.connection, SPANISH, '[Gmail]/Papelera', 900, 'inbox');

    expect(h.moves[0]!.destination).toBe('INBOX');
    expect(h.openedMailboxes).toEqual(['[Gmail]/Papelera']);
  });

  it('addresses exactly ONE uid, BY uid, out of the folder it was given', async () => {
    const h = harness();

    await moveMessage(h.connection, ENGLISH, 'INBOX', 42, 'archive');

    const call = h.moves[0]!;
    // An exact single-UID sequence set. No `a:b`, no `1:*`, no array —
    // the blast radius of a bug here is bounded by construction, the same
    // property ../src/imap/flags.ts pins for STORE.
    expect(call.range).toBe('42');
    expect(call.options).toEqual({ uid: true });
    expect(call.mailbox).toBe('INBOX');
  });

  it('refuses when the account exposes no such special-use folder', async () => {
    const h = harness();
    const noJunk: DiscoveredFolders = { ...ENGLISH, spam: null };

    await expect(moveMessage(h.connection, noJunk, 'INBOX', 42, 'spam')).rejects.toThrow(
      MoveDestinationUnavailableError,
    );
    await expect(moveMessage(h.connection, noJunk, 'INBOX', 42, 'spam')).rejects.toThrow(/spam/i);
    // The refusal happens BEFORE any contact with the mailbox, so a
    // request that cannot be satisfied provably touches nothing.
    expect(h.moves).toEqual([]);
    expect(h.openedMailboxes).toEqual([]);
  });

  it('refuses an archive when the account exposes no All Mail', async () => {
    const h = harness();
    const noArchive: DiscoveredFolders = { ...ENGLISH, archive: null };

    await expect(moveMessage(h.connection, noArchive, 'INBOX', 42, 'archive')).rejects.toThrow(
      /archive/i,
    );
    expect(h.moves).toEqual([]);
  });

  it('refuses a move into the folder the message is already in', async () => {
    // Not a silent no-op: a self-move is either a client bug or a stale
    // undo ticket, and issuing `UID MOVE 42 INBOX` while INBOX is
    // selected asks the server to do something undefined.
    const h = harness();

    await expect(moveMessage(h.connection, ENGLISH, 'INBOX', 42, 'inbox')).rejects.toThrow(
      MoveWouldNotChangeFolderError,
    );
    expect(h.moves).toEqual([]);
  });
});

describe('moveMessage / no expunge path, ever', () => {
  it('never sets a flag and never deletes', async () => {
    const h = harness();

    await moveMessage(h.connection, ENGLISH, 'INBOX', 42, 'trash');

    expect(h.flagsAdded).toEqual([]);
    expect(h.deleted).toEqual([]);
  });

  it('refuses outright on a server without the MOVE extension', async () => {
    // imapflow EMULATES a missing MOVE with COPY + \Deleted + EXPUNGE
    // (node_modules/imapflow/lib/commands/move.js). That fallback is the
    // exact destructive path this service must never open, and it is
    // reachable through a library call rather than through our own code,
    // so the only way to keep it unreachable is to refuse before issuing
    // the command at all.
    const h = harness({ capabilities: ['IDLE', 'UIDPLUS'] });

    await expect(moveMessage(h.connection, ENGLISH, 'INBOX', 42, 'trash')).rejects.toThrow(
      /MOVE/,
    );
    expect(h.moves).toEqual([]);
    expect(h.deleted).toEqual([]);
    expect(h.flagsAdded).toEqual([]);
  });
});

describe('moveMessage / what came back', () => {
  it('reports the new uid from the UIDPLUS response so undo can find it', async () => {
    const h = harness({ movedUid: 4242 });

    const outcome = await moveMessage(h.connection, ENGLISH, 'INBOX', 42, 'trash');

    expect(outcome.moved).toBe(true);
    expect(outcome.newUid).toBe(4242);
    expect(outcome.destination).toBe('[Gmail]/Trash');
  });

  it('a uid that no longer exists reports moved:false rather than throwing', async () => {
    // Gmail answers `UID MOVE 999 …` for an unresolvable uid with a
    // successful, EMPTY COPYUID: nothing was moved and nothing failed.
    // Throwing would turn "someone else already archived this" into an
    // error banner for a state the user actually wanted.
    const h = harness({
      moveResult: { path: 'INBOX', destination: '[Gmail]/Trash', uidValidity: 1n, uidMap: new Map() },
    });

    const outcome = await moveMessage(h.connection, ENGLISH, 'INBOX', 999, 'trash');

    expect(outcome.moved).toBe(false);
    expect(outcome.newUid).toBeNull();
  });

  it('a server with no UIDPLUS moves, but offers NO uid to undo with', async () => {
    // Honest rather than convenient: without COPYUID there is no way to
    // know which uid the message now carries, and inventing one would
    // make undo move an unrelated message. `newUid: null` is what the
    // route turns into "no undo offered".
    const h = harness({
      moveResult: { path: 'INBOX', destination: '[Gmail]/Trash' },
    });

    const outcome = await moveMessage(h.connection, ENGLISH, 'INBOX', 42, 'trash');

    expect(outcome.moved).toBe(true);
    expect(outcome.newUid).toBeNull();
  });

  it('throws when imapflow reports the command was refused', async () => {
    // `messageMove` RESOLVES false on a command error rather than
    // rejecting. A false that returned success would tell the client the
    // message left the inbox when it did not — the precise silent failure
    // this whole path exists to remove.
    const h = harness({ moveResult: false });

    await expect(moveMessage(h.connection, ENGLISH, 'INBOX', 42, 'trash')).rejects.toThrow(
      MoveRefusedError,
    );
  });

  it('throws when nothing came back at all', async () => {
    // imapflow returns `undefined` when its own preconditions are not met
    // (no mailbox selected, empty range). `null` stands in for that same
    // nothing-came-back shape here, because `undefined` is the fake's
    // "use the default response" sentinel.
    const h = harness({ moveResult: null });

    await expect(moveMessage(h.connection, ENGLISH, 'INBOX', 42, 'trash')).rejects.toThrow(
      MoveRefusedError,
    );
  });

  it('propagates a transport failure rather than reporting a move that never happened', async () => {
    const h = harness({ moveError: new Error('socket closed') });

    await expect(moveMessage(h.connection, ENGLISH, 'INBOX', 42, 'trash')).rejects.toThrow(
      'socket closed',
    );
  });

  it('releases the mailbox lock even when the MOVE fails', async () => {
    // A leaked lock would wedge every later operation on this account —
    // these connections live for the lifetime of the process.
    const h = harness({ moveError: new Error('socket closed') });

    await expect(moveMessage(h.connection, ENGLISH, 'INBOX', 42, 'trash')).rejects.toThrow();
    // The fake clears its open mailbox on release, so a later successful
    // call recording `mailbox: 'INBOX'` proves the lock was handed back.
    const second = harness();
    await moveMessage(second.connection, ENGLISH, 'INBOX', 43, 'trash');
    expect(second.moves[0]!.mailbox).toBe('INBOX');
  });
});

/**
 * THE SOURCE-WIDE GUARD, and the one assertion in this repo that is about
 * an ABSENCE.
 *
 * ../src/imap/flags.ts records that `\Deleted` is absent from
 * WRITABLE_FLAGS and must stay absent: this service has no expunge path,
 * and a flag whose only effect is to queue a message for permanent
 * deletion is not something a bug in an HTTP handler should be able to
 * reach. Every behavioural test above proves that the code paths this
 * plan added do not delete anything — but none of them could catch a
 * FOURTH module, added later, that does. A sweep of the whole source tree
 * can.
 *
 * Scoped to `src/`, not to the tests: tests/move.test.ts itself names
 * `messageDelete` (its fake records the call precisely so a suite can
 * prove it stayed empty), and a guard that read its own file would have
 * to be written around itself.
 */
describe('no expunge path exists anywhere in this service', () => {
  const SRC = path.resolve(import.meta.dirname, '..', 'src');

  function sourceFiles(dir: string): readonly string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.isFile() && full.endsWith('.ts') ? [full] : [];
    });
  }

  /**
   * Comments are stripped before matching, so the several places that
   * DOCUMENT the absence of an expunge path (../src/imap/flags.ts's
   * header, ../src/push/dispatch.ts's, and ../src/imap/move.ts's own) are
   * not read as live code. Same technique client/tests/
   * reply-wiring-static-guards.test.ts uses, and for the same reason: a
   * guard that fired on prose would be switched off within a week.
   */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  }

  /** Every way to reach a permanent deletion through imapflow, plus the
   *  flag that arms one. `messageDelete` is imapflow's
   *  `STORE +FLAGS \Deleted` + EXPUNGE; `expunge` is the command itself;
   *  `\\Deleted` is the flag. */
  const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
    ['messageDelete', /\bmessageDelete\b/],
    ['expunge', /\bexpunge\b/i],
    ['\\Deleted', /\\\\Deleted/],
  ];

  const FILES = sourceFiles(SRC);

  it('reads a source tree at all — the sweep is not vacuous', () => {
    expect(FILES.length).toBeGreaterThan(20);
  });

  for (const [name, pattern] of FORBIDDEN) {
    it(`never mentions ${name}`, () => {
      const offenders = FILES.filter((file) =>
        pattern.test(stripComments(readFileSync(file, 'utf8'))),
      ).map((file) => path.relative(SRC, file));
      expect(offenders).toEqual([]);
    });
  }

  it('the sweep would catch a real regression', () => {
    // Proves each pattern matches the code it is meant to forbid, so a
    // green result above means "absent", not "unmatchable".
    expect(/\bmessageDelete\b/.test('await client.messageDelete(range);')).toBe(true);
    expect(/\bexpunge\b/i.test('await client.mailboxClose({ expunge: true });')).toBe(true);
    expect(/\\\\Deleted/.test("const DELETED = '\\\\Deleted';")).toBe(true);
  });
});
