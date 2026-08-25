import { describe, it, expect } from 'vitest';
import {
  formatClockTime,
  formatLag,
  formatRelativeTime,
  formatSelfCountLine,
  describeEvent,
  partitionOpens,
  deriveRailView,
} from '../src/components/openEvents';
import type { OpenEvent, OpensResponse } from '../src/api';

/**
 * Pure-logic coverage for OpensView.tsx's supporting module, none of
 * which renders a component (client/CLAUDE.md's standing constraint).
 * The two functions the task's own report explicitly asks to be checked
 * for vacuousness live here: `partitionOpens` (self suppressed AND
 * counted) and `deriveRailView` (unavailable told apart from empty).
 */

function buildEvent(overrides: Partial<OpenEvent> & { readonly token: string }): OpenEvent {
  return {
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

describe('formatClockTime', () => {
  it('renders 24-hour, zero-padded, no seconds and no zone label', () => {
    // 2024-01-01T14:06:00Z
    expect(formatClockTime(Date.UTC(2024, 0, 1, 14, 6, 0))).toBe('14:06');
  });

  it('zero-pads a single-digit hour', () => {
    expect(formatClockTime(Date.UTC(2024, 0, 1, 9, 4, 0))).toBe('09:04');
  });
});

describe('formatLag', () => {
  it('renders whole seconds under a minute', () => {
    expect(formatLag(4_000)).toBe('4s after sending');
  });

  it('renders hours and minutes for a multi-hour gap', () => {
    // 2h 11m = (2*60+11)*60*1000 = 7,860,000ms
    expect(formatLag(7_860_000)).toBe('2h 11m after sending');
  });

  it('drops the minutes when they are exactly zero', () => {
    expect(formatLag(2 * 60 * 60 * 1000)).toBe('2h after sending');
  });

  it('renders bare minutes under an hour', () => {
    expect(formatLag(5 * 60 * 1000)).toBe('5m after sending');
  });

  it('never prints a negative duration for clock skew', () => {
    expect(formatLag(-500)).toBe('0s after sending');
  });
});

describe('formatRelativeTime', () => {
  const NOW = Date.UTC(2024, 0, 1, 12, 0, 0);

  it('says "just now" inside the first minute', () => {
    expect(formatRelativeTime(NOW - 10_000, NOW)).toBe('just now');
  });

  it('renders minutes under an hour', () => {
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago');
  });

  it('renders hours under a day', () => {
    expect(formatRelativeTime(NOW - 3 * 60 * 60_000, NOW)).toBe('3h ago');
  });

  it('renders days beyond that', () => {
    expect(formatRelativeTime(NOW - 2 * 24 * 60 * 60_000, NOW)).toBe('2d ago');
  });
});

describe('formatSelfCountLine', () => {
  it('uses the singular for exactly one', () => {
    expect(formatSelfCountLine(1)).toBe('1 view from you');
  });

  it('uses the plural for more than one', () => {
    expect(formatSelfCountLine(3)).toBe('3 views from you');
  });
});

describe('describeEvent', () => {
  it('names the recipient address in the confirmed headline', () => {
    const event = buildEvent({ token: 'a', classification: 'open', recipientEmail: 'kate@example.com' });
    expect(describeEvent(event).headline).toBe('kate@example.com opened this.');
  });

  it('gives mpp the permanent-ceiling copy, not the generic unconfirmable sentence', () => {
    const event = buildEvent({ token: 'b', classification: 'mpp' });
    const copy = describeEvent(event);
    expect(copy.headline).toMatch(/apple mail/i);
    expect(copy.sub).toMatch(/ceiling/i);
  });

  it('gives prefetch and scanner the same generic sentence, distinct from mpp', () => {
    const prefetch = describeEvent(buildEvent({ token: 'c', classification: 'prefetch' }));
    const scanner = describeEvent(buildEvent({ token: 'd', classification: 'scanner' }));
    const mpp = describeEvent(buildEvent({ token: 'e', classification: 'mpp' }));
    expect(prefetch.headline).toBe(scanner.headline);
    expect(prefetch.headline).not.toBe(mpp.headline);
  });

  // fix round 1: an unrecognised classification's meta line embeds the
  // raw token (`readStateFor`'s default branch keeps it unbounded on
  // purpose) — but the RENDERED meta string must still be bounded, or a
  // pathological wire value distorts the row's layout the same way an
  // unbounded badge would.
  it('bounds a pathologically long unrecognised classification in the meta line', () => {
    const pathological = 'x'.repeat(500);
    const copy = describeEvent(buildEvent({ token: 'f', classification: pathological }));
    expect(copy.meta.length).toBeLessThan(pathological.length);
  });
});

describe('partitionOpens — self suppressed from the rail, but counted', () => {
  it('excludes self events from `displayable`', () => {
    const events = [
      buildEvent({ token: 'a', classification: 'self' }),
      buildEvent({ token: 'b', classification: 'open' }),
    ];
    const { displayable } = partitionOpens(events);
    expect(displayable.some((e) => e.classification === 'self')).toBe(false);
  });

  it('still counts every self event in `selfCount`', () => {
    const events = [
      buildEvent({ token: 'a', classification: 'self' }),
      buildEvent({ token: 'b', classification: 'self' }),
      buildEvent({ token: 'c', classification: 'open' }),
    ];
    const { displayable, selfCount } = partitionOpens(events);
    expect(selfCount).toBe(2);
    expect(displayable).toHaveLength(1);
  });

  it('reports zero — not the length of an empty array coincidentally matching — when there are no self events', () => {
    const events = [buildEvent({ token: 'a', classification: 'open' }), buildEvent({ token: 'b', classification: 'mpp' })];
    const { selfCount, displayable } = partitionOpens(events);
    expect(selfCount).toBe(0);
    expect(displayable).toHaveLength(2);
  });

  it('sorts displayable events newest-first by occurredAt', () => {
    const older = buildEvent({ token: 'a', classification: 'open', occurredAt: 1000 });
    const newer = buildEvent({ token: 'b', classification: 'open', occurredAt: 5000 });
    const { displayable } = partitionOpens([older, newer]);
    expect(displayable.map((e) => e.token)).toEqual(['b', 'a']);
  });

  it('never mutates the array it is given', () => {
    const events = [buildEvent({ token: 'a', occurredAt: 1 }), buildEvent({ token: 'b', occurredAt: 2 })];
    const copy = [...events];
    partitionOpens(events);
    expect(events).toEqual(copy);
  });
});

describe('deriveRailView — unavailable told apart from empty', () => {
  // The critical case: identical `opens: []` content, differing ONLY in
  // `available`, must land on different `kind`s. A version of this test
  // that only checked one branch (or that asserted on `opens.length`
  // instead of `kind`) would pass even if OpensView rendered the two
  // states identically — this asserts the actual discriminant the
  // component branches on.
  it('reports `unavailable` when available is false, even with an empty opens array', () => {
    const response: OpensResponse = { opens: [], available: false };
    expect(deriveRailView(response).kind).toBe('unavailable');
  });

  it('reports `ready` with zero displayable events when available is true and opens is empty — NOT `unavailable`', () => {
    const response: OpensResponse = { opens: [], available: true };
    const view = deriveRailView(response);
    expect(view.kind).toBe('ready');
    expect(view.kind === 'ready' && view.displayable).toEqual([]);
  });

  it('the same opens content flips `kind` on `available` alone', () => {
    const opens: readonly OpenEvent[] = [];
    const unavailable = deriveRailView({ opens, available: false });
    const empty = deriveRailView({ opens, available: true });
    expect(unavailable.kind).not.toBe(empty.kind);
  });

  it('reports unavailable even if `opens` were non-empty alongside available: false — availability wins, not array length', () => {
    const response: OpensResponse = { opens: [buildEvent({ token: 'a' })], available: false };
    expect(deriveRailView(response).kind).toBe('unavailable');
  });

  it('carries the self count and displayable list through when ready', () => {
    const response: OpensResponse = {
      opens: [buildEvent({ token: 'a', classification: 'self' }), buildEvent({ token: 'b', classification: 'open' })],
      available: true,
    };
    const view = deriveRailView(response);
    expect(view.kind).toBe('ready');
    if (view.kind === 'ready') {
      expect(view.selfCount).toBe(1);
      expect(view.displayable).toHaveLength(1);
    }
  });
});
