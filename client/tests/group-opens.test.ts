import { describe, it, expect } from 'vitest';
import {
  countEpisodes,
  groupOpens,
  partitionOpens,
  formatOpenRowSentence,
} from '../src/components/openEvents';
import type { OpenEvent } from '../src/api';

/**
 * The feed was a raw event log — one row per pixel fetch. Measured against
 * the live service: 26 rows for 10 actual recipient-copies, one message
 * drawing SIX rows across 22 hours. Read as a list that claims six
 * people-shaped events; mostly it is Gmail's proxy re-fetching one copy.
 */

const BASE: OpenEvent = {
  token: 'copy-a',
  accountId: 'primary',
  messageId: '<m@example.com>',
  recipientEmail: 'someone@elsewhere.test',
  subject: 'subject',
  sentAt: 1_000_000,
  occurredAt: 2_000_000,
  classification: 'open',
  deviceClass: 'desktop',
  os: 'macOS',
};
const at = (over: Partial<OpenEvent>): OpenEvent => ({ ...BASE, ...over });

/** An hour apart, which is past OPEN_EPISODE_GAP_MS — so these fixtures are
 *  separate readings, not one burst. The earlier version of this file spaced
 *  them milliseconds apart, which episode-counting correctly collapses to a
 *  single row; the counts below are about grouping, not coalescing, so they
 *  need gaps a human could actually produce. */
const HOUR = 60 * 60 * 1000;

describe('groupOpens — one recipient-copy is one row', () => {
  it('collapses repeat fetches of the same copy and counts them', () => {
    const rows = groupOpens([
      at({ occurredAt: 3 * HOUR }),
      at({ occurredAt: 2 * HOUR }),
      at({ occurredAt: 1 * HOUR }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(3);
  });

  it('keeps different copies apart — the token is the identity', () => {
    // Two recipients of the SAME message are two different reads, and must
    // not merge. Grouping by messageId would have merged them.
    const rows = groupOpens([
      at({ token: 'copy-a', occurredAt: 300 }),
      at({ token: 'copy-b', occurredAt: 200 }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.count)).toEqual([1, 1]);
  });

  it('reports the most recent time for the copy', () => {
    const rows = groupOpens([at({ occurredAt: 100 }), at({ occurredAt: 900 })]);
    expect(rows[0]?.occurredAt).toBe(900);
  });

  it('a confirmed read outranks a machine fetch in the same group', () => {
    // A proxy prefetch arriving later does not un-read a message a person
    // read, so the row is an open even when the newest event is not.
    const rows = groupOpens([
      at({ classification: 'prefetch', occurredAt: 900 }),
      at({ classification: 'open', occurredAt: 100 }),
    ]);
    expect(rows[0]?.classification).toBe('open');
  });

  it('counts only the winning classification, so a prefetch is never called a read', () => {
    // This is the overstatement the whole three-tone vocabulary exists to
    // avoid: five opens plus one machine fetch is "opened 5 times", not 6.
    const rows = groupOpens([
      at({ classification: 'prefetch', occurredAt: 1 * HOUR }),
      at({ classification: 'open', occurredAt: 2 * HOUR }),
      at({ classification: 'open', occurredAt: 4 * HOUR }),
    ]);
    expect(rows[0]?.count).toBe(2);
  });

  it('and times the row by that winning classification too', () => {
    // "opened, 2h ago" must point at an actual open, not at a later
    // machine fetch of the same copy.
    const rows = groupOpens([
      at({ classification: 'prefetch', occurredAt: 900 }),
      at({ classification: 'open', occurredAt: 300 }),
    ]);
    expect(rows[0]?.occurredAt).toBe(300);
  });

  it('falls back to the newest classification when nothing was ever confirmed', () => {
    const rows = groupOpens([
      at({ classification: 'prefetch', occurredAt: 100 }),
      at({ classification: 'mpp', occurredAt: 900 }),
    ]);
    expect(rows[0]?.classification).toBe('mpp');
    expect(rows[0]?.count).toBe(1);
  });

  it('returns rows newest-first', () => {
    const rows = groupOpens([
      at({ token: 'old', occurredAt: 100 }),
      at({ token: 'new', occurredAt: 900 }),
    ]);
    expect(rows.map((r) => r.token)).toEqual(['new', 'old']);
  });

  it('survives an empty feed', () => {
    expect(groupOpens([])).toEqual([]);
  });
});

describe('partitionOpens with grouping', () => {
  it('groups what it displays', () => {
    const { displayable } = partitionOpens([
      at({ occurredAt: 1 * HOUR }),
      at({ occurredAt: 3 * HOUR }),
    ]);
    expect(displayable).toHaveLength(1);
    expect(displayable[0]?.count).toBe(2);
  });

  it('still counts SELF views one by one, not one per message', () => {
    // "3 views from you" is a count of views. Grouping first would report
    // the number of messages instead, which is a different and smaller
    // number — and a silent understatement.
    const { selfCount, displayable } = partitionOpens([
      at({ classification: 'self', occurredAt: 1 }),
      at({ classification: 'self', occurredAt: 2 }),
      at({ classification: 'self', occurredAt: 3 }),
    ]);
    expect(selfCount).toBe(3);
    expect(displayable).toHaveLength(0);
  });

  it('counts self views correctly even when displayable rows are ALSO grouped', () => {
    // The previous case could not tell the two formulas apart: with nothing
    // displayable, `raw - displayable` and `raw - rawDisplayable` agree. The
    // tempting `sorted.length - displayable.length` subtracts GROUPED rows
    // from RAW events, so any collapsing inflates the self count. Found by
    // mutation-testing the test above, which stayed green.
    const { selfCount, displayable } = partitionOpens([
      at({ classification: 'self', occurredAt: 1 }),
      at({ classification: 'self', occurredAt: 2 }),
      at({ token: 'shown', classification: 'open', occurredAt: 3 * HOUR }),
      at({ token: 'shown', classification: 'open', occurredAt: 5 * HOUR }),
      at({ token: 'shown', classification: 'open', occurredAt: 7 * HOUR }),
    ]);
    expect(displayable).toHaveLength(1);
    expect(displayable[0]?.count).toBe(3);
    // Two self views. `5 - 1` would say four.
    expect(selfCount).toBe(2);
  });
});

describe('the row sentence says the count out loud', () => {
  it('includes it above one', () => {
    const [row] = groupOpens([at({ occurredAt: 3 * HOUR }), at({ occurredAt: HOUR })]);
    expect(formatOpenRowSentence(row!, 3 * HOUR)).toContain('opened 2 times');
  });

  it('and stays silent at exactly one, where it would carry no information', () => {
    const [row] = groupOpens([at({ occurredAt: 300 })]);
    expect(formatOpenRowSentence(row!, 300)).not.toContain('times');
  });
});

describe('countEpisodes — a burst of fetches is one reading, not many', () => {
  const MIN = 60_000;
  // The exact bursts the live service produced, which the feed reported as
  // four separate reads each.
  const burst = (minutesAfterSend: readonly number[]) =>
    minutesAfterSend
      .map((m) => at({ occurredAt: 1_000_000 + m * MIN }))
      .sort((a, b) => b.occurredAt - a.occurredAt);

  it('collapses the observed 14/18/19/23-minute burst into one', () => {
    expect(countEpisodes(burst([14, 18, 19, 23]))).toBe(1);
  });

  it('collapses the 14/19/23/50-minute burst too — its largest gap is 27 minutes', () => {
    expect(countEpisodes(burst([14, 19, 23, 50]))).toBe(1);
  });

  it('but a return the NEXT DAY is a second reading', () => {
    // Same copy, 22 hours later — the gap in the real data between the burst
    // and a genuinely separate visit.
    expect(countEpisodes(burst([14, 18, 19, 23, 22 * 60]))).toBe(2);
  });

  it('splits exactly at the window, not around it', () => {
    const justInside = burst([0, 29]);
    const justOutside = burst([0, 31]);
    expect(countEpisodes(justInside)).toBe(1);
    expect(countEpisodes(justOutside)).toBe(2);
  });

  it('is 1 for a single fetch and 0 for none', () => {
    expect(countEpisodes(burst([5]))).toBe(1);
    expect(countEpisodes([])).toBe(0);
  });

  it('feeds the row count, so the feed says 2 where it used to say 5', () => {
    const rows = groupOpens([
      at({ occurredAt: 1_000_000 + 14 * MIN }),
      at({ occurredAt: 1_000_000 + 18 * MIN }),
      at({ occurredAt: 1_000_000 + 19 * MIN }),
      at({ occurredAt: 1_000_000 + 23 * MIN }),
      at({ occurredAt: 1_000_000 + 22 * 60 * MIN }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(2);
  });
});
