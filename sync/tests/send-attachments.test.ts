import { describe, it, expect } from 'vitest';
import { chooseTokenStrategy, TRACKED_SEND_BYTE_BUDGET } from '../src/send/attachments';

/**
 * Spec §5.3.1 (BINDING) — the attachment multiplication rule.
 *
 * Named `send-attachments.test.ts` rather than the plan's
 * `attachments.test.ts` because that name is already taken by the RECEIVE
 * side (../src/attachments.ts, the BODYSTRUCTURE walk). Two unrelated
 * modules sharing one test file would make either one harder to read than
 * the rename costs.
 */

const MB = 1024 * 1024;

describe('TRACKED_SEND_BYTE_BUDGET', () => {
  it('is the 25 MB the spec names', () => {
    expect(TRACKED_SEND_BYTE_BUDGET).toBe(25 * 1024 * 1024);
  });
});

describe('chooseTokenStrategy', () => {
  it('keeps per-recipient tracking when there is nothing to multiply', () => {
    expect(chooseTokenStrategy(0, 25)).toBe('per-recipient');
  });

  it('keeps per-recipient tracking under the budget', () => {
    // 2 MB x 5 = 10 MB, well under 25 MB.
    expect(chooseTokenStrategy(2 * MB, 5)).toBe('per-recipient');
  });

  it('degrades once the MULTIPLIED size exceeds the budget, not the raw size', () => {
    // 10 MB alone is fine; 10 MB x 5 recipients is 50 MB of quota. This is the
    // case the whole rule exists for, and the one a naive size check misses.
    expect(chooseTokenStrategy(10 * MB, 1)).toBe('per-recipient');
    expect(chooseTokenStrategy(10 * MB, 5)).toBe('shared');
  });

  it('is exclusive at the boundary — exactly the budget is still allowed', () => {
    expect(chooseTokenStrategy(5 * MB, 5)).toBe('per-recipient');   // == 25 MB
    expect(chooseTokenStrategy(5 * MB + 1, 5)).toBe('shared');
  });

  it('degrades a modest attachment once the recipient list is long enough', () => {
    // 2 MB is unremarkable and 12 recipients is unremarkable; together they
    // are 24 MB, and one more recipient tips it. Nothing about either input
    // on its own would tell you that, which is the point.
    expect(chooseTokenStrategy(2 * MB, 12)).toBe('per-recipient');
    expect(chooseTokenStrategy(2 * MB, 13)).toBe('shared');
  });

  it('never degrades a plain text message, however many recipients it has', () => {
    // Degrading a message with nothing to multiply would throw away
    // attribution and save nothing at all.
    for (const recipientCount of [1, 2, 25]) {
      expect(chooseTokenStrategy(0, recipientCount)).toBe('per-recipient');
    }
  });
});

/**
 * Plan 11 Task 2 — validating what arrives on the wire.
 *
 * EVERY FIELD HERE IS ATTACKER-REACHABLE. `filename` becomes a
 * `Content-Disposition` parameter, `contentType` becomes a `Content-Type`
 * header, and `contentBase64` becomes the bytes of a file the recipient
 * will open. None of the three may be taken on trust.
 */

import {
  parseAttachments,
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_ATTACHMENT_FILENAME_CHARS,
} from '../src/send/attachments';

/** "hi" — the smallest attachment that is unambiguously well-formed. */
const HI = 'aGk=';
const NUL = String.fromCharCode(0);

function attachment(overrides: Record<string, unknown> = {}) {
  return { filename: 'a.txt', contentType: 'text/plain', contentBase64: HI, ...overrides };
}

/** A base64 payload of exactly `bytes` decoded bytes. */
function payloadOf(bytes: number): string {
  return Buffer.alloc(bytes, 0x41).toString('base64');
}

describe('parseAttachments — absence', () => {
  it('treats a missing field as no attachments, not as an error', () => {
    const parsed = parseAttachments(undefined);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.attachments).toEqual([]);
    expect(parsed.totalBytes).toBe(0);
  });

  it('treats null the same way — a client omitting the field must still send', () => {
    expect(parseAttachments(null).ok).toBe(true);
  });

  it('accepts an empty array', () => {
    const parsed = parseAttachments([]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.totalBytes).toBe(0);
  });

  it('refuses a non-array — an object of attachments is not a list of them', () => {
    expect(parseAttachments({ filename: 'a.txt' }).ok).toBe(false);
    expect(parseAttachments('a.txt').ok).toBe(false);
  });
});

describe('parseAttachments — filename', () => {
  it('rejects a filename containing CR or LF (Content-Disposition injection)', () => {
    // A newline here terminates the header and lets whatever follows
    // become a header of the sender's choosing.
    for (const nasty of ['a.txt\r\nX-Injected: 1', 'a.txt\nX-Injected: 1', 'a.txt\rboom']) {
      const parsed = parseAttachments([attachment({ filename: nasty })]);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.reason).toBe('unsafe_filename');
    }
  });

  it('rejects a filename containing a path separator', () => {
    for (const nasty of ['../../etc/passwd', 'dir/a.txt', 'dir\\a.txt', '..\\..\\win.ini']) {
      expect(parseAttachments([attachment({ filename: nasty })]).ok).toBe(false);
    }
  });

  it('rejects a filename containing NUL', () => {
    expect(parseAttachments([attachment({ filename: `a.txt${NUL}.exe` })]).ok).toBe(false);
  });

  it('rejects a filename that is nothing but dots', () => {
    // No separator to catch, but "." and ".." are the traversal tokens
    // themselves against any future code that writes the file down.
    expect(parseAttachments([attachment({ filename: '..' })]).ok).toBe(false);
    expect(parseAttachments([attachment({ filename: '.' })]).ok).toBe(false);
  });

  it('rejects an empty, blank, over-long or non-string filename', () => {
    expect(parseAttachments([attachment({ filename: '' })]).ok).toBe(false);
    expect(parseAttachments([attachment({ filename: '   ' })]).ok).toBe(false);
    expect(
      parseAttachments([attachment({ filename: 'x'.repeat(MAX_ATTACHMENT_FILENAME_CHARS + 1) })]).ok,
    ).toBe(false);
    expect(parseAttachments([attachment({ filename: 42 })]).ok).toBe(false);
  });

  it('accepts ordinary names, spaces, unicode and dots inside them', () => {
    for (const fine of ['report.pdf', 'Q3 deck.key', 'résumé.docx', 'archive.tar.gz', '.gitignore']) {
      const parsed = parseAttachments([attachment({ filename: fine })]);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.attachments[0]!.filename).toBe(fine);
    }
  });
});

describe('parseAttachments — contentType', () => {
  it('rejects anything that is not a conservative type/subtype', () => {
    for (const nasty of [
      'text',                       // no subtype
      'text/plain; charset=utf-8',  // parameters are not accepted
      'text/plain\r\nX-Injected: 1',
      '../../etc',
      '',
      'text/',
      '/plain',
      'te xt/plain',
    ]) {
      expect(parseAttachments([attachment({ contentType: nasty })]).ok).toBe(false);
    }
    expect(parseAttachments([attachment({ contentType: 7 })]).ok).toBe(false);
  });

  it('accepts the ordinary types a person actually attaches', () => {
    for (const fine of [
      'text/plain',
      'application/pdf',
      'image/png',
      'image/svg+xml',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]) {
      expect(parseAttachments([attachment({ contentType: fine })]).ok).toBe(true);
    }
  });
});

describe('parseAttachments — content', () => {
  it('rejects undecodable base64 rather than sending a truncated file', () => {
    // Buffer.from(s, "base64") SILENTLY DROPS characters it does not
    // recognise, so "not!base64" decodes to six bytes of garbage instead
    // of throwing. Without a strict check this is a corrupt file the
    // recipient cannot open, sent with no error anywhere.
    const parsed = parseAttachments([attachment({ contentBase64: 'not!base64' })]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('undecodable_content');
  });

  it('rejects base64 with the wrong padding or length', () => {
    for (const nasty of ['aa', 'aGk', 'aGk==', 'aGk=x', 'aG k=', 'aGk-']) {
      expect(parseAttachments([attachment({ contentBase64: nasty })]).ok).toBe(false);
    }
    expect(parseAttachments([attachment({ contentBase64: 99 })]).ok).toBe(false);
  });

  it('decodes to the exact bytes, not to the base64 text', () => {
    const parsed = parseAttachments([attachment({ contentBase64: HI })]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.attachments[0]!.content.toString('utf8')).toBe('hi');
  });
});

describe('parseAttachments — DECODED bytes, never base64 length', () => {
  it('counts decoded bytes: 3 raw bytes are 4 base64 characters', () => {
    const parsed = parseAttachments([attachment({ contentBase64: payloadOf(3) })]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(payloadOf(3)).toHaveLength(4);
    // The whole §5.3.1 budget is wrong by 33% if this ever returns 4.
    expect(parsed.totalBytes).toBe(3);
  });

  it('sums decoded bytes across every attachment', () => {
    const parsed = parseAttachments([
      attachment({ contentBase64: payloadOf(300) }),
      attachment({ filename: 'b.txt', contentBase64: payloadOf(45) }),
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.totalBytes).toBe(345);
  });
});

describe('parseAttachments — caps', () => {
  it('refuses more attachments than the count cap', () => {
    const many = Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, (_, index) =>
      attachment({ filename: `a${index}.txt` }),
    );
    const parsed = parseAttachments(many);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('too_many');
    expect(parseAttachments(many.slice(0, MAX_ATTACHMENT_COUNT)).ok).toBe(true);
  });

  it('refuses more DECODED bytes than the size cap, exclusive at the boundary', () => {
    const atCap = parseAttachments([
      attachment({ contentBase64: payloadOf(MAX_ATTACHMENT_TOTAL_BYTES) }),
    ]);
    expect(atCap.ok).toBe(true);

    const overCap = parseAttachments([
      attachment({ contentBase64: payloadOf(MAX_ATTACHMENT_TOTAL_BYTES - 3) }),
      attachment({ filename: 'b.bin', contentBase64: payloadOf(6) }),
    ]);
    expect(overCap.ok).toBe(false);
    if (overCap.ok) return;
    expect(overCap.reason).toBe('too_large');
  });
});

describe('parseAttachments — a multi-megabyte payload is data, not a stack', () => {
  it('validates a payload at the size cap without throwing', () => {
    // Regression: the canonical-base64 check was first written as
    // /^(?:[A-Za-z0-9+\/]{4})*.../ and that expression overflowed V8's
    // stack on a 10 MiB payload — a RangeError escaping the route on a
    // request whose length an attacker chooses.
    expect(() =>
      parseAttachments([attachment({ contentBase64: payloadOf(MAX_ATTACHMENT_TOTAL_BYTES) })]),
    ).not.toThrow();
  });

  it('refuses a multi-megabyte payload with one foreign character, without throwing', () => {
    const poisoned = `${payloadOf(MAX_ATTACHMENT_TOTAL_BYTES - 3).slice(0, -4)}!!!!`;
    let parsed: ReturnType<typeof parseAttachments> | null = null;
    expect(() => {
      parsed = parseAttachments([attachment({ contentBase64: poisoned })]);
    }).not.toThrow();
    expect(parsed!.ok).toBe(false);
  });
});

describe('parseAttachments — shape', () => {
  it('refuses an entry that is not an object', () => {
    expect(parseAttachments(['a.txt']).ok).toBe(false);
    expect(parseAttachments([null]).ok).toBe(false);
    expect(parseAttachments([[]]).ok).toBe(false);
  });

  it('does not mutate what it was given', () => {
    const input = [attachment()];
    const frozen = JSON.stringify(input);
    parseAttachments(input);
    expect(JSON.stringify(input)).toBe(frozen);
  });
});
