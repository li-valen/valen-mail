import { describe, it, expect } from 'vitest';
import { stripOwnTrackingPixels } from '../src/api/strip-pixel.ts';

/**
 * Spec 5.6 — Valen Mail must strip its OWN tracking pixels before rendering a
 * message body, so that reading your own mail in Valen Mail never fires a
 * pixel and never manufactures an open event attributed to a recipient.
 *
 * The binding property under test is a NARROW one, and both halves matter
 * equally: our own pixel goes, and NOTHING ELSE DOES. A stripper that
 * removed every remote image would "pass" any suppression-only test while
 * silently deleting the images the user actually embedded — remote images
 * load by default at the user's explicit request (see MessageView.tsx), so
 * over-matching here is a real regression, not a conservative choice.
 */

const BASE = 'https://track.example';
const PIXEL = '<img alt="" src="https://track.example/o/aaaabbbbccccddddeeeeffff00001111.png">';

describe('stripOwnTrackingPixels / removes our own pixel', () => {
  it('removes the exact spec 5.1 pixel markup and nothing around it', () => {
    const html = `<div dir="auto">Hello<br>there</div>${PIXEL}`;
    expect(stripOwnTrackingPixels(html, BASE)).toBe('<div dir="auto">Hello<br>there</div>');
  });

  it('removes every one of our pixels, not just the first', () => {
    const html = `${PIXEL}<p>body</p>${PIXEL}`;
    expect(stripOwnTrackingPixels(html, BASE)).toBe('<p>body</p>');
  });

  it('matches regardless of host case — hostnames are case-insensitive', () => {
    const html = '<img alt="" src="https://TRACK.EXAMPLE/o/abc123.png">';
    expect(stripOwnTrackingPixels(html, BASE)).toBe('');
  });

  it('matches a single-quoted src', () => {
    const html = "<img alt='' src='https://track.example/o/abc123.png'>";
    expect(stripOwnTrackingPixels(html, BASE)).toBe('');
  });

  it('matches an unquoted src', () => {
    const html = '<img src=https://track.example/o/abc123.png>';
    expect(stripOwnTrackingPixels(html, BASE)).toBe('');
  });

  it('tolerates a pixel base carrying a trailing slash, as build.ts does', () => {
    expect(stripOwnTrackingPixels(PIXEL, 'https://track.example/')).toBe('');
  });

  it('honours a pixel base with a path prefix, as build.ts pixelUrl does', () => {
    const html = '<img alt="" src="https://track.example/px/o/abc123.png">';
    expect(stripOwnTrackingPixels(html, 'https://track.example/px/')).toBe('');
    // The same URL is NOT ours when the configured base has no prefix:
    // /px/o/... is a different path from /o/...
    expect(stripOwnTrackingPixels(html, BASE)).toBe(html);
  });
});

describe('stripOwnTrackingPixels / leaves everything else alone', () => {
  it('leaves a third-party tracking pixel on another origin', () => {
    const html = '<img src="https://tracker.example/open.gif">';
    expect(stripOwnTrackingPixels(html, BASE)).toBe(html);
  });

  it('leaves an image the user embedded, even on our own origin', () => {
    // Our origin, but not under /o/ — it is not a tracking pixel.
    const html = '<img src="https://track.example/assets/logo.png">';
    expect(stripOwnTrackingPixels(html, BASE)).toBe(html);
  });

  it('leaves a RELATIVE src alone rather than resolving it against our base', () => {
    // Resolving "/o/abc.png" against the pixel base would make any message
    // that happens to use that path look like ours and delete the image.
    const html = '<img src="/o/abc123.png">';
    expect(stripOwnTrackingPixels(html, BASE)).toBe(html);
  });

  it('leaves a cid: image untouched', () => {
    const html = '<img src="cid:logo@example.com">';
    expect(stripOwnTrackingPixels(html, BASE)).toBe(html);
  });

  it('leaves non-img tags that mention the pixel base', () => {
    const html = '<a href="https://track.example/o/abc123.png">link</a>';
    expect(stripOwnTrackingPixels(html, BASE)).toBe(html);
  });

  it('leaves the html untouched when tracking is not configured', () => {
    expect(stripOwnTrackingPixels(PIXEL, null)).toBe(PIXEL);
  });

  it('passes a null body through as null', () => {
    expect(stripOwnTrackingPixels(null, BASE)).toBe(null);
  });

  it('never throws on a malformed pixel base — it just strips nothing', () => {
    expect(stripOwnTrackingPixels(PIXEL, 'not a url')).toBe(PIXEL);
  });

  it('leaves an img whose attribute value contains ">" rather than truncating it', () => {
    // `[^>]*` cannot span that value, so the tag is not confidently ours.
    // Failing toward KEEPING the image is the correct direction.
    const html = '<img alt="a>b" src="https://track.example/o/abc123.png">';
    expect(stripOwnTrackingPixels(html, BASE)).toContain('src=');
  });
});
