import { describe, it, expect } from 'vitest';
import { normalizeMessage, SNIPPET_CHARS } from '../src/normalize';

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
