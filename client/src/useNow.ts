import { useEffect, useMemo, useState } from 'react';

/**
 * A CLOCK THAT ADVANCES, which is the whole point and was the bug.
 *
 * Four places in this client resolved `now` once with
 * `useState(() => Date.now())` and never touched it again, on the stated
 * reasoning that relative times "should not silently creep forward while the
 * tab sits open in the background for hours."
 *
 * That has it backwards. A relative time creeping forward is it staying
 * TRUE; freezing it makes every timestamp on screen wrong by however long
 * the tab has been open. In a PWA that is left open for days — which is what
 * this app is — the error is unbounded.
 *
 * **AND THERE IS A SHARPER FAILURE THE OLD COMMENT DID NOT ANTICIPATE.** The
 * opens feed POLLS, so events arrive after mount. For any of them
 * `occurredAt > now`, and `formatRelativeTime` clamps with
 * `Math.max(0, now - epochMs)` — so every genuinely new open rendered
 * **"just now", indefinitely**, no matter how long ago it actually
 * happened. That is what "the recent opens are just wrong" was.
 *
 * **THE TAB IS OFTEN NOT AWAKE.** Browsers throttle and suspend timers in
 * background tabs, and a laptop that slept does not run them at all, so a
 * bare interval returns to a visible tab still showing the time it was
 * suspended at. The `visibilitychange` listener is what makes reopening the
 * app correct immediately rather than at the next tick — and that is the
 * common case for a mail client, not an edge one.
 */

/**
 * One minute, matching the smallest unit any relative format here renders
 * ("1m ago"). A shorter tick would re-render the inbox list for a string
 * that cannot have changed; a longer one would let a minute-granular label
 * be visibly stale.
 */
export const NOW_TICK_MS = 60_000;

export function useNow(tickMs: number = NOW_TICK_MS): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, tickMs);
    // Fires on the way back from a background tab or a sleeping machine,
    // where the interval above has not been running.
    const onVisible = () => {
      if (document.visibilityState === 'visible') update();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [tickMs]);

  return now;
}

/**
 * The same clock as a `Date`, for the consumers that take one.
 *
 * Memoised on the tick rather than constructed per render: `new Date(now)`
 * inline would be a fresh object every render, and these values are read by
 * memo dependency lists and by day-grouping that compares identity.
 */
export function useNowDate(tickMs: number = NOW_TICK_MS): Date {
  const now = useNow(tickMs);
  return useMemo(() => new Date(now), [now]);
}
