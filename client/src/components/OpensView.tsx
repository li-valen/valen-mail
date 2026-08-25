import type { OpensFeedState } from '../useOpensFeed';
import OpensFeed from './OpensFeed';

/**
 * The Opens page: the sidebar's "Opens" nav destination. A thin adapter
 * around OpensFeed.tsx (task V1) — every actual behaviour (formatting,
 * the honesty requirement, the unavailable/empty split, the read-state
 * rows) lives there now, shared with OpensRail.tsx.
 *
 * ARCHITECTURE, task V1 (the opens-rail-on-Inbox restore). Until this
 * task, this file owned its own `getOpens` poll directly and was the
 * ONLY surface that rendered opens at all — task 7.6 (the Plunk rebase)
 * had deleted the always-visible desktop rail and made this page the
 * sole home for the feed, reasoning that Plunk's shell has no third
 * column. The user's directive reversed that: "don't only have opens as
 * a tab. I liked the timeline sidebar thing on the inbox from before."
 * Both surfaces stay — this page in the sidebar nav, unchanged in
 * behaviour, AND OpensRail.tsx beside the Inbox at desktop widths — so
 * the poll moved up to useOpensFeed.ts, owned once by App.tsx and passed
 * down to both as `feed`. Switching Inbox <-> Opens now reuses the same
 * in-flight/most-recent data rather than each view fetching its own.
 *
 * This deliberately REVERSES the SDD ledger's "polling only while the
 * Opens view is mounted" ruling recorded when 7.6 landed: that ruling's
 * premise — that nothing else on screen needed opens data — is gone now
 * that the rail exists again. See useOpensFeed.ts's own doc comment for
 * the full reasoning.
 *
 * Composition ported from Plunk (AGPL-3.0): the `Card` + `CardHeader` +
 * `divide-y divide-neutral-100` feed of `apps/web/src/pages/activity/`,
 * and the `EmptyState` molecule — all now inside OpensFeed.tsx.
 */
export interface OpensViewProps {
  readonly feed: OpensFeedState;
}

export default function OpensView({ feed }: OpensViewProps) {
  return <OpensFeed load={feed.load} now={feed.now} liveMessage={feed.liveMessage} />;
}
