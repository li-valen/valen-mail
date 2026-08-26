/**
 * THE SEARCH GRAMMAR, as a parser — Gmail's operator vocabulary over the
 * columns `messages` already has.
 *
 * The whole point of this module is that it turns ATTACKER-AUTHORED TEXT
 * into a CLOSED SET of values. Nothing downstream of `parseSearchQuery`
 * ever sees a string the user chose in a position where a string can mean
 * something: an operator becomes one of ten literal union members, an
 * `is:` value becomes one of three, a date becomes an ISO instant this
 * module built from three integers, a size becomes a JavaScript number.
 * The only free-form text that survives is a `value` that ./clause.ts
 * binds as a parameter and never writes into SQL. See that file's header
 * for the other half of the argument.
 *
 * **EVERY FAILURE DEGRADES TO A LITERAL SEARCH. Nothing is ever dropped,
 * and nothing is ever a 400.** An unknown operator (`foo:bar`), a
 * misspelled value (`is:frobnicated`), an impossible date
 * (`before:2026-02-30`), a size that is not a size (`larger:banana`) and
 * an empty operator value (`from:`) all become an ordinary text term
 * matching the characters the user typed. Two reasons, and the second is
 * the one that decided it:
 *
 *  1. Silently discarding part of someone's query is the worst available
 *     behaviour — the search runs, returns a plausible number of rows,
 *     and quietly answered a different question.
 *  2. The box is DEBOUNCED and searches as you type. Every operator is
 *     typed through its own invalid prefixes: `f`, `fr`, ... `from`,
 *     `from:`, `from:a`. A parser that 400s on `from:` would flash an
 *     error banner on the way to every single operator query.
 */

/** Which columns a text match looks in. `any` is the pre-operator
 *  behaviour — the four columns GET /api/search has always searched. */
export type MatchField = 'any' | 'from' | 'to' | 'cc' | 'subject';

/** The boolean properties of a message, named by `is:`/`has:`. */
export type FlagName = 'unread' | 'read' | 'starred' | 'attachment';

export type SearchTerm =
  /** A substring match against `field`'s columns. `value` is free-form
   *  user text and is the ONLY thing in this union that is. */
  | { readonly kind: 'match'; readonly field: MatchField; readonly value: string; readonly negated: boolean }
  | { readonly kind: 'flag'; readonly flag: FlagName; readonly negated: boolean }
  /** `at` is an ISO-8601 instant this module CONSTRUCTED from three
   *  integers — never a substring of the query. */
  | { readonly kind: 'date'; readonly bound: 'before' | 'after'; readonly at: string; readonly negated: boolean }
  | { readonly kind: 'size'; readonly bound: 'larger' | 'smaller'; readonly bytes: number; readonly negated: boolean };

/**
 * The operator vocabulary, as data.
 *
 * Exported because it is the contract two separate parsers share:
 * client/src/searchDisplay.ts re-declares the same list to LABEL a query
 * for the user, and tests/search-vocabulary.test.ts reads both files and
 * fails if they diverge. The client's copy exists because the chip has to
 * render on the keystroke, before any round trip — but it decides
 * nothing, since the raw query is what goes on the wire and this module
 * is the only thing that gives it meaning.
 */
export const SEARCH_OPERATORS = [
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
] as const;

export type SearchOperator = (typeof SEARCH_OPERATORS)[number];

/** `is:` values, closed. Anything else falls through to a literal
 *  search — see this file's header. */
const IS_VALUES: Readonly<Record<string, FlagName>> = {
  unread: 'unread',
  read: 'read',
  starred: 'starred',
};

/** `has:` values, closed. `attachments` is accepted alongside Gmail's
 *  own `attachment` deliberately: the plural is the likelier thing to
 *  type, and refusing it would answer with a literal search for the
 *  string "has:attachments", i.e. zero rows — which reads as the feature
 *  being broken rather than as a typo. */
const HAS_VALUES: Readonly<Record<string, FlagName>> = {
  attachment: 'attachment',
  attachments: 'attachment',
};

/**
 * Byte multipliers for `larger:`/`smaller:`, BINARY (1024), matching what
 * every mail client means by "10 MB" and what `size_bytes` counts.
 */
const SIZE_UNITS: Readonly<Record<string, number>> = {
  '': 1,
  b: 1,
  k: 1024,
  kb: 1024,
  m: 1024 * 1024,
  mb: 1024 * 1024,
  g: 1024 * 1024 * 1024,
  gb: 1024 * 1024 * 1024,
};

/** One token as the scanner found it, before any meaning is attached. */
interface RawToken {
  readonly negated: boolean;
  /** Lowercased text before a `:`, or null for a bare/quoted word. NOT
   *  yet known to be a real operator. */
  readonly operator: string | null;
  readonly value: string;
  /** True when `value` came from between quotes — which is what makes an
   *  EMPTY value meaningful (`""`) rather than merely absent. */
  readonly quoted: boolean;
}

function isSpace(char: string): boolean {
  return /\s/.test(char);
}

/**
 * Reads one value: a double-quoted phrase, or a run of non-space
 * characters.
 *
 * AN UNTERMINATED QUOTE RUNS TO THE END OF THE STRING and is not an
 * error, because a search-as-you-type box passes through `"quarterly`
 * on the way to `"quarterly report"` on every single phrase query. The
 * alternative — refusing the query until the quote is balanced — makes
 * the box unusable for exactly the feature quotes exist for.
 *
 * A quote that is not the FIRST character is an ordinary character
 * (`a"b` is the three-character word `a"b`). One rule, no lookahead, and
 * it means an apostrophe-heavy or measurement-heavy query cannot
 * accidentally open a phrase.
 */
function readValue(raw: string, start: number): { value: string; next: number; quoted: boolean } {
  if (raw[start] === '"') {
    let index = start + 1;
    while (index < raw.length && raw[index] !== '"') index += 1;
    const value = raw.slice(start + 1, index);
    // Step past the closing quote when there was one; stop at the end
    // when there was not.
    return { value, next: index < raw.length ? index + 1 : index, quoted: true };
  }

  let index = start;
  while (index < raw.length && !isSpace(raw[index]!) ) index += 1;
  return { value: raw.slice(start, index), next: index, quoted: false };
}

/**
 * Splits a query into tokens: whitespace separates, quotes group, a
 * leading `-` negates, and `word:` introduces an operator.
 *
 * `-` only negates when something follows it immediately, so a lone `-`
 * (or a `-` before a space) is an ordinary character. `word:` only
 * introduces an operator when `word` is all ASCII letters, which is what
 * keeps a colon inside real content — a URL, a time, `Re: something` —
 * from being read as syntax.
 */
function tokenize(raw: string): readonly RawToken[] {
  const tokens: RawToken[] = [];
  let index = 0;

  while (index < raw.length) {
    if (isSpace(raw[index]!)) {
      index += 1;
      continue;
    }

    let negated = false;
    if (raw[index] === '-' && index + 1 < raw.length && !isSpace(raw[index + 1]!)) {
      negated = true;
      index += 1;
    }

    let cursor = index;
    while (cursor < raw.length && /[A-Za-z]/.test(raw[cursor]!)) cursor += 1;

    let operator: string | null = null;
    if (cursor > index && raw[cursor] === ':') {
      operator = raw.slice(index, cursor).toLowerCase();
      index = cursor + 1;
    }

    const read = readValue(raw, index);
    index = read.next;
    tokens.push({ negated, operator, value: read.value, quoted: read.quoted });
  }

  return tokens;
}

/** What a token that could not be understood as an operator searches
 *  for: the characters the user typed, reassembled from the parts,
 *  quotes removed. `foo:bar` searches for "foo:bar"; `from:` searches
 *  for "from:". */
function literalText(token: RawToken): string {
  return token.operator === null ? token.value : `${token.operator}:${token.value}`;
}

function textTerm(token: RawToken, value: string): SearchTerm {
  return { kind: 'match', field: 'any', value, negated: token.negated };
}

/**
 * `YYYY-MM-DD` (or `YYYY/MM/DD`) to the UTC instant that day begins.
 *
 * **STRICT.** The three integers are put back through `Date.UTC` and
 * compared component by component, so `2026-02-30` and `2026-13-01` are
 * rejected rather than silently rolled over into March 2nd and January
 * 2027 — which is what `new Date('2026-02-30')` and every naive parser
 * would do, and is the sort of wrong answer nobody would ever notice.
 *
 * **UTC, not the server's zone.** `messages.date` is `timestamptz` and
 * this service has no configured timezone; UTC is the only boundary both
 * halves of the system already agree on. It also makes `before:X` and
 * `after:X` a partition of the timeline at exactly one instant, so the
 * two operators compose without a gap or an overlap.
 */
function parseDay(value: string): string | null {
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const at = new Date(Date.UTC(year, month - 1, day));
  if (
    at.getUTCFullYear() !== year ||
    at.getUTCMonth() !== month - 1 ||
    at.getUTCDate() !== day
  ) {
    return null;
  }
  return at.toISOString();
}

/**
 * `10mb` / `500k` / `1048576` to a byte count, or null.
 *
 * Integers only, and the result must be a SAFE integer: `larger:` with a
 * thirty-digit number would otherwise become a float, print in
 * exponential notation, and reach Postgres as something that is not a
 * bigint at all. Rejected here, it degrades to a literal search like
 * every other unparseable value.
 */
function parseSize(value: string): number | null {
  const match = /^(\d+)\s*([a-z]*)$/.exec(value.toLowerCase());
  if (match === null) return null;

  const unit = SIZE_UNITS[match[2]!];
  if (unit === undefined) return null;

  const bytes = Number(match[1]) * unit;
  if (!Number.isSafeInteger(bytes)) return null;
  return bytes;
}

/** The four operators that are a substring match against a fixed set of
 *  columns, mapped to the `MatchField` ./clause.ts resolves. */
const MATCH_OPERATORS: Readonly<Record<string, MatchField>> = {
  from: 'from',
  to: 'to',
  cc: 'cc',
  subject: 'subject',
};

/**
 * One token to one term, or to a literal text term when it cannot mean
 * anything else.
 *
 * Returns `null` ONLY for a genuinely contentless token — `""`, which
 * has nothing to search for and whose ILIKE pattern (`%%`) would
 * otherwise match the entire mailbox. That is the one case where
 * dropping is right, because keeping it would silently widen the search
 * to everything rather than narrow it.
 */
function classify(token: RawToken): SearchTerm | null {
  const { operator, value } = token;

  if (operator === null) {
    if (value === '') return null;
    return textTerm(token, value);
  }

  // An empty operator value is not an operator — see this file's header
  // on typing through `from:` on the way to `from:ada`.
  if (value === '') return textTerm(token, literalText(token));

  const field = MATCH_OPERATORS[operator];
  if (field !== undefined) return { kind: 'match', field, value, negated: token.negated };

  if (operator === 'is') {
    const flag = IS_VALUES[value.toLowerCase()];
    return flag === undefined
      ? textTerm(token, literalText(token))
      : { kind: 'flag', flag, negated: token.negated };
  }

  if (operator === 'has') {
    const flag = HAS_VALUES[value.toLowerCase()];
    return flag === undefined
      ? textTerm(token, literalText(token))
      : { kind: 'flag', flag, negated: token.negated };
  }

  if (operator === 'before' || operator === 'after') {
    const at = parseDay(value);
    return at === null
      ? textTerm(token, literalText(token))
      : { kind: 'date', bound: operator, at, negated: token.negated };
  }

  if (operator === 'larger' || operator === 'smaller') {
    const bytes = parseSize(value);
    return bytes === null
      ? textTerm(token, literalText(token))
      : { kind: 'size', bound: operator, bytes, negated: token.negated };
  }

  // An operator this grammar does not have. Searched for literally,
  // never dropped.
  return textTerm(token, literalText(token));
}

/**
 * A query string to the terms it means. **Terms combine with AND.**
 *
 * **`OR` IS NOT IMPLEMENTED, deliberately.** Gmail's `OR` is an infix
 * operator with precedence against the implicit AND, which drags in
 * grouping parentheses, a precedence climb and a second failure mode for
 * every malformed input — a real expression parser, for a box whose
 * every other feature is a filter that narrows. `-` negation IS
 * implemented, because it is a per-term modifier rather than a combiner:
 * it changes one term's clause and touches nothing about how terms join.
 *
 * A query that yields no terms at all (`""`, or only whitespace once the
 * caller's own trim is accounted for) falls back to ONE literal text
 * term over the whole raw query rather than to zero terms — because zero
 * terms means no WHERE clause, i.e. the entire mailbox, which is both
 * the wrong answer and the expensive one.
 */
export function parseSearchQuery(raw: string): readonly SearchTerm[] {
  const trimmed = raw.trim();
  if (trimmed === '') return [];

  const terms: SearchTerm[] = [];
  for (const token of tokenize(trimmed)) {
    const term = classify(token);
    if (term !== null) terms.push(term);
  }

  if (terms.length === 0) {
    return [{ kind: 'match', field: 'any', value: trimmed, negated: false }];
  }
  return terms;
}
