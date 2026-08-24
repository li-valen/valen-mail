import { describe, it, expect } from 'vitest';
import { extractAttachments } from '../src/attachments';

// imapflow BODYSTRUCTURE shape: a multipart node with childNodes.
const MIXED = {
  type: 'multipart/mixed',
  childNodes: [
    { part: '1', type: 'text/plain', size: 512 },
    { part: '2', type: 'application/pdf', size: 84213,
      disposition: 'attachment', dispositionParameters: { filename: 'report.pdf' } },
    { part: '3', type: 'image/png', size: 2048,
      disposition: 'inline', dispositionParameters: { filename: 'logo.png' } },
  ],
};

describe('extractAttachments', () => {
  it('finds an attachment-disposition part with its metadata', () => {
    const found = extractAttachments(MIXED);
    const pdf = found.find((a) => a.filename === 'report.pdf');
    expect(pdf).toBeDefined();
    expect(pdf?.mimeType).toBe('application/pdf');
    expect(pdf?.sizeBytes).toBe(84213);
    expect(pdf?.partId).toBe('2');
  });

  it('includes inline parts that carry a filename', () => {
    expect(extractAttachments(MIXED).some((a) => a.filename === 'logo.png')).toBe(true);
  });

  it('excludes the plain text body part', () => {
    expect(extractAttachments(MIXED).some((a) => a.mimeType === 'text/plain')).toBe(false);
  });

  it('returns an empty array for a simple text message', () => {
    expect(extractAttachments({ type: 'text/plain', size: 100 })).toEqual([]);
  });

  it('recurses into nested multiparts', () => {
    const nested = { type: 'multipart/mixed', childNodes: [
      { type: 'multipart/alternative', childNodes: [
        { part: '1.1', type: 'text/plain', size: 10 },
        { part: '1.2', type: 'text/html', size: 20 },
      ]},
      { part: '2', type: 'application/zip', size: 999,
        disposition: 'attachment', dispositionParameters: { filename: 'a.zip' } },
    ]};
    expect(extractAttachments(nested).map((a) => a.filename)).toEqual(['a.zip']);
  });

  it('returns an empty array rather than throwing on malformed input', () => {
    expect(extractAttachments(null)).toEqual([]);
    expect(extractAttachments({ childNodes: 'not-an-array' })).toEqual([]);
  });
});
