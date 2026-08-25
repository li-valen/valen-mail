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

/** The day-rule label (client/DESIGN.md §3.1/§4.2): weekday, month, day,
 *  and year, always — never a relative "Today"/"Yesterday", which would
 *  make the label depend on the current wall-clock time and turn this
 *  file's only exported grouping function into something that reads the
 *  clock despite taking no `now` parameter. */
function formatDayLabel(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
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
 */
export function groupByDay(messages: readonly InboxMessage[]): readonly DayGroup[] {
  const buckets = new Map<string, { readonly date: Date; readonly messages: InboxMessage[] }>();
  const dateless: InboxMessage[] = [];

  for (const message of messages) {
    const date = parseDate(message.date);
    if (!date) {
      dateless.push(message);
      continue;
    }
    const key = localDayKey(date);
    const existing = buckets.get(key);
    if (existing) {
      existing.messages.push(message);
    } else {
      buckets.set(key, { date, messages: [message] });
    }
  }

  const dayGroups: DayGroup[] = [...buckets.values()]
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .map((bucket) => ({ day: formatDayLabel(bucket.date), messages: bucket.messages }));

  if (dateless.length === 0) return dayGroups;
  return [...dayGroups, { day: NO_DATE_GROUP_LABEL, messages: dateless }];
}
