import { cachedDateTimeFormat } from '../displayLocale';
import type { InboxMessage, OpenEvent, OpensResponse } from '../api';
import { boundedToken, isDisplayable, readStateFor } from './ReadState';

/**
 * Pure formatting and derivation logic for the opens feed (rendered by
 * components/OpensFeed.tsx, shared since task V1 by OpensView.tsx — the
 * sidebar's Opens page — and OpensRail.tsx — the Inbox-adjacent rail;
 * named OpensRail.tsx before task 7.6 turned the rail into a page, then
 * OpensView.tsx before task V1 restored the rail alongside it), split out
 * the same way client/src/components/inboxDates.ts is split out of
 * InboxList.tsx — so it never imports React, which is what keeps it
 * testable at all (client/CLAUDE.md's standing constraint: no test in
 * this plan renders a component).
 *
 * `advanceOpensPoll` (bottom of this file) is the odd one out by subject
 * matter — poll-tick orchestration rather than display formatting — but
 * it earns its place here rather than a new file because it is a thin
 * wrapper around `deriveRailView`, already below, and keeping every pure
 * "given raw opens data, decide X" function in one cohesive module beats
 * splitting a single small function into its own file prematurely.
 *
 * Every function here is total: a malformed or out-of-range input
 * degrades to a safe value rather than throwing, the same discipline
 * client/src/components/inboxDates.ts applies to inbox timestamps — one
 * bad open event must not blank the whole feed.
 */

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * `HH:MM`, 24-hour, zero-padded, no seconds, no zone label — client/
 * DESIGN.md §5.3's exact meta-line examples ("14:06", "14:02", "11:48")
 * and §9's assumption that a single-user client never needs one.
 * `'en-GB'` is a formatting-locale choice only, not a claim about the
 * user's own locale: it is the shortest reliable way to get zero-padded
 * 24-hour digits without a hand-rolled pad. This is the ONE date in the
 * app that deliberately does NOT follow ../displayLocale.ts's
 * `DISPLAY_LOCALE`, and the reason is that DESIGN.md fixes the SHAPE
 * here rather than leaving it to preference: these times sit in a
 * narrow rail column beside a lag figure, where a variable-width
 * `2:06 PM` would ragged-edge a column of `14:06`s. A reader whose
 * locale is 12-hour still gets 24-hour digits here, on purpose.
 *
 * Cached rather than built per call for the reason ../displayLocale.ts's
 * `cachedDateTimeFormat` gives: the rail draws one of these per row.
 */
const CLOCK_24H_LOCALE = 'en-GB';
const CLOCK_24H_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
};

export function formatClockTime(epochMs: number): string {
  return cachedDateTimeFormat('clock24', CLOCK_24H_LOCALE, CLOCK_24H_OPTIONS).format(
    new Date(epochMs),
  );
}

/**
 * "4s after sending" / "2h 11m after sending" — client/DESIGN.md §5.3's
 * exact meta-line copy. `lagMs` is expected non-negative (an open cannot
 * occur before its send), but a negative value — clock skew between the
 * browser and the tracking service is a real possibility — degrades to
 * 0 rather than printing a nonsensical negative duration.
 */
export function formatLag(lagMs: number): string {
  const safeMs = Math.max(0, lagMs);
  const totalSeconds = Math.floor(safeMs / MS_PER_SECOND);
  if (totalSeconds < 60) return `${totalSeconds}s after sending`;

  const totalMinutes = Math.floor(safeMs / MS_PER_MINUTE);
  const totalHours = Math.floor(safeMs / MS_PER_HOUR);
  const totalDays = Math.floor(safeMs / MS_PER_DAY);

  if (totalDays > 0) {
    const hours = totalHours % 24;
    return hours > 0 ? `${totalDays}d ${hours}h after sending` : `${totalDays}d after sending`;
  }
  if (totalHours > 0) {
    const minutes = totalMinutes % 60;
    return minutes > 0 ? `${totalHours}h ${minutes}m after sending` : `${totalHours}h after sending`;
  }
  return `${totalMinutes}m after sending`;
}

/**
 * "5m ago" / "3h ago" / "2d ago" — the collapsed mobile rail strip's
 * relative time (client/DESIGN.md §4.3: "mark, headline, relative time").
 * Deliberately coarser than the expanded rail's meta line, which always
 * carries the absolute wall-clock time alongside it (DESIGN.md §9: a bare
 * "2h ago" is unverifiable on its own) — the strip is a one-line summary,
 * not the place that promise applies.
 */
export function formatRelativeTime(epochMs: number, now: number): string {
  const elapsed = Math.max(0, now - epochMs);
  if (elapsed < MS_PER_MINUTE) return 'just now';
  if (elapsed < MS_PER_HOUR) return `${Math.floor(elapsed / MS_PER_MINUTE)}m ago`;
  if (elapsed < MS_PER_DAY) return `${Math.floor(elapsed / MS_PER_HOUR)}h ago`;
  return `${Math.floor(elapsed / MS_PER_DAY)}d ago`;
}

/**
 * "1 view from you" / "3 views from you" — client/DESIGN.md §9's proposed
 * muted line, adopted by task-5-brief.md's Amendment 2 in place of hiding
 * `self` events outright ("silently dropping data is a small dishonesty
 * in a product about honesty"). Callers only render this when `count` is
 * greater than zero — zero self events means the line renders nothing,
 * not "0 views from you".
 */
export function formatSelfCountLine(count: number): string {
  return count === 1 ? '1 view from you' : `${count} views from you`;
}

/**
 * The self-count line's own visibility rule — `null` means "render
 * nothing", never the literal string "0 views from you". Pulled out of
 * OpensFeed.tsx's JSX conditional (task V1b) so the rule the component's
 * `SelfCount` now defers to is itself testable without rendering a
 * component (client/CLAUDE.md's standing constraint) — the same reason
 * every other display decision in this file (`describeEvent`,
 * `deriveRailView`, `formatOpenRowSentence` below) is a plain function
 * rather than inline JSX. `formatSelfCountLine` itself is untouched; this
 * only adds the "should it render at all" gate in front of it.
 */
export function selfCountLine(count: number): string | null {
  return count > 0 ? formatSelfCountLine(count) : null;
}

export interface EventCopy {
  readonly headline: string;
  readonly sub: string | null;
  readonly meta: string;
}

/**
 * Assembles one event's visible sentence and mono meta line.
 *
 * `recipientEmail` stands in for DESIGN.md §5.3's exact copy's "Kate Yu":
 * `OpenEvent` (client/src/api.ts) carries no display name, only the
 * address the tracking pixel was sent to, so the address is the only
 * identity this UI can honestly show — inventing a name from an email
 * local-part would be its own small overclaim in a product about
 * refusing those.
 *
 * `mpp` gets DESIGN.md §5.4's specific "permanent ceiling" copy rather
 * than §5.3's generic Unconfirmable sentence — DESIGN.md singles out MPP,
 * and only MPP, as a ceiling that will never resolve; prefetch and
 * scanner keep the generic sentence because DESIGN.md claims no such
 * permanence for them (see ReadState.tsx's `permanent` field, which this
 * branches on rather than re-checking the classification string here).
 */
export function describeEvent(event: OpenEvent): EventCopy {
  const state = readStateFor(event.classification);

  if (state.tone === 'confirmed') {
    const clock = formatClockTime(event.occurredAt);
    const lag = formatLag(event.occurredAt - event.sentAt);
    return { headline: `${event.recipientEmail} opened this.`, sub: null, meta: `${clock} · ${lag}` };
  }

  if (state.permanent) {
    return {
      headline: "Apple Mail. Opens can't be confirmed here.",
      sub: 'Not pending — this is the ceiling for this recipient.',
      meta: `${boundedToken(state.token)} · permanent`,
    };
  }

  const clock = formatClockTime(event.occurredAt);
  const lag = formatLag(event.occurredAt - event.sentAt);
  return {
    headline: 'Something fetched this. It was not a person.',
    sub: null,
    meta: `${clock} · ${lag} · ${boundedToken(state.token)}`,
  };
}

/**
 * The ENTIRE visible sentence for one row in the Superhuman/Mailspring
 * restyle (task V1b): `"{recipientEmail} opened "{subject}" · {relative
 * time}"`. This replaces `describeEvent` as what `OpensFeed.tsx` actually
 * renders — `describeEvent` itself is untouched (contract frozen; still
 * exercised by its own tests in this file), it is simply no longer read by
 * the component, per the task brief's explicit allowance for that.
 *
 * The user's own directive: "make it so I can see WHICH email gets opened
 * instead of just showing me things got opened... don't show the MPP mail
 * thing... Do it like superhuman or mailspring does it." Two consequences
 * fall out of that directly:
 *
 *   1. `subject` — never rendered before this task, even though
 *      `OpenEvent.subject` always carried it — is now the sentence's own
 *      "which email" fragment. Rendered quoted when present; when
 *      `event.subject` is `null`, the ENTIRE `"..."` fragment is
 *      omitted — never the literal text "null", never empty quotes. The
 *      trailing-space-then-quote construction below (`' "..."'` appended
 *      to `'opened'`, vs `''` appended) is what keeps a null subject from
 *      leaving a stray double space or a dangling quote mark behind.
 *
 *   2. This function takes NO classification-derived branch at all — it
 *      cannot special-case `mpp`/`prefetch`/`scanner` even by accident,
 *      because it never reads `event.classification` in the first place.
 *      That is what makes "an mpp row and an open row render the same
 *      sentence form" a structural guarantee rather than a convention two
 *      call sites have to remember to keep in sync: every displayable
 *      classification runs through this exact same code path. The one
 *      surviving distinction between them — the mark's tone and its
 *      hover-tooltip explanation — lives entirely in `<ReadState>`
 *      (ReadState.tsx), never here.
 *
 * `recipientEmail` and `subject` are both attacker-influenced (any sender
 * picks the recipient address their own tracking pixel points at, and
 * writes their own subject line), but this function only ever returns a
 * plain, unescaped string — never markup. `OpensFeed.tsx` interpolates the
 * result as a single JSX text child (`{formatOpenRowSentence(...)}`),
 * which React escapes on render; this module has no dependency on React
 * and could not call `dangerouslySetInnerHTML` even if something later
 * tried.
 */
export function formatOpenRowSentence(event: OpenEvent | GroupedOpen, now: number): string {
  const times = 'count' in event && event.count > 1 ? ` · ${formatOpenCount(event.count)}` : '';
  return `${formatOpenRowLead(event)}${times} · ${formatRelativeTime(event.occurredAt, now)}`;
}

/** "opened 6 times" — spoken form, for the row's accessible name. The visible
 *  row shows the same number as a compact `x6` beside the time, where it
 *  cannot be truncated away with the lead. */
export function formatOpenCount(count: number): string {
  return `opened ${count} times`;
}

/**
 * WHETHER THIS FETCH CAN BE PINNED ON THE RECIPIENT AT ALL.
 *
 * The user, about a message to their professor: *"The mail opens that get
 * detected are not from the email of my professor but just when I open the
 * email on gmail.com ... Only show the professors name when it is actually
 * the professor."*
 *
 * They are right, and the reason is structural. The service sends one copy
 * per recipient, each carrying that recipient's own pixel, and Gmail files
 * each of those in the sender's Sent folder. Opening your own Sent copy on
 * gmail.com therefore fetches the RECIPIENT's pixel, through the same
 * `GoogleImageProxy` the recipient's own read would use. Nothing in the hit
 * distinguishes them — classify.ts has documented this residual all along.
 *
 * **SO THE SPLIT IS ON WHETHER A DEVICE WAS REPORTED.** A proxy fetch
 * carries no platform information: measured across the live feed, every
 * `prefetch` and `mpp` hit and 7 of 16 `open` hits reported
 * `deviceClass: 'unknown'`. Those are the ambiguous ones — could be the
 * recipient, could be the sender re-reading their own Sent copy. A hit that
 * DID report a device came straight from a real client rather than a relay,
 * and is the recipient's by construction.
 *
 * Naming the recipient on an ambiguous hit is the specific falsehood being
 * removed here: it asserts a person read something when the evidence cannot
 * carry that. Naming them on an attributable hit is fine and stays.
 */
export function isAttributable(event: OpenEvent): boolean {
  return (
    event.classification === 'open' &&
    event.deviceClass !== null &&
    event.deviceClass !== undefined &&
    event.deviceClass !== 'unknown'
  );
}

/**
 * Which mail client did the fetching, as far as the hit can say.
 *
 * The relay that DESTROYS the device information is itself the client
 * fingerprint, which is why this is knowable when device class is not:
 * `GoogleImageProxy` means Gmail, Apple's contentless relay means Apple Mail
 * with Privacy Protection on, and a hit carrying a real platform came from
 * that platform's own client. Those three are exactly what classify.ts
 * already decides, so this reads the classification rather than adding a
 * second parser that could disagree with it.
 */
export function readerFor(event: OpenEvent): string {
  if (event.classification === 'prefetch') return 'Gmail image proxy';
  if (event.classification === 'mpp') return 'Apple Mail, Privacy Protection on';
  if (event.classification === 'scanner') return 'a security scanner';
  if (isAttributable(event)) {
    const os = event.os === null || event.os === undefined ? '' : `${event.os} `;
    return `${os}${event.deviceClass}`;
  }
  return 'a proxy that reported no device';
}

/**
 * The WHO-and-WHAT half of the sentence above, without the time.
 *
 * Exists because the rail is a 320px column and the row is one truncating
 * line: `recipient@example.com opened "Valen Mail end-to-end send test" ·
 * 2h ago` renders there as `recipient@example.com opened "…`, which
 * loses BOTH facts the row exists to carry. The recipient address is also
 * the least informative part — in this mailbox it is very nearly always
 * the same address — and it is first, so it eats the width that the
 * subject and the time needed.
 *
 * Splitting the sentence lets OpensFeed.tsx pin the time in its own
 * right-aligned column, where it cannot be truncated, and truncate only
 * this half. `formatOpenRowSentence` is now built FROM this rather than
 * beside it, so the two spellings of the same row cannot drift.
 *
 * Reads exactly `recipientEmail` and `subject` — never `deviceClass` or
 * `os` (see the note above and
 * tests/opens-rail-static-guards.test.ts) — and returns a plain string,
 * never markup.
 */
export function formatOpenRowLead(event: OpenEvent): string {
  const subjectFragment = event.subject !== null ? ` "${event.subject}"` : '';
  // The recipient is NAMED only when the hit can actually be pinned on them
  // — see `isAttributable`. Otherwise the row says what happened without
  // claiming who did it, because the alternative is telling the user their
  // professor read something when it may well have been their own Sent copy.
  if (!isAttributable(event)) return `${subjectFragment.trim() || 'A message'} was fetched`;
  return `${event.recipientEmail} opened${subjectFragment}`;
}

/** `expandedDetailFor`'s subject fallback when `event.subject` is `null` —
 *  the SAME copy components/MessageRow.tsx already uses for a missing
 *  inbox subject, so a reader who has seen one has seen the other,
 *  rather than a second convention for the same fact. */
const NO_SUBJECT_LABEL = '(no subject)';

/**
 * The four fields task V3's hover/keyboard-focus expansion (OpensFeed.tsx
 * `OpenEntry`) renders once a row is no longer collapsed to one truncated
 * line: the full recipient, the full subject, the absolute time the open
 * occurred, and the cause explanation that — before this task — lived
 * ONLY in `<ReadState>`'s `title` hover tooltip (ReadState.tsx), which is
 * unreachable by touch and unreliable for assistive tech. All four are
 * plain, pre-formatted strings, safe to render as a bare JSX text child.
 *
 * `absoluteTime` is `formatClockTime` — the SAME bare `HH:MM`, no-date,
 * no-zone format `describeEvent`'s confirmed branch and client/DESIGN.md
 * §5.3's own copy ("14:06 · 2h 11m after sending") already use for this
 * exact feed; this task did not invent a second absolute-time format.
 *
 * `cause` is `readStateFor(event.classification).title` verbatim — the
 * exact sentence the mark's `title` attribute already carries (task V1b:
 * "Apple Mail Privacy Protection downloads every image the moment mail
 * arrives…", "A fetch that matches no known prefetcher…", etc.),
 * promoted from hover-only to always-in-the-DOM-once-expanded text.
 *
 * **Never `deviceClass`/`os`, structurally, not by discipline.** This
 * function reads exactly `recipientEmail`, `subject`, `occurredAt` and
 * `classification` off `event` — nothing here ever evaluates either of
 * those two other fields, so an event carrying real values for either
 * (every event this app ever receives does) cannot leak them through
 * this function's result no matter what a future caller does with it.
 * tests/opens-rail-static-guards.test.ts's source scan backs
 * this with a mechanical check across the files that render open events;
 * this file's own tests (tests/opens-rail.test.ts) prove it directly by
 * feeding `deviceClass: 'iPhone'` in and asserting the string never
 * appears anywhere in the output — the non-vacuity that actually matters,
 * since a function that simply has no `deviceClass` FIELD in its return
 * type could still be lying if it silently folded the value into e.g.
 * `cause`.
 */
export interface ExpandedOpenDetail {
  readonly recipientEmail: string;
  readonly subject: string;
  readonly absoluteTime: string;
  readonly cause: string;  /**
   * Which client did the fetching, and whether the recipient can be named.
   *
   * The old version of this type deliberately had NO `deviceClass`/`os`
   * field, so leaking one was structurally impossible rather than a matter
   * of discipline — and that was right, because the measurement study found
   * device attribution 0-for-4 on real accounts and warned that a UI built
   * on it would read "unknown" almost always.
   *
   * What is exposed here is not that raw field. `reader` is a SENTENCE that
   * is honest in the unknown case ("a proxy that reported no device") rather
   * than a device string that pretends to know, and `isAttributable` is the
   * flag the row uses to decide whether naming the recipient is supportable
   * at all. The privacy property the old shape protected — never handing the
   * UI a raw platform string to render as fact — is intact.
   */
  readonly reader: string;
  readonly isAttributable: boolean;
}

export function expandedDetailFor(event: OpenEvent): ExpandedOpenDetail {
  return {
    recipientEmail: event.recipientEmail,
    subject: event.subject !== null ? event.subject : NO_SUBJECT_LABEL,
    absoluteTime: formatClockTime(event.occurredAt),
    cause: readStateFor(event.classification).title,
    reader: readerFor(event),
    isAttributable: isAttributable(event),
  };
}

/**
 * One recipient's copy of one message, plus how many times it registered.
 *
 * `count` is 1 for the ordinary case and only ever rendered above that.
 */
export interface GroupedOpen extends OpenEvent {
  readonly count: number;
}

export interface OpensPartition {
  readonly displayable: readonly GroupedOpen[];
  readonly selfCount: number;
}

/**
 * How long after a fetch another fetch of the same copy still counts as the
 * same reading.
 *
 * Measured against the live service, one copy produced fetches 14, 18, 19 and
 * 23 minutes after send, and another 14, 19, 23 and 50 minutes after. The
 * feed reported those as four and four separate reads. Nobody opens the same
 * email four times in nine minutes; Gmail's image proxy re-validating its
 * cache does, and so does a sender clicking around their own Sent folder.
 *
 * 30 minutes is chosen to sit above the largest observed intra-burst gap (27
 * minutes) and far below the gap to a genuinely separate return (22 hours in
 * the same data). It is a COALESCING window, so every error it makes is in
 * the direction of under-counting reads — which is the correct direction for
 * a number this app puts next to the word "opened".
 *
 * PROVISIONAL, like PREFETCH_WINDOW_MS in tracking/src/classify.ts and for
 * the same reason: two bursts is not a distribution. Revisit with more data.
 */
export const OPEN_EPISODE_GAP_MS = 30 * 60 * 1000;

/**
 * Collapses a copy's fetches into reading EPISODES.
 *
 * Consecutive fetches closer together than `OPEN_EPISODE_GAP_MS` are one
 * episode. `events` arrives newest-first, which is why the comparison walks
 * backwards through time.
 */
export function countEpisodes(events: readonly OpenEvent[]): number {
  if (events.length === 0) return 0;
  let episodes = 1;
  for (let i = 1; i < events.length; i += 1) {
    const newer = events[i - 1] as OpenEvent;
    const older = events[i] as OpenEvent;
    if (newer.occurredAt - older.occurredAt > OPEN_EPISODE_GAP_MS) episodes += 1;
  }
  return episodes;
}

/**
 * COLLAPSES REPEAT FETCHES OF THE SAME COPY INTO ONE ROW.
 *
 * The feed was a raw event log: every pixel fetch got its own row. Measured
 * against the live service, that meant 26 rows for 10 actual recipient-copies
 * — one message alone drew SIX rows spanning 22 hours. Read as a list, that
 * says six people-shaped events happened. Mostly it is Gmail's image proxy
 * re-fetching the same copy.
 *
 * **THE KEY IS THE TOKEN, and that is the point.** One token is minted per
 * recipient per message, so it identifies exactly "this person's copy of this
 * email" — which is the thing a reader means by "an open". Grouping by
 * message would merge two different recipients; grouping by recipient would
 * merge unrelated mail.
 *
 * **A CONFIRMED READ OUTRANKS EVERYTHING ELSE IN ITS GROUP.** If any fetch of
 * a copy was classified `open`, the row is an open — a machine prefetch
 * arriving later does not un-read a message a person read. Otherwise the row
 * takes the most recent classification, which is the honest answer when
 * nothing in the group was ever confirmed.
 *
 * **THE COUNT AND THE TIME BOTH DESCRIBE THAT WINNING CLASSIFICATION**, not
 * the group as a whole. A copy with one prefetch and five opens is "opened 5
 * times", most recently at the last of those five — saying six would count a
 * machine fetch as a read, which is exactly the overstatement this app's
 * three-tone vocabulary exists to avoid.
 */
export function groupOpens(events: readonly OpenEvent[]): readonly GroupedOpen[] {
  const byToken = new Map<string, OpenEvent[]>();
  for (const event of events) {
    const bucket = byToken.get(event.token);
    if (bucket === undefined) byToken.set(event.token, [event]);
    else bucket.push(event);
  }

  const rows: GroupedOpen[] = [];
  for (const bucket of byToken.values()) {
    const newestFirst = [...bucket].sort((a, b) => b.occurredAt - a.occurredAt);
    const confirmed = newestFirst.filter((event) => event.classification === 'open');
    const winning = confirmed.length > 0 ? confirmed : newestFirst;
    // `newestFirst` is never empty — a bucket exists only because something
    // was pushed into it — so the representative is always defined.
    const representative = winning[0] as OpenEvent;
    const classification = representative.classification;
    const matching = winning.filter((event) => event.classification === classification);
    rows.push({ ...representative, count: countEpisodes(matching) });
  }
  return rows.sort((a, b) => b.occurredAt - a.occurredAt);
}

/**
 * Splits raw events into what the rail renders (`displayable`) and what
 * it only counts (`selfCount`) — task-5-brief.md's Amendment 2: `self`
 * events never become a row, but they are never silently discarded
 * either.
 *
 * Sorted newest-first by `occurredAt` — "what the rail sorts and formats
 * by" (sync/src/api/opens.ts's own doc comment on the field) — rather
 * than trusting the wire order, the same boundary discipline
 * client/src/api.ts already applies to every other field on this
 * response. Never mutates `events`: sorts a shallow copy.
 */
export function partitionOpens(events: readonly OpenEvent[]): OpensPartition {
  const sorted = [...events].sort((a, b) => b.occurredAt - a.occurredAt);
  const displayable = groupOpens(sorted.filter((event) => isDisplayable(event.classification)));
  // Counted from the RAW events, not the grouped rows: "3 views from you" is
  // a count of views, and collapsing them first would report the number of
  // messages instead.
  const selfCount = sorted.length - sorted.filter((e) => isDisplayable(e.classification)).length;
  return { displayable, selfCount };
}

export type RailView =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly displayable: readonly GroupedOpen[]; readonly selfCount: number };

/**
 * The single seam that keeps "the tracking service could not be reached"
 * (`available: false`) from ever collapsing into "it answered and had
 * nothing" (`available: true`, `opens: []`) — both are an empty rail
 * otherwise, and client/DESIGN.md §7.3 requires the two to read as
 * visibly different things ("conflating them hides an outage").
 *
 * `available` alone decides the branch; the CONTENTS of `opens` are never
 * consulted to guess at availability. `client/src/api.ts`'s `getOpens`
 * already guarantees `opens` is empty whenever `available` is false, but
 * this function does not lean on that guarantee to draw the line — it
 * checks `available` first, unconditionally.
 */
export function deriveRailView(response: OpensResponse): RailView {
  if (!response.available) return { kind: 'unavailable' };
  const { displayable, selfCount } = partitionOpens(response.opens);
  return { kind: 'ready', displayable, selfCount };
}

/**
 * Result of one poll tick: the derived view, the live-region announcement
 * to fire (if any), and whether another retry should be scheduled.
 *
 * `liveMessage` is non-null on exactly the tick that FLIPS availability —
 * unavailable -> the "can't reach" sentence, or unavailable -> ready ->
 * the "reconnected" sentence — never on a tick that repeats the same
 * `kind` as the tick before it. That is what keeps a still-down tracking
 * service from re-announcing itself to a screen reader on every retry.
 */
export interface OpensPollTick {
  readonly view: RailView;
  readonly liveMessage: string | null;
  readonly shouldRetry: boolean;
}

/**
 * The pure state transition behind ONE poll tick — extracted (task V1,
 * the opens-rail-on-Inbox restore) out of the `useEffect` that used to
 * own this inline in OpensView.tsx, so useOpensFeed.ts's hook can be a
 * thin React wrapper around a framework-free function this file tests
 * directly, the same split every other pure derivation here already gets.
 *
 * `previousKind` is the LAST tick's `view.kind`, or `null` before the
 * first tick has ever run — matching the real hook's `useRef<RailView
 * ['kind'] | null>(null)` initial value, so the very first poll DOES
 * announce "can't reach the tracking service" if the service is already
 * down on first load (there is no earlier `kind` to compare against, so
 * `previousKind !== 'unavailable'` is true for `null` too). It is the
 * caller's job to thread this value across ticks — this function itself
 * is stateless and never mutates anything it is given.
 *
 * This is also the seam a "two pollers" regression would show up in: two
 * independent callers each starting from `previousKind: null` and
 * observing the SAME response will each independently decide to announce
 * the same transition — see tests/opens-poll.test.ts's single-poller
 * property test, which asserts that directly. Hoisting `useOpensFeed` to
 * App.tsx (one call site, shared by OpensView and OpensRail) rather than
 * letting each surface run its own poll loop is what keeps exactly one
 * `previousKind` thread alive for the process.
 */
export function advanceOpensPoll(
  previousKind: RailView['kind'] | null,
  response: OpensResponse,
): OpensPollTick {
  const view = deriveRailView(response);

  let liveMessage: string | null = null;
  if (view.kind === 'unavailable' && previousKind !== 'unavailable') {
    liveMessage = "Valen Mail can't reach the tracking service.";
  } else if (view.kind === 'ready' && previousKind === 'unavailable') {
    liveMessage = 'Tracking reconnected.';
  }

  return { view, liveMessage, shouldRetry: view.kind === 'unavailable' };
}

/**
 * Task V3, Ask 2. What clicking an open event resolves to: a message the
 * reader can open, or an explicit `not-found` — never a silent no-op, per
 * the task brief ("a dead click is the worst outcome").
 */
export type ResolvedOpenTarget =
  | { readonly kind: 'found'; readonly message: InboxMessage }
  | { readonly kind: 'not-found' };

/**
 * Strips the OPTIONAL RFC 5322 angle-bracket delimiters (`<…>`) a
 * Message-ID may or may not be wrapped in when this function sees it, so
 * `<test-1@postbox.local>` and `test-1@postbox.local` compare equal when
 * they name the same message.
 *
 * Not a defensive guess: verified against this app's own live data
 * (every open event on the account tested against, 11 of 11) that the
 * tracking service's `messageId` is stored WITHOUT the brackets, while
 * `InboxMessage.message_id` — parsed straight off the synced message's
 * actual `Message-ID:` header by sync's IMAP client — carries them, per
 * the header's own RFC 5322 syntax. An exact-string comparison between
 * the two therefore failed on 100% of real events before this function
 * normalised both sides here; see the task's own report for the numbers.
 * The brackets are RFC 5322 DELIMITER syntax, not part of the semantic
 * identifier, so stripping them before comparing is a normalisation of
 * two spellings of the same value, not a loosened/fuzzy match.
 */
export function bareMessageId(id: string): string {
  return id.replace(/^</, '').replace(/>$/, '');
}

/**
 * Whether a message row's RAW folder path names Sent. `InboxMessage`
 * only ever carries the raw IMAP folder string a row actually lives in
 * (api.ts's own header: "a verbatim mirror of Postgres columns"/wire
 * shape) — never the normalised `FolderId` id (`'sent'`) that only
 * exists as a REQUEST-side query parameter (`GET /api/inbox?folder=`).
 * Verified against this app's own live account: the raw value for a
 * Gmail Sent folder is `[Gmail]/Sent Mail`, which a bare `folder ===
 * 'sent'` comparison never matches — silently defeating step 2 of
 * `resolveOpenTarget`'s tie-break for every real Gmail account, not just
 * an edge case. A case-insensitive substring check is a heuristic, not a
 * guarantee (a folder someone genuinely named "Consent" would
 * false-positive), but it is what every provider's actual Sent path
 * observed so far (`[Gmail]/Sent Mail`) has in common, and getting this
 * tie-break wrong only means falling through to step 3's "first
 * candidate" rule — never a wrong ANSWER, just a less-preferred one.
 */
export function looksLikeSentFolder(folder: string): boolean {
  return folder.toLowerCase().includes('sent');
}

/**
 * Bridges an open event's `(accountId, messageId)` — `messageId` is the
 * RFC Message-ID of the mail the tracking pixel rode in — to the
 * `(accountId, folder, uid)` triple components/MessageView.tsx opens by.
 * There is no lookup endpoint (the task brief is explicit that one is a
 * different, backend lane): this searches only `loadedMessages`, the
 * rows this client has ALREADY fetched for some other reason this
 * session — see client/src/messageIndex.ts's `foldMessageIndex`, which is
 * what keeps that list from forgetting a row the moment its folder falls
 * out of view.
 *
 * Total and synchronous — no fetch, no loading state, no spinner that
 * could hang: given the exact same `loadedMessages`, this always answers
 * immediately, either `found` or `not-found`. The task brief's "no
 * spinner that never resolves" is satisfied structurally, not by careful
 * UI-layer discipline, because there is nothing here that could stay
 * pending.
 *
 * MULTIPLE CANDIDATES — more than one loaded row sharing the SAME
 * `messageId` — are an expected case this function must resolve
 * deterministically, not a bug to assume away: the identical RFC
 * Message-ID legitimately labels more than one loaded row when, say, the
 * user emailed themselves across two of their OWN synced accounts (the
 * same physical send lands as account A's Sent copy AND account B's
 * Inbox copy), or when Gmail's per-label UIDs put the same message under
 * both `inbox` and `starred`. The rule, applied in order:
 *
 *   1. Prefer a candidate whose `account_id` matches `event.accountId`.
 *      The tracking pixel is embedded in exactly ONE account's own copy
 *      of the message — the one that sent it — so this is the strongest
 *      signal available, and it is checked first.
 *   2. Within that narrowed set (or across ALL candidates, if none
 *      matched step 1 — a stale/wrong `accountId` must not make an
 *      otherwise-unambiguous message unreachable), prefer a candidate
 *      whose `folder` names Sent (see `looksLikeSentFolder` below — this
 *      client only ever sees a message row's RAW IMAP folder path, e.g.
 *      `[Gmail]/Sent Mail`, never the normalised `sent` id `?folder=`
 *      accepts on a REQUEST). A send-tracking pixel's own message
 *      overwhelmingly lives in Sent, never Inbox, which is exactly why
 *      Sent is called out in the task brief as "the likely folder for
 *      tracked sends."
 *   3. Still tied: the first remaining candidate, in `loadedMessages`
 *      order. Not expected to fire in practice, but a function that
 *      returns a value for every input needs a defined answer even for
 *      the case it does not expect — a documented, deterministic
 *      tie-break beats silently returning whichever the engine happened
 *      to iterate first for no stated reason.
 */
export function resolveOpenTarget(
  event: OpenEvent,
  loadedMessages: readonly InboxMessage[],
): ResolvedOpenTarget {
  const targetId = bareMessageId(event.messageId);
  const candidates = loadedMessages.filter(
    (message) => message.message_id !== null && bareMessageId(message.message_id) === targetId,
  );
  // Destructured, not indexed: tsconfig's `noUncheckedIndexedAccess`
  // types a bare `candidates[0]` as possibly `undefined` regardless of an
  // earlier `.length` check (TS does not narrow indexed access from a
  // separate length comparison) — checking the destructured binding
  // itself is what actually narrows it back to `InboxMessage`.
  const [firstCandidate] = candidates;
  if (firstCandidate === undefined) return { kind: 'not-found' };
  if (candidates.length === 1) return { kind: 'found', message: firstCandidate };

  const sameAccount = candidates.filter((message) => message.account_id === event.accountId);
  const pool = sameAccount.length > 0 ? sameAccount : candidates;
  const sentMatch = pool.find((message) => looksLikeSentFolder(message.folder));
  if (sentMatch !== undefined) return { kind: 'found', message: sentMatch };

  // `pool` is always non-empty here (it is `sameAccount`, already proven
  // non-empty, or `candidates`, proven to have at least 2 elements above)
  // — `?? firstCandidate` is an unreachable-in-practice type-safety floor,
  // not a real fallback path, and never a call to `pool[0]` unguarded.
  const [poolFirst] = pool;
  return { kind: 'found', message: poolFirst ?? firstCandidate };
}
