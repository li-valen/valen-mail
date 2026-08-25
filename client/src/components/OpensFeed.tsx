import { CloudOff, Radio, User } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import type { OpenEvent } from '../api';
import { Settle, railRowVariantsFor, scanNewEntries } from '../motion';
import type { MotionVariants } from '../motion';
import type { OpensLoadState } from '../useOpensFeed';
import { Card, CardHeader } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { ROW_FOCUS } from './MessageRow';
import { ReadState } from './ReadState';
import { expandedDetailFor, formatOpenRowSentence, selfCountLine } from './openEvents';

/**
 * The Recent Opens feed body, and the place the honesty requirement
 * lives: it renders a `RailView` (derived from `getOpens` by
 * `useOpensFeed.ts`) as a list, keeps `self` events out of it while
 * still counting them, and tells "the tracking service is unreachable"
 * apart from "it answered and nothing has come back" — those are
 * different facts and must never render identically.
 *
 * SHARED, since task V1 (the opens-rail-on-Inbox restore). Before this
 * task, this markup lived directly in OpensView.tsx, the only surface
 * that ever rendered it. The user's directive — "don't only have opens
 * as a tab. I liked the timeline sidebar thing on the inbox from
 * before" — brought back a second surface (OpensRail.tsx, beside the
 * Inbox at desktop widths) that needs the exact same read-state
 * semantics at a narrower width, so this file is the extraction:
 * OpensView.tsx and OpensRail.tsx both now render `<OpensFeed .../>`,
 * passing the SAME `useOpensFeed()` result — owned once by App.tsx, so
 * there is exactly one poller, not one per surface — down as props
 * rather than each fetching its own.
 *
 * `compact` is the one prop that changes the rendered markup: it drops
 * the outer `Card` border/shadow/rounded/bg chrome (the Inbox rail
 * already has its own `border-l` panel boundary — nesting a second
 * bordered card flush against it would double-frame the same content),
 * and nothing else. The header, the count `Badge`, the self-count line,
 * the unavailable/empty `EmptyState`s, and every row's read-state markup
 * are identical between the page and the rail — this is deliberately
 * NOT two components that happen to look similar; it is one component
 * with a two-value prop, per client/CLAUDE.md's DRY standing rule.
 *
 * tests/opens-rail-static-guards.test.ts scans this file's source (task
 * V1 added it to that test's SOURCE list, since this is now the file
 * that actually renders open events — OpensView.tsx and OpensRail.tsx
 * are both thin wrappers around it) for the same two hard bans it always
 * has: `deviceClass`/`os` never render, no checkmark-shaped icon.
 *
 * RESTYLED, task V1b, to the Superhuman/Mailspring convention. The user
 * reviewed the labelled/badged/details-and-summary-explained design this replaced
 * and directed, verbatim: "make it so I can see WHICH email gets opened
 * instead of just showing me things got opened... don't show the MPP mail
 * thing... i dont need any liek side notes. Do it like superhuman or
 * mailspring does it." Concretely: every row is now ONE always-visible
 * line — `[mark] {recipientEmail} opened "{subject}" · {relative time}` —
 * built by `formatOpenRowSentence` (openEvents.ts); the MPP/PREFETCH/
 * SCANNER token, the word "unconfirmable", the "· permanent" suffix, and
 * every details/summary disclosure is gone from the render tree entirely,
 * not hidden. The honesty model is NOT deleted — the classification
 * pipeline (`readStateFor`) and push notifications (confirmed-only,
 * untouched, out of this file's scope) are unchanged — it has one fewer
 * surviving visual channel: `<ReadState>`'s mark (colour + shape) plus its
 * `title` tooltip, the row's own text being byte-identical in form between
 * a confirmed and an unconfirmable event by construction. See OpenEntry's
 * own doc comment below for the full reasoning.
 *
 * TWO MORE INTERACTIONS, task V3, both on the SAME row and both the
 * user's own words: "When you hover over the opened ... it should expand
 * and show you the full thing. When you click on the recent open it
 * should open the email that was opened and there should be some icon
 * that tells you like oh this was opened by this person this device at
 * this time." (Device is measured, not guessed, to be unavailable —
 * Gmail's proxy strips it before the pixel request reaches this app —
 * and stays off the ban list below, not added to the render tree.) Each
 * row is now a real `<button>` (mirrors MessageRow.tsx's own row-as-
 * button precedent from Plan 6, down to reusing its exact `ROW_FOCUS`
 * ring): hover OR keyboard focus on it reveals a full-detail block below
 * the still-truncated summary line, and activating it (click, or
 * Enter/Space once focused) calls `onOpenEvent`, which App.tsx uses to
 * resolve the event to a message and open it — or, honestly, tell the
 * user it could not (`resolveOpenTarget`, openEvents.ts; the not-found
 * banner lives in App.tsx, the one place that already owns both the
 * loaded-message registry and the reader's `selected` state). See
 * OpenEntry's own doc comment below for the expansion mechanism and why
 * it was chosen over a popover.
 */

const SKELETON_ENTRY_COUNT = 4;

export interface OpensFeedProps {
  readonly load: OpensLoadState;
  readonly now: number;
  readonly liveMessage: string;
  /** True inside the Inbox rail (OpensRail.tsx); false (the default) on
   *  the full Opens page (OpensView.tsx). See the file doc comment above
   *  for exactly what this does, and does not, change. */
  readonly compact?: boolean;
  /** Activates one row (task V3, Ask 2) — click, or Enter/Space once
   *  focused. Required, not optional: as of this task a row IS a
   *  control, mirroring InboxList.tsx's `onOpenMessage` contract exactly
   *  ("a row with no destination is the defect ... exists to fix, and an
   *  optional handler would let a caller reintroduce it silently").
   *  Resolving the event to a message — or deciding it can't be — is the
   *  caller's job (App.tsx); this component only ever reports which
   *  event was activated. */
  readonly onOpenEvent: (event: OpenEvent) => void;
}

export default function OpensFeed({ load, now, liveMessage, compact = false, onOpenEvent }: OpensFeedProps) {
  return (
    <>
      <p className="sr-only" role="status" aria-live="polite">
        {liveMessage}
      </p>
      <OpensFeedBody load={load} now={now} compact={compact} onOpenEvent={onOpenEvent} />
    </>
  );
}

interface PanelProps {
  readonly compact: boolean;
  readonly busy?: boolean;
  readonly children: ReactNode;
}

/** The one place `compact` branches: `Card`'s border/shadow/rounded/bg
 *  chrome in the page, a plain unstyled wrapper in the rail. Everything
 *  passed as `children` is identical between the two call sites. */
function Panel({ compact, busy, children }: PanelProps) {
  if (compact) return <div aria-busy={busy}>{children}</div>;
  return <Card aria-busy={busy}>{children}</Card>;
}

interface OpensFeedBodyProps {
  readonly load: OpensLoadState;
  readonly now: number;
  readonly compact: boolean;
  readonly onOpenEvent: (event: OpenEvent) => void;
}

function OpensFeedBody({ load, now, compact, onOpenEvent }: OpensFeedBodyProps) {
  if (load.status === 'loading') {
    return (
      <Panel compact={compact} busy>
        <p className="sr-only" role="status">
          Loading opens…
        </p>
        <div className="divide-y divide-neutral-100 dark:divide-border" aria-hidden="true">
          {Array.from({ length: SKELETON_ENTRY_COUNT }, (_, index) => (
            <div key={index} className="flex items-center gap-3 px-4 py-2">
              <Skeleton className="h-2.5 w-2.5 shrink-0 rounded-full" />
              <Skeleton className="h-3 flex-1" />
            </div>
          ))}
        </div>
      </Panel>
    );
  }

  const { view } = load;

  // The two states below are the ones that must never collapse into each
  // other: "the service could not be reached" and "the service answered and
  // had nothing" are both an empty feed otherwise. Different icon, different
  // title, different explanation — deliberately not one shared empty state
  // with swapped copy, because conflating them hides an outage.
  if (view.kind === 'unavailable') {
    return (
      <Panel compact={compact}>
        <EmptyState
          icon={CloudOff}
          title="Postbox can't reach the tracking service."
          description="This feed is blank because nothing is being recorded, not because nothing happened. It fills in again once the connection returns."
        />
      </Panel>
    );
  }

  const { displayable, selfCount } = view;

  if (displayable.length === 0) {
    return (
      <div className="space-y-3">
        <SelfCount count={selfCount} />
        <Panel compact={compact}>
          <EmptyState
            icon={Radio}
            title="Nothing has come back yet."
            description="Marks appear here as they arrive. Most of what arrives will not be a person."
          />
        </Panel>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* self events are never a row, but never silently discarded either —
          zero self events render nothing here rather than "0 views from
          you". `SelfCount` itself owns that gate now (`selfCountLine`,
          openEvents.ts), so this call site does not repeat the `> 0`
          check. */}
      <SelfCount count={selfCount} />
      {/* PLAN 7 TASK 2 — the panel settles in ONCE, when the feed first
          resolves. Individual rows animate only when they are genuinely
          new; see OpenEntries below. */}
      <Settle>
        <Panel compact={compact}>
          <CardHeader className="flex-row items-center justify-between space-y-0 border-b border-neutral-200 dark:border-border p-4">
            {/* Plunk's CardTitle is a <div>; this needs to be a real heading
                so the opens feed sits under the shell's <h1> in the document
                outline, so it borrows the atom's classes rather than the atom. */}
            <h2 className="text-sm font-semibold leading-none tracking-tight text-neutral-900 dark:text-foreground">
              Recent opens
            </h2>
            <Badge variant="secondary" className="font-mono tabular-nums">
              {displayable.length}
            </Badge>
          </CardHeader>
          <OpenEntries displayable={displayable} now={now} onOpen={onOpenEvent} />
        </Panel>
      </Settle>
    </div>
  );
}

/**
 * Renders nothing (not an empty line, not "0 views from you") when
 * `count` is zero — `selfCountLine` (openEvents.ts) owns that gate; this
 * component just defers to it rather than re-checking `count > 0` itself,
 * so both call sites above can pass `selfCount` through unconditionally.
 */
function SelfCount({ count }: { readonly count: number }) {
  const line = selfCountLine(count);
  if (line === null) return null;
  return <p className="px-1 text-xs text-neutral-500 dark:text-muted-foreground">{line}</p>;
}

/**
 * The stable identity of one row, and the thing the whole
 * "don't re-animate on every poll" requirement rests on.
 *
 * NOT `event.token` alone: the same token legitimately appears more than
 * once (an mpp prefetch and a later real open on the same send), so
 * `token` by itself collides as a React key and would silently drop one
 * of the two rows. And NEVER the array index — the feed PREPENDS new
 * events, so every index shifts when one arrives and an index key would
 * report all fifty rows as new, forever.
 *
 * The three fields together are what the tracking service actually
 * identifies an event by, and they do not change between polls, which is
 * exactly the property `scanNewEntries` needs.
 */
function entryKey(event: OpenEvent): string {
  return `${event.token}:${event.occurredAt}:${event.classification}`;
}

interface OpenEntriesProps {
  readonly displayable: readonly OpenEvent[];
  readonly now: number;
  readonly onOpen: (event: OpenEvent) => void;
}

/**
 * The row list, and the one place in this app where "which of these is
 * NEW?" has to be answered before anything can animate.
 *
 * WHY IT IS ITS OWN COMPONENT. `OpensFeedBody` returns early for the
 * loading and unavailable states, so hooks cannot live there — they would
 * be called conditionally. Splitting the list out gives the hooks an
 * unconditional home and keeps the state machine above it readable.
 *
 * THE DEFECT THIS PREVENTS. src/useOpensFeed.ts refetches on a timer.
 * Every response is a fresh array of fresh objects, so `initial="hidden"`
 * applied unconditionally would replay the entrance on all fifty rows
 * every time the poll came back — a rail that twitches at the edge of
 * vision while the user is reading something else. `scanNewEntries`
 * (src/motion/newEntries.ts) is the pure half of the fix; the ref and the
 * effect below are the half React insists on owning.
 *
 * THE FIRST SCAN REPORTS NOTHING AS NEW, on purpose: the initial response
 * is fifty rows arriving at once, and fifty individual entrances is the
 * opposite of "only new rows animate". The `<Settle>` around the panel
 * covers that case with one entrance for the whole list.
 *
 * The ref is advanced in an EFFECT rather than during render, so a
 * StrictMode double-render cannot mark this pass's new rows as already
 * seen before they have had a chance to animate.
 */
function OpenEntries({ displayable, now, onOpen }: OpenEntriesProps) {
  const isReduced = useReducedMotion() ?? false;
  const keys = useMemo(() => displayable.map(entryKey), [displayable]);
  const seenRef = useRef<ReadonlySet<string> | null>(null);
  const scan = useMemo(() => scanNewEntries(seenRef.current, keys), [keys]);
  useEffect(() => {
    seenRef.current = scan.seen;
  }, [scan]);

  // Built once per render and shared by every row rather than rebuilt per
  // row: fifty identical variant objects is fifty allocations and fifty
  // reasons for `motion` to think a row's animation definition changed.
  const variants = railRowVariantsFor(isReduced);

  return (
    <ol className="divide-y divide-neutral-100 dark:divide-border">
      {displayable.map((event) => {
        const key = entryKey(event);
        return (
          <OpenEntry
            key={key}
            event={event}
            now={now}
            onOpen={onOpen}
            variants={variants}
            isNew={scan.newKeys.has(key)}
          />
        );
      })}
    </ol>
  );
}

interface OpenEntryProps {
  readonly event: OpenEvent;
  readonly now: number;
  readonly onOpen: (event: OpenEvent) => void;
  /** Built once by `OpenEntries` above and shared across every row. */
  readonly variants: MotionVariants;
  /** True only for a row this feed has never rendered before — see
   *  `OpenEntries`. False on the initial load, for every row. */
  readonly isNew: boolean;
}

/**
 * One event in the feed — task V1b (the Superhuman/Mailspring restyle)
 * collapsed this from a two-tier, details-and-summary-disclosing row (a dominant
 * two-line confirmed sentence; a collapsed one-line unconfirmable summary
 * with its explanation one tap away) to ONE always-visible, information-
 * dense line, identical in STRUCTURE for every displayable classification:
 *
 *   [mark] {recipientEmail} opened "{subject}" · {relative time}
 *
 * This is a deliberate, informed product decision, not a regression of the
 * honesty model. The user reviewed the labelled/badged/explained design
 * this replaced and asked, verbatim, to "see WHICH email gets opened
 * instead of just showing me things got opened... don't show the MPP mail
 * thing... i dont need any liek side notes. Do it like superhuman or
 * mailspring does it." The three-tone classification pipeline underneath
 * (`readStateFor`, ReadState.tsx) is completely unchanged; what changed is
 * which of its fields ever reach the screen as visible text.
 *
 * The MPP/PREFETCH/SCANNER token, the word "unconfirmable", the
 * "· permanent" suffix, and every explanation paragraph this row used to
 * reveal via details/summary are gone — not hidden, not collapsed, gone from
 * the render tree entirely. `describeEvent` (openEvents.ts) still exists
 * and is still tested — its `headline`/`sub`/`meta` strings are simply no
 * longer read by this component; `formatOpenRowSentence` is what this row
 * actually renders now. The one surviving visual distinction is
 * `<ReadState>`'s mark: green for confirmed, neutral for everything else,
 * with the per-cause explanation as a hover tooltip only (`title`,
 * ReadState.tsx) — this row's own text is byte-identical in FORM between
 * an `open` row and an `mpp` row, by construction:
 * `formatOpenRowSentence` never reads `event.classification` at all.
 *
 * `subject` (new here — the previous design never rendered it, even
 * though `OpenEvent.subject` always carried it) is the "which email" the
 * user asked for. Rendered quoted when present; when `event.subject` is
 * `null`, the whole `"..."` fragment is omitted by `formatOpenRowSentence`
 * — never the literal text "null", never empty quotes.
 *
 * NEVER a device or a location. `deviceClass` and `os` exist on
 * `OpenEvent` and are deliberately not read here or anywhere —
 * tests/opens-rail-static-guards.test.ts fails the build if they are.
 *
 * XSS: both `subject` and `recipientEmail` are attacker-influenced — any
 * sender picks the subject line and the address their own tracking pixel
 * points at. `formatOpenRowSentence` (openEvents.ts) returns a single
 * plain string built by template-literal concatenation, never markup, and
 * it is interpolated here as ONE JSX text child (`{...}`), which React
 * escapes by default; this file never touches `dangerouslySetInnerHTML`.
 *
 * TASK V3 makes this row do two more things, without touching a byte of
 * the summary line or the honesty model above — both additions live
 * ENTIRELY below/around it.
 *
 * **Ask 1 — hover/focus reveals the full thing.** MECHANISM CHOICE:
 * in-place expansion (a block that grows below the summary line), not a
 * positioned popover. The rail this renders inside (OpensRail.tsx) is a
 * fixed `w-80` (320px) column with its OWN `overflow-y-auto` scroll
 * container (`lg:max-h-[calc(100dvh-4rem)]`); a popover wide enough to
 * hold a full recipient address and subject would either need to escape
 * that scroller (a portal, `position: fixed`, manual viewport-collision
 * math, a close-on-scroll/outside-click handler) or clip against it —
 * real complexity bought for a narrow-column layout that an in-place
 * expansion never has to solve, since it only ever grows the row's OWN
 * height inside a `<ol>`/`<li>` list the scroller already knows how to
 * hold. It also composes for free with "keyboard focus does the same
 * thing", ask 1's second half: the trigger IS the row's own `<button>`,
 * so `:hover` and `:focus-visible` on that ONE element are both that
 * button's own pseudo-classes — no second focusable element, no
 * `aria-expanded`/`aria-controls` bookkeeping, nothing that can fall out
 * of sync with what is visually showing.
 *
 * IMPLEMENTATION: `group` on the button plus a `grid-rows-[0fr] ->
 * group-hover:grid-rows-[1fr] group-focus-visible:grid-rows-[1fr]` grid
 * on the detail wrapper — the standard CSS-only technique for animating
 * to an unknown content height without JS measurement (`0fr`/`1fr` are
 * grid track sizes, not lengths, so the browser can tween between them;
 * the `overflow-hidden` child inside is what actually clips while the
 * track is smaller than its content). `prefers-reduced-motion` is
 * satisfied by styles.css's EXISTING global floor (`*, ::before, ::after
 * { transition-duration: 0.01ms !important }`) — the same mechanism
 * every other transition in this app (the sidebar drawer, the theme
 * switch thumb, this row's own `hover:bg-neutral-50` fade) already relies
 * on, so this adds no per-component override; the state still changes
 * instantly for a viewer who asked for reduced motion, it just does not
 * animate getting there. Collapsed content stays in the DOM (never
 * `display:none`/`aria-hidden`) rather than being removed, so it is
 * already part of the button's accessible name for assistive tech
 * regardless of the CSS track size — a strict improvement over today's
 * `title`-only tooltip, which screen readers do not reliably expose at
 * all.
 *
 * What the expansion shows — full recipient, full subject, the absolute
 * time, and the cause explanation that used to live only in `title` —
 * is `expandedDetailFor(event)` (openEvents.ts), verbatim; this component
 * never re-derives or re-formats any of those four fields itself.
 *
 * **Ask 3 — who/when/cause, with an icon.** The SAME `expandedDetailFor`
 * result, laid out with a single `User` icon (lucide-react) marking the
 * recipient line — "this was opened by this person" — followed by the
 * subject, then a mono time+cause line. Device is the one fact the user
 * asked for that this deliberately omits: `deviceClass`/`os` are
 * measured, not assumed, to be unusable (Gmail's proxy strips them
 * before the pixel request reaches this app — every event ever recorded
 * carries `deviceClass: 'unknown'`, `os: null`), and a permanently-blank
 * "Device: unknown" row would be worse than no row at all, per the task
 * brief. `expandedDetailFor` cannot leak either field even by accident —
 * it never reads either one off `event` in the first place — and
 * `User` does not match tests/opens-rail-static-guards.test.ts's
 * checkmark-icon ban (it is a person glyph, not a check-adjacent one).
 *
 * **Ask 2 — click opens the message.** The row is now a real `<button>`
 * (mirrors MessageRow.tsx's row-as-button precedent, including its exact
 * `ROW_FOCUS` inset ring — these rows sit inside the SAME kind of
 * `overflow-hidden` `Card`/rail an outset ring would clip against).
 * `onOpen(event)` fires on click or Enter/Space; resolving that event to
 * an actual message — or deciding it can't be, and saying so — is
 * App.tsx's job (`resolveOpenTarget`, openEvents.ts), not this
 * component's: OpenEntry only ever reports WHICH event was activated.
 */
function OpenEntry({ event, now, onOpen, variants, isNew }: OpenEntryProps) {
  const detail = expandedDetailFor(event);
  return (
    // `initial={false}` — not `initial="hidden"` — for every row that is
    // not new: it tells `motion` to render straight at the finished state
    // with no animation at all, which is what keeps a poll from replaying
    // fifty entrances. A new row drops in from ABOVE (ROW_ENTER_PX is
    // negative, src/motion/tokens.ts) because new events are prepended to
    // the top of this list: it enters from the direction it came from.
    <motion.li variants={variants} initial={isNew ? 'hidden' : false} animate="visible">
      <button
        type="button"
        onClick={() => onOpen(event)}
        /* Pressed feedback matches MessageRow.tsx's exactly — a tint, not
           a scale, for the same reason: these are full-bleed rows in a
           divided list. See that file's note. */
        className={`group flex w-full items-start gap-3 px-4 py-2 text-left transition-colors hover:bg-neutral-50 active:bg-neutral-100 dark:hover:bg-accent dark:active:bg-accent ${ROW_FOCUS}`}
      >
        <span className="pt-0.5">
          <ReadState classification={event.classification} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-neutral-900 dark:text-foreground">
            {formatOpenRowSentence(event, now)}
          </span>
          {/* Collapsed to zero height by default; grows on hover OR
              keyboard focus of the button above (see this function's own
              doc comment for the grid-rows mechanism and why it was
              chosen over a popover). Never removed from the DOM, so it
              is already part of the button's accessible name for
              assistive tech even while visually collapsed. */}
          <span className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-150 ease-out group-hover:grid-rows-[1fr] group-focus-visible:grid-rows-[1fr]">
            <span className="overflow-hidden">
              <span className="flex items-start gap-1.5 pb-0.5 pt-1.5 text-xs text-neutral-500 dark:text-muted-foreground">
                <User
                  className="mt-0.5 h-3 w-3 shrink-0 text-neutral-400 dark:text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="min-w-0 space-y-0.5 break-words">
                  <span className="block text-neutral-900 dark:text-foreground">{detail.recipientEmail}</span>
                  <span className="block">{detail.subject}</span>
                  <span className="block font-mono">
                    {detail.absoluteTime} · {detail.cause}
                  </span>
                </span>
              </span>
            </span>
          </span>
        </span>
      </button>
    </motion.li>
  );
}
