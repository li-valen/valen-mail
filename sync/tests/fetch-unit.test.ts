import { describe, it, expect } from 'vitest';
import { HEADER_FETCH_OPTIONS, applyAttachmentFlag } from '../src/imap/fetch';
import { normalizeMessage } from '../src/normalize';
import type { AttachmentMeta } from '../src/attachments';

/**
 * Pure unit tests — no network, no live Gmail account, no database. These
 * exist specifically because the live suite (tests/fetch.test.ts) cannot
 * causally prove "we never fetch BODY[]" (bytesDownloaded is a fixed
 * estimate, not a wire measurement — see ESTIMATED_BYTES_PER_HEADER_FETCH's
 * comment in src/imap/fetch.ts) and cannot deterministically exercise
 * hasAttach: true against a shared mailbox that may or may not contain an
 * attachment on any given run.
 */

describe('HEADER_FETCH_OPTIONS', () => {
  it('requests exactly the header-safe fields — nothing more, nothing less', () => {
    expect(Object.keys(HEADER_FETCH_OPTIONS).sort()).toEqual(
      ['bodyStructure', 'envelope', 'flags', 'labels', 'size', 'threadId', 'uid'].sort(),
    );
  });

  it('never requests a body-bearing field', () => {
    // If any of these were added, fetchHeaders() would start pulling BODY[]
    // content during sync — the exact regression this module exists to
    // prevent. This is the causal guard: unlike the live byte-magnitude
    // check, it fails immediately and deterministically the moment a
    // body-bearing key is added, independent of mailbox contents.
    const bodyBearingKeys = ['source', 'bodyParts', 'body'] as const;
    for (const key of bodyBearingKeys) {
      expect(HEADER_FETCH_OPTIONS).not.toHaveProperty(key);
    }
  });
});

describe('applyAttachmentFlag', () => {
  const normalized = normalizeMessage(
    {
      uid: 7,
      size: 4096,
      flags: new Set(['\\Seen']),
      labels: new Set(['\\Inbox']),
      envelope: { messageId: '<x@mail.gmail.com>', subject: 'hi' },
    },
    'primary',
    'INBOX',
  );

  const attachmentParts: readonly AttachmentMeta[] = [
    { partId: '2', filename: 'invoice.pdf', mimeType: 'application/pdf', sizeBytes: 51200 },
  ];

  it('sets hasAttach: true when extractAttachments found at least one part', () => {
    const result = applyAttachmentFlag(normalized, attachmentParts);
    expect(result.hasAttach).toBe(true);
  });

  it('sets hasAttach: false when extractAttachments found no parts', () => {
    const result = applyAttachmentFlag(normalized, []);
    expect(result.hasAttach).toBe(false);
  });

  it('does not mutate the normalized input it was given', () => {
    applyAttachmentFlag(normalized, attachmentParts);
    expect(normalized.hasAttach).toBe(false);
  });

  it('preserves every other field unchanged', () => {
    const result = applyAttachmentFlag(normalized, attachmentParts);
    expect(result.uid).toBe(normalized.uid);
    expect(result.subject).toBe(normalized.subject);
    expect(result.accountId).toBe(normalized.accountId);
    expect(result.folder).toBe(normalized.folder);
  });
});
