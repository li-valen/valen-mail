import { CloudOff, Radio } from 'lucide-react';
import type { ReactNode } from 'react';
import type { OpenEvent } from '../api';
import type { OpensLoadState } from '../useOpensFeed';
import { Card, CardHeader } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { ReadState } from './ReadState';
import { formatOpenRowSentence, selfCountLine } from './openEvents';

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
        <ol className="divide-y divide-neutral-100 dark:divide-border">
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

interface OpenEntryProps {
  readonly event: OpenEvent;
  readonly now: number;
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
 */
function OpenEntry({ event, now }: OpenEntryProps) {
  return (
    <li className="transition-colors hover:bg-neutral-50 dark:hover:bg-accent">
      <div className="flex items-center gap-3 px-4 py-2">
        <ReadState classification={event.classification} />
        <span className="min-w-0 flex-1 truncate text-sm text-neutral-900 dark:text-foreground">
          {formatOpenRowSentence(event, now)}
        </span>
      </div>
    </li>
  );
}
