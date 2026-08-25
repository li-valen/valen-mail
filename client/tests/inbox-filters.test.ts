import { describe, it, expect } from 'vitest';
import { buildInboxParams, headingFor, FOLDER_IDS } from '../src/inboxFilters';
import type { InboxCursor } from '../src/api';

/**
 * Plan 5 Task 3. `buildInboxParams` is the ONE place this client turns a
 * {folder, account, cursor} selection into GET /api/inbox's query string,
 * and it exists because two of the three hand-off traps in that contract
 * are query-string shaped:
 *
 *  - TRAP 1 — `nextCursor` carries no filter identity. The server derives
 *    it purely from the last returned row (sync/src/api/inbox.ts's
 *    `nextCursorFrom`), so a paged request that forwards the cursor but
 *    NOT `folder`/`account` silently pages into `inbox`, all accounts,
 *    with a 200 and no error anywhere. Defended structurally — a cursor
 *    cannot be encoded except through the same call that encodes the
 *    filter — and asserted below.
 *  - TRAP 2 — `?account=` (the empty string) is a 400, not "all
 *    accounts": sync/src/api/inbox.ts's `parseAccountParam` only reads
 *    ABSENT as "all", and '' matches no configured id. The obvious
 *    `params.set('account', selected ?? '')` idiom therefore breaks the
 *    DEFAULT view on the very first render.
 */
describe('buildInboxParams', () => {
  it('omits both filter params for the default selection (inbox, all accounts)', () => {
    expect(buildInboxParams({})).toBe('');
  });

  /**
   * The chosen convention, stated once so the rest of the file is
   * consistent with it: `folder: 'inbox'` is OMITTED, never sent
   * explicitly. It is the server's own default (`parseFolderParam(null)
   * === 'inbox'`), so omitting it makes the default request the shortest
   * one and keeps exactly one wire spelling per selection.
   */
  it("omits folder when it is the default 'inbox', explicit or not", () => {
    expect(buildInboxParams({ folder: 'inbox' })).toBe('');
    expect(buildInboxParams({ folder: 'inbox', limit: 50 })).toBe('limit=50');
  });

  it('sends folder for every non-default folder', () => {
    expect(buildInboxParams({ folder: 'sent' })).toBe('folder=sent');
    expect(buildInboxParams({ folder: 'spam' })).toBe('folder=spam');
    expect(buildInboxParams({ folder: 'trash' })).toBe('folder=trash');
    expect(buildInboxParams({ folder: 'starred' })).toBe('folder=starred');
  });

  // TRAP 2.
  it('OMITS account entirely when no account is selected — never sends account=', () => {
    expect(buildInboxParams({ account: null })).toBe('');
    expect(buildInboxParams({ account: null, limit: 50 })).toBe('limit=50');
    expect(buildInboxParams({ account: null, folder: 'sent' })).toBe('folder=sent');
  });

  // TRAP 2, the specific broken idiom: `params.set('account', selected ?? '')`.
  it('OMITS account for the empty string too, rather than emitting the 400 shape', () => {
    const params = buildInboxParams({ account: '', limit: 50 });
    expect(params).not.toContain('account');
    expect(params).toBe('limit=50');
  });

  it('sends account when one is selected', () => {
    expect(buildInboxParams({ account: 'harvard' })).toBe('account=harvard');
  });

  it('percent-encodes an account id with URL-significant characters', () => {
    expect(buildInboxParams({ account: 'work&home' })).toBe('account=work%26home');
  });

  it('composes folder and account — they are orthogonal, both ride together', () => {
    expect(buildInboxParams({ folder: 'sent', account: 'harvard', limit: 50 })).toBe(
      'limit=50&folder=sent&account=harvard',
    );
  });

  // TRAP 1: the whole point of this test file.
  it('carries folder AND account alongside the cursor fields on a paged request', () => {
    const cursor: InboxCursor = {
      before: '2026-08-24T00:00:00Z',
      beforeAccount: 'harvard',
      beforeUid: '33097',
    };
    const params = buildInboxParams({ folder: 'sent', account: 'harvard', cursor, limit: 50 });
    expect(params).toBe(
      'limit=50&folder=sent&account=harvard&before=2026-08-24T00%3A00%3A00Z&beforeAccount=harvard&beforeUid=33097',
    );
  });

  // TRAP 1 again, narrowed to the exact regression the brief names: a
  // SECOND page under folder=sent must still say folder=sent, or the
  // server answers 200 with INBOX rows and nothing anywhere reports it.
  it('a second-page request under folder=sent still carries folder=sent', () => {
    const cursor: InboxCursor = { before: null, beforeAccount: 'personal', beforeUid: '12' };
    expect(buildInboxParams({ folder: 'sent', cursor, limit: 50 })).toContain('folder=sent');
  });

  it('forwards the NULL-date-tail cursor shape (no before, both ids set) under a filter', () => {
    const cursor: InboxCursor = { before: null, beforeAccount: 'personal', beforeUid: '12' };
    expect(buildInboxParams({ folder: 'trash', account: 'personal', cursor })).toBe(
      'folder=trash&account=personal&beforeAccount=personal&beforeUid=12',
    );
  });

  it('omits every cursor field when there is no cursor', () => {
    const params = buildInboxParams({ folder: 'starred', account: 'harvard', cursor: null, limit: 50 });
    expect(params).not.toContain('before');
    expect(params).not.toContain('beforeAccount');
    expect(params).not.toContain('beforeUid');
  });
});

describe('FOLDER_IDS', () => {
  /**
   * The wire contract, asserted as a literal rather than described in
   * prose: this set must stay equal to sync/src/api/inbox.ts's
   * FOLDER_PARAM_VALUES, because anything else is a 400 from
   * `parseFolderParam` and a folder the sidebar can render but not load.
   * The ORDER is a UI decision (Starred second, where a mail reader
   * expects it) and is what the sidebar lists.
   */
  it('is exactly the five folders GET /api/inbox understands, in sidebar order', () => {
    expect(FOLDER_IDS).toEqual(['inbox', 'starred', 'sent', 'spam', 'trash']);
  });

  it('produces a distinct, sendable query string for every one of them', () => {
    const encoded = FOLDER_IDS.map((folder) => buildInboxParams({ folder }));
    expect(new Set(encoded).size).toBe(FOLDER_IDS.length);
  });
});

describe('headingFor', () => {
  it('names the folder when every account is showing', () => {
    expect(headingFor('inbox', null)).toBe('Inbox');
    expect(headingFor('starred', null)).toBe('Starred');
    expect(headingFor('trash', null)).toBe('Trash');
  });

  it('names both when an account filter narrows the folder', () => {
    expect(headingFor('sent', 'harvard')).toBe('Sent — harvard');
  });
});
