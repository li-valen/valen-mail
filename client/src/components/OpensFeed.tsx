import { ChevronDown, CloudOff, Radio } from 'lucide-react';
import type { ReactNode } from 'react';
import type { OpenEvent } from '../api';
import type { OpensLoadState } from '../useOpensFeed';
import { Card, CardHeader } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { ReadState, readStateFor } from './ReadState';
import { describeEvent, formatRelativeTime, formatSelfCountLine } from './openEvents';

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
}

export default function OpensFeed({ load, now, liveMessage, compact = false }: OpensFeedProps) {
  return (
    <>
      <p className="sr-only" role="status" aria-live="polite">
        {liveMessage}
      </p>
      <OpensFeedBody load={load} now={now} compact={compact} />
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
}

function OpensFeedBody({ load, now, compact }: OpensFeedBodyProps) {
  if (load.status === 'loading') {
    return (
      <Panel compact={compact} busy>
        <p className="sr-only" role="status">
          Loading opens…
        </p>
        <div className="divide-y divide-neutral-100" aria-hidden="true">
          {Array.from({ length: SKELETON_ENTRY_COUNT }, (_, index) => (
            <div key={index} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="h-5 w-16 shrink-0 rounded-full" />
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
        {selfCount > 0 && <SelfCount count={selfCount} />}
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
          you". */}
      {selfCount > 0 && <SelfCount count={selfCount} />}
      <Panel compact={compact}>
        <CardHeader className="flex-row items-center justify-between space-y-0 border-b border-neutral-200 p-4">
          {/* Plunk's CardTitle is a <div>; this needs to be a real heading
              so the opens feed sits under the shell's <h1> in the document
              outline, so it borrows the atom's classes rather than the atom. */}
          <h2 className="text-sm font-semibold leading-none tracking-tight text-neutral-900">
            Recent opens
          </h2>
          <Badge variant="secondary" className="font-mono tabular-nums">
            {displayable.length}
          </Badge>
        </CardHeader>
        <ol className="divide-y divide-neutral-100">
          {displayable.map((event) => (
            // NOT `event.token` alone: the same token legitimately appears
            // more than once (e.g. an mpp prefetch and a later real open on
            // the same send), so `token` by itself collides as a React key
            // and would silently drop one of the two rows.
            <OpenEntry
              key={`${event.token}:${event.occurredAt}:${event.classification}`}
              event={event}
              now={now}
            />
          ))}
        </ol>
      </Panel>
    </div>
  );
}

function SelfCount({ count }: { readonly count: number }) {
  return <p className="px-1 text-xs text-neutral-500">{formatSelfCountLine(count)}</p>;
}

interface OpenEntryProps {
  readonly event: OpenEvent;
  readonly now: number;
}

/**
 * One event in the feed, with the classification's full explanatory note
 * revealed on demand via `<details>/<summary>`.
 *
 * A **confirmed** row keeps two visible lines (who + time · lag) —
 * confirmed is rare and valuable, and stays visually dominant. An
 * **unconfirmable** row (mpp/prefetch/scanner) collapses to ONE visible
 * line — badge, relative time, plus a compact `· permanent` suffix for mpp
 * (the ceiling fact must stay visible, not buried) — because four
 * consecutive MPP events would otherwise repeat the same three-line
 * explanation four times. The distinct per-cause explanation
 * (`state.title`), the ceiling copy (`copy.headline`/`copy.sub`), and the
 * absolute clock/lag meta (`copy.meta`) all still exist — they live in the
 * `<details>` note, closed by default, one tap or click away. Nothing is
 * deleted, only relocated.
 *
 * `<details>/<summary>` rather than a floating popover: it is a native
 * disclosure widget with keyboard support and expanded/collapsed state
 * built in, it works identically on a phone, and it pushes the following
 * rows down in normal flow instead of needing to escape a scroll
 * container.
 *
 * NEVER a device or a location. `deviceClass` and `os` exist on
 * `OpenEvent` and are deliberately not read here or anywhere —
 * tests/opens-rail-static-guards.test.ts fails the build if they are.
 *
 * XSS: `subject` is never rendered at all. `recipientEmail` is
 * attacker-influenced — any sender picks the address their own tracking
 * pixel points at — and is only ever interpolated as JSX text (via
 * `describeEvent`'s returned string), which React escapes by default; this
 * file never touches `dangerouslySetInnerHTML`.
 */
function OpenEntry({ event, now }: OpenEntryProps) {
  const state = readStateFor(event.classification);
  const copy = describeEvent(event);
  const isConfirmed = state.tone === 'confirmed';

  return (
    <li className="transition-colors hover:bg-neutral-50">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
          <ReadState classification={event.classification} />
          {isConfirmed ? (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-neutral-900">{copy.headline}</span>
              <span className="block truncate font-mono text-xs text-neutral-500">{copy.meta}</span>
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-500">
              {formatRelativeTime(event.occurredAt, now)}
              {state.permanent ? ' · permanent' : ''}
            </span>
          )}
          <ChevronDown
            className="h-4 w-4 shrink-0 text-neutral-400 transition-transform duration-200 group-open:rotate-180"
            aria-hidden="true"
          />
        </summary>
        <div className="space-y-1 px-4 pb-3 text-sm leading-relaxed text-neutral-600 sm:pl-[4.5rem]">
          {isConfirmed ? (
            <p>{state.title}</p>
          ) : (
            <>
              <p className="text-neutral-900">{copy.headline}</p>
              {copy.sub !== null && <p>{copy.sub}</p>}
              <p>{state.title}</p>
              <p className="font-mono text-xs text-neutral-500">{copy.meta}</p>
            </>
          )}
        </div>
      </details>
    </li>
  );
}
