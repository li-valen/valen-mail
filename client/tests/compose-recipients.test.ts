import { describe, expect, it } from 'vitest';
import {
  MAX_RECIPIENT_CHARS,
  excludeRecipients,
  isValidRecipient,
  mergeRecipients,
  parseRecipients,
  splitPendingInput,
} from '../src/components/composeRecipients';

/**
 * The recipient-entry rules, tested as pure functions because no test in
 * this client renders a component (client/CLAUDE.md's standing
 * constraint). Everything the To/Cc fields do to a keystroke or a paste
 * happens in one of the four functions below, so testing them is testing
 * the field.
 */

describe('parseRecipients', () => {
  it('splits a comma-separated list', () => {
    expect(parseRecipients('a@x.com,b@y.com')).toEqual(['a@x.com', 'b@y.com']);
  });

  it('splits on whitespace as well as commas', () => {
    expect(parseRecipients('a@x.com b@y.com')).toEqual(['a@x.com', 'b@y.com']);
  });

  it('splits on a mixed run of commas and whitespace', () => {
    expect(parseRecipients('a@x.com, \t b@y.com,,\nc@z.com')).toEqual([
      'a@x.com',
      'b@y.com',
      'c@z.com',
    ]);
  });

  it('trims whitespace around every address', () => {
    expect(parseRecipients('   a@x.com   ')).toEqual(['a@x.com']);
  });

  it('drops empty segments rather than emitting blank recipients', () => {
    expect(parseRecipients(',,, ,,')).toEqual([]);
  });

  it('returns an empty list for an empty string', () => {
    expect(parseRecipients('')).toEqual([]);
  });

  it('de-duplicates repeats, preserving the order of first appearance', () => {
    expect(parseRecipients('b@y.com a@x.com b@y.com c@z.com a@x.com')).toEqual([
      'b@y.com',
      'a@x.com',
      'c@z.com',
    ]);
  });

  it('de-duplicates case-insensitively and keeps the FIRST appearance casing', () => {
    // Two SMTP sends to A@X.com and a@x.com are one send to one mailbox
    // as far as every provider is concerned — and would be two tokens,
    // two pixels and a duplicate copy in the recipient's inbox.
    expect(parseRecipients('A@X.com, a@x.com')).toEqual(['A@X.com']);
  });

  it('keeps addresses that are not valid — parsing is not validating', () => {
    // The chip has to appear before it can be marked wrong; silently
    // swallowing a typo would leave the user staring at a recipient list
    // missing someone they know they typed.
    expect(parseRecipients('not-an-address, b@y.com')).toEqual(['not-an-address', 'b@y.com']);
  });
});

describe('isValidRecipient', () => {
  it('accepts an ordinary address', () => {
    expect(isValidRecipient('someone@example.com')).toBe(true);
  });

  it('rejects an address with no @', () => {
    expect(isValidRecipient('someone.example.com')).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(isValidRecipient('')).toBe(false);
  });

  it('rejects a whitespace-only string', () => {
    expect(isValidRecipient('   ')).toBe(false);
  });

  it(`accepts an address of exactly ${MAX_RECIPIENT_CHARS} characters`, () => {
    const local = 'a'.repeat(MAX_RECIPIENT_CHARS - '@example.com'.length);
    const address = `${local}@example.com`;
    expect(address).toHaveLength(MAX_RECIPIENT_CHARS);
    expect(isValidRecipient(address)).toBe(true);
  });

  it(`rejects an address one character over ${MAX_RECIPIENT_CHARS}`, () => {
    const local = 'a'.repeat(MAX_RECIPIENT_CHARS + 1 - '@example.com'.length);
    const address = `${local}@example.com`;
    expect(address).toHaveLength(MAX_RECIPIENT_CHARS + 1);
    expect(isValidRecipient(address)).toBe(false);
  });

  it('rejects CR and LF — the SMTP header-injection vector the server also refuses', () => {
    expect(isValidRecipient('a@x.com\r\nBcc: victim@z.com')).toBe(false);
    expect(isValidRecipient('a@x.com\nsomething')).toBe(false);
  });

  it('rejects other C0 controls and DEL', () => {
    expect(isValidRecipient('a\u0000@x.com')).toBe(false);
    expect(isValidRecipient('a@x.com\u001F')).toBe(false);
    expect(isValidRecipient('a@x.com\u007F')).toBe(false);
  });

  it('measures length AFTER trimming, exactly as the server does', () => {
    const local = 'a'.repeat(MAX_RECIPIENT_CHARS - '@example.com'.length);
    expect(isValidRecipient(`  ${local}@example.com  `)).toBe(true);
  });
});

describe('splitPendingInput', () => {
  it('leaves a half-typed address in the pending tail with nothing committed', () => {
    expect(splitPendingInput('some')).toEqual({ committed: [], pending: 'some' });
  });

  it('commits an address the moment a comma is typed', () => {
    expect(splitPendingInput('a@x.com,')).toEqual({ committed: ['a@x.com'], pending: '' });
  });

  it('commits an address the moment a space is typed', () => {
    expect(splitPendingInput('a@x.com ')).toEqual({ committed: ['a@x.com'], pending: '' });
  });

  it('keeps the last address of a pasted list pending, committing the rest', () => {
    expect(splitPendingInput('a@x.com, b@y.com, c@z.com')).toEqual({
      committed: ['a@x.com', 'b@y.com'],
      pending: 'c@z.com',
    });
  });

  it('commits every address of a pasted list that ends in a separator', () => {
    expect(splitPendingInput('a@x.com, b@y.com, ')).toEqual({
      committed: ['a@x.com', 'b@y.com'],
      pending: '',
    });
  });

  it('commits nothing from whitespace alone', () => {
    expect(splitPendingInput('   ')).toEqual({ committed: [], pending: '' });
  });

  it('de-duplicates within what it commits', () => {
    expect(splitPendingInput('a@x.com a@x.com b@y.com')).toEqual({
      committed: ['a@x.com'],
      pending: 'b@y.com',
    });
  });
});

describe('mergeRecipients', () => {
  it('appends additions after the existing addresses', () => {
    expect(mergeRecipients(['a@x.com'], ['b@y.com'])).toEqual(['a@x.com', 'b@y.com']);
  });

  it('skips an addition already present, case-insensitively', () => {
    expect(mergeRecipients(['A@X.com'], ['a@x.com', 'b@y.com'])).toEqual(['A@X.com', 'b@y.com']);
  });

  it('de-duplicates within the additions themselves', () => {
    expect(mergeRecipients([], ['b@y.com', 'B@Y.com'])).toEqual(['b@y.com']);
  });

  it('never mutates the array it was given', () => {
    const existing = ['a@x.com'];
    const merged = mergeRecipients(existing, ['b@y.com']);
    expect(existing).toEqual(['a@x.com']);
    expect(merged).not.toBe(existing);
  });
});

describe('excludeRecipients', () => {
  it('removes an address, whatever case either side is written in', () => {
    // The whole reason ../src/replyDraft.ts can promise that reply-all
    // never mails the user themselves.
    expect(excludeRecipients(['ME@Example.com', 'bob@x.com'], ['me@example.com'])).toEqual([
      'bob@x.com',
    ]);
    expect(excludeRecipients(['me@example.com'], ['Me@Example.COM'])).toEqual([]);
  });

  it('removes every listed address, not just the first', () => {
    expect(excludeRecipients(['a@x.com', 'b@x.com', 'c@x.com'], ['a@x.com', 'c@x.com'])).toEqual([
      'b@x.com',
    ]);
  });

  it('keeps the surviving addresses in their original order', () => {
    expect(excludeRecipients(['a@x.com', 'b@x.com', 'c@x.com'], ['b@x.com'])).toEqual([
      'a@x.com',
      'c@x.com',
    ]);
  });

  it('changes nothing when the exclusion list is empty', () => {
    expect(excludeRecipients(['a@x.com'], [])).toEqual(['a@x.com']);
  });

  it('does not mutate either input', () => {
    const addresses = ['a@x.com', 'b@x.com'];
    const excluded = ['a@x.com'];
    excludeRecipients(addresses, excluded);
    expect(addresses).toEqual(['a@x.com', 'b@x.com']);
    expect(excluded).toEqual(['a@x.com']);
  });

  it('agrees with includesRecipient — one definition of "same mailbox"', () => {
    // Two different answers to that question is how the composer's chips
    // and the reply derivation eventually disagree about one person.
    expect(excludeRecipients(['A@X.com'], ['a@x.com'])).toEqual([]);
  });
});
