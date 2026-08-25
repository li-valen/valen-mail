import { describe, it, expect } from 'vitest';
import { formatWhen, groupByDay } from '../src/components/InboxList';
import type { InboxMessage } from '../src/api';

/**
 * Task 4 — chronological unified inbox. Covers the two pure functions
 * `InboxList.tsx` re-exports from `./inboxDates`: `formatWhen` (per-row
 * timestamp text) and `groupByDay` (day-bucketing for the list). Neither
 * test here renders a component — client/CLAUDE.md's standing constraint
 * is that no test in this plan does, so layout/theme/focus stay a manual
 * verification step (client/CLAUDE.md chain step 9), not an automated one.
 *
 * `NOW` is fixed so every test is deterministic regardless of the day the
 * suite runs. client/vite.config.ts pins `TZ=UTC` for this test run
 * (task-4-brief.md Amendment 2) — without it, these Aug 21 vs Aug 24
 * fixtures group 2+1 in UTC and US Eastern but collapse to a single group
 * at UTC+3 and eastward, which is exactly the kind of failure that is
 * green on one machine and red on another for no visible reason.
 */

const NOW = new Date('2026-08-24T23:30:00Z');

function buildMessage(overrides: Partial<InboxMessage> & { readonly uid: string }): InboxMessage {
  return {
    account_id: 'primary',
    message_id: null,
    thread_id: null,
    folder: 'INBOX',
    subject: 'Test subject',
    from_name: 'Test Sender',
    from_email: 'sender@example.com',
    to_emails: [],
    cc_emails: [],
    date: null,
    snippet: null,
    flags: [],
    labels: [],
    has_attach: false,
    size_bytes: null,
    attachments: [],
    ...overrides,
  };
}

describe('formatWhen', () => {
  it('shows a clock time for today', () => {
    expect(formatWhen('2026-08-24T21:05:00Z', NOW)).toMatch(/^\d{1,2}:\d{2}/);
  });

  it('shows a weekday within the last week', () => {
    expect(formatWhen('2026-08-21T10:00:00Z', NOW)).toMatch(/^[A-Z][a-z]{2}$/);
  });

  it('still shows a weekday at the 6-day boundary (inside the window)', () => {
    expect(formatWhen('2026-08-18T10:00:00Z', NOW)).toMatch(/^[A-Z][a-z]{2}$/);
  });

  it('switches to a date at the 7-day boundary (outside the window)', () => {
    expect(formatWhen('2026-08-17T10:00:00Z', NOW)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  it('shows a date beyond a week', () => {
    expect(formatWhen('2026-06-01T10:00:00Z', NOW)).toMatch(/Jun/);
  });

  it('never throws on a null or malformed date', () => {
    expect(() => formatWhen(null, NOW)).not.toThrow();
    expect(() => formatWhen('', NOW)).not.toThrow();
    expect(() => formatWhen('not-a-date', NOW)).not.toThrow();
  });

  // Stronger than "does not throw": pins the actual fallback value, so a
  // change that returns e.g. "Invalid Date" instead of failing loudly
  // still fails this test.
  it('returns an em dash — not an empty string or "Invalid Date" — for null, empty, or unparseable input', () => {
    expect(formatWhen(null, NOW)).toBe('—');
    expect(formatWhen('', NOW)).toBe('—');
    expect(formatWhen('not-a-date', NOW)).toBe('—');
  });
});

describe('groupByDay', () => {
  it('groups messages under day headers, newest day first', () => {
    const out = groupByDay([
      buildMessage({ uid: '3', date: '2026-08-24T10:00:00Z' }),
      buildMessage({ uid: '2', date: '2026-08-24T08:00:00Z' }),
      buildMessage({ uid: '1', date: '2026-08-23T22:00:00Z' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.messages).toHaveLength(2);
  });

  // Pins the exact order rather than just a count: this fails if the
  // groups came out oldest-first, or in input order, or in any order
  // other than newest calendar day first.
  it('would fail if day order were reversed: newest day is index 0', () => {
    const out = groupByDay([
      buildMessage({ uid: 'a', date: '2026-08-20T10:00:00Z' }), // oldest
      buildMessage({ uid: 'b', date: '2026-08-24T10:00:00Z' }), // newest
      buildMessage({ uid: 'c', date: '2026-08-22T10:00:00Z' }), // middle
    ]);
    expect(out.map((group) => group.messages.map((m) => m.uid))).toEqual([['b'], ['c'], ['a']]);
  });

  it('puts messages with no date in their own group rather than dropping them', () => {
    const out = groupByDay([buildMessage({ uid: '1', date: null })]);
    expect(out.flatMap((g) => g.messages)).toHaveLength(1);
  });

  // The brief's own sample test only checks the flattened length, which
  // would also pass if the dateless message were silently merged into an
  // unrelated day's group. This pins that it is KEPT, in a group of its
  // OWN, and that group is TRAILING — any of those three being violated
  // (dropped, merged, or placed first) fails this test.
  it('keeps a dateless message in its own trailing group, not merged or dropped', () => {
    const dated = buildMessage({ uid: 'dated', date: '2026-08-24T10:00:00Z' });
    const dateless = buildMessage({ uid: 'dateless', date: null });
    const out = groupByDay([dateless, dated]);

    expect(out).toHaveLength(2);
    expect(out[0]?.messages).toEqual([dated]);
    expect(out[out.length - 1]?.messages).toEqual([dateless]);
  });

  it('groups multiple dateless messages together in the single trailing group', () => {
    const out = groupByDay([
      buildMessage({ uid: '1', date: null }),
      buildMessage({ uid: '2', date: null }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.messages.map((m) => m.uid)).toEqual(['1', '2']);
  });

  it('returns an empty list for an empty inbox, not a placeholder group', () => {
    expect(groupByDay([])).toEqual([]);
  });

  it('treats an unparseable date string the same as a null date', () => {
    const out = groupByDay([buildMessage({ uid: '1', date: 'not-a-date' })]);
    expect(out).toHaveLength(1);
    expect(out[0]?.messages).toHaveLength(1);
  });

  // Immutability (project-wide rule, and DESIGN's own list ordering
  // depends on it not corrupting the caller's array). Freezing the input
  // turns any in-place mutation (`.sort()`, `.reverse()`, `.push()`) into
  // a thrown TypeError under strict mode, so this fails loudly — not just
  // "the order happens to still look right" — if a future edit sorts the
  // input array itself instead of a derived copy.
  it('does not mutate its input array (frozen input must not throw)', () => {
    const input = Object.freeze([
      buildMessage({ uid: '2', date: '2026-08-24T10:00:00Z' }),
      buildMessage({ uid: '1', date: '2026-08-20T10:00:00Z' }),
    ]);
    expect(() => groupByDay(input)).not.toThrow();
    // The frozen array's own element order is untouched — this is the
    // part that would fail if groupByDay had instead called `.slice()`
    // then silently returned messages in a mutated order derived from a
    // copy, masking an in-place sort attempt on a non-frozen array.
    expect(input.map((m) => m.uid)).toEqual(['2', '1']);
  });
});
