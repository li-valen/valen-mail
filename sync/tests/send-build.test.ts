import { describe, it, expect } from 'vitest';
import { buildTrackedMessage, escapeHtml, formatFrom } from '../src/send/build.ts';
import type { TrackedMessage } from '../src/send/build';

/**
 * Plan 4 Task 3 — the PURE half of the send path.
 *
 * Spec §5.1 makes the tracking pixel's markup BINDING, so the assertions
 * below are literal serialized strings rather than "contains the token":
 * a builder that emitted `<img alt="" src="..." width="1">` would satisfy
 * every structural check anyone would think to write, and would still be
 * the exact thing Gmail's image proxy and Apple MPP treat differently from
 * the markup the spec pinned. See task-p4t3-report.md for the recorded
 * mutation run (adding `width="1"` fails `renders EXACTLY the spec §5.1
 * pixel tag`, and nothing else).
 */

/** 32 hex, the shape tracking/src/token.ts mints. */
const TOKEN = 'abcdef0123456789abcdef0123456789';
const PIXEL_BASE = 'https://track.example';

/** The one markup the spec pins, spelled out once. */
const PIXEL_TAG = '<img alt="" src="https://track.example/o/abcdef0123456789abcdef0123456789.png">';

function messageWith(overrides: Partial<TrackedMessage> = {}): TrackedMessage {
  return {
    fromEmail: 'primary@example.com',
    to: ['one@example.com'],
    cc: [],
    subject: 'Subject line',
    textBody: 'hello',
    token: TOKEN,
    pixelBase: PIXEL_BASE,
    ...overrides,
  };
}

describe('escapeHtml', () => {
  it('escapes all five entities', () => {
    expect(escapeHtml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &#39;');
  });

  it('neutralises a script tag rather than passing it through', () => {
    const payload = `<script>alert("xss")</script>`;
    const escaped = escapeHtml(payload);

    expect(escaped).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(escaped).not.toContain('<script');
    expect(escaped).not.toContain('</script>');
  });

  it('escapes an ampersand exactly once — never double-escaping its own output', () => {
    // A naive chain of five .replace() calls with & handled last turns
    // `<` into `&lt;` and then into `&amp;lt;`. One pass over a character
    // class cannot: this is the assertion that pins that.
    expect(escapeHtml('a & b < c')).toBe('a &amp; b &lt; c');
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeHtml('plain text, no markup')).toBe('plain text, no markup');
  });

  it('returns an empty string for an empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('formatFrom', () => {
  it('is the bare address when no display name is configured', () => {
    expect(formatFrom(undefined, 'primary@example.com')).toBe('primary@example.com');
  });

  it('quotes a display name ahead of the angle-bracketed address', () => {
    expect(formatFrom('Valen Li', 'primary@example.com')).toBe(
      '"Valen Li" <primary@example.com>',
    );
  });

  it('strips quotes, backslashes and CR/LF from a display name rather than emitting them', () => {
    // A display name is the one From-header component that could carry a
    // newline into a header. Nodemailer would encode it, but this function
    // must not depend on that.
    expect(formatFrom('Ev"il\\\r\nName', 'primary@example.com')).toBe(
      '"EvilName" <primary@example.com>',
    );
  });

  it('falls back to the bare address when the display name is only whitespace', () => {
    expect(formatFrom('   ', 'primary@example.com')).toBe('primary@example.com');
  });

  it('holds the ADDRESS to the same standard as the name (fix round 1)', () => {
    // The name was stripped of quotes/backslashes/CR-LF with an explicit
    // "does not depend on nodemailer doing it" posture while the address
    // went through untouched. Not exploitable — the address is operator
    // config and nodemailer strips C0 itself — but the module cannot
    // declare a standard and then apply it to one of its two inputs.
    expect(formatFrom(undefined, 'pri mary@example.com\r\n')).toBe('primary@example.com');
    expect(formatFrom('Valen', '<primary@example.com>')).toBe('"Valen" <primary@example.com>');
    expect(formatFrom(undefined, 'a"b\\c@example.com')).toBe('abc@example.com');
  });
});

describe('buildTrackedMessage — text alternative', () => {
  it('carries textBody verbatim, with no escaping and no pixel', () => {
    // The plaintext alternative is deliberately untracked: a text/plain
    // part cannot load an image, so there is nothing to embed. This is
    // correct MIME practice, not a hole — see build.ts's own comment.
    const body = `Line one\nLine & two <b>not markup</b>`;
    const { text } = buildTrackedMessage(messageWith({ textBody: body }));

    expect(text).toBe(body);
    expect(text).not.toContain('&amp;');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('<img');
  });

  it('preserves an empty body as an empty string', () => {
    expect(buildTrackedMessage(messageWith({ textBody: '' })).text).toBe('');
  });
});

describe('buildTrackedMessage — html alternative', () => {
  it('renders EXACTLY the spec §5.1 pixel tag', () => {
    // BINDING (spec §5.1). This is the mutation-sensitive assertion: any
    // width/height/style/class attribute, any descriptive alt, any
    // reordering or self-closing slash changes this string and fails here.
    const { html } = buildTrackedMessage(messageWith());

    expect(html).toContain(PIXEL_TAG);
    expect(html.endsWith(PIXEL_TAG)).toBe(true);
  });

  it('serialises the whole html body byte for byte', () => {
    const { html } = buildTrackedMessage(messageWith({ textBody: 'hello' }));

    expect(html).toBe(`<div dir="auto">hello</div>${PIXEL_TAG}`);
  });

  it('carries no sizing, styling or descriptive-alt attribute on the pixel', () => {
    const { html } = buildTrackedMessage(messageWith());
    const tag = html.slice(html.indexOf('<img'));

    expect(tag).not.toContain('width');
    expect(tag).not.toContain('height');
    expect(tag).not.toContain('style');
    expect(tag).not.toContain('class');
    expect(tag).toContain('alt=""');
  });

  it('wraps the body in <div dir="auto">', () => {
    const { html } = buildTrackedMessage(messageWith({ textBody: 'hi' }));
    expect(html.startsWith('<div dir="auto">')).toBe(true);
    expect(html).toContain('</div>');
  });

  it('turns newlines into <br>', () => {
    const { html } = buildTrackedMessage(messageWith({ textBody: 'one\ntwo\nthree' }));
    expect(html).toBe(`<div dir="auto">one<br>two<br>three</div>${PIXEL_TAG}`);
  });

  it('normalises CRLF and bare CR to the same <br>', () => {
    const { html } = buildTrackedMessage(messageWith({ textBody: 'one\r\ntwo\rthree' }));
    expect(html).toBe(`<div dir="auto">one<br>two<br>three</div>${PIXEL_TAG}`);
  });

  it('escapes the body so a pasted script tag cannot execute in a mail client', () => {
    const { html } = buildTrackedMessage(
      messageWith({ textBody: `<script>alert("xss")</script>` }),
    );

    expect(html).toBe(
      `<div dir="auto">&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</div>${PIXEL_TAG}`,
    );
    expect(html).not.toContain('<script');
  });

  it('still emits the pixel for an empty body', () => {
    const { html } = buildTrackedMessage(messageWith({ textBody: '' }));
    expect(html).toBe(`<div dir="auto"></div>${PIXEL_TAG}`);
  });
});

describe('buildTrackedMessage — pixel base joining', () => {
  it('produces exactly one /o/ when the base has NO trailing slash', () => {
    const { html } = buildTrackedMessage(messageWith({ pixelBase: 'https://track.example' }));

    expect(html).toContain(`src="https://track.example/o/${TOKEN}.png"`);
    expect(html.split('/o/')).toHaveLength(2);
    expect(html).not.toContain('//o/');
  });

  it('produces exactly one /o/ when the base HAS a trailing slash', () => {
    const { html } = buildTrackedMessage(messageWith({ pixelBase: 'https://track.example/' }));

    expect(html).toContain(`src="https://track.example/o/${TOKEN}.png"`);
    expect(html.split('/o/')).toHaveLength(2);
    expect(html).not.toContain('//o/');
  });

  it('collapses several trailing slashes rather than emitting them', () => {
    const { html } = buildTrackedMessage(messageWith({ pixelBase: 'https://track.example///' }));
    expect(html).toContain(`src="https://track.example/o/${TOKEN}.png"`);
  });

  it('keeps a path prefix on the base intact', () => {
    const { html } = buildTrackedMessage(messageWith({ pixelBase: 'https://track.example/px/' }));
    expect(html).toContain(`src="https://track.example/px/o/${TOKEN}.png"`);
  });
});

describe('buildTrackedMessage — purity', () => {
  it('does not mutate the message it is given', () => {
    const message = messageWith({ to: ['a@example.com'], cc: ['b@example.com'] });
    const snapshot = JSON.stringify(message);

    buildTrackedMessage(message);

    expect(JSON.stringify(message)).toBe(snapshot);
  });

  it('returns the same output for the same input, every time', () => {
    const message = messageWith();
    expect(buildTrackedMessage(message)).toEqual(buildTrackedMessage(message));
  });
});

describe('buildTrackedMessage — spec §5.2, the pixel goes BEFORE the quote', () => {
  /**
   * Plan 9 Task 3. Plan 4 only ever exercised the no-quote branch, so this
   * is the first time the binding half of §5.2 is executed at all.
   *
   * Gmail collapses quoted text behind a "..." toggle. An image inside that
   * region is never fetched until the reader expands it, so a pixel placed
   * inside the quote makes every tracked reply report "unopened" forever —
   * silently, and indistinguishably from a genuinely unopened message.
   */
  const QUOTE = '<div class="gmail_quote"><blockquote class="gmail_quote">old</blockquote></div>';

  it('places the tracking pixel BEFORE the quote, not inside it', () => {
    const { html } = buildTrackedMessage(messageWith({ textBody: 'my reply', htmlQuote: QUOTE }));

    // ORDER, not mere containment. `toContain` passes for BOTH placements
    // and is therefore vacuous here — the whole defect this asserts against
    // is a pixel that is present but in the wrong place.
    expect(html.indexOf(PIXEL_TAG)).toBeLessThan(html.indexOf('gmail_quote'));
  });

  it('serialises a reply body byte for byte: body, pixel, then quote', () => {
    const { html } = buildTrackedMessage(messageWith({ textBody: 'my reply', htmlQuote: QUOTE }));

    expect(html).toBe(`<div dir="auto">my reply</div>${PIXEL_TAG}${QUOTE}`);
  });

  it('with no quote the pixel still appends to the body root — unchanged behaviour', () => {
    const { html } = buildTrackedMessage(messageWith({ textBody: 'new mail' }));

    expect(html).toBe(`<div dir="auto">new mail</div>${PIXEL_TAG}`);
    expect(html.endsWith(PIXEL_TAG)).toBe(true);
  });

  it('a plain compose is byte-identical whether htmlQuote is absent or undefined', () => {
    // The regression this guards: every message this product has ever sent
    // took the no-quote path, and adding the reply path must not move a
    // single byte of it.
    expect(buildTrackedMessage(messageWith({ textBody: 'hi' })).html).toBe(
      buildTrackedMessage(messageWith({ textBody: 'hi', htmlQuote: undefined })).html,
    );
  });

  it('leaves the plaintext alternative free of both pixel and quote markup', () => {
    const { text } = buildTrackedMessage(messageWith({ textBody: 'my reply', htmlQuote: QUOTE }));

    expect(text).toBe('my reply');
    expect(text).not.toContain('gmail_quote');
    expect(text).not.toContain('<img');
  });
});
