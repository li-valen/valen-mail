import { escapeLikePattern } from './like.ts';
import type { FlagName, MatchField, SearchTerm } from './terms';

/**
 * TERMS TO SQL — the half of search that touches the database, and
 * therefore the half where a mistake is a SQL injection rather than a
 * wrong result.
 *
 * **THE INVARIANT: no character the user typed ever reaches the
 * statement text.** Every string this module writes into SQL comes from
 * one of the frozen tables below, keyed by a value ./terms.ts has
 * already narrowed to a literal union. There is no branch that
 * concatenates a `value`, no template that interpolates an operator, and
 * — the one that is easy to get wrong — no path by which a COLUMN NAME
 * is derived from input. `MATCH_COLUMNS`, `FLAG_TESTS` and the two
 * comparison tables are the complete list of identifiers this file can
 * emit, and they are constants.
 *
 * tests/db-filter.test.ts asserts that directly, on the generated
 * statement, for a query built to break out of it.
 *
 * **WHY ILIKE STILL ESCAPES `%` AND `_`.** A bound parameter is immune
 * to injection but is NOT immune to being a PATTERN: `%` and `_` are
 * LIKE syntax wherever they appear in the value, so an unescaped
 * `from:100%` would match every sender and `subject:a_b` would also
 * match "axb". The user typed text, not a pattern, so the two characters
 * are escaped into themselves — see ./like.ts.
 */

/** Which columns each `MatchField` searches, and how. Scalar columns get
 *  a plain ILIKE; `text[]` columns get an ILIKE against ANY element.
 *
 *  `any` is the pre-operator behaviour of GET /api/search, unchanged,
 *  and MUST stay the same four columns in the same order — a single
 *  bare word has to produce byte-identical SQL to what shipped before
 *  operators existed (tests/db-filter.test.ts pins the string). */
interface MatchColumns {
  readonly scalar: readonly string[];
  readonly array: readonly string[];
}

const MATCH_COLUMNS: Readonly<Record<MatchField, MatchColumns>> = {
  any: { scalar: ['subject', 'from_name', 'from_email', 'snippet'], array: [] },
  from: { scalar: ['from_name', 'from_email'], array: [] },
  // `to:` is the To header only and `cc:` the Cc header only, matching
  // Gmail — where the two are separate operators precisely because "was
  // this addressed to me or was I copied" is a distinction people search
  // on. Folding Cc into `to:` would make `to:me` unable to express it.
  to: { scalar: [], array: ['to_emails'] },
  cc: { scalar: [], array: ['cc_emails'] },
  subject: { scalar: ['subject'], array: [] },
};

/** How a `FlagName` becomes a boolean. Two shapes, because
 *  `has_attach` is a real boolean column while read/starred live in the
 *  `flags` array as IMAP's own names. */
type FlagTest =
  | { readonly kind: 'imap-flag'; readonly flag: string; readonly present: boolean }
  | { readonly kind: 'column'; readonly column: string };

const FLAG_TESTS: Readonly<Record<FlagName, FlagTest>> = {
  // The backslashes are JS escapes for a single one: the stored values
  // are IMAP's `\Seen` and `\Flagged` (confirmed against the live table).
  // They are BOUND rather than written into the SQL for the reason
  // ../db.ts's pushFolderClause documents at length — an inlined
  // `'\Flagged'` literal's meaning depends on the
  // `standard_conforming_strings` GUC, and if it were ever off the
  // clause would silently stop matching instead of failing.
  read: { kind: 'imap-flag', flag: '\\Seen', present: true },
  unread: { kind: 'imap-flag', flag: '\\Seen', present: false },
  starred: { kind: 'imap-flag', flag: '\\Flagged', present: true },
  attachment: { kind: 'column', column: 'has_attach' },
};

/**
 * The comparison each date bound uses. A table rather than a ternary so
 * that the operator characters are unmistakably constants — this and
 * SIZE_COMPARISONS below are the only two places an SQL operator is
 * chosen at all.
 *
 * `after:` is `>=` and `before:` is `<` — half-open at the same instant,
 * so the two partition the timeline exactly: every message is on one
 * side or the other of `before:X`/`after:X`, never both and never
 * neither.
 */
const DATE_COMPARISONS: Readonly<Record<'before' | 'after', string>> = {
  before: '<',
  after: '>=',
};

const SIZE_COMPARISONS: Readonly<Record<'larger' | 'smaller', string>> = {
  larger: '>',
  smaller: '<',
};

/**
 * THE DATE EXPRESSION, and it is load-bearing for performance rather
 * than for correctness.
 *
 * `coalesce(date, '-infinity')` is character-for-character the
 * expression `messages_unified_keyset` (schema.sql) is built on, and
 * matching it exactly is what lets Postgres turn `before:`/`after:` into
 * an INDEX RANGE BOUND on that index instead of a filter applied to
 * every row it walks. Measured on the real 41,813-row mailbox, page one:
 *
 *     coalesce(date,'-infinity') >= $1   ->  Index Cond, 0.52 ms
 *     date >= $1                         ->  Filter,     0.62 ms
 *     after:2015-01-01 before:2016-01-01 ->  both bounds, 0.24 ms
 *
 * The `>=` case is the one that decides it: written against the bare
 * column, `date >= $1` cannot be an index condition on an index over
 * `coalesce(date, …)` at all, so a query for recent mail degrades to a
 * walk of the whole index. Changing this expression without changing
 * schema.sql's index to match silently costs that.
 *
 * It also inherits the index's NULL convention, which is the app's
 * convention everywhere else (INBOX_ORDER, the keyset cursor): a message
 * with no parseable `Date:` header sorts as `-infinity`, so it is
 * "before" every real date and "after" none of them.
 */
function dateExpression(alias: string): string {
  return `coalesce(${alias}.date, '-infinity'::timestamptz)`;
}

/** Pushes a value and answers the placeholder number to reference it by.
 *  Supplied by the caller so this module never touches the values array
 *  or has to know what a `FilterContext.offset` is. */
export type BindValue = (value: unknown) => number;

/**
 * Wraps a term's clause when it is negated.
 *
 * `coalesce(…, false)` is not decoration. Every clause here can evaluate
 * to NULL on a row with a NULL column — a message with no subject, no
 * flags, no `to_emails` — and `not NULL` is NULL, which WHERE treats as
 * "no match". Without the coalesce, `-from:ada` would exclude every
 * message whose sender is unknown, which is the opposite of what it
 * says: those messages are certainly not from Ada.
 */
function negate(clause: string): string {
  return `not coalesce(${clause}, false)`;
}

function matchClause(field: MatchField, value: string, alias: string, bind: BindValue): string {
  const columns = MATCH_COLUMNS[field];
  // ONE bound parameter for every column of the term, not one per
  // column: the pattern is identical, and a single placeholder makes it
  // impossible for the escaping to be applied to three columns and
  // forgotten on the fourth.
  const placeholder = bind(`%${escapeLikePattern(value)}%`);

  const parts = [
    ...columns.scalar.map((column) => `${alias}.${column} ilike $${placeholder}`),
    // `text[]` columns match when ANY address does. `unnest` in an
    // EXISTS rather than `array_to_string(…) ilike …`, which would let a
    // quoted phrase match ACROSS two addresses that are only adjacent in
    // the joined string.
    ...columns.array.map(
      (column) =>
        `exists (select 1 from unnest(${alias}.${column}) as addr where addr ilike $${placeholder})`,
    ),
  ];

  return parts.length === 1 ? parts[0]! : `(${parts.join(' or ')})`;
}

function flagClause(flag: FlagName, alias: string, bind: BindValue): string {
  const test = FLAG_TESTS[flag];
  if (test.kind === 'column') return `${alias}.${test.column}`;

  const placeholder = bind(test.flag);
  const present = `$${placeholder} = any(${alias}.flags)`;
  // `is:unread` is the absence of `\Seen`, and a row with NULL flags is
  // unread rather than unknown — `any(NULL)` is NULL, so without the
  // coalesce every such row would be excluded from BOTH is:read and
  // is:unread.
  return test.present ? present : negate(present);
}

function termClause(term: SearchTerm, alias: string, bind: BindValue): string {
  const base = ((): string => {
    switch (term.kind) {
      case 'match':
        return matchClause(term.field, term.value, alias, bind);
      case 'flag':
        return flagClause(term.flag, alias, bind);
      case 'date':
        return `${dateExpression(alias)} ${DATE_COMPARISONS[term.bound]} $${bind(term.at)}::timestamptz`;
      case 'size':
        // Bound as a string with an explicit `::bigint`: `size_bytes` is
        // a bigint, and this project has already been bitten by the two
        // encodings the pg driver uses for that type.
        return `${alias}.size_bytes ${SIZE_COMPARISONS[term.bound]} $${bind(String(term.bytes))}::bigint`;
    }
  })();

  return term.negated ? negate(base) : base;
}

/**
 * The WHERE fragment for a parsed query. **Terms are ANDed.**
 *
 * A SINGLE term is emitted WITHOUT wrapping parentheses, which is not a
 * cosmetic choice: a one-word query has to produce byte-identical SQL to
 * what GET /api/search generated before operators existed, and
 * tests/db-filter.test.ts asserts the whole string. Two or more terms
 * are parenthesised so the fragment stays one self-contained expression
 * however the caller joins it to the folder, account and cursor clauses.
 *
 * Callers must not pass an empty array — there is no correct SQL for
 * "no terms" here (`true` is the whole mailbox and `false` is nothing),
 * and ../db.ts's pushSearchClause decides that case by adding no clause
 * at all.
 */
export function buildSearchClause(
  terms: readonly SearchTerm[],
  alias: string,
  bind: BindValue,
): string {
  const clauses = terms.map((term) => termClause(term, alias, bind));
  return clauses.length === 1 ? clauses[0]! : `(${clauses.join(' and ')})`;
}
