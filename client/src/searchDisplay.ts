/**
 * WHAT THE QUERY WAS UNDERSTOOD TO MEAN, for the user to read — and
 * NOTHING ELSE.
 *
 * **This module decides nothing.** It emits labels. The raw query string
 * is what goes on the wire (../src/searchQuery.ts builds the params from
 * it untouched), and sync/src/search/terms.ts is the only thing that
 * gives it meaning. Two parsers that can disagree is a bug generator, so
 * this one is confined to the one job where disagreement is cosmetic:
 * it exports no term type, nothing else in the client imports it, and
 * there is no path by which its output can change which messages come
 * back.
 *
 * **Why a second parser exists at all.** The chip has to render on the
 * keystroke — the box is debounced at 220 ms and the results banner is
 * up before any response — so the interpretation cannot come from the
 * server without lagging the thing it describes by a whole round trip.
 *
 * **What keeps the two honest.** The operator vocabulary below is pinned
 * against the server's own list by sync/tests/search-vocabulary.test.ts,
 * which reads both files: adding an operator to one and not the other
 * fails the suite. The TOKENISER is a deliberate transcription of the
 * server's (same quote handling, same `-` rule, same `word:` rule);
 * tests/search-display.test.ts covers the same edge cases the server's
 * tests do, case for case.
 *
 * **The display rule, and it is the user's own standing direction
 * ("i dont need any liek side notes"):** a query with no operators shows
 * NOTHING extra — the banner already echoes what was typed, and a chip
 * reading `invoice` next to a banner reading `invoice` is noise. The
 * line appears only once the user reaches for the vocabulary.
 */

/**
 * The ten operators, mirroring sync/src/search/terms.ts's
 * SEARCH_OPERATORS in the same order.
 */
export const DISPLAY_OPERATORS = [
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

const OPERATOR_SET: ReadonlySet<string> = new Set(DISPLAY_OPERATORS);

/**
 * How many chips are drawn before the rest become a count.
 *
 * The server caps `q` at 200 characters, which is room for roughly a
 * hundred single-letter terms — a line of a hundred chips is a layout
 * defect at 375 px and tells the user nothing they could read. Only the
 * DISPLAY is truncated; the search still runs on every term.
 */
export const MAX_CHIPS = 8;

export interface QueryChip {
  readonly label: string;
  /** `operator` when the token used one of the ten names AND its value
   *  parsed; `text` for a bare word, a phrase, and for anything that
   *  degraded to a literal search. The distinction is the entire signal
   *  that `before:yesterday` is being searched for as characters rather
   *  than applied as a date filter — shown by drawing the two
   *  differently, not by explaining it. */
  readonly kind: 'operator' | 'text';
}

export interface SearchInterpretation {
  readonly chips: readonly QueryChip[];
  /** Terms beyond MAX_CHIPS, for a trailing "+N". */
  readonly overflow: number;
  /** Whether the line is worth drawing at all: true once the query uses
   *  one of the ten operator NAMES, whether or not its value parsed. */
  readonly isInterpreted: boolean;
}

const FLAG_LABELS: Readonly<Record<string, { readonly yes: string; readonly no: string }>> = {
  unread: { yes: 'Unread', no: 'Not unread' },
  read: { yes: 'Read', no: 'Not read' },
  starred: { yes: 'Starred', no: 'Not starred' },
};

const HAS_LABELS: Readonly<Record<string, { readonly yes: string; readonly no: string }>> = {
  attachment: { yes: 'Has attachment', no: 'No attachment' },
  attachments: { yes: 'Has attachment', no: 'No attachment' },
};

/** The four substring operators and the word that reads best in front of
 *  their value. */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  from: 'From',
  to: 'To',
  cc: 'Cc',
  subject: 'Subject',
};

const BOUND_LABELS: Readonly<Record<string, string>> = {
  before: 'Before',
  after: 'After',
  larger: 'Larger than',
  smaller: 'Smaller than',
};

interface RawToken {
  readonly negated: boolean;
  readonly operator: string | null;
  readonly value: string;
  readonly quoted: boolean;
}

function isSpace(char: string): boolean {
  return /\s/.test(char);
}

/** Transcribed from sync/src/search/terms.ts's `readValue`: an
 *  unterminated quote runs to the end of the string, and a quote that is
 *  not the first character is an ordinary character. */
function readValue(raw: string, start: number): { value: string; next: number; quoted: boolean } {
  if (raw[start] === '"') {
    let index = start + 1;
    while (index < raw.length && raw[index] !== '"') index += 1;
    const value = raw.slice(start + 1, index);
    return { value, next: index < raw.length ? index + 1 : index, quoted: true };
  }

  let index = start;
  while (index < raw.length && !isSpace(raw[index]!)) index += 1;
  return { value: raw.slice(start, index), next: index, quoted: false };
}

/** Transcribed from sync/src/search/terms.ts's `tokenize`. */
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

/** Whether a `before:`/`after:` value is a day the server would accept.
 *  Same shape and same strictness — a rolled-over `2026-02-30` is not a
 *  date filter there, so it must not be drawn as one here. */
function isDay(value: string): boolean {
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value);
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const at = new Date(Date.UTC(year, month - 1, day));
  return (
    at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day
  );
}

/** Whether a `larger:`/`smaller:` value is a size the server would
 *  accept. */
function isSize(value: string): boolean {
  return /^\d+\s*(b|kb?|mb?|gb?)?$/i.test(value);
}

/** Applies `-` to a label built for the positive case. The flag labels
 *  above carry their own negative wording, because "Not has attachment"
 *  is not English. */
function notLabel(label: string): string {
  return `Not ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

/**
 * What a token searches for when it could not be an operator: the
 * characters as typed, quotes REMOVED — matching the server's own
 * `literalText`.
 *
 * The label carries no quotes of its own, and that is a fix rather than
 * an omission: this used to re-add a `"…"` around a phrase so the user
 * could see its spaces were one term, and the renderer wraps every text
 * chip in `“…”` too — so `"security alert"` drew as `““security alert””`.
 * Found in the browser; the unit test had simply agreed with the label.
 * The chip's own boundary is what says "one term" — `“security alert”`
 * is one chip where two bare words are two — so the renderer's quotes
 * are enough and are the only ones.
 */
function literalText(token: RawToken): string {
  return token.operator === null ? token.value : `${token.operator}:${token.value}`;
}

function textChip(token: RawToken): QueryChip {
  const text = literalText(token);
  return { label: token.negated ? notLabel(text) : text, kind: 'text' };
}

function operatorChip(label: string, negated: boolean): QueryChip {
  return { label: negated ? notLabel(label) : label, kind: 'operator' };
}

function chipFor(token: RawToken): QueryChip | null {
  const { operator, value } = token;

  if (operator === null) return value === '' ? null : textChip(token);
  if (value === '') return textChip(token);

  const field = FIELD_LABELS[operator];
  if (field !== undefined) return operatorChip(`${field} ${value}`, token.negated);

  if (operator === 'is') {
    const labels = FLAG_LABELS[value.toLowerCase()];
    if (labels === undefined) return textChip(token);
    return { label: token.negated ? labels.no : labels.yes, kind: 'operator' };
  }

  if (operator === 'has') {
    const labels = HAS_LABELS[value.toLowerCase()];
    if (labels === undefined) return textChip(token);
    return { label: token.negated ? labels.no : labels.yes, kind: 'operator' };
  }

  if (operator === 'before' || operator === 'after') {
    if (!isDay(value)) return textChip(token);
    return operatorChip(`${BOUND_LABELS[operator]} ${value}`, token.negated);
  }

  if (operator === 'larger' || operator === 'smaller') {
    if (!isSize(value)) return textChip(token);
    return operatorChip(`${BOUND_LABELS[operator]} ${value}`, token.negated);
  }

  return textChip(token);
}

/**
 * A query to the line under the results banner.
 *
 * Returns `isInterpreted: false` — the "draw nothing" answer — for a
 * query that uses none of the ten operator names, which is every query
 * this app answered before operators existed.
 */
export function describeSearchQuery(raw: string): SearchInterpretation {
  const tokens = tokenize(raw.trim());

  const chips: QueryChip[] = [];
  let isInterpreted = false;

  for (const token of tokens) {
    if (token.operator !== null && OPERATOR_SET.has(token.operator)) isInterpreted = true;
    const chip = chipFor(token);
    if (chip !== null) chips.push(chip);
  }

  return {
    chips: chips.slice(0, MAX_CHIPS),
    overflow: Math.max(0, chips.length - MAX_CHIPS),
    isInterpreted,
  };
}
