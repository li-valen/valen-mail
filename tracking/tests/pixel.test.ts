import { describe, it, expect } from 'vitest';
import { PIXEL_BYTES, pixelResponse } from '../src/pixel';

describe('pixel', () => {
  it('starts with the PNG signature bytes', () => {
    expect(Array.from(PIXEL_BYTES.slice(0, 8)))
      .toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('declares 1x1 dimensions in its IHDR chunk', () => {
    const view = new DataView(PIXEL_BYTES.buffer, PIXEL_BYTES.byteOffset);
    expect(view.getUint32(16)).toBe(1); // width
    expect(view.getUint32(20)).toBe(1); // height
  });

  it('sends cache-defeating headers so repeat opens are not swallowed', () => {
    const headers = pixelResponse().headers;
    expect(headers.get('cache-control'))
      .toBe('no-store, no-cache, must-revalidate, max-age=0');
    expect(headers.get('pragma')).toBe('no-cache');
    expect(headers.get('expires')).toBe('0');
    expect(headers.get('content-type')).toBe('image/png');
  });

  it('responds 200 so the tracker is not fingerprintable by status code', () => {
    expect(pixelResponse().status).toBe(200);
  });
});
