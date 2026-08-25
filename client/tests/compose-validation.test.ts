import { describe, expect, it } from 'vitest';
import {
  MAX_IDENTITY_ID_CHARS,
  MAX_RECIPIENTS,
  MAX_SUBJECT_CHARS,
  MAX_TEXT_BODY_BYTES,
  hasDraftContent,
  textBodyBytes,
  validateCompose,
} from '../src/components/composeValidation';
import type { ComposeDraft } from '../src/components/composeValidation';

/**
 * Client-side mirror of every cap sync/src/api/send.ts enforces.
 *
 * The server answers one fixed string — `{"error":"invalid request body"}`
 * — for every one of these, deliberately (it must never echo a recipient
 * list or a subject back into a log). That is exactly why this file
 * exists: without it the user's only feedback for a 200-character-too-long
 * subject would be an opaque 400. Every threshold below is checked at the
 * boundary AND one past it, so a client cap that drifts off the server's
 * fails here rather than in production.
 */

const VALID: ComposeDraft = {
  identityId: 'primary',
  to: ['someone@example.com'],
  cc: [],
  subject: 'Hello',
  textBody: 'Hi there.',
};

/** `n` distinct, individually valid addresses. */
function addresses(n: number, prefix = 'r'): readonly string[] {
  return Array.from({ length: n }, (_, index) => `${prefix}${index}@example.com`);
}

describe('validateCompose — a well-formed draft', () => {
  it('reports no errors at all', () => {
    const validation = validateCompose(VALID);
    expect(validation.errors).toEqual({});
    expect(validation.isValid).toBe(true);
  });

  it('accepts an empty subject, exactly as the server does', () => {
    expect(validateCompose({ ...VALID, subject: '' }).isValid).toBe(true);
  });

  it('accepts an empty body, exactly as the server does', () => {
    expect(validateCompose({ ...VALID, textBody: '' }).isValid).toBe(true);
  });
});

describe('validateCompose — the sending identity', () => {
  it('refuses an empty identity id', () => {
    const validation = validateCompose({ ...VALID, identityId: '' });
    expect(validation.errors.identityId).toBeDefined();
    expect(validation.isValid).toBe(false);
  });

  it(`accepts an identity id of exactly ${MAX_IDENTITY_ID_CHARS} characters`, () => {
    const identityId = 'a'.repeat(MAX_IDENTITY_ID_CHARS);
    expect(validateCompose({ ...VALID, identityId }).errors.identityId).toBeUndefined();
  });

  it(`refuses an identity id one character over ${MAX_IDENTITY_ID_CHARS}`, () => {
    const identityId = 'a'.repeat(MAX_IDENTITY_ID_CHARS + 1);
    expect(validateCompose({ ...VALID, identityId }).errors.identityId).toBeDefined();
  });
});

describe('validateCompose — recipients', () => {
  it('refuses a draft with no To recipient', () => {
    const validation = validateCompose({ ...VALID, to: [] });
    expect(validation.errors.to).toBeDefined();
    expect(validation.isValid).toBe(false);
  });

  it('does not require a Cc recipient', () => {
    expect(validateCompose({ ...VALID, cc: [] }).errors.cc).toBeUndefined();
  });

  it('flags an invalid address in To, on the To field', () => {
    const validation = validateCompose({ ...VALID, to: ['someone@example.com', 'oops'] });
    expect(validation.errors.to).toBeDefined();
    expect(validation.errors.cc).toBeUndefined();
  });

  it('flags an invalid address in Cc, on the Cc field', () => {
    const validation = validateCompose({ ...VALID, cc: ['oops'] });
    expect(validation.errors.cc).toBeDefined();
    expect(validation.errors.to).toBeUndefined();
  });

  it('flags an over-long address, matching the server 254-character forward-path bound', () => {
    const tooLong = `${'a'.repeat(250)}@example.com`;
    expect(validateCompose({ ...VALID, to: [tooLong] }).errors.to).toBeDefined();
  });

  it('flags an address carrying a CRLF header-injection payload', () => {
    const injected = 'a@x.com\r\nBcc: victim@z.com';
    expect(validateCompose({ ...VALID, to: [injected] }).errors.to).toBeDefined();
  });
});

describe(`validateCompose — the ${MAX_RECIPIENTS}-recipient cap is on To AND Cc COMBINED`, () => {
  it('accepts 24 in To plus 1 in Cc', () => {
    const validation = validateCompose({
      ...VALID,
      to: addresses(MAX_RECIPIENTS - 1, 'to'),
      cc: addresses(1, 'cc'),
    });
    expect(validation.errors.recipients).toBeUndefined();
    expect(validation.isValid).toBe(true);
  });

  it('refuses 13 in To plus 13 in Cc — neither field is over on its own', () => {
    const validation = validateCompose({ ...VALID, to: addresses(13, 'to'), cc: addresses(13, 'cc') });
    expect(validation.errors.recipients).toBeDefined();
    expect(validation.isValid).toBe(false);
  });

  it('refuses 26 in To with an empty Cc', () => {
    const validation = validateCompose({ ...VALID, to: addresses(MAX_RECIPIENTS + 1, 'to') });
    expect(validation.errors.recipients).toBeDefined();
  });

  it('accepts exactly 25 in To with an empty Cc', () => {
    const validation = validateCompose({ ...VALID, to: addresses(MAX_RECIPIENTS, 'to') });
    expect(validation.errors.recipients).toBeUndefined();
  });

  it('names the combined total, so the message is not read as a per-field cap', () => {
    const validation = validateCompose({ ...VALID, to: addresses(13, 'to'), cc: addresses(13, 'cc') });
    expect(validation.errors.recipients).toContain('26');
  });
});

describe(`validateCompose — the ${MAX_SUBJECT_CHARS}-character subject cap`, () => {
  it(`accepts a subject of exactly ${MAX_SUBJECT_CHARS} characters`, () => {
    expect(validateCompose({ ...VALID, subject: 'a'.repeat(MAX_SUBJECT_CHARS) }).errors.subject)
      .toBeUndefined();
  });

  it(`refuses a subject one character over ${MAX_SUBJECT_CHARS}`, () => {
    const validation = validateCompose({ ...VALID, subject: 'a'.repeat(MAX_SUBJECT_CHARS + 1) });
    expect(validation.errors.subject).toBeDefined();
    expect(validation.isValid).toBe(false);
  });

  it('refuses a newline in the subject — the server refuses CR and LF there too', () => {
    expect(validateCompose({ ...VALID, subject: 'two\nlines' }).errors.subject).toBeDefined();
    expect(validateCompose({ ...VALID, subject: 'two\rlines' }).errors.subject).toBeDefined();
  });
});

describe('textBodyBytes — UTF-8 bytes, never characters', () => {
  it('counts ASCII as one byte each', () => {
    expect(textBodyBytes('hello')).toBe(5);
  });

  it('counts a two-byte Latin-1 supplement character as two', () => {
    expect(textBodyBytes('é')).toBe(2);
  });

  it('counts an astral-plane emoji as four bytes, not its two UTF-16 units', () => {
    expect('😀'.length).toBe(2);
    expect(textBodyBytes('😀')).toBe(4);
  });

  it('counts an empty string as zero', () => {
    expect(textBodyBytes('')).toBe(0);
  });
});

describe(`validateCompose — the ${MAX_TEXT_BODY_BYTES}-BYTE body cap`, () => {
  it('accepts an ASCII body of exactly the cap', () => {
    const textBody = 'a'.repeat(MAX_TEXT_BODY_BYTES);
    expect(validateCompose({ ...VALID, textBody }).errors.textBody).toBeUndefined();
  });

  it('refuses an ASCII body one byte over the cap', () => {
    const textBody = 'a'.repeat(MAX_TEXT_BODY_BYTES + 1);
    expect(validateCompose({ ...VALID, textBody }).errors.textBody).toBeDefined();
  });

  it('accepts an all-emoji body of exactly the cap — 25,600 four-byte emoji', () => {
    const textBody = '😀'.repeat(MAX_TEXT_BODY_BYTES / 4);
    expect(textBodyBytes(textBody)).toBe(MAX_TEXT_BODY_BYTES);
    expect(validateCompose({ ...VALID, textBody }).errors.textBody).toBeUndefined();
  });

  it('refuses an all-emoji body ONE EMOJI over the cap, which a character count would wave through', () => {
    // The whole point of measuring bytes: this string is 51,202 UTF-16
    // units — half the character cap anyone would naively write — and
    // 102,404 bytes on the wire, four bytes past what the server accepts.
    const textBody = '😀'.repeat(MAX_TEXT_BODY_BYTES / 4 + 1);
    expect(textBody.length).toBeLessThan(MAX_TEXT_BODY_BYTES);
    expect(textBodyBytes(textBody)).toBe(MAX_TEXT_BODY_BYTES + 4);
    const validation = validateCompose({ ...VALID, textBody });
    expect(validation.errors.textBody).toBeDefined();
    expect(validation.isValid).toBe(false);
  });
});

describe('validateCompose — several problems at once', () => {
  it('reports every field that is wrong rather than stopping at the first', () => {
    const validation = validateCompose({
      identityId: '',
      to: [],
      cc: ['nope'],
      subject: 'a'.repeat(MAX_SUBJECT_CHARS + 1),
      textBody: 'a'.repeat(MAX_TEXT_BODY_BYTES + 1),
    });
    expect(Object.keys(validation.errors).sort()).toEqual([
      'cc',
      'identityId',
      'subject',
      'textBody',
      'to',
    ]);
    expect(validation.isValid).toBe(false);
  });

  it('never mutates the draft it was handed', () => {
    const draft: ComposeDraft = { ...VALID, to: ['a@x.com'] };
    const before = JSON.stringify(draft);
    validateCompose(draft);
    expect(JSON.stringify(draft)).toBe(before);
  });
});

describe('hasDraftContent — what makes a close worth confirming', () => {
  it('is false for an untouched draft', () => {
    expect(hasDraftContent({ ...VALID, to: [], subject: '', textBody: '' })).toBe(false);
  });

  it('is false when the body is nothing but whitespace', () => {
    expect(hasDraftContent({ ...VALID, to: [], subject: '', textBody: '   \n\t ' })).toBe(false);
  });

  it('is true once the body has real text', () => {
    expect(hasDraftContent({ ...VALID, to: [], subject: '', textBody: 'draft' })).toBe(true);
  });

  it('is true for a subject with no body — a typed subject is still work to lose', () => {
    expect(hasDraftContent({ ...VALID, to: [], subject: 'Re: budget', textBody: '' })).toBe(true);
  });

  it('is true for a recipient list with no body', () => {
    expect(hasDraftContent({ ...VALID, to: ['a@x.com'], subject: '', textBody: '' })).toBe(true);
  });

  it('is true for a Cc-only recipient list', () => {
    expect(hasDraftContent({ ...VALID, to: [], cc: ['a@x.com'], subject: '', textBody: '' })).toBe(true);
  });

  it('ignores the identity — picking an account is not a draft', () => {
    expect(hasDraftContent({ identityId: 'harvard', to: [], cc: [], subject: '', textBody: '' })).toBe(
      false,
    );
  });
});
