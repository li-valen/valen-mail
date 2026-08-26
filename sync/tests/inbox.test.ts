import { describe, it, expect } from 'vitest';
import { parseFolderParam, parseAccountParam, resolveFolderFilter } from '../src/api/inbox';
import type { AccountConfig } from '../src/config';
import { makeFakePool } from './helpers/api-fakes.ts';

/**
 * Pure-function coverage for ../src/api/inbox.ts's query-string parsing and
 * logical-to-native folder resolution (Plan 5 Task 2). Router-level
 * behaviour — status codes, the full HTTP round trip through createRouter —
 * lives in routes.test.ts alongside every other route; this file exercises
 * the pure logic directly, the same split message.ts's own pure helpers get
 * relative to message-route.test.ts.
 */

const ACCOUNT_A: AccountConfig = {
  id: 'a', email: 'a@example.com', appPassword: 'x'.repeat(16), isPrimary: true,
};
const ACCOUNT_B: AccountConfig = {
  id: 'b', email: 'b@example.com', appPassword: 'y'.repeat(16), isPrimary: false,
};
const ACCOUNTS: readonly AccountConfig[] = [ACCOUNT_A, ACCOUNT_B];

describe('parseFolderParam', () => {
  it('defaults to inbox when the param is absent', () => {
    expect(parseFolderParam(null)).toBe('inbox');
  });

  it('accepts every one of the five documented values', () => {
    expect(parseFolderParam('inbox')).toBe('inbox');
    expect(parseFolderParam('sent')).toBe('sent');
    expect(parseFolderParam('spam')).toBe('spam');
    expect(parseFolderParam('trash')).toBe('trash');
    expect(parseFolderParam('starred')).toBe('starred');
  });

  it('rejects a value outside the five documented ones', () => {
    expect(parseFolderParam('archive')).toBe('invalid');
  });

  it('rejects the empty string rather than silently treating it as absent', () => {
    expect(parseFolderParam('')).toBe('invalid');
  });

  it('is case-sensitive: "Inbox" is not the same value as "inbox"', () => {
    expect(parseFolderParam('Inbox')).toBe('invalid');
  });
});

describe('parseAccountParam', () => {
  it('defaults to null (no account filter) when the param is absent', () => {
    expect(parseAccountParam(null, ACCOUNTS)).toBeNull();
  });

  it('accepts a configured account id', () => {
    expect(parseAccountParam('a', ACCOUNTS)).toBe('a');
    expect(parseAccountParam('b', ACCOUNTS)).toBe('b');
  });

  it('rejects an id that is not among the configured accounts', () => {
    // The failure mode Plan 5 Task 2 calls out by name: a typo'd id must
    // not silently resolve to "no filter" or "empty result" — the caller
    // needs to know its own input was wrong. `undefined` (not a string
    // sentinel) is what signals that — see the next test.
    expect(parseAccountParam('nope', ACCOUNTS)).toBeUndefined();
  });

  it('rejects an empty accounts list the same way as any other unknown id', () => {
    expect(parseAccountParam('a', [])).toBeUndefined();
  });

  it('an account genuinely named "invalid" is accepted, not confused with the invalid-input signal', () => {
    // Fix round 1: this function used to signal "not found" with the
    // string 'invalid', which collided with a real account id that
    // happened to equal that string — that account would 400 forever, on
    // every request, regardless of whether it existed. `undefined` cannot
    // collide with any account id, because config.ts's parseAccount
    // requires every id to be a non-empty string and rejects duplicates,
    // but never rejects the literal text "invalid".
    const accountNamedInvalid: AccountConfig = {
      id: 'invalid', email: 'invalid@example.com', appPassword: 'z'.repeat(16), isPrimary: false,
    };
    expect(parseAccountParam('invalid', [...ACCOUNTS, accountNamedInvalid])).toBe('invalid');
  });
});

describe('resolveFolderFilter', () => {
  it('resolves "inbox" to the literal INBOX folder without consulting discovery at all', () => {
    // No discoveredFolders entries at all — if this branch touched the
    // pool, it would see nothing and could not produce a literal filter.
    const { pool } = makeFakePool();
    expect(resolveFolderFilter('inbox', null, ACCOUNTS, pool)).toEqual({
      kind: 'literal',
      folder: 'INBOX',
    });
  });

  it('resolves "starred" to the virtual flag filter without consulting discovery at all', () => {
    const { pool } = makeFakePool();
    expect(resolveFolderFilter('starred', null, ACCOUNTS, pool)).toEqual({ kind: 'starred' });
  });

  it('resolves "sent" to each account\'s own discovered native folder — including a non-Gmail-shaped one', () => {
    // Account "a" localises the way an English Gmail account does; account
    // "b" does not even carry the "[Gmail]/" prefix at all. If this
    // function ever hardcoded a pattern instead of reading discovery, "b"
    // would resolve wrong (or not at all) while "a" kept working — this is
    // the test that would catch that.
    const { pool } = makeFakePool({
      discoveredFolders: {
        a: { inbox: 'INBOX', sent: '[Gmail]/Sent Mail', spam: '[Gmail]/Spam', trash: '[Gmail]/Trash', archive: null },
        b: { inbox: 'INBOX', sent: 'Envoyés', spam: 'Indésirables', trash: 'Corbeille', archive: null },
      },
    });
    expect(resolveFolderFilter('sent', null, ACCOUNTS, pool)).toEqual({
      kind: 'pairs',
      pairs: [
        { accountId: 'a', folder: '[Gmail]/Sent Mail' },
        { accountId: 'b', folder: 'Envoyés' },
      ],
    });
  });

  it('narrows pairs to just the account named by an account filter', () => {
    const { pool } = makeFakePool({
      discoveredFolders: {
        a: { inbox: 'INBOX', sent: '[Gmail]/Sent Mail', spam: null, trash: null, archive: null },
        b: { inbox: 'INBOX', sent: 'Envoyés', spam: null, trash: null, archive: null },
      },
    });
    expect(resolveFolderFilter('sent', 'b', ACCOUNTS, pool)).toEqual({
      kind: 'pairs',
      pairs: [{ accountId: 'b', folder: 'Envoyés' }],
    });
  });

  it('excludes an account whose kind the server flagged as absent (a real null)', () => {
    const { pool } = makeFakePool({
      discoveredFolders: {
        a: { inbox: 'INBOX', sent: '[Gmail]/Sent Mail', spam: null, trash: null, archive: null },
        b: { inbox: 'INBOX', sent: 'Envoyés', spam: null, trash: null, archive: null },
      },
    });
    // Neither account has a Trash — pairs is empty, not an error.
    expect(resolveFolderFilter('trash', null, ACCOUNTS, pool)).toEqual({ kind: 'pairs', pairs: [] });
  });

  it('excludes an account whose discovery has not run at all (undefined, not a DiscoveredFolders)', () => {
    const { pool } = makeFakePool({
      discoveredFolders: {
        a: { inbox: 'INBOX', sent: '[Gmail]/Sent Mail', spam: null, trash: '[Gmail]/Trash', archive: null },
        // "b" has no entry: this process has not completed its first sync
        // cycle for "b" yet (or "b" never connected).
      },
    });
    expect(resolveFolderFilter('trash', 'b', ACCOUNTS, pool)).toEqual({ kind: 'pairs', pairs: [] });
  });

  it('an account filter combined with a folder that account never discovered still yields empty pairs, not an error', () => {
    const { pool } = makeFakePool({
      discoveredFolders: {
        a: { inbox: 'INBOX', sent: '[Gmail]/Sent Mail', spam: null, trash: null, archive: null },
      },
    });
    expect(resolveFolderFilter('trash', 'a', ACCOUNTS, pool)).toEqual({ kind: 'pairs', pairs: [] });
  });
});
