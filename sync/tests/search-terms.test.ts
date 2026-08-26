import { describe, expect, it } from 'vitest';
import { SEARCH_OPERATORS, parseSearchQuery } from '../src/search/terms';
import type { SearchTerm } from '../src/search/terms';

/**
 * The grammar, asserted on the parsed terms rather than on the SQL.
 *
 * The split matters: this file pins WHAT A QUERY MEANS, and
 * tests/db-filter.test.ts pins how that meaning becomes a statement. A
 * single suite over the generated SQL would let a misread operator hide
 * behind a plausible-looking clause, and a single suite over the terms
 * would prove nothing about injection.
 */

function terms(query: string): readonly SearchTerm[] {
  return parseSearchQuery(query);
}

/** The term a query degrades to when nothing else could be understood —
 *  the shape every failure branch in ../src/search/terms.ts produces. */
function literal(value: string, negated = false): SearchTerm {
  return { kind: 'match', field: 'any', value, negated };
}

describe('bare words', () => {
  it('parses one word as the pre-operator search, unchanged', () => {
    expect(terms('invoice')).toEqual([literal('invoice')]);
  });

  it('splits an unquoted multi-word query into one term per word', () => {
    // THE ONE BEHAVIOUR CHANGE in this whole feature, and it is the
    // change that makes quoting mean something: `quarterly report` used
    // to be a single ILIKE `%quarterly report%`, requiring the two words
    // to be adjacent in ONE column. It is now two terms ANDed.
    //
    // Nothing is lost by it — a row containing the phrase contains both
    // words, so the new result set is a strict SUPERSET of the old one
    // (verified against the real 41,813-row mailbox: five real
    // multi-word queries, zero rows dropped, `order shipped` going from
    // 0 hits to 26). The exact old behaviour is one pair of quotes away.
    expect(terms('quarterly report')).toEqual([literal('quarterly'), literal('report')]);
  });

  it('collapses runs of whitespace rather than emitting empty terms', () => {
    // An empty term's ILIKE pattern is `%%`, which matches the entire
    // mailbox — the one failure that silently WIDENS a search.
    expect(terms('  invoice \t\n  receipt  ')).toEqual([literal('invoice'), literal('receipt')]);
  });

  it('is empty for a query with no content at all', () => {
    expect(terms('')).toEqual([]);
    expect(terms('   ')).toEqual([]);
  });
});

describe('quoted phrases', () => {
  it('makes a quoted phrase ONE term, spaces included', () => {
    expect(terms('"quarterly report"')).toEqual([literal('quarterly report')]);
  });

  it('quotes an operator value too', () => {
    expect(terms('from:"Ada Lovelace"')).toEqual([
      { kind: 'match', field: 'from', value: 'Ada Lovelace', negated: false },
    ]);
  });

  it('runs an UNBALANCED quote to the end of the query instead of failing', () => {
    // A search-as-you-type box passes through `"quarterly` on the way to
    // `"quarterly report"` on every phrase query ever typed. Refusing
    // the query until the quote balances makes the feature unusable.
    expect(terms('"quarterly report')).toEqual([literal('quarterly report')]);
  });

  it('treats a quote that is not the first character as an ordinary character', () => {
    expect(terms('a"b')).toEqual([literal('a"b')]);
  });

  it('drops an EMPTY quoted phrase — the one case where dropping is right', () => {
    // `""` has nothing to search for, and keeping it would produce
    // `ilike '%%'` — the whole mailbox. Dropping narrows nothing; keeping
    // widens everything.
    expect(terms('invoice ""')).toEqual([literal('invoice')]);
  });

  it('falls back to a literal search when a query is ONLY an empty phrase', () => {
    // Zero terms would mean no WHERE clause at all, i.e. the entire
    // mailbox. The literal fallback searches for the characters typed.
    expect(terms('""')).toEqual([literal('""')]);
  });
});

describe('from/to/cc/subject', () => {
  it('parses each of the four text operators', () => {
    expect(terms('from:ada')).toEqual([{ kind: 'match', field: 'from', value: 'ada', negated: false }]);
    expect(terms('to:bob')).toEqual([{ kind: 'match', field: 'to', value: 'bob', negated: false }]);
    expect(terms('cc:eve')).toEqual([{ kind: 'match', field: 'cc', value: 'eve', negated: false }]);
    expect(terms('subject:invoice')).toEqual([
      { kind: 'match', field: 'subject', value: 'invoice', negated: false },
    ]);
  });

  it('accepts the operator in any case but preserves the value as typed', () => {
    expect(terms('FROM:Ada')).toEqual([{ kind: 'match', field: 'from', value: 'Ada', negated: false }]);
  });

  it('keeps a colon inside the VALUE rather than re-splitting on it', () => {
    expect(terms('subject:re:budget')).toEqual([
      { kind: 'match', field: 'subject', value: 're:budget', negated: false },
    ]);
  });
});

describe('is: and has:', () => {
  it('parses the three is: values', () => {
    expect(terms('is:unread')).toEqual([{ kind: 'flag', flag: 'unread', negated: false }]);
    expect(terms('is:read')).toEqual([{ kind: 'flag', flag: 'read', negated: false }]);
    expect(terms('is:starred')).toEqual([{ kind: 'flag', flag: 'starred', negated: false }]);
  });

  it('parses has:attachment, and the plural nobody can help typing', () => {
    expect(terms('has:attachment')).toEqual([{ kind: 'flag', flag: 'attachment', negated: false }]);
    expect(terms('has:attachments')).toEqual([{ kind: 'flag', flag: 'attachment', negated: false }]);
  });

  it('searches literally for an is: value the grammar does not have', () => {
    expect(terms('is:important')).toEqual([literal('is:important')]);
  });
});

describe('before: and after:', () => {
  it('turns a day into the UTC instant it begins', () => {
    expect(terms('before:2026-08-01')).toEqual([
      { kind: 'date', bound: 'before', at: '2026-08-01T00:00:00.000Z', negated: false },
    ]);
    expect(terms('after:2026-01-01')).toEqual([
      { kind: 'date', bound: 'after', at: '2026-01-01T00:00:00.000Z', negated: false },
    ]);
  });

  it('accepts Gmail’s slash form as well as the ISO one', () => {
    expect(terms('after:2026/1/5')).toEqual([
      { kind: 'date', bound: 'after', at: '2026-01-05T00:00:00.000Z', negated: false },
    ]);
  });

  it('REFUSES a day that does not exist rather than rolling it over', () => {
    // `new Date('2026-02-30')` is March 2nd, and `2026-13-01` is January
    // 2027. Either would answer a question the user did not ask, with a
    // result set that looks entirely reasonable.
    expect(terms('before:2026-02-30')).toEqual([literal('before:2026-02-30')]);
    expect(terms('before:2026-13-01')).toEqual([literal('before:2026-13-01')]);
  });

  it('searches literally for a value that is not a date at all', () => {
    expect(terms('after:yesterday')).toEqual([literal('after:yesterday')]);
  });
});

describe('larger: and smaller:', () => {
  it('parses binary units', () => {
    expect(terms('larger:10mb')).toEqual([
      { kind: 'size', bound: 'larger', bytes: 10 * 1024 * 1024, negated: false },
    ]);
    expect(terms('smaller:1mb')).toEqual([
      { kind: 'size', bound: 'smaller', bytes: 1024 * 1024, negated: false },
    ]);
    expect(terms('larger:500k')).toEqual([
      { kind: 'size', bound: 'larger', bytes: 500 * 1024, negated: false },
    ]);
    expect(terms('larger:2G')).toEqual([
      { kind: 'size', bound: 'larger', bytes: 2 * 1024 * 1024 * 1024, negated: false },
    ]);
  });

  it('treats a bare number as bytes', () => {
    expect(terms('larger:1048576')).toEqual([
      { kind: 'size', bound: 'larger', bytes: 1048576, negated: false },
    ]);
  });

  it('searches literally for an unparseable size', () => {
    expect(terms('larger:banana')).toEqual([literal('larger:banana')]);
    expect(terms('larger:10tb')).toEqual([literal('larger:10tb')]);
    expect(terms('larger:1.5mb')).toEqual([literal('larger:1.5mb')]);
  });

  it('refuses a magnitude that is not a safe integer', () => {
    // Otherwise the byte count becomes a float, prints in exponential
    // notation, and reaches Postgres as something that is not a bigint.
    expect(terms('larger:99999999999999999999gb')).toEqual([
      literal('larger:99999999999999999999gb'),
    ]);
  });
});

describe('the degradations — nothing is ever dropped, nothing is ever an error', () => {
  it('searches literally for an UNKNOWN operator', () => {
    // The single worst available behaviour is discarding part of
    // someone's query and answering a different question with a
    // plausible number of rows.
    //
    // ASSERTED ALONGSIDE A SECOND TERM, deliberately. On its own,
    // `foo:bar` is rescued by the whole-query literal fallback even when
    // `classify` drops it — so the one-token form of this assertion
    // passes under the very mutation it exists to catch. (Found by
    // running that mutation.) With a second term present, the fallback
    // cannot fire and only a real literal keeps the term.
    expect(terms('foo:bar invoice')).toEqual([literal('foo:bar'), literal('invoice')]);
    expect(terms('foo:bar')).toEqual([literal('foo:bar')]);
  });

  it('searches literally for an EMPTY operator value', () => {
    // Every operator is typed through this state: `f`, `fr`, ... `from`,
    // `from:`, `from:a`. A 400 here flashes an error on the way to every
    // operator query the user ever writes.
    expect(terms('from:')).toEqual([literal('from:')]);
    expect(terms('is:')).toEqual([literal('is:')]);
    expect(terms('before:')).toEqual([literal('before:')]);
  });

  it('keeps the other terms when one of them is unparseable', () => {
    expect(terms('foo:bar is:unread')).toEqual([
      literal('foo:bar'),
      { kind: 'flag', flag: 'unread', negated: false },
    ]);
  });
});

describe('negation', () => {
  it('negates a bare word, a phrase, an operator and a flag alike', () => {
    expect(terms('-invoice')).toEqual([literal('invoice', true)]);
    expect(terms('-"quarterly report"')).toEqual([literal('quarterly report', true)]);
    expect(terms('-from:ada')).toEqual([{ kind: 'match', field: 'from', value: 'ada', negated: true }]);
    expect(terms('-is:unread')).toEqual([{ kind: 'flag', flag: 'unread', negated: true }]);
  });

  it('carries the negation onto the LITERAL fallback of an unknown operator', () => {
    expect(terms('-foo:bar')).toEqual([literal('foo:bar', true)]);
  });

  it('treats a lone hyphen as an ordinary character', () => {
    expect(terms('-')).toEqual([literal('-')]);
    expect(terms('- invoice')).toEqual([literal('-'), literal('invoice')]);
  });

  it('leaves a hyphen INSIDE a word alone', () => {
    expect(terms('e-mail')).toEqual([literal('e-mail')]);
    expect(terms('from:e-corp')).toEqual([
      { kind: 'match', field: 'from', value: 'e-corp', negated: false },
    ]);
  });
});

describe('combination', () => {
  it('parses a realistic mixed query left to right', () => {
    expect(terms('from:ada is:unread has:attachment after:2026-01-01 "status report"')).toEqual([
      { kind: 'match', field: 'from', value: 'ada', negated: false },
      { kind: 'flag', flag: 'unread', negated: false },
      { kind: 'flag', flag: 'attachment', negated: false },
      { kind: 'date', bound: 'after', at: '2026-01-01T00:00:00.000Z', negated: false },
      literal('status report'),
    ]);
  });
});

describe('hostile input', () => {
  it('parses a SQL payload into ordinary text terms and nothing else', () => {
    const parsed = terms("'; drop table messages; --");
    expect(parsed.every((term) => term.kind === 'match' && term.field === 'any')).toBe(true);
  });

  it('handles a 10 kB single term without truncating or throwing', () => {
    const huge = 'a'.repeat(10_000);
    expect(terms(huge)).toEqual([literal(huge)]);
  });

  it('handles 500 terms in one query', () => {
    const many = Array.from({ length: 500 }, (_unused, index) => `w${index}`);
    expect(terms(many.join(' '))).toHaveLength(500);
  });

  it('does not treat a colon in a URL as an operator', () => {
    expect(terms('https://example.com/x')).toEqual([literal('https://example.com/x')]);
  });
});

describe('the vocabulary itself', () => {
  it('is exactly the ten operators the client also knows about', () => {
    // Pinned as a list rather than derived, so ADDING an operator is a
    // deliberate two-file edit (see tests/search-vocabulary.test.ts,
    // which holds the client's copy to this one).
    expect([...SEARCH_OPERATORS]).toEqual([
      'from',
      'to',
      'cc',
      'subject',
      'is',
      'has',
      'before',
      'after',
      'larger',
      'smaller',
    ]);
  });
});
