import { useEffect, useRef, useState } from 'react';
import { ChevronDown, CloudOff, Radio } from 'lucide-react';
import { getOpens } from '../api';
import type { OpenEvent } from '../api';
import { Card, CardHeader } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { ReadState, readStateFor } from './ReadState';
import { describeEvent, formatRelativeTime, formatSelfCountLine, deriveRailView } from './openEvents';
import type { RailView } from './openEvents';

/**
 * The Recent Opens view, and the place the honesty requirement lives: it
 * renders `getOpens` as a feed, keeps `self` events out of the list while
 * still counting them, and tells "the tracking service is unreachable"
 * apart from "it answered and nothing has come back" — those are different
 * facts and must never render identically.
 *
 * WAS A RAIL, IS NOW A PAGE (Plunk restyle). Plunk's shell
 * (`apps/web/src/components/DashboardLayout.tsx`) is a sidebar plus ONE
 * content column; a third column exists nowhere in its layout language and
 * would have had to be invented, then re-invented again for phone widths.
 * Plunk's own analogue for a live event feed is a nav destination —
 * `apps/web/src/pages/activity/index.tsx` — so Opens became a nav
 * destination too. That deletes the 1080px collapsed strip and the
 * `<dialog>` bottom sheet outright: the sidebar drawer already solves
 * mobile, and the same feed renders at every width.
 *
 * Consequence worth naming: polling now runs only while this view is on
 * screen, where the always-mounted rail polled continuously. The
 * unreachable/reconnected announcements below are therefore scoped to
 * someone actually looking at the opens feed.
 *
 * Composition ported from Plunk (AGPL-3.0): the `Card` + `CardHeader` +
 * `divide-y divide-neutral-100` feed of `apps/web/src/pages/activity/`,
 * and the `EmptyState` molecule.
 */

const OPENS_LIMIT = 50;
const SKELETON_ENTRY_COUNT = 4;

/**
 * How long to wait before quietly trying the tracking service again after
 * it reports unavailable. Deliberately never surfaced in any copy this
 * file renders: naming a retry cadence in the UI is a promise that has to
 * stay true as this number changes, and it would be the one piece of copy
 * in Postbox that overclaims. The feed "fills in on reconnect" by polling
 * silently, not by asking the user to do anything or telling them when it
 * will try next.
 */
const UNAVAILABLE_RETRY_MS = 30_000;

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly view: RailView };

export default function OpensView() {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [liveMessage, setLiveMessage] = useState('');
  // Resolved once per mount, same reasoning as InboxList's own `now`: the
  // relative times ("5m ago") should not silently creep forward while the
  // tab sits open in the background for hours.
  const [now] = useState(() => Date.now());
  const previousKindRef = useRef<RailView['kind'] | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    function poll() {
      // getOpens (client/src/api.ts) never rejects — every failure mode
      // already degrades to { opens: [], available: false } inside it,
      // so there is deliberately no .catch() here to swallow.
      getOpens(OPENS_LIMIT).then((response) => {
        if (cancelled) return;
        const view = deriveRailView(response);

        // Announce the transition into/out of unavailable once, not on
        // every still-unavailable retry.
        const previousKind = previousKindRef.current;
        if (view.kind === 'unavailable' && previousKind !== 'unavailable') {
          setLiveMessage("Postbox can't reach the tracking service.");
        } else if (view.kind === 'ready' && previousKind === 'unavailable') {
          setLiveMessage('Tracking reconnected.');
        }
        previousKindRef.current = view.kind;

        setLoad({ status: 'loaded', view });
        if (view.kind === 'unavailable') {
          retryTimer = setTimeout(poll, UNAVAILABLE_RETRY_MS);
        }
      });
    }

    poll();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, []);

  return (
    <>
      <p className="sr-only" role="status" aria-live="polite">
        {liveMessage}
      </p>
      <OpensBody load={load} now={now} />
    </>
  );
}

interface OpensBodyProps {
  readonly load: LoadState;
  readonly now: number;
}

function OpensBody({ load, now }: OpensBodyProps) {
  if (load.status === 'loading') {
    return (
      <Card aria-busy="true">
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
      </Card>
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
      <Card>
        <EmptyState
          icon={CloudOff}
          title="Postbox can't reach the tracking service."
          description="This feed is blank because nothing is being recorded, not because nothing happened. It fills in again once the connection returns."
        />
      </Card>
    );
  }

  const { displayable, selfCount } = view;

  if (displayable.length === 0) {
    return (
      <div className="space-y-3">
        {selfCount > 0 && <SelfCount count={selfCount} />}
        <Card>
          <EmptyState
            icon={Radio}
            title="Nothing has come back yet."
            description="Marks appear here as they arrive. Most of what arrives will not be a person."
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* self events are never a row, but never silently discarded either —
          zero self events render nothing here rather than "0 views from
          you". */}
      {selfCount > 0 && <SelfCount count={selfCount} />}
      <Card>
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
      </Card>
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
