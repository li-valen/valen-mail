import { describe, it, expect } from 'vitest';
import { attributionLine, buildQuotedHtml } from '../src/send/quote.ts';
import type { QuoteInput } from '../src/send/quote';

/**
 * Plan 9 Task 2 — the quote a reply or forward carries.
 *
 * Pure, so the two BINDING spec rules this file exists for are assertable
 * without a socket:
 *
 *  - §5.6 the original body's OWN pixel is stripped out of the quote. The
 *    ordering half of that rule (strip before the NEW pixel is injected)
 *    is not observable from this module alone — nothing here injects a
 *    pixel — so it is pinned where both halves actually meet, in
 *    tests/send-route.test.ts's "spec 5.6" block. See the report.
 *  - §5.2 this module emits a `.gmail_quote` container so ../send/build.ts
 *    has something to place the pixel BEFORE. The ordering itself is
 *    asserted in tests/send-build.test.ts.
 */

const BASE: QuoteInput = {
  originalHtml: null,
  originalText: null,
  fromLabel: 'Ada <ada@example.com>',
  // 2023-11-14T22:13:20Z — a Tuesday, 10:13 PM UTC.
  sentAtMs: 1_700_000_000_000,
  trackingBaseUrl: 'https://track.test',
};

function quote(overrides: Partial<QuoteInput> = {}): string {
  return buildQuotedHtml({ ...BASE, ...overrides });
}

describe('attributionLine', () => {
  it("matches Gmail's own attribution shape", () => {
    // A reply from Valen Mail should be indistinguishable from a reply from
    // Gmail in every client that renders one.
    expect(attributionLine('Ada <ada@example.com>', 1_700_000_000_000)).toBe(
      'On Tue, Nov 14, 2023 at 10:13 PM Ada <ada@example.com> wrote:',
    );
  });

  it('renders in UTC regardless of where the box is deployed', () => {
    // FIXED to UTC deliberately: this string is written into mail that
    // leaves the machine, so rendering it in the server's local zone would
    // make the same reply read differently depending on the deployment
    // region. Asserted by picking an instant whose UTC hour differs from
    // every plausible local one — 00:30 UTC is the previous DAY in the
    // Americas and mid-morning in Asia.
    expect(attributionLine('A <a@x.com>', Date.UTC(2026, 0, 2, 0, 30, 0))).toBe(
      'On Fri, Jan 2, 2026 at 12:30 AM A <a@x.com> wrote:',
    );
  });

  it('renders noon and midnight as 12 PM and 12 AM, not 0', () => {
    expect(attributionLine('A <a@x.com>', Date.UTC(2026, 5, 1, 12, 0, 0))).toContain('12:00 PM');
    expect(attributionLine('A <a@x.com>', Date.UTC(2026, 5, 1, 0, 0, 0))).toContain('12:00 AM');
  });

  it('zero-pads the minute', () => {
    expect(attributionLine('A <a@x.com>', Date.UTC(2026, 5, 1, 13, 5, 0))).toContain('1:05 PM');
  });

  it('omits the date entirely when the message carried no usable one', () => {
    // ParsedMessage.date is nullable — a message with no Date header, or an
    // unparseable one, is real mail. "On Invalid Date, NaN ... wrote:" must
    // never leave this machine. Null is the shape that actually arrives;
    // NaN is what a caller that did its own arithmetic would produce.
    expect(attributionLine('Ada <ada@example.com>', null)).toBe('Ada <ada@example.com> wrote:');
    expect(attributionLine('Ada <ada@example.com>', Number.NaN)).toBe(
      'Ada <ada@example.com> wrote:',
    );
  });
});

describe('buildQuotedHtml — spec 5.6, our own pixel never rides in the quote', () => {
  it('strips a Valen Mail pixel out of the quoted original', () => {
    // This is our own tracking origin, i.e. exactly what our own Sent copy
    // of the message being replied to contains. Quoting it unstripped
    // re-fires the ORIGINAL recipient's token on every future reply,
    // forever.
    const html = quote({
      originalHtml: '<p>hi</p><img alt="" src="https://track.test/o/deadbeef.png">',
    });

    expect(html).not.toContain('deadbeef');
    expect(html).toContain('hi');
  });

  it('keeps a third-party image in the quote — the strip is OURS only', () => {
    // Remote images load by default at the user's explicit request. A
    // stripper that removed every image would delete the pictures the user
    // wanted while still passing any "the tracking pixel is gone" check.
    const html = quote({ originalHtml: '<img src="https://cdn.example.com/logo.png">' });

    expect(html).toContain('cdn.example.com/logo.png');
  });

  it('strips nothing when tracking is not configured', () => {
    // No TRACKING_BASE_URL means no origin to compare against, so there is
    // no pixel this service can confidently call its own.
    const html = quote({
      originalHtml: '<img alt="" src="https://track.test/o/deadbeef.png">',
      trackingBaseUrl: null,
    });

    expect(html).toContain('deadbeef');
  });
});

describe('buildQuotedHtml — the quoted body', () => {
  it('quoted plain text is ESCAPED, never injected as markup', () => {
    const html = quote({ originalText: '<script>alert(1)</script>', trackingBaseUrl: null });

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes the attribution line too, so a hostile display name is inert', () => {
    // fromLabel is built from a From header the sender controls.
    const html = quote({
      originalHtml: '<p>x</p>',
      fromLabel: '<script>alert(1)</script> <a@x.com>',
    });

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('prefers the html original over the plaintext one', () => {
    // A message with both alternatives quotes the rich one, as Gmail does.
    const html = quote({ originalHtml: '<p>rich</p>', originalText: 'plain' });

    expect(html).toContain('<p>rich</p>');
    expect(html).not.toContain('plain');
  });

  it('falls back to the plaintext original when there is no html', () => {
    const html = quote({ originalHtml: null, originalText: 'line one\nline two' });

    expect(html).toContain('line one\nline two');
  });

  it('still produces a well-formed quote when the original had no body at all', () => {
    // Both alternatives null is real: an attachment-only message.
    // tests/message-route.test.ts already pins that ParsedMessage shape.
    const html = quote({ originalHtml: null, originalText: null });

    expect(html).toContain('class="gmail_quote"');
    expect(html).toContain('wrote:');
  });
});

describe('buildQuotedHtml — spec 5.2, the container the pixel goes before', () => {
  it('emits a .gmail_quote container so send/build can place the pixel before it', () => {
    expect(quote({ originalHtml: '<p>x</p>', trackingBaseUrl: null })).toContain(
      'class="gmail_quote"',
    );
  });

  it('opens with the .gmail_quote element, so "before the quote" means before ALL of it', () => {
    // The attribution line lives INSIDE the container, exactly as Gmail
    // nests it. If it sat outside, "immediately before the .gmail_quote
    // element" would put the pixel between the attribution and the
    // blockquote — inside the region Gmail collapses, which is the whole
    // failure §5.2 exists to prevent.
    const html = quote({ originalHtml: '<p>x</p>', trackingBaseUrl: null });

    expect(html.startsWith('<div class="gmail_quote">')).toBe(true);
    expect(html.indexOf('gmail_quote')).toBeLessThan(html.indexOf('wrote:'));
  });
});

describe('buildQuotedHtml — purity', () => {
  it('does not mutate the input it is given', () => {
    const input: QuoteInput = { ...BASE, originalHtml: '<p>x</p>' };
    const snapshot = JSON.stringify(input);

    buildQuotedHtml(input);

    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('returns the same output for the same input, every time', () => {
    const input: QuoteInput = { ...BASE, originalHtml: '<p>x</p>' };
    expect(buildQuotedHtml(input)).toBe(buildQuotedHtml(input));
  });
});
