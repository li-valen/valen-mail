import { describe, it, expect } from 'vitest';
import { advanceOpensPoll } from '../src/components/openEvents';
import type { RailView } from '../src/components/openEvents';
import type { OpenEvent, OpensResponse } from '../src/api';

/**
 * Coverage for `advanceOpensPoll` (client/src/components/openEvents.ts),
 * the pure poll-tick reducer task V1 extracted out of OpensView.tsx's old
 * `useEffect` when the fetch/poll cycle moved up into useOpensFeed.ts and
 * became shared by two surfaces (OpensRail.tsx and OpensView.tsx) instead
 * of owned by one. None of this renders a component
 * (client/CLAUDE.md's standing constraint).
 *
 * The second `describe` block is the one the task brief specifically
 * asked for: a property test proving why exactly ONE poller — one
 * `previousKind` thread — has to exist, expressed as a pure-function
 * property rather than as a claim about how many `setTimeout` chains a
 * rendered hook creates (which this codebase has no tool to assert on
 * directly).
 */

function buildEvent(overrides: Partial<OpenEvent> & { readonly token: string }): OpenEvent {
  return {
    accountId: 'acct-1',
    messageId: '<msg-1@postbox.local>',
    recipientEmail: 'someone@example.com',
    subject: 'Test subject',
    sentAt: 1_700_000_000_000,
    occurredAt: 1_700_000_060_000,
    classification: 'open',
    deviceClass: 'unknown',
    os: null,
    ...overrides,
  };
}

const UNAVAILABLE: OpensResponse = { opens: [], available: false };
const EMPTY_READY: OpensResponse = { opens: [], available: true };
const READY_WITH_EVENT: OpensResponse = { opens: [buildEvent({ token: 'a' })], available: true };

describe('advanceOpensPoll — the transition-announcement policy', () => {
  it('does not announce anything on a first-ever tick that comes back ready', () => {
    const tick = advanceOpensPoll(null, EMPTY_READY);
    expect(tick.liveMessage).toBeNull();
    expect(tick.view.kind).toBe('ready');
  });

  it('announces "can\'t reach" on a first-ever tick that is already unavailable — there is no earlier kind to compare against, so `null` must behave like "not already unavailable"', () => {
    const tick = advanceOpensPoll(null, UNAVAILABLE);
    expect(tick.liveMessage).toBe("Valen Mail can't reach the tracking service.");
  });

  it('does not repeat the "can\'t reach" announcement on a still-unavailable retry', () => {
    const tick = advanceOpensPoll('unavailable', UNAVAILABLE);
    expect(tick.liveMessage).toBeNull();
  });

  it('announces "reconnected" exactly on the unavailable -> ready transition', () => {
    const tick = advanceOpensPoll('unavailable', EMPTY_READY);
    expect(tick.liveMessage).toBe('Tracking reconnected.');
  });

  it('does not announce anything across consecutive ready ticks', () => {
    const tick = advanceOpensPoll('ready', READY_WITH_EVENT);
    expect(tick.liveMessage).toBeNull();
  });

  it('schedules a retry exactly when, and only when, the derived view is unavailable', () => {
    expect(advanceOpensPoll(null, UNAVAILABLE).shouldRetry).toBe(true);
    expect(advanceOpensPoll('unavailable', UNAVAILABLE).shouldRetry).toBe(true);
    expect(advanceOpensPoll(null, EMPTY_READY).shouldRetry).toBe(false);
    expect(advanceOpensPoll('ready', READY_WITH_EVENT).shouldRetry).toBe(false);
  });

  it('carries the derived view through untouched — same displayable/selfCount split deriveRailView produces', () => {
    const withSelf: OpensResponse = {
      opens: [buildEvent({ token: 'a', classification: 'self' }), buildEvent({ token: 'b' })],
      available: true,
    };
    const tick = advanceOpensPoll(null, withSelf);
    expect(tick.view.kind).toBe('ready');
    if (tick.view.kind === 'ready') {
      expect(tick.view.selfCount).toBe(1);
      expect(tick.view.displayable).toHaveLength(1);
    }
  });

  it('never mutates the response it is given', () => {
    const response: OpensResponse = { opens: [buildEvent({ token: 'a' })], available: true };
    const copy: OpensResponse = { available: response.available, opens: [...response.opens] };
    advanceOpensPoll(null, response);
    expect(response).toEqual(copy);
  });
});

describe('advanceOpensPoll — the single-poller property', () => {
  it('one accumulated thread announces an outage exactly once across repeated unavailable ticks', () => {
    const responses = [UNAVAILABLE, UNAVAILABLE, UNAVAILABLE];
    let previousKind: RailView['kind'] | null = null;
    const messages: (string | null)[] = [];

    for (const response of responses) {
      const tick = advanceOpensPoll(previousKind, response);
      messages.push(tick.liveMessage);
      previousKind = tick.view.kind;
    }

    expect(messages.filter((message) => message !== null)).toHaveLength(1);
    expect(messages[0]).toBe("Valen Mail can't reach the tracking service.");
  });

  it('one accumulated thread announces exactly one outage and one reconnect across a down-then-up run', () => {
    const responses = [UNAVAILABLE, UNAVAILABLE, EMPTY_READY, EMPTY_READY];
    let previousKind: RailView['kind'] | null = null;
    const messages: (string | null)[] = [];

    for (const response of responses) {
      const tick = advanceOpensPoll(previousKind, response);
      messages.push(tick.liveMessage);
      previousKind = tick.view.kind;
    }

    expect(messages).toEqual([
      "Valen Mail can't reach the tracking service.",
      null,
      'Tracking reconnected.',
      null,
    ]);
  });

  // This is the property the hoist to useOpensFeed.ts exists to
  // guarantee. Before task V1, OpensView.tsx owned its own poll loop and
  // its own `previousKindRef`, created fresh every time the user
  // navigated to the Opens page and torn down every time they left it.
  // Simulate what would happen if OpensRail.tsx ran an independent poll
  // loop the same way instead of sharing App.tsx's one `useOpensFeed()`
  // call: two separate `previousKind` threads, BOTH starting at `null`,
  // both observing the same first response.
  it('two INDEPENDENT accumulators — the bug hoisting to one poller fixes — each re-announce the same outage, because neither thread knows the other has already seen it', () => {
    const pagePoller = advanceOpensPoll(null, UNAVAILABLE);
    const railPoller = advanceOpensPoll(null, UNAVAILABLE);
    expect(pagePoller.liveMessage).not.toBeNull();
    expect(railPoller.liveMessage).not.toBeNull();

    // A single hoisted poller, by contrast, only announces once: feeding
    // the first tick's resulting `kind` forward into the second call
    // suppresses the duplicate — which is exactly what one
    // `previousKindRef`, shared by both surfaces via useOpensFeed.ts,
    // guarantees structurally rather than by convention.
    const sharedFollowUp = advanceOpensPoll(pagePoller.view.kind, UNAVAILABLE);
    expect(sharedFollowUp.liveMessage).toBeNull();
  });
});
