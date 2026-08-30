import { describe, it, expect } from 'vitest';
import useNowSource from '../src/useNow.ts?raw';
import appSource from '../src/App.tsx?raw';
import inboxListSource from '../src/components/InboxList.tsx?raw';
import followupSource from '../src/components/FollowupView.tsx?raw';
import opensFeedSource from '../src/useOpensFeed.ts?raw';
import openEventsSource from '../src/components/openEvents.ts?raw';

/**
 * "the timings are wrong."
 *
 * Four places resolved `now` once with `useState(() => Date.now())` and never
 * updated it, so every relative timestamp was stale by however long the tab
 * had been open — unbounded, in a PWA meant to stay open for days.
 *
 * The opens feed was the worst of the four because it POLLS: an event
 * arriving after mount has `occurredAt > now`, and `formatRelativeTime`
 * clamps the elapsed time at zero, so every genuinely new open rendered
 * "just now" indefinitely.
 *
 * No test in this project renders a component, so these read the source.
 * They are paired with a behavioural test of the clamp itself, which is the
 * part that turned a stale clock into a visibly false one.
 */

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const SOURCES = {
  'App.tsx': appSource,
  'InboxList.tsx': inboxListSource,
  'FollowupView.tsx': followupSource,
  'useOpensFeed.ts': opensFeedSource,
};

describe('the clock advances', () => {
  it('no frozen now snapshots are left anywhere', () => {
    // The exact shape that caused this. If it comes back, it comes back
    // silently — nothing about a frozen clock throws.
    for (const [name, source] of Object.entries(SOURCES)) {
      expect(
        stripComments(source),
        `${name} still freezes its clock`,
      ).not.toMatch(/useState\(\(\)\s*=>\s*(Date\.now\(\)|new Date\(\))\)/);
    }
  });

  it('every consumer takes its clock from the shared hook', () => {
    for (const [name, source] of Object.entries(SOURCES)) {
      expect(stripComments(source), `${name} does not use useNow`).toMatch(
        /const now = useNow(Date)?\(\)/,
      );
    }
  });

  it('the hook actually schedules an update', () => {
    const src = stripComments(useNowSource);
    expect(src).toMatch(/setInterval\(update, tickMs\)/);
    expect(src).toMatch(/clearInterval\(timer\)/);
  });

  it('and catches up when the tab wakes, which a bare interval cannot', () => {
    // Browsers throttle and suspend timers in background tabs, and a machine
    // that slept does not run them at all. Without this, reopening the app
    // shows the time it was suspended at until the next tick.
    const src = stripComments(useNowSource);
    expect(src).toMatch(/addEventListener\('visibilitychange'/);
    expect(src).toMatch(/removeEventListener\('visibilitychange'/);
    expect(src).toMatch(/visibilityState === 'visible'/);
  });

  it('ticks at the granularity the labels actually render', () => {
    // "1m ago" is the smallest unit any relative format emits, so a faster
    // tick re-renders the inbox for a string that cannot have changed.
    expect(stripComments(useNowSource)).toMatch(/NOW_TICK_MS = 60_000/);
  });

  it('memoises the Date so it is stable between ticks', () => {
    // `new Date(now)` inline would be a fresh object every render, which
    // these values are read by memo dependency lists.
    expect(stripComments(useNowSource)).toMatch(/useMemo\(\(\) => new Date\(now\), \[now\]\)/);
  });

  it('the clamp that made a stale clock a LYING clock is still there', () => {
    // Math.max(0, …) is correct — a negative elapsed must not render as a
    // negative age. It is only harmful when `now` never advances, which is
    // what the rest of this file fixes. Pinned so the two stay understood
    // together.
    expect(stripComments(openEventsSource)).toMatch(/Math\.max\(0, now - epochMs\)/);
  });
});
