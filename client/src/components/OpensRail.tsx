import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { getOpens } from '../api';
import type { OpenEvent } from '../api';
import { ReadState, readStateFor } from './ReadState';
import { describeEvent, formatRelativeTime, formatSelfCountLine, deriveRailView } from './openEvents';
import type { RailView } from './openEvents';
import './OpensRail.css';

/**
 * The Recent Opens rail (client/DESIGN.md §6 components #13 OpensRail,
 * #14 RailStrip, #15 RailSheet) and the place task-5-brief.md's honesty
 * requirement lives: it renders `getOpens` (Task 3) as marks on the time
 * spine, keeps `self` events out of the list while still counting them
 * (Amendment 2), and tells "the tracking service is unreachable" apart
 * from "it answered and nothing has come back" (Amendment 3, DESIGN.md
 * §7.3) — those are different facts and must never render identically.
 *
 * Owns its own fetch. Renders three things every mount, in a Fragment,
 * so all three read the SAME response rather than each fetching its own:
 * the always-visible desktop `<aside class="rail">` (client/App.tsx used
 * to render this directly; it now renders `<OpensRail />` instead, which
 * is the one place `grid-area: rail` is claimed), the collapsed mobile
 * `<button class="rail-strip">` (client/src/shell.css's own comment:
 * "The strip itself is rendered by Task 5" — DESIGN.md §4.3: the rail
 * "collapses, it does not disappear"), and the `<dialog class="rail-
 * sheet">` the strip opens. CSS alone decides which of the aside/strip
 * is visible at a given width (client/src/shell.css's existing
 * `@media (max-width: 1079px) { .rail { display: none } }`, mirrored by
 * OpensRail.css's `.rail-strip { display: none }` above that width) — the
 * strip is simply unreachable to a pointer/keyboard user on a desktop
 * layout, so the sheet it opens never has a way to appear there either.
 */

const RAIL_LIMIT = 50;
const SKELETON_ENTRY_COUNT = 4;

/**
 * How long to wait before quietly trying the tracking service again
 * after it reports unavailable. Deliberately never surfaced in any copy
 * this file renders — task-5-brief.md's Amendment 3: naming a retry
 * cadence in the UI is a promise that has to stay true as this number
 * changes, and it would be the one piece of copy in Postbox that
 * overclaims. The rail "fills in on reconnect" by polling silently, not
 * by asking the user to do anything or telling them when it will try
 * next.
 */
const UNAVAILABLE_RETRY_MS = 30_000;

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly view: RailView };

export default function OpensRail() {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [liveMessage, setLiveMessage] = useState('');
  const [isSheetOpen, setSheetOpen] = useState(false);
  // Resolved once per mount, same reasoning as InboxList.tsx's own `now`:
  // the mobile strip's relative time ("5m ago") should not silently
  // creep forward while the tab sits open in the background for hours.
  const [now] = useState(() => Date.now());
  const previousKindRef = useRef<RailView['kind'] | null>(null);
  const sheetRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    function poll() {
      // getOpens (client/src/api.ts) never rejects — every failure mode
      // already degrades to { opens: [], available: false } inside it,
      // so there is deliberately no .catch() here to swallow.
      getOpens(RAIL_LIMIT).then((response) => {
        if (cancelled) return;
        const view = deriveRailView(response);

        // Announce the transition into/out of unavailable once, not on
        // every still-unavailable retry (client/DESIGN.md §7.3: "Do not
        // toast it repeatedly on retry").
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

  useEffect(() => {
    const dialog = sheetRef.current;
    if (dialog === null) return;
    if (isSheetOpen && !dialog.open) dialog.showModal();
    if (!isSheetOpen && dialog.open) dialog.close();
  }, [isSheetOpen]);

  const openSheet = useCallback(() => setSheetOpen(true), []);
  const closeSheet = useCallback(() => setSheetOpen(false), []);

  return (
    <>
      <aside className="rail" aria-label="Opens tracking" aria-busy={load.status === 'loading'}>
        <RailBody load={load} />
      </aside>

      <p className="visually-hidden" role="status" aria-live="polite">
        {liveMessage}
      </p>

      <RailStrip load={load} now={now} onExpand={openSheet} />

      <dialog
        ref={sheetRef}
        className="rail-sheet"
        aria-label="Opens tracking"
        onClose={closeSheet}
        onCancel={closeSheet}
      >
        <div className="rail-sheet__header">
          <span className="rail-sheet__title">Opens</span>
          <button type="button" className="rail-sheet__close" onClick={closeSheet}>
            <X size={18} strokeWidth={1.5} aria-hidden="true" />
            <span className="visually-hidden">Close</span>
          </button>
        </div>
        <RailBody load={load} />
      </dialog>
    </>
  );
}

interface RailBodyProps {
  readonly load: LoadState;
}

/** The rail's actual content — shared verbatim between the always-visible
 *  desktop aside and the mobile sheet, so the two never drift out of
 *  sync (both are rendered from the same fetched `load` state). */
function RailBody({ load }: RailBodyProps) {
  if (load.status === 'loading') {
    return (
      <div className="rail__inner">
        <p className="visually-hidden" role="status">
          Loading opens…
        </p>
        <div className="rail__list rail__list--skeleton" aria-hidden="true">
          {Array.from({ length: SKELETON_ENTRY_COUNT }, (_, index) => (
            <div key={index} className="rail__skeleton-entry" />
          ))}
        </div>
      </div>
    );
  }

  const { view } = load;

  if (view.kind === 'unavailable') {
    return (
      <div className="rail__inner">
        <div className="rail__list" data-available="false" aria-hidden="true" />
        <div className="rail__unavailable">
          <p className="rail__unavailable-headline">Postbox can't reach the tracking service.</p>
          <p className="rail__unavailable-sub prose">
            The rail is blank because nothing is being recorded, not because nothing happened. It fills
            in again once the connection returns.
          </p>
        </div>
      </div>
    );
  }

  const { displayable, selfCount } = view;

  return (
    <div className="rail__inner">
      <header className="rail__header">
        <h2 className="rail__heading">Opens</h2>
        <span className="rail__count">{displayable.length}</span>
      </header>

      {/* task-5-brief.md Amendment 2: self events are never a row, but
          never silently discarded either — zero self events render
          nothing here rather than "0 views from you". */}
      {selfCount > 0 && <p className="rail__self-count">{formatSelfCountLine(selfCount)}</p>}

      {displayable.length === 0 ? (
        <>
          <div className="rail__list" data-available="true" aria-hidden="true" />
          <div className="rail__empty">
            <p className="rail__empty-headline">Nothing has come back yet.</p>
            <p className="rail__empty-sub prose">
              Marks appear here as they arrive. Most of what arrives will not be a person.
            </p>
          </div>
        </>
      ) : (
        <ol className="rail__list" data-available="true">
          {displayable.map((event) => (
            // NOT `event.token` alone: the ground-truth sample this task
            // shipped against had 10 events across only 5 tracked
            // emails — the same token legitimately appears more than
            // once (e.g. an mpp prefetch and a later real open on the
            // same send), so `token` by itself collides as a React key
            // and would silently drop one of the two rows.
            <OpenEntry key={`${event.token}:${event.occurredAt}:${event.classification}`} event={event} />
          ))}
        </ol>
      )}
    </div>
  );
}

interface OpenEntryProps {
  readonly event: OpenEvent;
}

/**
 * One event on the spine (client/DESIGN.md §6 component #11 OpenEvent):
 * mark · headline · (sub, for the permanent-ceiling case) · meta · token,
 * with the classification's full explanatory note revealed on demand.
 *
 * `<details>/<summary>` rather than DESIGN.md's literal Popover-API
 * suggestion for the note (component #12 StateNote): both give "the
 * whole entry is one control that opens the note," but `<details>` is a
 * native disclosure widget with keyboard support and screen-reader
 * expanded/collapsed state built in, and — unlike an absolutely
 * positioned popover — it never needs to escape `.rail`'s own
 * `overflow-y: auto` to avoid being clipped, because it pushes the
 * following rows down in normal flow instead of floating over them. That
 * trade was made without a browser available to verify either
 * implementation visually; see task-5-report.md.
 *
 * XSS: `subject` is never rendered at all (DESIGN.md gives it no role in
 * the rail's copy). `recipientEmail` is attacker-influenced — any sender
 * picks the address their own tracking pixel points at — and is only
 * ever interpolated as JSX text (via `describeEvent`'s returned string),
 * which React escapes by default; this file never touches
 * `dangerouslySetInnerHTML`.
 */
function OpenEntry({ event }: OpenEntryProps) {
  const state = readStateFor(event.classification);
  const copy = describeEvent(event);

  return (
    <li className={`rail__entry${state.permanent ? ' rail__entry--permanent' : ''}`}>
      <details className="rail__entry-details">
        <summary className="rail__entry-summary">
          <ReadState classification={event.classification} />
          <span className="rail__entry-body">
            <span className="rail__entry-headline">{copy.headline}</span>
            {copy.sub !== null && <span className="rail__entry-sub">{copy.sub}</span>}
            <span className="rail__entry-meta">{copy.meta}</span>
          </span>
        </summary>
        <p className="rail__note">{state.title}</p>
      </details>
    </li>
  );
}

interface RailStripProps {
  readonly load: LoadState;
  readonly now: number;
  readonly onExpand: () => void;
}

/**
 * The <1080px collapsed rail (client/DESIGN.md §4.3, §6 component #14):
 * a 44px bottom strip carrying the single most recent displayable event
 * as one line. Persistent — it never vanishes — because the rail itself
 * is persistent by the direction's own definition; it only ever changes
 * WHAT one line it shows (loading / unavailable / empty / an event).
 *
 * Tapping it opens the full rail as a bottom sheet (`OpensRail`'s
 * `<dialog class="rail-sheet">`), which renders from the exact same
 * `load` state — there is no second fetch here.
 */
function RailStrip({ load, now, onExpand }: RailStripProps) {
  const isUnavailable = load.status === 'loaded' && load.view.kind === 'unavailable';
  const mostRecent =
    load.status === 'loaded' && load.view.kind === 'ready' ? load.view.displayable[0] : undefined;

  return (
    <button
      type="button"
      className={`rail-strip${isUnavailable ? ' rail-strip--unavailable' : ''}`}
      onClick={onExpand}
      aria-haspopup="dialog"
      aria-label="Open opens tracking"
    >
      {load.status === 'loading' && <span className="rail-strip__label">Loading opens…</span>}

      {isUnavailable && <span className="rail-strip__label">Tracking unreachable</span>}

      {load.status === 'loaded' && load.view.kind === 'ready' && mostRecent === undefined && (
        <span className="rail-strip__label">No opens yet</span>
      )}

      {mostRecent !== undefined && (
        <>
          <ReadState classification={mostRecent.classification} />
          <span className="rail-strip__headline">{describeEvent(mostRecent).headline}</span>
          <span className="rail-strip__time">{formatRelativeTime(mostRecent.occurredAt, now)}</span>
        </>
      )}
    </button>
  );
}
