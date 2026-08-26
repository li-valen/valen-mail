import { describe, it, expect } from 'vitest';
import {
  DISPLAY_LOCALE,
  FALLBACK_LOCALE,
  cachedDateTimeFormat,
  resolveDisplayLocale,
} from '../src/displayLocale';
import { formatReceived, formatWhen, groupByDay } from '../src/components/inboxDates';
import type { InboxMessage } from '../src/api';

/**
 * src/displayLocale.ts - the module that decides whose calendar the
 * mailbox's dates are written in, replacing the hardcoded `'en-US'` that
 * used to sit in five places in components/inboxDates.ts.
 *
 * `resolveDisplayLocale` is the only part with real branching, and it is
 * pure by construction (the browser list is passed in), so it is tested
 * directly rather than by rendering anything - client/CLAUDE.md's
 * standing constraint.
 *
 * These tests assert BEHAVIOUR under a pinned locale and the resolution
 * rules themselves. What they deliberately do NOT assert is the exact
 * text a non-en-US locale produces: `Intl` output for a given tag is ICU
 * data, it moves between Node and browser versions, and pinning it would
 * be testing ICU rather than this app. The contract this file locks down
 * is "the locale argument is honoured, and a bad one never throws".
 */

const NOW = new Date('2026-08-24T23:30:00Z');

function buildMessage(date: string | null): InboxMessage {
  return {
    account_id: 'primary',
    uid: '1',
    message_id: null,
    thread_id: null,
    folder: 'INBOX',
    subject: 'Test subject',
    from_name: 'Test Sender',
    from_email: 'sender@example.com',
    to_emails: [],
    cc_emails: [],
    date,
    snippet: null,
    flags: [],
    labels: [],
    has_attach: false,
    size_bytes: null,
    attachments: [],
  };
}

describe('resolveDisplayLocale', () => {
  it('takes the first candidate the runtime can actually format with', () => {
    expect(resolveDisplayLocale(['en-GB', 'en-US'])).toBe('en-GB');
  });

  it('falls back when the browser offers nothing at all', () => {
    expect(resolveDisplayLocale(undefined)).toBe(FALLBACK_LOCALE);
    expect(resolveDisplayLocale([])).toBe(FALLBACK_LOCALE);
  });

  it('skips a structurally invalid tag instead of throwing on it', () => {
    // `supportedLocalesOf` throws a RangeError for these rather than
    // returning an empty list, which is the case a naive loop gets wrong.
    expect(() => resolveDisplayLocale(['en_US'])).not.toThrow();
    expect(resolveDisplayLocale(['en_US', 'en-GB'])).toBe('en-GB');
    expect(resolveDisplayLocale(['not a tag'])).toBe(FALLBACK_LOCALE);
  });

  it('skips empty and non-string entries rather than resolving to them', () => {
    expect(resolveDisplayLocale(['', 'en-GB'])).toBe('en-GB');
    expect(resolveDisplayLocale([undefined as unknown as string, 'en-GB'])).toBe('en-GB');
  });

  it('honours an explicit fallback', () => {
    expect(resolveDisplayLocale([], 'de-DE')).toBe('de-DE');
  });

  it('resolves the app-wide locale to something usable at import time', () => {
    expect(typeof DISPLAY_LOCALE).toBe('string');
    expect(DISPLAY_LOCALE.length).toBeGreaterThan(0);
    expect(() => new Intl.DateTimeFormat(DISPLAY_LOCALE)).not.toThrow();
  });
});

describe('cachedDateTimeFormat', () => {
  it('returns the SAME formatter instance for the same key and locale', () => {
    // This is the whole point: a fresh `Intl.DateTimeFormat` per row is
    // the cost this replaces, so identity is the property under test.
    const a = cachedDateTimeFormat('test-clock', 'en-US', { hour: 'numeric' });
    const b = cachedDateTimeFormat('test-clock', 'en-US', { hour: 'numeric' });
    expect(a).toBe(b);
  });

  it('keys on the locale as well as the option-set name', () => {
    const us = cachedDateTimeFormat('test-clock', 'en-US', { hour: 'numeric' });
    const gb = cachedDateTimeFormat('test-clock', 'en-GB', { hour: 'numeric' });
    expect(us).not.toBe(gb);
    expect(gb.resolvedOptions().locale).toBe('en-GB');
  });
});

describe('the inbox formatters honour the locale they are given', () => {
  it('formatWhen puts the day before the month for en-GB and after it for en-US', () => {
    // The single clearest observable difference between the two, and the
    // reason a hardcoded locale was wrong: same instant, same timezone,
    // two different readings.
    const iso = '2026-06-01T10:00:00Z';
    expect(formatWhen(iso, NOW, 'en-US')).toBe('Jun 1');
    expect(formatWhen(iso, NOW, 'en-GB')).toBe('1 Jun');
  });

  it('formatWhen uses a 24-hour clock where the locale does', () => {
    const iso = '2026-08-24T14:32:00Z';
    expect(formatWhen(iso, NOW, 'en-US')).toBe('2:32 PM');
    expect(formatWhen(iso, NOW, 'en-GB')).toBe('14:32');
  });

  it('formatReceived honours the locale too, so row and header agree', () => {
    const iso = '2026-08-24T14:32:00Z';
    expect(formatReceived(iso, 'en-GB')).toContain('14:32');
    expect(formatReceived(iso, 'en-US')).toContain('2:32');
  });

  it('groupByDay day rules follow the locale, but Today/Yesterday stay English', () => {
    // The deliberate split this app makes: FORMAT is the reader's,
    // COPY is the product's. See src/displayLocale.ts's header.
    const older = groupByDay([buildMessage('2026-08-20T10:00:00Z')], NOW, 'en-GB');
    expect(older[0]?.day).toBe('Thu 20 Aug');

    const today = groupByDay([buildMessage('2026-08-24T10:00:00Z')], NOW, 'en-GB');
    expect(today[0]?.day).toBe('Today');
  });

  it('still degrades to an em dash for unparseable input in any locale', () => {
    expect(formatWhen(null, NOW, 'en-GB')).toBe('—');
    expect(formatReceived('not a date', 'en-GB')).toBe('—');
  });
});
