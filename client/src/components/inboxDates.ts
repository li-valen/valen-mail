import type { InboxMessage } from '../api';

/**
 * Pure date-grouping and timestamp-formatting logic for the chronological
 * inbox, split out of InboxList.tsx (which re-exports both functions) so
 * this file never imports React — client/CLAUDE.md's standing constraint
 * is that no test in this plan renders a component, so keeping this logic
 * framework-free is what makes it testable at all.
 *
 * Every function here is total. A null, empty, or unparseable `date` is
 * expected input — the API genuinely returns `null` for a message with no
 * `Date:` header (task-4-brief.md Amendment 3) — not a bug to throw on.
 * One malformed row must degrade in place, never blank the whole list.
 */

const EM_DASH = '—';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** "Within the last week" means the 6 calendar days before today, plus
 *  today itself (handled separately) — 7 days' worth of rows total. */
const RECENT_WEEKDAY_WINDOW_DAYS = 6;
const NO_DATE_GROUP_LABEL = 'No date';

/** Parses `iso` into a Date, or null for anything that is not a valid,
 *  parseable timestamp: `null`, `undefined`, empty string, or a string
 *  `Date` cannot make sense of. */
function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Midnight, in local time, for the calendar day `date` falls on — the
 *  unit every calendar-day comparison in this file is done in, so 11pm
 *  and 1am on the same day compare equal regardless of the hour. */
function localMidnight(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Whole calendar days between two local midnights: 0 for the same day,
 *  a positive number when `date` is earlier than `reference`. */
function calendarDaysBefore(reference: Date, date: Date): number {
  return Math.round((localMidnight(reference) - localMidnight(date)) / MS_PER_DAY);
}

/** `YYYY-MM-DD` in local time. A grouping key only — never rendered. */
function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Formats one message's timestamp for its row (task-4-brief.md, Step 3):
 * a clock time for today, a weekday inside the last 7 days, and a
 * `MMM D` date beyond that. Returns an em dash for null, empty, or
 * unparseable input rather than throwing (Amendment 3) — a message with
 * an unparseable `Date:` header is exactly the case that must not break
 * the list, so the whole body is defensive, not just the parse step.
 */
export function formatWhen(iso: string | null, now: Date): string {
  try {
    const date = parseDate(iso);
    if (!date) return EM_DASH;

    const daysAgo = calendarDaysBefore(now, date);
    if (daysAgo === 0) {
      return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }
    if (daysAgo >= 1 && daysAgo <= RECENT_WEEKDAY_WINDOW_DAYS) {
      return date.toLocaleDateString('en-US', { weekday: 'short' });
    }
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    // Belt-and-braces: no known input reaches this, but a formatter that
    // is allowed to throw is a formatter that can take the inbox down
    // with it for one weird `Date:` header. See the file doc comment.
    return EM_DASH;
  }
}

export interface DayGroup {
  readonly day: string;
  readonly messages: readonly InboxMessage[];
}

/**
 * The day-rule label (client/DESIGN.md's "Amendment 1: density &
 * ergonomics" — supersedes §3.1/§4.2's original "weekday, month, day,
 * year, always, never relative" rule). `Today` / `Yesterday`, else a
 * short `Mon, Aug 24` — every glyph in all three forms (letters, digits,
 * comma, space) is inside the Bricolage Grotesque `&text=` subset
 * `index.html` requests; a period or any other punctuation here would
 * silently fall back to the UI face instead of erroring, so nothing here
 * introduces one.
 *
 * Reads `now` explicitly rather than `new Date()` — the same reason
 * `formatWhen` takes it: every group label in one render agrees on what
 * "today" means, and this stays a pure, testable function. This is a
 * deliberate reversal of the ORIGINAL version's design (quoted in the
 * amendment's history), which took no `now` for exactly the purity
 * reason restated here; Amendment 1 judged relative labels worth the
 * `now` parameter this needs to stay pure while having them.
 */
function formatDayLabel(date: Date, now: Date): string {
  const daysAgo = calendarDaysBefore(now, date);
  if (daysAgo === 0) return 'Today';
  if (daysAgo === 1) return 'Yesterday';
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Buckets messages by local calendar day, newest day first. A message
 * with no date, or an unparseable one, cannot be placed on the timeline —
 * rather than dropping it, which would silently shrink the inbox, it goes
 * into one trailing group of its own so it stays visible
 * (task-4-brief.md, "What to build").
 *
 * Never mutates `messages`: every bucket holds a freshly built array, and
 * the only sort runs over an array of bucket entries derived from a Map,
 * never over the input array itself (project immutability rule).
 *
 * `now` (Amendment 1): threaded through to `formatDayLabel` so `Today`/
 * `Yesterday` resolve against the one "now" the whole render agrees on —
 * see that function's own comment. It affects label text only, never the
 * bucketing/ordering/dateless-handling logic below, which is unchanged
 * from the original version.
 */
export function groupByDay(messages: readonly InboxMessage[], now: Date): readonly DayGroup[] {
  return groupByDayOf(messages, (message) => message.date, now).map((group) => ({
    day: group.day,
    messages: group.items,
  }));
}

/** One day's worth of whatever the list is drawing — messages before Plan
 *  12, conversations after it. */
export interface DayGroupOf<T> {
  readonly day: string;
  readonly items: readonly T[];
}

/**
 * `groupByDay`, over anything that can name its own timestamp.
 *
 * Generalised (Plan 12) because the inbox list now draws CONVERSATIONS
 * rather than messages, and a conversation's place on the timeline is its
 * representative's date. The alternative — day-grouping the
 * representatives and then mapping each one back to its conversation —
 * would put the same lookup at every call site and make the two
 * groupings' orders a coincidence rather than a fact.
 *
 * Every rule this file already made is unchanged and is now made in ONE
 * place: newest day first, a NULL or unparseable timestamp goes into a
 * trailing group of its own rather than being dropped, `Today`/
 * `Yesterday` resolve against the caller's `now`, and nothing is mutated.
 * `groupByDay` is this function with `message.date`, so the message list
 * and the conversation list cannot drift apart.
 */
export function groupByDayOf<T>(
  items: readonly T[],
  dateOf: (item: T) => string | null,
  now: Date,
): readonly DayGroupOf<T>[] {
  const buckets = new Map<string, { readonly date: Date; readonly items: T[] }>();
  const dateless: T[] = [];

  for (const item of items) {
    const date = parseDate(dateOf(item));
    if (!date) {
      dateless.push(item);
      continue;
    }
    const key = localDayKey(date);
    const existing = buckets.get(key);
    if (existing) {
      existing.items.push(item);
    } else {
      buckets.set(key, { date, items: [item] });
    }
  }

  const dayGroups: DayGroupOf<T>[] = [...buckets.values()]
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .map((bucket) => ({ day: formatDayLabel(bucket.date, now), items: bucket.items }));

  if (dateless.length === 0) return dayGroups;
  return [...dayGroups, { day: NO_DATE_GROUP_LABEL, items: dateless }];
}

/**
 * The full timestamp for the reader's message header (components/
 * MessageView.tsx) — `Mon, Aug 24, 2026, 2:32 PM`.
 *
 * Deliberately NOT `formatWhen`'s output. A row is scanned in a list of
 * fifty, where `2:32 PM` is enough and a full date is noise; an OPEN
 * message is one thing being read on its own, where "Mon" alone is
 * ambiguous and the year matters for anything more than a week old. Two
 * jobs, two formatters, one shared parse.
 *
 * Same defensive contract as every other function in this file: a null,
 * empty, or unparseable timestamp is expected input and returns an em
 * dash. The explicit `'en-US'` locale matches `formatWhen`/
 * `formatDayLabel` and keeps the output independent of the machine's own
 * locale, which is what makes it testable at all.
 */
export function formatReceived(iso: string | null): string {
  try {
    const date = parseDate(iso);
    if (!date) return EM_DASH;
    return date.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return EM_DASH;
  }
}
