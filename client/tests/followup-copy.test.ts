import { describe, it, expect } from 'vitest';
import followupCopySource from '../src/followupCopy.ts?raw';
import followupViewSource from '../src/components/FollowupView.tsx?raw';
import followupRowSource from '../src/components/FollowupRow.tsx?raw';
import type { EngagementState, FollowupRow } from '../src/api';
import {
  ENGAGEMENT_RANK,
  ENGAGEMENT_STATES,
  emptyStateFor,
  engagementCopy,
  filterRows,
  formatRecipients,
  isQueueRow,
  rankRows,
  toReaderMessage,
} from '../src/followupCopy';

/**
 * The words the follow-up queue says, and the order it says them in.
 *
 * client/CLAUDE.md's standing constraint is that no test renders a
 * component, so every display decision here is a pure function and this
 * file is where they are pinned. The bans at the bottom are static source
 * scans over the three files this feature ships, for the same reason
 * tests/opens-rail-static-guards.test.ts scans the opens feed: a
 * regression in copy is silent, and nothing else would catch it.
 */

function row(overrides: Partial<FollowupRow> = {}): FollowupRow {
  return {
    accountId: 'harvard',
    uid: 1,
    folder: '[Gmail]/Sent Mail',
    subject: 'Q3 numbers',
    fromName: 'Valen',
    fromEmail: 'me@example.com',
    recipients: ['ada@x.com'],
    sentAtMs: 1_000,
    openCount: 0,
    distinctRecipientOpens: 0,
    lastOpenAtMs: null,
    hasReply: false,
    state: 'never-opened',
    ...overrides,
  };
}

describe('engagementCopy', () => {
  it('leads a repeat-opened row with the count', () => {
    expect(engagementCopy('opened-repeatedly', 3).lead).toBe('Opened 3×, no reply');
  });

  it('leads a single-open row with the plain form', () => {
    expect(engagementCopy('opened-no-reply', 1).lead).toBe('Opened, no reply');
  });

  it('says a replied thread is replied, and nothing more', () => {
    expect(engagementCopy('opened-replied', 4).lead).toBe('Replied');
  });

  it('says what is recorded, not what the recipient did, for a silent send', () => {
    // "Never opened" would be a claim about a person. "No opens recorded"
    // is a claim about our own records, which is the only one we can make.
    expect(engagementCopy('never-opened', 0).lead).toBe('No opens recorded');
  });

  it('says something honest and short when we cannot tell', () => {
    expect(engagementCopy('unverifiable', 0).lead).toBe('No signal yet');
  });

  it('renders never-opened and unverifiable as DIFFERENT text (spec 7A.2)', () => {
    // The whole point of the two states. Collapsing them is the lie.
    expect(engagementCopy('never-opened', 0).lead).not.toBe(engagementCopy('unverifiable', 0).lead);
  });

  it('gives the two queue states the waiting tone and the rest their own', () => {
    expect(engagementCopy('opened-no-reply', 1).tone).toBe('waiting');
    expect(engagementCopy('opened-repeatedly', 2).tone).toBe('waiting');
    expect(engagementCopy('never-opened', 0).tone).toBe('quiet');
    expect(engagementCopy('unverifiable', 0).tone).toBe('quiet');
    expect(engagementCopy('opened-replied', 1).tone).toBe('resolved');
  });

  it('never emits an empty lead, for any state or count', () => {
    for (const state of ENGAGEMENT_STATES) {
      for (const count of [0, 1, 2, 99]) {
        expect(engagementCopy(state, count).lead.length).toBeGreaterThan(0);
      }
    }
  });

  it('degrades an unrecognised state to the honest unknown, never to a confident one', () => {
    const copy = engagementCopy('something-invented-later' as EngagementState, 0);
    expect(copy.lead).toBe('No signal yet');
    expect(copy.tone).toBe('quiet');
  });

  it('falls back to the plain form if a repeat row arrives with a count of one', () => {
    expect(engagementCopy('opened-repeatedly', 1).lead).toBe('Opened, no reply');
  });
});

describe('ranking', () => {
  it('ranks repeat opens above a single open above no opens', () => {
    expect(ENGAGEMENT_RANK['opened-repeatedly']).toBeLessThan(ENGAGEMENT_RANK['opened-no-reply']);
    expect(ENGAGEMENT_RANK['opened-no-reply']).toBeLessThan(ENGAGEMENT_RANK['never-opened']);
  });

  it('ranks a replied thread last — a resolved thread is not a queue item', () => {
    for (const state of ENGAGEMENT_STATES) {
      if (state === 'opened-replied') continue;
      expect(ENGAGEMENT_RANK['opened-replied']).toBeGreaterThan(ENGAGEMENT_RANK[state]);
    }
  });

  it('orders by engagement first and by date only within a state', () => {
    const rows = [
      row({ uid: 1, state: 'never-opened', sentAtMs: 9_000 }),
      row({ uid: 2, state: 'opened-no-reply', sentAtMs: 1_000 }),
      row({ uid: 3, state: 'opened-repeatedly', sentAtMs: 2_000 }),
      row({ uid: 4, state: 'opened-no-reply', sentAtMs: 5_000 }),
    ];
    expect(rankRows(rows).map((ranked) => ranked.uid)).toEqual([3, 4, 2, 1]);
  });

  it('never mutates the array it was given', () => {
    const rows = [row({ uid: 1, state: 'never-opened' }), row({ uid: 2, state: 'opened-no-reply' })];
    const before = rows.map((each) => each.uid);
    rankRows(rows);
    expect(rows.map((each) => each.uid)).toEqual(before);
  });

  it('is total on an empty list', () => {
    expect(rankRows([])).toEqual([]);
  });
});

describe('the queue predicate', () => {
  it('holds exactly the two states that are read and unanswered', () => {
    expect(isQueueRow('opened-no-reply')).toBe(true);
    expect(isQueueRow('opened-repeatedly')).toBe(true);
    expect(isQueueRow('never-opened')).toBe(false);
    expect(isQueueRow('unverifiable')).toBe(false);
    expect(isQueueRow('opened-replied')).toBe(false);
  });

  it('filters to the queue and ranks in one pass', () => {
    const rows = [
      row({ uid: 1, state: 'opened-replied' }),
      row({ uid: 2, state: 'never-opened' }),
      row({ uid: 3, state: 'opened-no-reply' }),
    ];
    expect(filterRows(rows, 'queue').map((each) => each.uid)).toEqual([3]);
    expect(filterRows(rows, 'all').map((each) => each.uid)).toEqual([3, 2, 1]);
  });
});

describe('formatRecipients', () => {
  it('names one recipient outright', () => {
    expect(formatRecipients(['ada@x.com'])).toBe('ada@x.com');
  });

  it('names the first and counts the rest', () => {
    expect(formatRecipients(['ada@x.com', 'bo@x.com', 'cy@x.com'])).toBe('ada@x.com +2');
  });

  it('says so rather than rendering an empty column', () => {
    expect(formatRecipients([])).toBe('No recipients');
  });

  it('ignores a blank entry rather than counting it', () => {
    expect(formatRecipients(['ada@x.com', '   '])).toBe('ada@x.com');
  });
});

describe('emptyStateFor', () => {
  it('distinguishes an empty queue from an unreadable one', () => {
    const quiet = emptyStateFor('queue', true);
    const blind = emptyStateFor('queue', false);
    expect(quiet.title).not.toBe(blind.title);
  });

  it('never claims the queue is clear when read state could not be read', () => {
    expect(emptyStateFor('queue', false).title.toLowerCase()).not.toContain('clear');
  });

  it('has copy for every scope', () => {
    for (const scope of ['queue', 'all'] as const) {
      for (const available of [true, false]) {
        expect(emptyStateFor(scope, available).title.length).toBeGreaterThan(0);
        expect(emptyStateFor(scope, available).description.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('toReaderMessage', () => {
  it('carries the identity the reader fetches a body by', () => {
    const message = toReaderMessage(row({ accountId: 'harvard', uid: 12, folder: 'S' }));
    expect(message.account_id).toBe('harvard');
    expect(message.uid).toBe('12');
    expect(message.folder).toBe('S');
  });

  it('carries the real sender rather than inventing one', () => {
    const message = toReaderMessage(row({ fromName: 'Valen', fromEmail: 'me@example.com' }));
    expect(message.from_name).toBe('Valen');
    expect(message.from_email).toBe('me@example.com');
  });

  it('renders the sent time as the ISO string the reader formats', () => {
    expect(toReaderMessage(row({ sentAtMs: 0 })).date).toBe(new Date(0).toISOString());
  });

  it('claims nothing it does not know', () => {
    const message = toReaderMessage(row());
    expect(message.snippet).toBeNull();
    expect(message.flags).toEqual([]);
    expect(message.attachments).toEqual([]);
  });
});

/**
 * THE BANS. The user's own direction: "dont show the MPP mail thing just
 * give me as much information as possible i dont need any liek side
 * notes. Do it like superhuman or mailspring does it."
 *
 * Both halves are checked: every string these functions can produce, and
 * the source of all three files this feature ships (comments stripped, so
 * this note itself does not trip it).
 */
const BANNED = ['mpp', 'apple', 'privacy'];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const EVERY_COPY_STRING: readonly string[] = [
  ...ENGAGEMENT_STATES.flatMap((state) =>
    [0, 1, 2, 9].map((count) => engagementCopy(state, count).lead),
  ),
  ...(['queue', 'all'] as const).flatMap((scope) =>
    [true, false].flatMap((available) => [
      emptyStateFor(scope, available).title,
      emptyStateFor(scope, available).description,
    ]),
  ),
  formatRecipients([]),
  formatRecipients(['ada@x.com', 'bo@x.com']),
];

describe('no measurement caveats anywhere in this feature', () => {
  it.each(BANNED)('no copy string contains "%s"', (banned) => {
    for (const copy of EVERY_COPY_STRING) {
      expect(copy.toLowerCase()).not.toContain(banned);
    }
  });

  it.each(BANNED)('no rendered source in the view contains "%s"', (banned) => {
    const source = stripComments(
      `${followupCopySource}\n${followupViewSource}\n${followupRowSource}`,
    ).toLowerCase();
    expect(source).not.toContain(banned);
  });

  it('the source scan is not vacuous', () => {
    const buggy = stripComments('const note = "Apple Mail Privacy Protection";').toLowerCase();
    expect(buggy).toContain('apple');
    expect(buggy).toContain('privacy');
  });

  it('never reads a device class or an OS off a row', () => {
    const source = `${followupCopySource}\n${followupViewSource}\n${followupRowSource}`;
    expect(source).not.toMatch(/\.deviceClass\b/);
    expect(source).not.toMatch(/\.os\b/);
  });

  it('never imports a checkmark-shaped icon — the mark this product refuses', () => {
    const source = `${followupViewSource}\n${followupRowSource}`;
    expect(source).not.toMatch(/\bCheck(Circle2?|Square)?\b|\bBadgeCheck\b/);
  });
});
