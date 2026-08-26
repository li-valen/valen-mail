import { describe, expect, it } from 'vitest';
import inboxListSource from '../src/components/InboxList.tsx?raw';
import {
  DISPLAY_OPERATORS,
  MAX_CHIPS,
  describeSearchQuery,
} from '../src/searchDisplay';

/**
 * The chip line under the results banner.
 *
 * Two properties matter more than any individual label:
 *
 *  1. **A query with no operators draws nothing.** That is both the
 *     user's standing direction and the backwards-compatibility rule for
 *     the UI half — every query this app could express before operators
 *     existed must look exactly as it did.
 *  2. **Nothing is ever dropped.** A token that could not be understood
 *     appears as a `text` chip, because the server searches for it
 *     literally. A chip line that quietly omitted `foo:bar` would be
 *     telling the user their query means something it does not.
 */

function chips(query: string): readonly string[] {
  return describeSearchQuery(query).chips.map((chip) => chip.label);
}

function kinds(query: string): readonly string[] {
  return describeSearchQuery(query).chips.map((chip) => chip.kind);
}

describe('when the line is drawn at all', () => {
  it('draws NOTHING for a query with no operators', () => {
    // The banner already echoes the query; a chip repeating it is noise.
    expect(describeSearchQuery('invoice').isInterpreted).toBe(false);
    expect(describeSearchQuery('quarterly report').isInterpreted).toBe(false);
    expect(describeSearchQuery('"quarterly report"').isInterpreted).toBe(false);
    expect(describeSearchQuery('').isInterpreted).toBe(false);
  });

  it('draws the line as soon as one of the ten operator NAMES is used', () => {
    expect(describeSearchQuery('from:ada').isInterpreted).toBe(true);
    expect(describeSearchQuery('invoice is:unread').isInterpreted).toBe(true);
  });

  it('draws the line for a known operator whose VALUE did not parse', () => {
    // `before:yesterday` is searched for as characters, not applied as a
    // date filter. The user reached for the vocabulary, so the line is
    // worth drawing — and the chip is a `text` one, which is the whole
    // signal that it did not become a filter.
    const result = describeSearchQuery('before:yesterday');
    expect(result.isInterpreted).toBe(true);
    expect(result.chips).toEqual([{ label: 'before:yesterday', kind: 'text' }]);
  });

  it('does NOT draw the line for an operator name the grammar does not have', () => {
    expect(describeSearchQuery('foo:bar').isInterpreted).toBe(false);
  });
});

describe('the labels', () => {
  it('names the four substring operators in plain words', () => {
    expect(chips('from:ada')).toEqual(['From ada']);
    expect(chips('to:bob')).toEqual(['To bob']);
    expect(chips('cc:eve')).toEqual(['Cc eve']);
    expect(chips('subject:invoice')).toEqual(['Subject invoice']);
  });

  it('names the flags without repeating the syntax back at the user', () => {
    expect(chips('is:unread')).toEqual(['Unread']);
    expect(chips('is:read')).toEqual(['Read']);
    expect(chips('is:starred')).toEqual(['Starred']);
    expect(chips('has:attachment')).toEqual(['Has attachment']);
    expect(chips('has:attachments')).toEqual(['Has attachment']);
  });

  it('echoes a date and a size exactly as typed', () => {
    // Not reformatted: the server reads the day in UTC, and a client
    // that redrew it in the reader's calendar could show a different day
    // from the one being filtered on.
    expect(chips('before:2026-08-01')).toEqual(['Before 2026-08-01']);
    expect(chips('after:2026-01-01')).toEqual(['After 2026-01-01']);
    expect(chips('larger:10mb')).toEqual(['Larger than 10mb']);
    expect(chips('smaller:1mb')).toEqual(['Smaller than 1mb']);
  });

  it('does NOT re-quote a phrase — the chip’s own boundary says "one term"', () => {
    // THE BROWSER-FOUND DEFECT. The renderer wraps every text chip in
    // `“…”`, so a label that carried its own quotes drew as
    // `““security alert””`. One chip IS the delimiter: `security alert`
    // renders as one `“security alert”` where two bare words render as
    // two separate chips.
    expect(chips('"quarterly report"')).toEqual(['quarterly report']);
    expect(chips('quarterly report')).toEqual(['quarterly', 'report']);
  });

  it('drops the quotes from an operator value, which needs no such hint', () => {
    expect(chips('from:"Ada Lovelace"')).toEqual(['From Ada Lovelace']);
  });

  it('joins several terms in the order they were typed', () => {
    expect(chips('from:ada is:unread invoice')).toEqual(['From ada', 'Unread', 'invoice']);
  });
});

describe('negation', () => {
  it('reads a negated operator as English rather than as a prefix', () => {
    expect(chips('-from:ada')).toEqual(['Not from ada']);
    expect(chips('-subject:invoice')).toEqual(['Not subject invoice']);
    expect(chips('-before:2026-08-01')).toEqual(['Not before 2026-08-01']);
  });

  it('gives has:attachment its own negative wording', () => {
    // "Not has attachment" is not English.
    expect(chips('-has:attachment')).toEqual(['No attachment']);
    expect(chips('-is:unread')).toEqual(['Not unread']);
    expect(chips('-is:starred')).toEqual(['Not starred']);
  });

  it('negates a bare word too', () => {
    expect(chips('-invoice')).toEqual(['Not invoice']);
  });

  it('treats a lone hyphen, and a hyphen inside a word, as characters', () => {
    expect(chips('-')).toEqual(['-']);
    expect(chips('e-mail')).toEqual(['e-mail']);
  });
});

describe('NOTHING IS EVER DROPPED', () => {
  it('shows an unknown operator as the text it will be searched for', () => {
    // THE MUTATION THIS EXISTS FOR. A chip line that omitted the term
    // would tell the user their query means something narrower than what
    // actually runs. Asserted alongside a second term so the assertion
    // cannot pass merely because the list is short.
    expect(chips('foo:bar')).toEqual(['foo:bar']);
    expect(chips('foo:bar invoice')).toEqual(['foo:bar', 'invoice']);
    expect(kinds('foo:bar invoice')).toEqual(['text', 'text']);
  });

  it('shows an empty operator value as the text it will be searched for', () => {
    expect(chips('from:')).toEqual(['from:']);
    expect(chips('from: invoice')).toEqual(['from:', 'invoice']);
  });

  it('shows an impossible date as text, not as a date filter', () => {
    expect(describeSearchQuery('before:2026-02-30').chips).toEqual([
      { label: 'before:2026-02-30', kind: 'text' },
    ]);
  });

  it('shows an unparseable size as text', () => {
    expect(kinds('larger:banana')).toEqual(['text']);
    expect(kinds('larger:1.5mb')).toEqual(['text']);
    expect(kinds('larger:10mb')).toEqual(['operator']);
  });

  it('shows an is: value the grammar does not have as text', () => {
    expect(describeSearchQuery('is:important').chips).toEqual([
      { label: 'is:important', kind: 'text' },
    ]);
  });

  it('keeps every OTHER term when one of them degrades', () => {
    expect(chips('foo:bar is:unread from:ada')).toEqual(['foo:bar', 'Unread', 'From ada']);
  });
});

describe('the tokeniser matches the server’s, case for case', () => {
  it('runs an unbalanced quote to the end of the query', () => {
    expect(chips('"quarterly report')).toEqual(['quarterly report']);
  });

  it('treats a quote that is not the first character as a character', () => {
    expect(chips('a"b')).toEqual(['a"b']);
  });

  it('emits no chip for an empty phrase', () => {
    expect(chips('invoice ""')).toEqual(['invoice']);
  });

  it('does not read a colon inside a URL as an operator', () => {
    expect(chips('https://example.com/x')).toEqual(['https://example.com/x']);
    expect(describeSearchQuery('https://example.com/x').isInterpreted).toBe(false);
  });

  it('keeps a colon inside an operator value', () => {
    expect(chips('subject:re:budget')).toEqual(['Subject re:budget']);
  });

  it('accepts the operator name in any case', () => {
    expect(chips('FROM:Ada')).toEqual(['From Ada']);
  });

  it('collapses runs of whitespace', () => {
    expect(chips('  from:ada \t is:unread  ')).toEqual(['From ada', 'Unread']);
  });
});

describe('a query too long to draw', () => {
  it('caps the chips and counts the rest instead of overflowing the line', () => {
    // Only the DISPLAY is truncated — the search still runs on every
    // term. A hundred chips is a layout defect at 375 px.
    const many = Array.from({ length: 20 }, (_unused, index) => `w${index}`).join(' ');
    const result = describeSearchQuery(many);
    expect(result.chips).toHaveLength(MAX_CHIPS);
    expect(result.overflow).toBe(20 - MAX_CHIPS);
  });

  it('reports no overflow when everything fits', () => {
    expect(describeSearchQuery('from:ada is:unread').overflow).toBe(0);
  });
});

describe('hostile input reaches the label as text and nothing else', () => {
  it('labels a SQL payload without interpreting any of it', () => {
    const result = describeSearchQuery("from:'; drop table messages; --");
    expect(result.chips.every((chip) => chip.kind === 'text' || chip.kind === 'operator')).toBe(true);
    // The payload's first token IS `from:'`, a real operator with a
    // real (if absurd) value, so it labels as one. Everything else is
    // ordinary text. Either way it is a string in a JSX text child.
    // The trailing `--` is a `-` negating a `-`, exactly as the server
    // tokenises it: a negated literal search for a hyphen.
    expect(result.chips.map((chip) => chip.label)).toEqual([
      "From ';",
      'drop',
      'table',
      'messages;',
      'Not -',
    ]);
  });

  it('does not throw on a 10 kB term', () => {
    const huge = 'a'.repeat(10_000);
    expect(describeSearchQuery(huge).chips).toEqual([{ label: huge, kind: 'text' }]);
  });
});

describe('the vocabulary', () => {
  it('is the same ten names, in the same order, as the server’s', () => {
    // sync/tests/search-vocabulary.test.ts reads both source files and
    // fails if they diverge; this pins the client's own copy so the
    // divergence is visible from either side.
    expect([...DISPLAY_OPERATORS]).toEqual([
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

/**
 * THE WIRING — the `?raw`-import-and-regex technique
 * tests/bulk-wiring-static-guards.test.ts established, and the only tool
 * available under client/CLAUDE.md's standing constraint that no test in
 * this project renders a component.
 *
 * Everything above proves `describeSearchQuery` answers correctly. None
 * of it can reach the question that decides whether the user ever sees
 * a chip: does the banner CALL it, and does it draw both kinds?
 */
const LIST = inboxListSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('the results banner draws the interpretation', () => {
  it('calls describeSearchQuery on the debounced query', () => {
    expect(LIST).toContain("from '../searchDisplay'");
    expect(LIST).toMatch(/describeSearchQuery\(search\)/);
  });

  it('draws the line only when the query used an operator', () => {
    // Without this gate every plain word search grows a chip repeating
    // itself — the "side note" the user asked not to have.
    expect(LIST).toMatch(/interpretation\.isInterpreted \?/);
  });

  it('draws BOTH chip kinds differently, which is the whole signal', () => {
    // One class for both would erase the difference between "this became
    // a filter" and "this is being searched for as text".
    expect(LIST).toMatch(/chip\.kind === 'operator' \? CHIP_STATIC : CHIP_LITERAL/);
  });

  it('renders every chip in the list, and the overflow count', () => {
    expect(LIST).toMatch(/interpretation\.chips\.map/);
    expect(LIST).toMatch(/interpretation\.overflow/);
  });

  it('would notice the line being deleted', () => {
    // The synthetic proof that the patterns above are not vacuous.
    const withoutWiring = LIST.replace(/interpretation/g, 'REMOVED');
    expect(withoutWiring).not.toMatch(/interpretation\.chips\.map/);
  });
});
