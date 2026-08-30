import { useEffect, useRef, useState } from 'react';
import { getOpens } from './api';
import { advanceOpensPoll } from './components/openEvents';
import type { RailView } from './components/openEvents';
import { useNow } from './useNow';

/**
 * Owns the ONE fetch/poll cycle for open events, for the lifetime of an
 * authorized session — hoisted here from OpensView.tsx (task V1: the
 * user's directive after the Plunk rebase, "don't only have opens as a
 * tab. I liked the timeline sidebar thing on the inbox from before").
 * App.tsx calls this ONCE and passes the result to both OpensRail.tsx
 * (beside the Inbox at desktop widths) and OpensView.tsx (the sidebar's
 * Opens page), so switching between the two never tears down or
 * duplicates the poll.
 *
 * This deliberately REVERSES the SDD ledger's "polling only while the
 * Opens view is mounted" ruling (client/CLAUDE.md / the whole-branch
 * review that landed with task 7.6). That ruling's premise was that the
 * Plunk rebase deleted the always-visible rail, so nothing needed opens
 * data except the Opens page itself. Task V1 re-creates the rail beside
 * the Inbox, so the premise is gone — the fetch has to live somewhere
 * both surfaces can share instead of somewhere tied to either one.
 *
 * `isEnabled` replaces the gating OpensView used to get for free simply
 * by never being mounted while signed out: this hook IS mounted
 * unconditionally now (App.tsx must call every hook on every render,
 * signed in or not — rules of hooks), so the "no poll while signed out"
 * contract has to be threaded in explicitly instead of falling out of
 * mount timing. Callers pass `gate.status === 'authorized'`.
 *
 * The poll policy itself — fetch once, and if the tracking service comes
 * back unavailable, retry silently every `UNAVAILABLE_RETRY_MS` until it
 * isn't — is UNCHANGED from OpensView's own effect; only where it lives
 * moved. `advanceOpensPoll` (components/openEvents.ts) is the testable
 * pure half of that policy; this hook is the thin, framework-required
 * half (state, the ref that threads `previousKind` across ticks, and the
 * actual `setTimeout` chain).
 */

/** Matches the page's former `OPENS_LIMIT` — unchanged by the hoist. */
const OPENS_POLL_LIMIT = 50;

/**
 * How long to wait before quietly trying the tracking service again after
 * it reports unavailable. Deliberately never surfaced in any copy this
 * app renders (see components/OpensFeed.tsx): naming a retry cadence in
 * the UI is a promise that has to stay true as this number changes. The
 * feed "fills in on reconnect" by polling silently, not by asking the
 * user to do anything or telling them when it will try next.
 */
const UNAVAILABLE_RETRY_MS = 30_000;

export type OpensLoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly view: RailView };

export interface OpensFeedState {
  readonly load: OpensLoadState;
  readonly liveMessage: string;
  readonly now: number;
}

export function useOpensFeed(isEnabled: boolean): OpensFeedState {
  const [load, setLoad] = useState<OpensLoadState>({ status: 'loading' });
  const [liveMessage, setLiveMessage] = useState('');
  // A TICKING clock, not a snapshot. This used to be
  // `useState(() => Date.now())` on the reasoning that relative times should
  // not creep forward while the tab sits open — which is backwards, and on
  // THIS hook was the worst of the four, because the feed polls: every event
  // arriving after mount had `occurredAt > now` and rendered "just now"
  // indefinitely. See ./useNow.ts.
  const now = useNow();
  const previousKindRef = useRef<RailView['kind'] | null>(null);

  useEffect(() => {
    if (!isEnabled) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    function poll() {
      // getOpens (client/src/api.ts) never rejects — every failure mode
      // already degrades to { opens: [], available: false } inside it,
      // so there is deliberately no .catch() here to swallow.
      getOpens(OPENS_POLL_LIMIT).then((response) => {
        if (cancelled) return;
        const tick = advanceOpensPoll(previousKindRef.current, response);
        previousKindRef.current = tick.view.kind;

        if (tick.liveMessage !== null) setLiveMessage(tick.liveMessage);
        setLoad({ status: 'loaded', view: tick.view });
        if (tick.shouldRetry) retryTimer = setTimeout(poll, UNAVAILABLE_RETRY_MS);
      });
    }

    poll();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
    // `isEnabled` is the only real dependency: a session that starts
    // signed out and later authorizes must (re)start the poll. In
    // practice this app never flips authorized back to unauthorized
    // (there is no sign-out control), so `previousKindRef` is never reset
    // mid-session — the same one-thread-of-announcements property the
    // doc comment on advanceOpensPoll describes.
  }, [isEnabled]);

  return { load, liveMessage, now };
}
