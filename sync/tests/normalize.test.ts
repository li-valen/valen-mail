import { describe, it, expect } from 'vitest';
import { applySnippet, normalizeMessage, SNIPPET_CHARS } from '../src/normalize';

const RAW = {
  uid: 42,
  size: 20480,
  flags: new Set(['\\Seen', '\\Flagged']),
  labels: new Set(['\\Inbox', 'Work']),
  envelope: {
    messageId: '<abc@mail.gmail.com>',
    date: new Date('2026-08-20T10:00:00Z'),
    subject: 'Quarterly numbers',
    from: [{ name: 'Sarah Chen', address: 'sarah@example.com' }],
    to: [{ name: '', address: 'me@gmail.com' }, { name: 'B', address: 'b@example.com' }],
    cc: [],
  },
  threadId: 'thread-9',
  bodyText: 'Hi — attaching the numbers we discussed. Let me know if anything looks off.',
};

describe('normalizeMessage', () => {
  it('maps envelope fields onto the canonical shape', () => {
    const m = normalizeMessage(RAW, 'primary', 'INBOX');
    expect(m.accountId).toBe('primary');
    expect(m.folder).toBe('INBOX');
    expect(m.uid).toBe(42);
    expect(m.subject).toBe('Quarterly numbers');
    expect(m.fromName).toBe('Sarah Chen');
    expect(m.fromEmail).toBe('sarah@example.com');
    expect(m.toEmails).toEqual(['me@gmail.com', 'b@example.com']);
  });

  it('converts flag and label sets to sorted arrays', () => {
    const m = normalizeMessage(RAW, 'primary', 'INBOX');
    expect(m.flags).toEqual(['\\Flagged', '\\Seen']);
    expect(m.labels).toEqual(['\\Inbox', 'Work']);
  });

  it('truncates the snippet to SNIPPET_CHARS', () => {
    const long = { ...RAW, bodyText: 'x'.repeat(SNIPPET_CHARS + 200) };
    expect(normalizeMessage(long, 'p', 'INBOX').snippet).toHaveLength(SNIPPET_CHARS);
  });

  it('collapses whitespace in the snippet', () => {
    const messy = { ...RAW, bodyText: 'line one\n\n\n   line two\t\tend' };
    expect(normalizeMessage(messy, 'p', 'INBOX').snippet).toBe('line one line two end');
  });

  it('tolerates a message with no envelope sender', () => {
    const anon = { ...RAW, envelope: { ...RAW.envelope, from: [] } };
    const m = normalizeMessage(anon, 'p', 'INBOX');
    expect(m.fromEmail).toBeNull();
    expect(m.fromName).toBeNull();
  });

  it('tolerates a missing date rather than inventing one', () => {
    const undated = { ...RAW, envelope: { ...RAW.envelope, date: undefined } };
    expect(normalizeMessage(undated, 'p', 'INBOX').date).toBeNull();
  });

  it('falls back to the message id when no thread id is present', () => {
    const nothread = { ...RAW, threadId: undefined };
    expect(normalizeMessage(nothread, 'p', 'INBOX').threadId).toBe('<abc@mail.gmail.com>');
  });

  it('yields null threadId when both threadId and messageId are absent', () => {
    const both = { ...RAW, threadId: undefined, envelope: { ...RAW.envelope, messageId: undefined } };
    const m = normalizeMessage(both, 'p', 'INBOX');
    expect(m.threadId).toBeNull();
    expect(m.messageId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// applySnippet (Plan 7 Task 1)
// ---------------------------------------------------------------------------

describe('applySnippet', () => {
  // The message as fetchHeaders produces it: header-only, so always
  // snippet-less. The preview arrives later, from the separate partial
  // PEEK fetch, which is why this overlay exists at all.
  const headerOnly = normalizeMessage({ ...RAW, bodyText: undefined }, 'primary', 'INBOX');

  it('overlays the preview onto an otherwise unchanged message', () => {
    const result = applySnippet(headerOnly, 'Numbers are attached.');
    expect(result.snippet).toBe('Numbers are attached.');
    expect(result.uid).toBe(headerOnly.uid);
    expect(result.subject).toBe(headerOnly.subject);
    expect(result.flags).toEqual(headerOnly.flags);
  });

  it('does not mutate the message it was given', () => {
    applySnippet(headerOnly, 'Numbers are attached.');
    expect(headerOnly.snippet).toBeNull();
  });

  it('applies the same SNIPPET_CHARS cap normalizeMessage does', () => {
    // One cap, one code path: the preview route must not be able to store
    // more than the inbox route ever could.
    expect(applySnippet(headerOnly, 'x'.repeat(SNIPPET_CHARS + 200)).snippet)
      .toHaveLength(SNIPPET_CHARS);
  });

  it('collapses the line structure preview.ts deliberately leaves behind', () => {
    // preview.ts keeps line breaks because its quoting and signature rules
    // need them; a list row is one line, so they are collapsed here.
    expect(applySnippet(headerOnly, 'first line\n\n  second line').snippet)
      .toBe('first line second line');
  });

  it('stores null, not an empty string, for a preview that stripped to nothing', () => {
    // The client has to distinguish "no preview" (render no second line)
    // from "empty preview" (would reserve a blank one).
    expect(applySnippet(headerOnly, '').snippet).toBeNull();
    expect(applySnippet(headerOnly, '   \n  ').snippet).toBeNull();
    expect(applySnippet(headerOnly, null).snippet).toBeNull();
  });
});
