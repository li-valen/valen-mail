import { describe, expect, it } from 'vitest';
import {
  BODY_HEIGHT_BOUNDS_PX,
  IFRAME_SANDBOX,
  attachmentUrl,
  bodyKind,
  contentSecurityPolicyFor,
  estimatedBodyHeightPx,
  formatSize,
  isDownloadable,
  messageKey,
  srcDocFor,
} from '../src/components/messageBody';
import { formatReceived } from '../src/components/inboxDates';

/**
 * Plan 6 Task 2's pure helpers, and the two guards that make the reader's
 * security posture a property of the SUITE rather than of whoever last
 * edited MessageView.tsx.
 *
 * The message body is attacker-authored HTML that sync/ deliberately does
 * not sanitise (sync/src/api/message.ts explains why adding a sanitiser
 * would weaken this rather than strengthen it), so two things and only
 * two things stand between it and this origin: the iframe's `sandbox`
 * attribute and the CSP `<meta>` inside the srcdoc. Both are asserted
 * below, and both assertions carry a fixture proving they can fail.
 */

describe('srcDocFor — the sandboxed body document', () => {
  const HTML = '<p>hello</p><img src="https://tracker.example/pixel.gif">';

  /** The policy the document actually enforces, read back out of the meta
   *  tag — asserted on the POLICY rather than on the whole document,
   *  because the message markup embedded below it legitimately contains
   *  remote URLs of its own and would make a naive substring check pass
   *  for the wrong reason. */
  function policyOf(doc: string): string {
    const match = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(doc);
    expect(match).not.toBeNull();
    return match![1]!;
  }

  /**
   * PINNED THE OTHER WAY ROUND, ON PURPOSE.
   *
   * These three tests used to assert that remote images were BLOCKED by
   * default and permitted only behind an explicit per-message
   * `allowRemote` flag. The user removed that control outright —
   * "remove the dont load images thing i dont care if people can track me
   * with the pixels" — so the behaviour they pin is inverted rather than
   * deleted: mail renders the way the sender built it, first time, and a
   * future change that quietly reinstates blocking fails here.
   *
   * The sandbox guard further down is UNTOUCHED. Remote images were a
   * privacy trade the user is entitled to make; `allow-scripts` and
   * `allow-same-origin` are an XSS boundary and are not on the table.
   */
  it('permits remote images — img-src allows data:, cid: and remote hosts', () => {
    const policy = policyOf(srcDocFor(HTML));
    expect(policy).toContain('img-src data: cid: https: http:');
    expect(policy).toBe(contentSecurityPolicyFor());
  });

  it('has no way left to ask for a blocking policy', () => {
    // Non-vacuity for the assertion above, and the thing that makes the
    // inversion stick: there is exactly ONE document `srcDocFor` can
    // build for a given html, so there is no second, blocking branch for
    // a caller to reach or for a default to drift back to.
    expect(srcDocFor(HTML)).toBe(srcDocFor(HTML));
    expect(srcDocFor.length).toBe(1);
    expect(contentSecurityPolicyFor.length).toBe(0);
  });

  it('still denies every OTHER remote load — objects, frames, media, fonts, stylesheets', () => {
    // Loosening `img-src` loosened `img-src`. `default-src 'none'` still
    // means a message cannot pull in a stylesheet, a font from a remote
    // host, a frame, an object or an XHR.
    const policy = policyOf(srcDocFor(HTML));
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).toContain('font-src data:');
    expect(policy).not.toContain('media-src');
    expect(policy).not.toContain('connect-src');
  });

  it('denies scripts, objects, frames, forms and base', () => {
    const doc = srcDocFor(HTML);
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("script-src 'none'");
    expect(doc).toContain("object-src 'none'");
    expect(doc).toContain("frame-src 'none'");
    expect(doc).toContain("form-action 'none'");
    expect(doc).toContain("base-uri 'none'");
  });

  it('puts the CSP meta before any message markup, so nothing can load ahead of it', () => {
    const doc = srcDocFor('<img src="https://tracker.example/pixel.gif">');
    const csp = doc.indexOf('Content-Security-Policy');
    const message = doc.indexOf('tracker.example');
    expect(csp).toBeGreaterThan(-1);
    expect(message).toBeGreaterThan(csp);
  });

  it('embeds the html verbatim — nothing is stripped, escaped or rewritten', () => {
    // The same markup sync/tests/message-route.test.ts asserts survives
    // the server. It must reach the frame intact: the sandbox is the
    // boundary precisely because it holds without inspecting the input.
    const hostile = '<script>fetch("/api/inbox")</script><a onclick="steal()">x</a>';
    expect(srcDocFor(hostile)).toContain(hostile);
  });

  it('never emits allow-scripts anywhere in the document it builds', () => {
    expect(srcDocFor('<p>x</p>')).not.toContain('allow-scripts');
    expect(srcDocFor(HTML)).not.toContain('allow-scripts');
  });

  it('sends no referrer, so following a link does not leak where it was followed from', () => {
    expect(srcDocFor('<p>x</p>')).toContain('<meta name="referrer" content="no-referrer">');
  });

  it('renders on a light ground in both themes — the email assumes white', () => {
    const doc = srcDocFor('<p>x</p>');
    expect(doc).toContain('color-scheme:light');
    expect(doc).toContain('background:#ffffff');
  });
});

/**
 * THE NO-SIDEWAYS-PAN RULE SET.
 *
 * The user read mail on a phone and reported the page moving left to
 * right — *"should have no overflow and stuff for some reason i can move
 * left to right on the emails fix that."* Each rule below was chosen
 * against a MEASURED cause in this user's own inbox (see BODY_STYLE's
 * comment for the numbers), so each is pinned individually: a future edit
 * that drops one silently brings back one specific class of broken
 * message, and "the CSS is still there somewhere" is not the assertion
 * that catches it.
 */
describe('srcDocFor — the stylesheet that keeps a message inside its frame', () => {
  const style = (): string => {
    const match = /<style>([\s\S]*?)<\/style>/.exec(srcDocFor('<p>x</p>'));
    expect(match).not.toBeNull();
    return match![1]!;
  };

  it('breaks long unbreakable tokens with `anywhere`, not `break-word`', () => {
    // Not interchangeable, and the difference is the whole fix: both wrap
    // a long URL, but only `anywhere` also lowers min-content width,
    // which is what stops a table cell holding one from forcing the
    // table — and the document — wider than the frame.
    expect(style()).toContain('overflow-wrap:anywhere');
    expect(style()).not.toContain('overflow-wrap:break-word');
  });

  it('wraps <pre>, where white-space:pre otherwise defeats every wrap rule', () => {
    // A GitHub notification carrying a code diff measured 707px wide in a
    // 341px frame with no ELEMENT wider than the frame — the overflow was
    // inline content inside <pre>. This rule took it to exactly 341.
    expect(style()).toContain('pre{white-space:pre-wrap;overflow-wrap:anywhere}');
  });

  it('caps images with a viewport length, because a percentage cannot shrink a table', () => {
    // The load-bearing detail. A percentage max-width is treated as
    // `none` while the browser computes min-content width — the very step
    // that sizes a <table width="640"> around an <img width="640"> — so
    // `max-width:100%` alone leaves both at 640. A vw length participates.
    const declaration = /img\{([^}]*)\}/.exec(style())?.[1] ?? '';
    expect(declaration).toContain('100vw');
    expect(declaration).toContain('height:auto');
  });

  it('bounds tables, and gives a top-level one its own horizontal scroll', () => {
    // One measured message pins its width at 640 through a single <tr> of
    // five <td>s — a real five-across layout no stylesheet can stack
    // without destroying it. The top-level table becomes a block-level
    // scroll container so that overflow is confined to that element and
    // the DOCUMENT never pans.
    expect(style()).toContain('table{max-width:100%}');
    expect(style()).toContain('body>table{display:block;max-width:100%;overflow-x:auto}');
  });

  it('scopes the block-scroll treatment to TOP-LEVEL tables only', () => {
    // `table{display:block}` unscoped would collapse every multi-column
    // email into one column, because email layout IS nested tables.
    // Anchored to the START of a rule, so it cannot be satisfied (or
    // defeated) by the `body>table{...}` rule the previous test requires:
    // what must not exist is a rule whose whole selector is `table`.
    expect(style()).not.toMatch(/(?:^|[;}])table\{[^}]*display:block/);
    expect(style()).toMatch(/body>table\{[^}]*display:block/);
  });

  it('leaves the sandbox and the policy untouched — this was a layout fix', () => {
    // The pan was fixed inside the srcdoc's own stylesheet. Nothing about
    // it needed, or got, a loosened frame.
    const doc = srcDocFor('<p>x</p>');
    expect(doc).not.toContain('allow-scripts');
    expect(doc).not.toContain('allow-same-origin');
    expect(IFRAME_SANDBOX).toBe('allow-popups allow-popups-to-escape-sandbox');
  });
});

describe('contentSecurityPolicyFor', () => {
  it('emits one fixed policy, with img-src as the only permissive fetch directive', () => {
    const directives = contentSecurityPolicyFor().split('; ');
    // Every directive that names a scheme rather than 'none' or
    // 'unsafe-inline'. If a future edit re-opens connect-src, media-src
    // or anything else to the network, this list grows and the test
    // fails — which is the point: the user traded away ONE control.
    const permissive = directives.filter((directive) => /https:|http:/.test(directive));
    expect(permissive).toEqual(['img-src data: cid: https: http:']);
  });

  it('is deterministic — the same policy on every call', () => {
    expect(contentSecurityPolicyFor()).toBe(contentSecurityPolicyFor());
  });
});

/**
 * THE SANDBOX GUARD.
 *
 * `IFRAME_SANDBOX` being correct is worth nothing if a second iframe
 * appears somewhere with its own, laxer attribute — which is exactly how
 * a boundary like this erodes in practice. So this scans the real source
 * tree: every `sandbox=` in client/src must be the shared constant, and
 * the constant must not contain `allow-scripts` (nor `allow-same-origin`,
 * whose pairing with it is the documented way to remove a sandbox
 * entirely).
 */
const sources = import.meta.glob('../src/**/*.{ts,tsx}', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

/** Same treatment tests/neutral-class-guard.test.ts applies, and for the
 *  same reason: the doc comments in MessageView.tsx and messageBody.ts
 *  both DISCUSS `sandbox=` in prose, and prose is not an emitted
 *  attribute. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const SANDBOX_ATTR = /sandbox\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g;

function sandboxAttributes(source: string): readonly string[] {
  return [...stripComments(source).matchAll(SANDBOX_ATTR)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? '',
  );
}

describe('the iframe sandbox, as actually emitted by client/src', () => {
  it('omits allow-scripts — nothing in a message body ever executes', () => {
    expect(IFRAME_SANDBOX).not.toContain('allow-scripts');
  });

  it('omits allow-same-origin — the frame cannot reach this document or its session', () => {
    expect(IFRAME_SANDBOX).not.toContain('allow-same-origin');
  });

  it('is exactly the pair that keeps ordinary links working, and nothing more', () => {
    expect(IFRAME_SANDBOX).toBe('allow-popups allow-popups-to-escape-sandbox');
  });

  it('finds at least one real sandbox attribute to check (the guard is not vacuous)', () => {
    const found = Object.values(sources).flatMap(sandboxAttributes);
    expect(found.length).toBeGreaterThan(0);
  });

  it('routes every sandbox attribute in client/src through the one shared constant', () => {
    const offenders = Object.entries(sources).flatMap(([file, source]) =>
      sandboxAttributes(source)
        .filter((value) => value.trim() !== 'IFRAME_SANDBOX')
        .map((value) => ({ file, value })),
    );
    expect(offenders).toEqual([]);
  });

  it('would catch a hand-written allow-scripts iframe (proves the scanner can fail)', () => {
    const buggy = '<iframe sandbox="allow-scripts allow-same-origin" srcDoc={doc} />';
    expect(sandboxAttributes(buggy)).toEqual(['allow-scripts allow-same-origin']);
    expect(sandboxAttributes(buggy).some((value) => value.includes('allow-scripts'))).toBe(true);
  });
});

/**
 * THE BODY FRAME'S HEIGHT.
 *
 * The parent cannot measure a frame it has deliberately given an opaque
 * origin (`iframe.contentDocument` is `null`; `contentWindow.document`
 * throws), and neither `allow-same-origin` nor `allow-scripts` is on the
 * table — so this estimate is what decides how tall the message sits.
 *
 * These tests assert PROPERTIES rather than a table of numbers copied out
 * of the implementation. A test that restated the formula would pass for
 * any formula; what actually matters is the clamp, the direction of the
 * bias, and the one case that made this function necessary — a body that
 * is structurally present and visually empty.
 */
describe('estimatedBodyHeightPx — how tall the sandboxed body frame gets', () => {
  const { min, max, referenceWidth } = BODY_HEIGHT_BOUNDS_PX;

  /** At the reference width the text term scales by 1, so these read as
   *  the phone-width estimate the constants were measured against. */
  const heightOf = (html: string, width: number = referenceWidth): number =>
    estimatedBodyHeightPx(html, width);

  it('gives an empty Gmail body a short frame, not two screens of white', () => {
    // THE CASE THIS FUNCTION EXISTS FOR. One generous fixed height was
    // tried first, and this real message — the entire body of a "Pitch
    // Deck" mail whose content is its attachment — rendered as ~1786px of
    // blank white above its own attachment list.
    const empty = '<div dir="ltr"><div class="gmail_default"><br></div></div>';
    expect(heightOf(empty)).toBe(min);
    expect(heightOf('')).toBe(min);
  });

  it('keeps a two-line reply near the floor rather than near the ceiling', () => {
    const reply = '<p>Sounds good — merged and deployed. Thanks for the review!</p>';
    expect(heightOf(reply)).toBeLessThan(600);
  });

  it('takes a long marketing mail to the ceiling', () => {
    const long = '<tr><td>' + 'Summer savings, ends tonight. '.repeat(400) + '</td></tr>';
    expect(heightOf(long)).toBe(max);
  });

  it('never escapes its bounds, whatever it is handed', () => {
    for (const html of ['', '<br>', '<img>'.repeat(500), 'x'.repeat(200_000)]) {
      const height = heightOf(html);
      expect(height).toBeGreaterThanOrEqual(min);
      expect(height).toBeLessThanOrEqual(max);
    }
  });

  it('grows with text, with images and with table rows', () => {
    // Monotonic in each input, which is the property that makes an
    // over-estimate a WHITE-SPACE bug rather than a scrolling one.
    const base = '<p>' + 'word '.repeat(120) + '</p>';
    expect(heightOf(base + 'word '.repeat(120))).toBeGreaterThan(
      heightOf(base),
    );
    expect(heightOf(base + '<img src="a.png">')).toBeGreaterThan(
      heightOf(base),
    );
    expect(heightOf(base + '<tr><td>a</td></tr>')).toBeGreaterThan(
      heightOf(base),
    );
  });

  it('does not count a stylesheet or a script as prose', () => {
    // Marketing mail routinely carries tens of KB of <style>. Counting it
    // as text would push every such message to the ceiling and put the
    // white space back.
    const styled =
      '<style>' + '.a{color:#fff;background:#000;padding:4px}'.repeat(400) + '</style><p>Hi</p>';
    expect(heightOf(styled)).toBe(min);
  });

  it('is pure — the same html gives the same height every time', () => {
    // The regexes it counts with are module-level and carry /g, so a
    // leaked `lastIndex` would make the SECOND call on a message shorter
    // than the first. That would show up as a frame that changes height
    // when the reader re-renders.
    const html = '<p>hello</p><img src="a.png"><tr><td>x</td></tr>';
    expect(heightOf(html)).toBe(heightOf(html));
    expect(heightOf(html)).toBe(heightOf(html));
  });

  it('shortens the same message in a wider column, because prose reflows', () => {
    // The desktop half of the same bug. A phone-tuned constant applied at
    // the 960px reader column put ~1000px of white under a 1025px message.
    const prose = '<p>' + 'The quick brown fox jumps over the lazy dog. '.repeat(60) + '</p>';
    expect(heightOf(prose, 960)).toBeLessThan(heightOf(prose, referenceWidth));
  });

  it('leaves images and table rows unscaled — those do not reflow with the column', () => {
    // No text nodes at all: the text term is the only one that scales, so
    // a stray character in a cell would make this assertion about prose.
    const media = '<img src="a.png">'.repeat(6) + '<tr><td></td></tr>'.repeat(6);
    expect(heightOf(media, 960)).toBe(heightOf(media, referenceWidth));
  });

  it('falls back to the reference width rather than dividing by a bad one', () => {
    // An unmounted frame or a display:none column reports 0. Dividing by
    // it would produce Infinity and, after the clamp, silently pin every
    // message to the ceiling.
    const prose = '<p>' + 'word '.repeat(80) + '</p>';
    const expected = heightOf(prose, referenceWidth);
    expect(heightOf(prose, 0)).toBe(expected);
    expect(heightOf(prose, -50)).toBe(expected);
    expect(heightOf(prose, Number.NaN)).toBe(expected);
  });

  it('returns whole pixels, and bounds that are sane relative to each other', () => {
    expect(Number.isInteger(heightOf('<p>x</p>'))).toBe(true);
    expect(min).toBeLessThan(max);
  });
});

describe('bodyKind', () => {
  it('prefers html when there is one', () => {
    expect(bodyKind({ html: '<p>hi</p>', text: 'hi' })).toBe('html');
  });

  it('falls back to text when html is null', () => {
    expect(bodyKind({ html: null, text: 'plain body' })).toBe('text');
  });

  it('treats whitespace-only html as absent, not as an empty frame', () => {
    expect(bodyKind({ html: '   \n ', text: 'plain body' })).toBe('text');
  });

  it('is empty when the message carries neither — an attachment-only mail', () => {
    expect(bodyKind({ html: null, text: null })).toBe('empty');
    expect(bodyKind({ html: '', text: '  ' })).toBe('empty');
  });
});

describe('formatSize — the DECODED size this route supplies', () => {
  it('shows whole bytes below 1 KB', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(812)).toBe('812 B');
  });

  it('shows one decimal above it, with no trailing .0', () => {
    expect(formatSize(1024)).toBe('1 KB');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(1048576)).toBe('1 MB');
    expect(formatSize(2411724)).toBe('2.3 MB');
    expect(formatSize(1073741824)).toBe('1 GB');
  });

  it('says so when the size is unknown, rather than claiming an empty file', () => {
    expect(formatSize(null)).toBe('unknown size');
    expect(formatSize(undefined)).toBe('unknown size');
    expect(formatSize(Number.NaN)).toBe('unknown size');
    expect(formatSize(-1)).toBe('unknown size');
  });
});

describe('isDownloadable — the partId === "" 404-avoidance', () => {
  it('is false for the empty part id, which means "not addressable"', () => {
    // sync/src/api/message.ts emits '' when it cannot establish the real
    // IMAP part number and refuses to guess. A guessed number is the 4th
    // segment of the download route: it 404s, or silently fetches a
    // different part of the message. So: no link, ever.
    expect(isDownloadable({ partId: '' })).toBe(false);
  });

  it('is false for whitespace, which would build an equally dead URL', () => {
    expect(isDownloadable({ partId: '   ' })).toBe(false);
  });

  it('is true for a real part number', () => {
    expect(isDownloadable({ partId: '2' })).toBe(true);
    expect(isDownloadable({ partId: '2.1.3' })).toBe(true);
  });
});

describe('attachmentUrl', () => {
  /** Copied verbatim from sync/src/api/routes.ts's `attachmentMatch`. If
   *  the route ever changes shape, this test is what notices. */
  const ROUTE = /^\/api\/attachment\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/;

  it('builds the four-segment route the server actually matches', () => {
    const url = attachmentUrl('primary', 'INBOX', '33097', '2');
    expect(url).toBe('/api/attachment/primary/INBOX/33097/2');
    expect(ROUTE.test(url)).toBe(true);
  });

  it('keeps a folder containing a slash inside ONE segment', () => {
    // '[Gmail]/Sent Mail' unencoded would split the path into five
    // segments and miss the route entirely — a 404 for every attachment
    // in every Gmail system folder.
    const url = attachmentUrl('primary', '[Gmail]/Sent Mail', '12', '2.1');
    const match = ROUTE.exec(url);
    expect(match).not.toBeNull();
    expect(decodeURIComponent(match![2]!)).toBe('[Gmail]/Sent Mail');
    expect(match![4]).toBe('2.1');
  });

  it('encodes an account id or part id that carries route-significant characters', () => {
    const url = attachmentUrl('a/b', 'INBOX', '1', 'x y');
    const match = ROUTE.exec(url);
    expect(match).not.toBeNull();
    expect(decodeURIComponent(match![1]!)).toBe('a/b');
    expect(decodeURIComponent(match![4]!)).toBe('x y');
  });
});

describe('messageKey', () => {
  it('is accountId:uid — unique across the merged inbox, where a uid is not', () => {
    expect(messageKey({ account_id: 'primary', uid: '33097' })).toBe('primary:33097');
  });

  it('separates two accounts that share a uid', () => {
    expect(messageKey({ account_id: 'primary', uid: '7' })).not.toBe(
      messageKey({ account_id: 'harvard', uid: '7' }),
    );
  });
});

describe('formatReceived — the reader header timestamp', () => {
  // The vitest config pins TZ=UTC and this formatter pins the locale, so
  // the parts asserted here are stable; the exact separators are left
  // unasserted because ICU has changed them between Node versions before.
  it('gives a full date and time, not the list row abbreviation', () => {
    const formatted = formatReceived('2026-08-24T14:32:00Z');
    expect(formatted).toContain('Aug');
    expect(formatted).toContain('24');
    expect(formatted).toContain('2026');
    expect(formatted).toContain('2:32');
  });

  it('degrades to an em dash for a missing or unparseable header', () => {
    expect(formatReceived(null)).toBe('—');
    expect(formatReceived('')).toBe('—');
    expect(formatReceived('not a date')).toBe('—');
  });
});

describe('srcDocFor dark scheme', () => {
  const HTML = '<p style="color:#333">hello</p>';

  it('leaves the document light when no scheme is asked for', () => {
    // Back-compat: the one-argument call MessageView used before dark mode
    // existed must produce exactly what it always did.
    expect(srcDocFor(HTML)).toBe(srcDocFor(HTML, 'light'));
    expect(srcDocFor(HTML)).not.toContain('invert(1)');
  });

  it('inverts the page in dark, so a sender-set text colour cannot go black-on-black', () => {
    const doc = srcDocFor(HTML, 'dark');
    expect(doc).toContain('html{color-scheme:dark;filter:invert(1) hue-rotate(180deg)}');
  });

  it('re-inverts media so a photo is not served as a negative', () => {
    const doc = srcDocFor(HTML, 'dark');
    // The SECOND inversion is the whole point: it must apply to media and
    // must be the same transform, or it does not cancel.
    expect(doc).toMatch(/img,picture,video,canvas,svg,embed,object\{filter:invert\(1\) hue-rotate\(180deg\)\}/);
  });

  it('keeps the pre-filter background WHITE, since white is what inverts to near-black', () => {
    // A dark literal here would invert to WHITE and hand the user the exact
    // bright rectangle this change exists to remove — the inverted-twice
    // trap. Pin it so nobody "fixes" the background to a dark value.
    const doc = srcDocFor(HTML, 'dark');
    expect(doc).toContain('background:#ffffff');
    expect(doc).not.toContain('background:#000');
  });

  it('still carries the CSP and sandbox-critical head in dark', () => {
    // Dark mode is a stylesheet concern and must not disturb the security
    // boundary; this asserts the two cannot drift apart.
    const doc = srcDocFor(HTML, 'dark');
    expect(doc).toContain('Content-Security-Policy');
    expect(doc).toContain('<base target="_blank">');
  });
});
