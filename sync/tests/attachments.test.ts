import { describe, it, expect, vi } from 'vitest';
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

  it('handles branching cycles (fan-out > 1) without hanging', () => {
    const cyc: any = { type: 'multipart/mixed', childNodes: [] };
    cyc.childNodes.push(cyc, cyc); // branching factor 2 — would cause exponential work

    const start = Date.now();
    const result = extractAttachments(cyc);
    const elapsed = Date.now() - start;

    expect(result).toEqual([]);
    expect(elapsed).toBeLessThan(1000); // Must complete promptly, not hang
  });

  it('respects node budget on wide acyclic structures', () => {
    // Create a wide tree with 1100 children (exceeds MAX_NODES=1000)
    const wide: any = { type: 'multipart/mixed', childNodes: [] };
    for (let i = 0; i < 1100; i++) {
      wide.childNodes.push({ type: 'text/plain', size: 100 });
    }

    const spy = vi.spyOn(console, 'error');
    const result = extractAttachments(wide);

    expect(result).toEqual([]);
    expect(spy).toHaveBeenCalled();
    const callArg = spy.mock.calls[0]?.[0];
    expect(String(callArg)).toContain('exceeded node budget');

    spy.mockRestore();
  });

  it('suppresses duplicate attachments from cyclic self-referencing nodes', () => {
    // A self-referencing attachment node: the visited set MUST prevent duplicates.
    // Without cycle detection, node budget would collect MAX_NODES copies of the same attachment.
    const evil: any = {
      part: '1',
      type: 'application/pdf',
      disposition: 'attachment',
      dispositionParameters: { filename: 'evil.pdf' },
      size: 100,
      childNodes: [],
    };
    evil.childNodes.push(evil); // Self-reference

    const result = extractAttachments(evil);

    // Must return exactly 1 attachment, not 1000 duplicates
    expect(result).toHaveLength(1);
    const attachment = result[0];
    expect(attachment?.filename).toBe('evil.pdf');
    expect(attachment?.partId).toBe('1');
  });

});
