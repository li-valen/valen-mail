import { describe, it, expect } from 'vitest';
import { groupOpens, partitionOpens, formatOpenRowSentence } from '../src/components/openEvents';
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

describe('groupOpens — one recipient-copy is one row', () => {
  it('collapses repeat fetches of the same copy and counts them', () => {
    const rows = groupOpens([
      at({ occurredAt: 300 }),
      at({ occurredAt: 200 }),
      at({ occurredAt: 100 }),
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
      at({ classification: 'prefetch', occurredAt: 10 }),
      at({ classification: 'open', occurredAt: 20 }),
      at({ classification: 'open', occurredAt: 30 }),
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
    const { displayable } = partitionOpens([at({ occurredAt: 1 }), at({ occurredAt: 2 })]);
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
      at({ token: 'shown', classification: 'open', occurredAt: 3 }),
      at({ token: 'shown', classification: 'open', occurredAt: 4 }),
      at({ token: 'shown', classification: 'open', occurredAt: 5 }),
    ]);
    expect(displayable).toHaveLength(1);
    expect(displayable[0]?.count).toBe(3);
    // Two self views. `5 - 1` would say four.
    expect(selfCount).toBe(2);
  });
});

describe('the row sentence says the count out loud', () => {
  it('includes it above one', () => {
    const [row] = groupOpens([at({ occurredAt: 300 }), at({ occurredAt: 200 })]);
    expect(formatOpenRowSentence(row!, 300)).toContain('opened 2 times');
  });

  it('and stays silent at exactly one, where it would carry no information', () => {
    const [row] = groupOpens([at({ occurredAt: 300 })]);
    expect(formatOpenRowSentence(row!, 300)).not.toContain('times');
  });
});
