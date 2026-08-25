import type { OpenEvent, OpensResponse } from '../api';
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
 * 24-hour digits out of `toLocaleTimeString` without a hand-rolled pad.
 */
export function formatClockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
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
export function formatOpenRowSentence(event: OpenEvent, now: number): string {
  const relativeTime = formatRelativeTime(event.occurredAt, now);
  const subjectFragment = event.subject !== null ? ` "${event.subject}"` : '';
  return `${event.recipientEmail} opened${subjectFragment} · ${relativeTime}`;
}

export interface OpensPartition {
  readonly displayable: readonly OpenEvent[];
  readonly selfCount: number;
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
  const displayable = sorted.filter((event) => isDisplayable(event.classification));
  const selfCount = sorted.length - displayable.length;
  return { displayable, selfCount };
}

export type RailView =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly displayable: readonly OpenEvent[]; readonly selfCount: number };

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
    liveMessage = "Postbox can't reach the tracking service.";
  } else if (view.kind === 'ready' && previousKind === 'unavailable') {
    liveMessage = 'Tracking reconnected.';
  }

  return { view, liveMessage, shouldRetry: view.kind === 'unavailable' };
}
