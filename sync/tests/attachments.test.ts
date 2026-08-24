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

  it('handles forwarded email attachments (message/rfc822 with disposition)', () => {
    const forwarded = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 100 },
        {
          part: '2',
          type: 'message/rfc822',
          size: 5000,
          disposition: 'attachment',
          dispositionParameters: { filename: 'forwarded.eml' },
          childNodes: [
            { part: '2.1', type: 'text/plain', size: 50 },
          ],
        },
      ],
    };
    const found = extractAttachments(forwarded);
    const eml = found.find((a) => a.filename === 'forwarded.eml');
    expect(eml).toBeDefined();
    expect(eml?.partId).toBe('2');
    expect(eml?.mimeType).toBe('message/rfc822');
    // Verify we did not recurse into the forwarded message's children
    expect(found).toHaveLength(1);
  });

  it('validates that part must be a string, not a number', () => {
    const invalid = {
      type: 'multipart/mixed',
      childNodes: [
        { part: 1, type: 'application/pdf', size: 100,
          disposition: 'attachment', dispositionParameters: { filename: 'bad.pdf' } },
      ],
    };
    expect(extractAttachments(invalid)).toEqual([]);
  });

  it('never throws on deeply nested BODYSTRUCTURE (depth limit)', () => {
    // Build a structure 150 levels deep (well past MAX_DEPTH=100)
    let deep: any = { type: 'text/plain', part: '1', size: 100 };
    for (let i = 0; i < 150; i++) {
      deep = { type: 'multipart/mixed', childNodes: [deep] };
    }
    expect(() => extractAttachments(deep)).not.toThrow();
    expect(extractAttachments(deep)).toEqual([]);
  });

  it('never throws on cyclic BODYSTRUCTURE references', () => {
    const node: any = { type: 'multipart/mixed', childNodes: [] };
    node.childNodes.push(node); // Self-reference
    expect(() => extractAttachments(node)).not.toThrow();
    expect(extractAttachments(node)).toEqual([]);
  });
});
