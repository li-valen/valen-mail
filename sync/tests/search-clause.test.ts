import { describe, expect, it } from 'vitest';
import { buildInboxFilter, type InboxFolderFilter } from '../src/db';

/**
 * THE SQL each operator generates, and the injection surface.
 *
 * Asserted through `buildInboxFilter` rather than through
 * `buildSearchClause` directly, because the placeholder NUMBERS are part
 * of what has to be right and they only exist once a clause is composed
 * with the folder/account/cursor clauses that share the values array.
 *
 * Why here and not tests/db.test.ts: every case in that file is
 * `describe.skip`ped unless TEST_DATABASE_URL is set, so on an ordinary
 * checkout it proves nothing — and a query string that reaches the SQL
 * TEXT is a SQL-injection surface whether or not anyone executed it.
 * tests/db.test.ts covers what only a real database can (that these
 * clauses select the rows they claim to).
 */

const ALL: InboxFolderFilter = { kind: 'all' };

function filterFor(search: string) {
  return buildInboxFilter({ cursor: null, folder: ALL, accountId: null, search });
}

function whereFor(search: string): string {
  return filterFor(search).where.replace(/^where /, '');
}

describe('from / to / cc / subject', () => {
  it('searches both sender columns from one placeholder for from:', () => {
    const filter = filterFor('from:ada');
    expect(filter.where).toBe('where (m.from_name ilike $1 or m.from_email ilike $1)');
    expect(filter.values).toEqual(['%ada%']);
  });

  it('searches ONLY the subject for subject:, with no parentheses to spare', () => {
    const filter = filterFor('subject:invoice');
    expect(filter.where).toBe('where m.subject ilike $1');
    expect(filter.values).toEqual(['%invoice%']);
  });

  it('matches ANY element of the to_emails array, not the array printed as text', () => {
    // `array_to_string(to_emails,' ') ilike '%…%'` would let a quoted
    // phrase match ACROSS two addresses that are merely adjacent in the
    // joined string. `unnest` in an EXISTS cannot.
    const filter = filterFor('to:bob');
    expect(filter.where).toBe(
      'where exists (select 1 from unnest(m.to_emails) as addr where addr ilike $1)',
    );
    expect(filter.values).toEqual(['%bob%']);
  });

  it('addresses cc_emails for cc:, and never to_emails', () => {
    const where = whereFor('cc:eve');
    expect(where).toContain('unnest(m.cc_emails)');
    expect(where).not.toContain('to_emails');
  });
});

describe('is: and has:', () => {
  it('binds the IMAP flag rather than writing it into the statement', () => {
    // An inlined `'\Flagged'` literal's meaning depends on the
    // `standard_conforming_strings` GUC; a bound value is never parsed
    // as a literal at all. Same discipline as pushFolderClause.
    const filter = filterFor('is:starred');
    expect(filter.where).toBe('where $1 = any(m.flags)');
    expect(filter.values).toEqual(['\\Flagged']);
  });

  it('makes is:read the PRESENCE of \\Seen', () => {
    const filter = filterFor('is:read');
    expect(filter.where).toBe('where $1 = any(m.flags)');
    expect(filter.values).toEqual(['\\Seen']);
  });

  it('makes is:unread the absence of \\Seen, with NULL flags counting as unread', () => {
    // `any(NULL)` is NULL and `not NULL` is NULL, which WHERE reads as
    // "no match" — so without the coalesce a message whose flags were
    // never stored would be in NEITHER is:read nor is:unread.
    const filter = filterFor('is:unread');
    expect(filter.where).toBe('where not coalesce($1 = any(m.flags), false)');
    expect(filter.values).toEqual(['\\Seen']);
  });

  it('uses the has_attach column for has:attachment, binding nothing', () => {
    const filter = filterFor('has:attachment');
    expect(filter.where).toBe('where m.has_attach');
    expect(filter.values).toEqual([]);
  });
});

describe('before / after — the clause that has to be index-usable', () => {
  it('writes the date in the SAME expression messages_unified_keyset is built on', () => {
    // THE PERFORMANCE ASSERTION. schema.sql indexes
    // `(coalesce(date,'-infinity') desc, account_id desc, uid desc)`.
    // Written against the bare column, `m.date >= $1` cannot be an index
    // CONDITION on that index — it becomes a filter applied to every row
    // the scan walks. Measured on the real mailbox: 0.52 ms as an index
    // bound, and a walk of the whole index without it.
    const filter = filterFor('after:2026-01-01');
    expect(filter.where).toBe(
      "where coalesce(m.date, '-infinity'::timestamptz) >= $1::timestamptz",
    );
    expect(filter.values).toEqual(['2026-01-01T00:00:00.000Z']);
  });

  it('makes before: a strict < at the same instant, so the two bounds partition', () => {
    const filter = filterFor('before:2026-08-01');
    expect(filter.where).toBe(
      "where coalesce(m.date, '-infinity'::timestamptz) < $1::timestamptz",
    );
    expect(filter.values).toEqual(['2026-08-01T00:00:00.000Z']);
  });

  it('composes both bounds into one window', () => {
    const filter = filterFor('after:2026-01-01 before:2026-02-01');
    expect(filter.where).toBe(
      "where (coalesce(m.date, '-infinity'::timestamptz) >= $1::timestamptz and " +
        "coalesce(m.date, '-infinity'::timestamptz) < $2::timestamptz)",
    );
  });
});

describe('larger / smaller', () => {
  it('casts the bound value to bigint explicitly', () => {
    // `size_bytes` is a bigint, and this project has already been bitten
    // by the two encodings the pg driver uses for that type.
    const filter = filterFor('larger:10mb');
    expect(filter.where).toBe('where m.size_bytes > $1::bigint');
    expect(filter.values).toEqual(['10485760']);
  });

  it('uses < for smaller:', () => {
    expect(whereFor('smaller:1mb')).toBe('m.size_bytes < $1::bigint');
  });
});

describe('negation', () => {
  it('wraps the clause in `not coalesce(…, false)` so NULL columns are not excluded', () => {
    // `-from:ada` must KEEP a message whose sender is unknown: it is
    // certainly not from Ada. Bare `not (…)` yields NULL there and drops
    // the row.
    expect(whereFor('-from:ada')).toBe(
      'not coalesce((m.from_name ilike $1 or m.from_email ilike $1), false)',
    );
  });

  it('negates a flag by wrapping its own clause, double coalesce and all', () => {
    expect(whereFor('-is:unread')).toBe(
      'not coalesce(not coalesce($1 = any(m.flags), false), false)',
    );
  });
});

describe('terms combine with AND', () => {
  it('joins two terms with `and`, never with `or`', () => {
    // THE MUTATION THIS SUITE EXISTS FOR. An OR here turns every
    // multi-term query into a broader search than the user asked for —
    // `from:ada is:unread` would return all of Ada's mail plus every
    // unread message in the mailbox, which looks like a working search.
    const where = whereFor('from:ada is:unread');
    expect(where).toBe(
      '((m.from_name ilike $1 or m.from_email ilike $1) and not coalesce($2 = any(m.flags), false))',
    );
    expect(where).not.toContain(') or (');
  });

  it('ANDs five terms of five different kinds', () => {
    const filter = filterFor('from:ada is:unread has:attachment larger:1mb invoice');
    const conjunctions = filter.where.split(' and ').length - 1;
    expect(conjunctions).toBe(4);
    expect(filter.values).toEqual(['%ada%', '\\Seen', '1048576', '%invoice%']);
  });

  it('numbers every term’s placeholder from the shared values array', () => {
    const filter = filterFor('from:ada to:bob subject:invoice');
    expect(filter.where).toContain('m.from_name ilike $1');
    expect(filter.where).toContain('unnest(m.to_emails) as addr where addr ilike $2');
    expect(filter.where).toContain('m.subject ilike $3');
    expect(filter.values).toEqual(['%ada%', '%bob%', '%invoice%']);
  });
});

describe('BACKWARDS COMPATIBILITY — an operator-free query is unchanged', () => {
  it('produces the EXACT statement GET /api/search generated before operators existed', () => {
    // Byte-for-byte, not merely equivalent. This string is the contract:
    // if operators changed what a plain search means, every bookmark,
    // every habit and every existing test of this route would silently
    // start answering a different question.
    const filter = filterFor('numbers');
    expect(filter.where).toBe(
      'where (m.subject ilike $1 or m.from_name ilike $1 or m.from_email ilike $1 or m.snippet ilike $1)',
    );
    expect(filter.values).toEqual(['%numbers%']);
  });

  it('still escapes ILIKE wildcards, so `100%` is not "every message"', () => {
    expect(filterFor('100%').values).toEqual(['%100\\%%']);
    expect(filterFor('a_b').values).toEqual(['%a\\_b%']);
  });

  it('escapes wildcards inside an OPERATOR value too', () => {
    // The escaping has to follow the value into every new code path, not
    // just the one it was written for. `from:%` unescaped is "every
    // sender", which is a search that returns the whole mailbox.
    expect(filterFor('from:100%').values).toEqual(['%100\\%%']);
    expect(filterFor('subject:a_b').values).toEqual(['%a\\_b%']);
  });

  it('adds no clause at all for a whitespace-only query', () => {
    // Not reachable through the route (an empty `q` is a 400). The old
    // implementation produced `ilike '%%'` here — the whole mailbox.
    const filter = buildInboxFilter({ cursor: null, folder: ALL, accountId: null, search: '   ' });
    expect(filter.where).toBe('');
    expect(filter.values).toEqual([]);
  });
});

/**
 * THE INJECTION SUITE.
 *
 * The property under test is not "the payload did not work" — it is that
 * NO CHARACTER THE USER TYPED IS IN THE STATEMENT AT ALL. That is a
 * stronger and much easier claim to check: the generated WHERE is drawn
 * from a fixed alphabet of column names, comparison operators and
 * `$n` placeholders, so anything outside that alphabet is a leak.
 */
const SQL_ALPHABET =
  /^[a-z0-9_$(), .'\\:=<>|%-]*$/i;

/** Every identifier and keyword ../src/search/clause.ts is allowed to
 *  emit. Anything else appearing in a generated statement is either a
 *  new feature that must be added here deliberately, or a leak. */
const ALLOWED_WORDS = new Set([
  'm', 'sib', 'addr', 'pair',
  'subject', 'from_name', 'from_email', 'snippet', 'to_emails', 'cc_emails',
  'flags', 'has_attach', 'size_bytes', 'date', 'account_id', 'uid', 'folder',
  'ilike', 'or', 'and', 'not', 'coalesce', 'false', 'true', 'any', 'exists',
  'select', 'from', 'unnest', 'as', 'where', 'infinity', 'timestamptz', 'bigint', 'text',
]);

function wordsIn(sql: string): readonly string[] {
  return sql.replace(/\$\d+/g, ' ').match(/[A-Za-z_]+/g) ?? [];
}

describe('injection — nothing the user typed reaches the statement', () => {
  const PAYLOADS: readonly [string, string][] = [
    ['classic', "'; drop table messages; --"],
    ['operator-shaped', "from:'; drop table messages; --"],
    ['quoted payload', 'from:"\'; drop table messages; --"'],
    ['union', "x' union select * from accounts --"],
    ['comment terminator', 'subject:*/;delete from messages;/*'],
    ['placeholder forgery', 'from:$1 or 1=1'],
    ['identifier quoting', 'subject:"a" or m."flags" is null --'],
    ['backslash', 'from:\\\\'],
    ['null byte', 'from:a\u0000b'],
    ['unicode quote escape', "from:\u00a5' or ''='"],
    ['unbalanced quote', 'subject:"never closed'],
    ['empty operator value', 'from:'],
    ['lone quote', '"'],
  ];

  for (const [name, payload] of PAYLOADS) {
    it(`emits only known SQL for the ${name} payload`, () => {
      const filter = filterFor(payload);

      expect(filter.where).toMatch(SQL_ALPHABET);
      for (const word of wordsIn(filter.where)) {
        expect(ALLOWED_WORDS.has(word.toLowerCase())).toBe(true);
      }
      // Every parameter is a real bound value, never spliced in.
      expect(filter.values.length).toBeGreaterThan(0);
    });
  }

  it('never lets a `--` or a `;` from the query into the statement', () => {
    const where = filterFor("'; drop table messages; -- and from:x';--").where;
    expect(where).not.toContain('--');
    expect(where).not.toContain(';');
  });

  it('survives a 10 kB single term and binds it whole', () => {
    const huge = 'a'.repeat(10_000);
    const filter = filterFor(huge);
    expect(filter.where).toBe(
      'where (m.subject ilike $1 or m.from_name ilike $1 or m.from_email ilike $1 or m.snippet ilike $1)',
    );
    expect(filter.values).toEqual([`%${huge}%`]);
  });

  it('survives 500 terms in one query, numbering every placeholder', () => {
    // Unreachable through the route, which caps `q` at 200 characters —
    // asserted here anyway because buildInboxFilter is callable directly
    // and 500 ANDed clauses must be valid SQL rather than a crash.
    const query = Array.from({ length: 500 }, (_unused, index) => `w${index}`).join(' ');
    const filter = filterFor(query);

    expect(filter.values).toHaveLength(500);
    expect(filter.where).toContain('ilike $500');
    expect(filter.where).not.toContain('$501');
    // Every clause ANDed, so 500 terms can only ever NARROW the result.
    expect(filter.where.split(' and ').length - 1).toBe(499);
  });

  it('writes every clause against the caller’s alias, including the new ones', () => {
    // The sibling probe in getConversationPage. Written against `m` by
    // accident, a sibling test matches the outer row itself and every
    // conversation collapses to its newest message across all folders.
    const filter = buildInboxFilter({
      cursor: null,
      folder: ALL,
      accountId: null,
      search: 'from:ada to:bob is:unread has:attachment before:2026-01-01 larger:1mb',
      alias: 'sib',
      offset: 4,
    });

    expect(filter.where).not.toContain('m.');
    for (const fragment of [
      'sib.from_name',
      'sib.to_emails',
      'sib.flags',
      'sib.has_attach',
      'coalesce(sib.date',
      'sib.size_bytes',
    ]) {
      expect(filter.where).toContain(fragment);
    }
    // offset 4 means the first search placeholder is $5.
    expect(filter.where).toContain('$5');
    expect(filter.where).not.toContain('$1');
  });
});
