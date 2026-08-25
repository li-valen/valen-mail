import { describe, it, expect } from 'vitest';
import { buildInboxFilter, escapeLikePattern, type InboxFolderFilter } from '../src/db';

/**
 * The SQL GET /api/inbox and GET /api/search actually run, asserted
 * directly against buildInboxFilter's output.
 *
 * Why here and not in tests/db.test.ts: every case in that file is
 * `describe.skip`ped unless TEST_DATABASE_URL is set, so on an ordinary
 * checkout it proves nothing. Parameterization and wildcard escaping are
 * exactly the properties that must not depend on whether a Postgres
 * happened to be running — a query string that reaches the SQL TEXT is a
 * SQL-injection surface whether or not anyone executed it, and an
 * unescaped `%` silently turns "search for 100%" into "match every row".
 * This suite proves both from the generated statement itself.
 *
 * tests/db.test.ts still covers what only a real database can: that these
 * clauses actually select the rows they claim to.
 */

const ALL_FOLDERS: InboxFolderFilter = { kind: 'all' };

function filterFor(search: string) {
  return buildInboxFilter({ cursor: null, folder: ALL_FOLDERS, accountId: null, search });
}

describe('escapeLikePattern', () => {
  it('escapes the percent sign, so "100%" is not a wildcard', () => {
    expect(escapeLikePattern('100%')).toBe('100\\%');
  });

  it('escapes the underscore, so "a_b" does not also match "axb"', () => {
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
  });

  it('escapes the backslash FIRST, so its own escapes are not double-escaped', () => {
    // Reversing the order turns `\%` into `\\%` — a literal backslash
    // followed by a live wildcard, i.e. the exact bug this prevents.
    expect(escapeLikePattern('a\\%b')).toBe('a\\\\\\%b');
  });

  it('leaves ordinary text completely alone', () => {
    expect(escapeLikePattern('quarterly numbers')).toBe('quarterly numbers');
  });
});

describe('buildInboxFilter — the search clause', () => {
  it('binds the query as a parameter and never interpolates it into the SQL', () => {
    // The injection guard. A query that reached the statement text would
    // appear here; it must only ever appear in `values`.
    const hostile = "'; drop table messages; --";
    const filter = filterFor(hostile);

    expect(filter.where).not.toContain('drop table');
    expect(filter.where).not.toContain(hostile);
    expect(filter.values).toContain(`%${hostile}%`);
  });

  it('escapes wildcards in the BOUND pattern: "100%" cannot match everything', () => {
    // Unescaped, the bound value would be `%100%%` — three live wildcards
    // that match every row whose subject contains "100", and (via the
    // trailing `%%`) nothing narrower than "100". Escaped, the middle `%`
    // is a literal character.
    const filter = filterFor('100%');
    expect(filter.values).toEqual(['%100\\%%']);
    expect(filter.values).not.toContain('%100%%');
  });

  it('escapes an underscore in the bound pattern', () => {
    expect(filterFor('a_b').values).toEqual(['%a\\_b%']);
  });

  it('searches all four columns from ONE placeholder', () => {
    // One bound value referenced four times, not four copies: it is then
    // impossible for the escaping to be applied to three columns and
    // forgotten on the fourth.
    const filter = filterFor('numbers');
    expect(filter.values).toHaveLength(1);
    for (const column of ['m.subject', 'm.from_name', 'm.from_email', 'm.snippet']) {
      expect(filter.where).toContain(`${column} ilike $1`);
    }
  });

  it('uses ILIKE, so the match is case-insensitive without lowering either side', () => {
    expect(filterFor('Numbers').where).toContain('ilike');
    expect(filterFor('Numbers').where).not.toContain(' like ');
  });

  it('adds no search clause at all when there is no query', () => {
    const filter = buildInboxFilter({ cursor: null, folder: ALL_FOLDERS, accountId: null });
    expect(filter.where).toBe('');
    expect(filter.values).toHaveLength(0);
  });
});

describe('buildInboxFilter — search composes with the existing filters', () => {
  it('composes with a folder filter, numbering both placeholders correctly', () => {
    const filter = buildInboxFilter({
      cursor: null,
      folder: { kind: 'literal', folder: 'INBOX' },
      accountId: null,
      search: 'numbers',
    });

    expect(filter.values).toEqual(['INBOX', '%numbers%']);
    expect(filter.where).toContain('m.folder = $1');
    expect(filter.where).toContain('m.subject ilike $2');
    expect(filter.where).toContain(' and ');
  });

  it('composes with folder AND account together', () => {
    const filter = buildInboxFilter({
      cursor: null,
      folder: { kind: 'starred' },
      accountId: 'work',
      search: 'invoice',
    });

    expect(filter.values).toEqual(['\\Flagged', 'work', '%invoice%']);
    expect(filter.where).toContain('$1 = any(m.flags)');
    expect(filter.where).toContain('m.account_id = $2');
    expect(filter.where).toContain('m.subject ilike $3');
  });

  it('composes with a native-folder pairs filter, whose clause binds two arrays', () => {
    const filter = buildInboxFilter({
      cursor: null,
      folder: { kind: 'pairs', pairs: [{ accountId: 'work', folder: '[Gmail]/Sent Mail' }] },
      accountId: null,
      search: 'invoice',
    });

    expect(filter.values).toEqual([['work'], ['[Gmail]/Sent Mail'], '%invoice%']);
    expect(filter.where).toContain('m.subject ilike $3');
  });

  it('composes with the keyset cursor, which is pushed BEFORE it', () => {
    // The cursor contributes three values, so the search placeholder has to
    // be $4 — this is the numbering that a hardcoded $1 would break.
    const filter = buildInboxFilter({
      cursor: { date: new Date('2026-08-01T00:00:00Z'), accountId: 'work', uid: 42 },
      folder: ALL_FOLDERS,
      accountId: null,
      search: 'invoice',
    });

    expect(filter.values).toHaveLength(4);
    expect(filter.values[3]).toBe('%invoice%');
    expect(filter.where).toContain('m.subject ilike $4');
  });

  it('leaves an unsearched inbox read byte-for-byte as it was', () => {
    // The existing /api/inbox contract: adding search must not change the
    // statement any pre-Plan-7 caller produces.
    const filter = buildInboxFilter({
      cursor: null,
      folder: { kind: 'literal', folder: 'INBOX' },
      accountId: 'work',
      search: null,
    });

    expect(filter.where).toBe('where m.folder = $1 and m.account_id = $2');
    expect(filter.values).toEqual(['INBOX', 'work']);
  });
});
