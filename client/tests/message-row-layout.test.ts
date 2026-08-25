import { describe, it, expect } from 'vitest';
import {
  AVATAR_TONE_COUNT,
  NO_SUBJECT_LABEL,
  ROW_LINES,
  UNKNOWN_SENDER_LABEL,
  rowLayoutFor,
} from '../src/components/messageRowLayout';
import type { InboxMessage } from '../src/api';

/**
 * Plan 7 Task 3, and the one thing about the preview line that a test can
 * actually hold: **a row with a snippet and a row without one occupy the
 * same number of lines.**
 *
 * THE GROUND TRUTH THIS IS WRITTEN AGAINST. Plan 7 Task 1 populates
 * `snippet` on newly-synced mail only — backfill was explicitly out of
 * scope — so all 461 rows in the user's database have `snippet: null`
 * permanently and will sit next to populated ones forever. The mixed case
 * is not an edge case here; it is the ordinary case, and a row anatomy
 * that only looks right with a snippet would look broken on almost every
 * message the user owns today.
 *
 * THE ANATOMY THAT SATISFIES BOTH HALVES. Two lines, always:
 *
 *     line 1   sender ······································ meta
 *     line 2   Subject — the preview, muted, same line
 *
 * The snippet EXTENDS line 2 rather than adding a line 3. That is the
 * whole trick, and it is Gmail's: a row without a preview is just
 * "Subject", a row with one is "Subject — preview", both are two lines
 * tall, and nothing anywhere reserves an empty line for a snippet that
 * may never arrive. `subject` therefore has to be non-empty for EVERY
 * message — the `(no subject)` fallback is what keeps line 2 occupied
 * when a message has neither a subject nor a snippet, which is the row
 * that would otherwise collapse.
 *
 * `preview` is `null` and never `''` for a row without one, so the
 * component renders no node at all rather than an empty span with its own
 * margin. The wire contract says `snippet` is never `''` either; this
 * normalises anyway, because "the server promised" is not a thing a
 * boundary gets to assume.
 */

function buildMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    account_id: 'primary',
    uid: '1',
    message_id: '<a@example.com>',
    thread_id: null,
    folder: 'INBOX',
    subject: 'Q3 numbers',
    from_name: 'Kate Bell',
    from_email: 'kate@example.com',
    to_emails: null,
    cc_emails: null,
    date: '2026-08-25T10:00:00.000Z',
    snippet: null,
    flags: null,
    labels: null,
    has_attach: false,
    size_bytes: null,
    attachments: [],
    ...overrides,
  };
}

describe('rowLayoutFor — the null-snippet row and the with-snippet row are the same height', () => {
  it('reports the same line count for both', () => {
    const without = rowLayoutFor(buildMessage({ snippet: null }));
    const withOne = rowLayoutFor(buildMessage({ snippet: 'Numbers attached, see tab two.' }));
    expect(without.lines).toBe(withOne.lines);
    expect(without.lines).toBe(ROW_LINES);
  });

  it('occupies exactly two lines even with neither a subject nor a snippet', () => {
    const bare = rowLayoutFor(buildMessage({ subject: null, snippet: null }));
    expect(bare.lines).toBe(ROW_LINES);
    // The fallback is what keeps line 2 from being blank — the row that
    // would otherwise be the shortest in the list.
    expect(bare.subject).toBe(NO_SUBJECT_LABEL);
    expect(bare.subject.length).toBeGreaterThan(0);
  });

  it('keeps line 2 non-empty for every message, which is what fixes the height', () => {
    const cases: readonly InboxMessage[] = [
      buildMessage({ subject: null, snippet: null }),
      buildMessage({ subject: '', snippet: null }),
      buildMessage({ subject: 'Only a subject', snippet: null }),
      buildMessage({ subject: null, snippet: 'Only a snippet' }),
      buildMessage({ subject: 'Both', snippet: 'and a preview' }),
    ];
    for (const message of cases) {
      const layout = rowLayoutFor(message);
      expect(layout.subject.length).toBeGreaterThan(0);
      expect(layout.lines).toBe(ROW_LINES);
    }
  });

  it('adding a snippet to a message changes only the preview, never the line count', () => {
    const base = buildMessage({ subject: 'Dinner Friday?' });
    const without = rowLayoutFor(base);
    const withOne = rowLayoutFor({ ...base, snippet: 'Are we still on for 7?' });
    expect({ ...without, preview: null }).toEqual({ ...withOne, preview: null });
    expect(without.preview).toBeNull();
    expect(withOne.preview).toBe('Are we still on for 7?');
  });
});

describe('rowLayoutFor — preview normalisation', () => {
  it('is null, never the empty string, when there is no snippet', () => {
    expect(rowLayoutFor(buildMessage({ snippet: null })).preview).toBeNull();
  });

  it('is null for a snippet that is empty or only whitespace', () => {
    // The wire contract says this never happens. Normalised anyway: an
    // empty span still costs the gap its parent puts between children.
    expect(rowLayoutFor(buildMessage({ snippet: '' })).preview).toBeNull();
    expect(rowLayoutFor(buildMessage({ snippet: '   \n\t ' })).preview).toBeNull();
  });

  it('collapses the newlines and runs of spaces that body text arrives with', () => {
    const layout = rowLayoutFor(
      buildMessage({ snippet: 'Hi Valen,\n\nThe report   is ready.\r\nThanks' }),
    );
    expect(layout.preview).toBe('Hi Valen, The report is ready. Thanks');
  });

  it('trims the ends without touching the interior', () => {
    expect(rowLayoutFor(buildMessage({ snippet: '  two words  ' })).preview).toBe('two words');
  });
});

describe('rowLayoutFor — sender and subject', () => {
  it('prefers the display name, falls back to the address, then to a label', () => {
    expect(rowLayoutFor(buildMessage()).sender).toBe('Kate Bell');
    expect(rowLayoutFor(buildMessage({ from_name: null })).sender).toBe('kate@example.com');
    expect(rowLayoutFor(buildMessage({ from_name: '', from_email: '' })).sender).toBe(
      UNKNOWN_SENDER_LABEL,
    );
    expect(rowLayoutFor(buildMessage({ from_name: null, from_email: null })).sender).toBe(
      UNKNOWN_SENDER_LABEL,
    );
  });

  it('treats a whitespace-only display name as absent rather than rendering a blank column', () => {
    expect(rowLayoutFor(buildMessage({ from_name: '   ' })).sender).toBe('kate@example.com');
  });

  it('collapses whitespace in a subject, which arrives folded across header lines', () => {
    expect(rowLayoutFor(buildMessage({ subject: 'Re:\r\n  your  application' })).subject).toBe(
      'Re: your application',
    );
  });

  /**
   * XSS: every one of these three fields is attacker-authored — any
   * sender picks their own display name and subject, and `snippet` is
   * their message body. This helper returns PLAIN STRINGS and never
   * markup, so the component can only ever interpolate them as JSX text
   * children, which React escapes. Asserted so a future "helpful"
   * highlight-the-match feature cannot start returning HTML from here
   * without a test going red.
   */
  it('returns the text verbatim, never markup, for attacker-authored fields', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const layout = rowLayoutFor(
      buildMessage({ from_name: hostile, subject: hostile, snippet: hostile }),
    );
    expect(layout.sender).toBe(hostile);
    expect(layout.subject).toBe(hostile);
    expect(layout.preview).toBe(hostile);
  });
});

/**
 * The circular initial avatar, which exists only below `lg:` — the
 * Gmail-mobile row the user asked for by screenshot. Both fields are
 * derived here rather than in the component so that "the same sender
 * always gets the same circle" is a property a test can hold, instead of
 * something that happens to be true of one render.
 */
describe('rowLayoutFor — the avatar', () => {
  it('takes the first letter of the display name, uppercased', () => {
    expect(rowLayoutFor(buildMessage({ from_name: 'Kate Bell' })).initial).toBe('K');
    expect(rowLayoutFor(buildMessage({ from_name: 'linsoul audio' })).initial).toBe('L');
  });

  it('skips a leading emoji or bracket rather than rendering every sender as the same glyph', () => {
    // Real senders in this mailbox: "🎒Last 24 Hours to Save…",
    // "[A-Ravioli/pokerbot]". Indexing character zero would give a whole
    // column of identical circles.
    expect(rowLayoutFor(buildMessage({ from_name: '🎒 Linsoul Audio' })).initial).toBe('L');
    expect(rowLayoutFor(buildMessage({ from_name: '[GitHub] Arav' })).initial).toBe('G');
    expect(rowLayoutFor(buildMessage({ from_name: '5% Off Store' })).initial).toBe('5');
  });

  it('falls back to the address, then to the label, like the sender does', () => {
    expect(rowLayoutFor(buildMessage({ from_name: null })).initial).toBe('K');
    expect(
      rowLayoutFor(buildMessage({ from_name: null, from_email: null })).initial,
    ).toBe('U');
  });

  it('always yields exactly one glyph', () => {
    for (const from_name of ['Kate', '🎒🎒🎒', '   ', '!!!', 'ünter']) {
      expect(Array.from(rowLayoutFor(buildMessage({ from_name })).initial)).toHaveLength(1);
    }
  });

  it('gives the same sender the same tone every time', () => {
    const first = rowLayoutFor(buildMessage({ uid: '1' })).tone;
    const second = rowLayoutFor(buildMessage({ uid: '99', subject: 'Different' })).tone;
    expect(first).toBe(second);
  });

  it('keys the tone on the ADDRESS, so a display-name change keeps the colour', () => {
    const beforeRename = rowLayoutFor(buildMessage({ from_name: 'Kate Bell' })).tone;
    const afterRename = rowLayoutFor(buildMessage({ from_name: 'Kate B. (Acme)' })).tone;
    expect(afterRename).toBe(beforeRename);
  });

  it('is case-insensitive about the address, which mail servers are too', () => {
    const lower = rowLayoutFor(buildMessage({ from_email: 'kate@example.com' })).tone;
    const upper = rowLayoutFor(buildMessage({ from_email: 'Kate@Example.COM' })).tone;
    expect(upper).toBe(lower);
  });

  it('stays inside the palette for every sender', () => {
    const addresses = [
      'a@b.com', 'kate@example.com', 'no-reply@my.harvard.edu', 'shein@shein.com',
      'notifications@github.com', 'x@y.z', '', 'a'.repeat(300) + '@long.example',
    ];
    for (const from_email of addresses) {
      const { tone } = rowLayoutFor(buildMessage({ from_email }));
      expect(Number.isInteger(tone)).toBe(true);
      expect(tone).toBeGreaterThanOrEqual(0);
      expect(tone).toBeLessThan(AVATAR_TONE_COUNT);
    }
  });

  it('spreads a realistic set of senders over more than one tone (not vacuous)', () => {
    const tones = new Set(
      ['kate@example.com', 'shein@shein.com', 'no-reply@my.harvard.edu', 'a@github.com',
       'hi@linsoul.com', 'news@uniqlo.com', 'x@papajohns.com', 'q@skechers.com'].map(
        (from_email) => rowLayoutFor(buildMessage({ from_email })).tone,
      ),
    );
    expect(tones.size).toBeGreaterThan(2);
  });
});
