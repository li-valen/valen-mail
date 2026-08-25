import type { OpenEvent } from '../api';
import type { OpensFeedState } from '../useOpensFeed';
import OpensFeed from './OpensFeed';

export interface OpensRailProps {
  readonly feed: OpensFeedState;
  /** Forwarded straight to OpensFeed.tsx (task V3) — see that prop's own
   *  doc comment. */
  readonly onOpenEvent: (event: OpenEvent) => void;
}

/**
 * The timeline rail beside the Inbox at desktop widths (task V1) — the
 * user's own words, after the Plunk rebase: "don't only have opens as a
 * tab. I liked the timeline sidebar thing on the inbox from before."
 * Restores the pre-Plunk OpensRail.tsx's PLACEMENT
 * (`git show 0996f09:client/src/components/OpensRail.tsx`), not its
 * markup or its bespoke `OpensRail.css`: this renders the exact same
 * `OpensFeed` body the Opens page renders, `compact`, in Plunk's own
 * visual language (`border-l`, the `Badge` variants, the `EmptyState`
 * molecule) rather than the pre-Plunk hand-rolled CSS system, which is
 * gone and stays gone.
 *
 * Desktop-only: `hidden` below the shell's own `lg:` breakpoint
 * (AppShell.tsx's sidebar uses the same one). Below that width the rail
 * does not render at all — no collapsed bottom strip, unlike the
 * pre-Plunk rail's `<button class="rail-strip">`. The sidebar's Opens
 * nav item is the mobile path to this feed now; App.tsx's own comment on
 * the two-column composition has the reasoning for why that strip is not
 * coming back.
 *
 * `lg:top-8` / `lg:max-h-[calc(100dvh-4rem)]` mirror the shell's own
 * content padding (`lg:py-8` = 2rem top and bottom, AppShell.tsx) so the
 * sticky rail keeps the same breathing room the rest of the page has,
 * rather than sticking flush to the browser chrome. `lg:overflow-y-auto`
 * is what gives the rail "own scroll" — independent of the message list
 * beside it — once its own content is taller than that capped height,
 * rather than sharing the page's one scrollbar.
 *
 * Renders from `feed` — the SAME `useOpensFeed()` result App.tsx passes
 * to OpensView — so there is exactly one poller for the process, not one
 * per surface, and switching Inbox <-> Opens never refetches from
 * scratch or starts a second timer chain.
 */
export default function OpensRail({ feed, onOpenEvent }: OpensRailProps) {
  return (
    <aside
      aria-label="Opens"
      className="hidden w-80 shrink-0 border-l border-neutral-200 dark:border-border pl-6 lg:block lg:sticky lg:top-6 lg:max-h-[calc(100dvh-7rem)] lg:overflow-y-auto"
    >
      <OpensFeed
        load={feed.load}
        now={feed.now}
        liveMessage={feed.liveMessage}
        compact
        onOpenEvent={onOpenEvent}
      />
    </aside>
  );
}
