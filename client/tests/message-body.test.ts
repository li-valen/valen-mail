import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DARK_GROUND,
  FALLBACK_BODY_HEIGHT_PX,
  applySchemeTo,
  IFRAME_SANDBOX,
  attachmentUrl,
  bodyKind,
  contentSecurityPolicyFor,
  formatSize,
  isDownloadable,
  measuredBodyHeightPx,
  messageKey,
  safeGroundColor,
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

  /** The declarations of the one `body>table` rule, without its braces. */
  const bodyTableRule = (): string => {
    const match = /(?:^|[;}])body>table\{([^}]*)\}/.exec(style());
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
    // Asserted declaration by declaration rather than as one literal, so
    // that the centring rule below can be added to, or removed from, this
    // same block without either test standing in for the other.
    expect(bodyTableRule()).toContain('display:block');
    expect(bodyTableRule()).toContain('max-width:100%');
    expect(bodyTableRule()).toContain('overflow-x:auto');
  });

  it('centres that block, because display:block is what discarded its centring', () => {
    // A table box is shrink-to-fit and gets centred by `align="center"`,
    // by an inline `margin:0 auto`, or by the containers around it. A
    // BLOCK box with an explicit width is none of those, so the rule
    // above pinned every fixed-width message to the left edge: measured
    // in the running app at a 960px frame on a <table width="640">,
    // gapLeft 16 (body padding, nothing more) against gapRight 304.
    // Auto inline margins take that to 160/160.
    expect(bodyTableRule()).toContain('margin-inline:auto');
  });

  it('centres ONLY where there is slack, so a full-width email gains no side gaps', () => {
    // Load-bearing, and the reason one declaration is enough: auto margins
    // resolve to zero unless the box's own width leaves room. `max-width`
    // has to stay a PERCENTAGE cap in the same block — it is what clamps
    // an oversized table to the container before margins are resolved, so
    // the too-wide case keeps scrolling in its own box at 16/16 instead of
    // being centred with negative slack. A `max-content`/`fit-content`
    // width here would instead shrink every full-width email and centre
    // the result, which is a different message than the sender wrote.
    expect(bodyTableRule()).toMatch(/max-width:100%/);
    expect(bodyTableRule()).not.toMatch(/width:(?:max|fit|min)-content/);
  });

  it('leaves the centring scoped to top-level tables, like the block treatment', () => {
    // An unscoped `table{margin-inline:auto}` would centre every NESTED
    // table too — in email layout that is the content of the columns, not
    // the layout, and centring it re-flows the message the sender wrote.
    expect(style()).not.toMatch(/(?:^|[;}])table\{[^}]*margin-inline:auto/);
    expect(style()).toMatch(/body>table\{[^}]*margin-inline:auto/);
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

  it('pins html and body to an automatic height, so a message cannot walk the frame down the page', () => {
    // Not styling. The frame is sized from the body's measured height, so a
    // message setting `body{height:100%}` would resolve that against the
    // frame we are sizing, grow by its own padding, and repeat — forever.
    // `!important` is what stops the message's own stylesheet winning.
    expect(style()).toMatch(/html,body\{height:auto!important;min-height:0!important\}/);
  });

  it('leaves the sandbox and the policy untouched — this was a layout fix', () => {
    // The pan was fixed inside the srcdoc's own stylesheet. Nothing about
    // it needed, or got, a loosened frame.
    const doc = srcDocFor('<p>x</p>');
    expect(doc).not.toContain('allow-scripts');
    expect(IFRAME_SANDBOX).toBe(
      'allow-same-origin allow-popups allow-popups-to-escape-sandbox',
    );
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
 * the constant must never contain `allow-scripts`.
 *
 * That second check got MORE important, not less, when `allow-same-origin`
 * was added to the constant so the frame could be measured. The two
 * together are the documented way to remove a sandbox entirely — a frame
 * holding both can reach into this document and rewrite its own `sandbox`
 * attribute — and one half is now permanently present. What used to need
 * two mistakes now needs one.
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
  it('omits allow-scripts — the half whose absence is the entire XSS boundary', () => {
    // Verified in a real browser across all four combinations before
    // `allow-same-origin` was added: with the CSP deliberately removed so
    // the sandbox stood alone, a frame carrying both an inline <script> and
    // an onerror handler ran NEITHER, while the same frame plus
    // `allow-scripts` ran the handler immediately. Execution is the only
    // thing that can use an origin, so this is the assertion that matters.
    expect(IFRAME_SANDBOX).not.toContain('allow-scripts');
  });

  it('carries allow-same-origin, which is what lets the frame be measured', () => {
    // Not a relaxation of the line above — an independent attribute. Its
    // presence is why MessageView.tsx can size the frame to the message
    // instead of estimating it, which is what removed the second scrollbar.
    expect(IFRAME_SANDBOX).toContain('allow-same-origin');
  });

  it('is exactly the three tokens it needs, and nothing more', () => {
    expect(IFRAME_SANDBOX).toBe(
      'allow-same-origin allow-popups allow-popups-to-escape-sandbox',
    );
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
describe('measuredBodyHeightPx — how tall the sandboxed body frame gets', () => {
  /** The structural shape a real `Document` presents to the measurement.
   *  A literal, because jsdom performs no layout and would report every
   *  box as zero — the arithmetic is what is under test here, and the
   *  browser verification of the real numbers is in the task report. */
  const documentWhoseBody = (rectHeight: number, scrollHeight: number) => ({
    body: { scrollHeight, getBoundingClientRect: () => ({ height: rectHeight }) },
  });

  it('returns null when the document cannot be reached at all', () => {
    expect(measuredBodyHeightPx(null)).toBeNull();
    expect(measuredBodyHeightPx(undefined)).toBeNull();
  });

  it('returns null when the document has loaded no body yet', () => {
    expect(measuredBodyHeightPx({ body: null })).toBeNull();
  });

  it('rounds a subpixel body UP, so the frame is never a fraction short of its content', () => {
    // 1535.125 is a real measurement from a real frame. `body.scrollHeight`
    // had already floored it to 1535, and a frame one eighth of a pixel
    // short of its content is a frame with a scrollbar — the exact defect
    // this whole change exists to remove.
    expect(measuredBodyHeightPx(documentWhoseBody(1535.125, 1535))).toBe(1536);
  });

  it('takes the larger of the body box and its scroll height, so overflowing children still fit', () => {
    // An absolutely-positioned footer escapes the body's border box but
    // still counts toward its scroll height.
    expect(measuredBodyHeightPx(documentWhoseBody(200, 900))).toBe(900);
    expect(measuredBodyHeightPx(documentWhoseBody(900, 200))).toBe(900);
  });

  it('refuses a zero measurement rather than collapsing the frame onto it', () => {
    // What an unlaid-out or display:none document reports. Indistinguishable
    // from a real answer once returned, so it is refused at the source.
    expect(measuredBodyHeightPx(documentWhoseBody(0, 0))).toBeNull();
  });

  it('ignores a non-finite measurement rather than writing NaN into a style attribute', () => {
    expect(measuredBodyHeightPx(documentWhoseBody(Number.NaN, 400))).toBe(400);
    expect(measuredBodyHeightPx(documentWhoseBody(Number.POSITIVE_INFINITY, 400))).toBe(400);
  });

  it('offers a fallback tall enough that an unmeasured message is scrollable, not clipped', () => {
    expect(FALLBACK_BODY_HEIGHT_PX).toBeGreaterThan(600);
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
  // The vitest config pins TZ=UTC and this call pins the locale, so the
  // parts asserted here are stable; the exact separators are left
  // unasserted because ICU has changed them between Node versions before.
  // The locale is now an ARGUMENT rather than baked into the formatter
  // (src/displayLocale.ts) — without pinning it, `2:32` would be `14:32`
  // on any machine whose browser or OS reports a 24-hour locale.
  it('gives a full date and time, not the list row abbreviation', () => {
    const formatted = formatReceived('2026-08-24T14:32:00Z', 'en-US');
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
    expect(srcDocFor(HTML)).toContain('<html data-scheme="light"');
    // Not a bare substring check: the dark RULES name the attribute in their
    // selectors in every document, which is the point of them.
    expect(srcDocFor(HTML)).not.toContain('<html data-scheme="dark"');
  });

  it('inverts the page in dark, so a sender-set text colour cannot go black-on-black', () => {
    const doc = srcDocFor(HTML, 'dark');
    expect(doc).toContain('data-scheme="dark"');
    expect(doc).toContain(
      'html[data-scheme="dark"] body{filter:invert(1) hue-rotate(180deg);background:transparent}',
    );
  });

  it('puts the filter on BODY and the ground on HTML, never the other way round', () => {
    // THE WHOLE SEAM FIX. A root background PROPAGATES TO THE CANVAS, and
    // the canvas is painted OUTSIDE the root's own filter — so a filter on
    // `html` can never reach the ground it sits on, and a transparent
    // ground falls back to the opaque colour `color-scheme` implies
    // (#ffffff for light). That shipped once and came back as "dark mode
    // not working here": pale-grey text on a white card.
    const doc = srcDocFor(HTML, 'dark', '#030711');
    expect(doc).toContain('html[data-scheme="dark"]{background:var(--ground,#030711)}');
    expect(doc).toContain('--ground:#030711');
    expect(doc).toContain(
      'html[data-scheme="dark"] body{filter:invert(1) hue-rotate(180deg);background:transparent}',
    );
    // The filter must NOT be on html, and the ground must NOT be
    // transparent — either alone re-creates the defect.
    expect(doc).not.toMatch(/html(\[data-scheme="dark"\])?\{[^}]*filter:/);
    expect(doc).not.toMatch(/html(\[data-scheme="dark"\])?\{[^}]*background:transparent/);
  });

  it('paints the ground the caller was given, so the frame matches its card', () => {
    // Read live from `--color-card` by MessageView, not written here, so
    // the document ground and the card it sits in cannot drift apart.
    // Carried as a custom property on the root element rather than compiled
    // into the stylesheet, so the parent can repaint the ground without
    // rebuilding the document. See `applySchemeTo`.
    expect(srcDocFor(HTML, 'dark', 'hsl(224 71% 4%)')).toContain('--ground:hsl(224 71% 4%)');
    expect(srcDocFor(HTML, 'dark', 'rgb(3, 7, 17)')).toContain('--ground:rgb(3, 7, 17)');
  });

  it('leaves color-scheme at light in dark, so UA controls invert INTO the dark page', () => {
    // `color-scheme:dark` was measured to do the opposite of what it was
    // added for: it gives the frame an opaque #121212 canvas (which no
    // amount of `background:transparent` can see through, so the seam
    // survives), and the dark controls it draws are inverted once more on
    // the way out and arrive LIGHT. Keeping BODY_STYLE's `light` is what
    // makes the UA draw light controls that invert to dark.
    const doc = srcDocFor(HTML, 'dark');
    expect(doc).toContain('color-scheme:light');
    expect(doc).not.toContain('color-scheme:dark');
  });

  it('re-inverts media so a photo is not served as a negative', () => {
    const doc = srcDocFor(HTML, 'dark');
    // The SECOND inversion is the whole point: it must apply to media and
    // must be the same transform, or it does not cancel.
    expect(doc).toMatch(
      /html\[data-scheme="dark"\] :is\(img,picture,video,canvas,svg,embed,object\)\{filter:invert\(1\) hue-rotate\(180deg\)\}/,
    );
  });

  it('overrides the light ground rather than leaving the white one in place', () => {
    // BODY_STYLE paints html AND body #ffffff. Both must be answered: a
    // white html ground is the #000000-vs-#030711 seam the user
    // photographed, and a white BODY box would invert to a black
    // rectangle over the content area regardless of what the root did.
    const doc = srcDocFor(HTML, 'dark', '#030711');
    const css = /<style>([\s\S]*?)<\/style>/.exec(doc)![1]!;
    // Later rules win, so the dark block must come after the base one.
    expect(css.lastIndexOf('html[data-scheme="dark"]{background:var(--ground,#030711)}')).toBeGreaterThan(
      css.indexOf('html{color-scheme:light;background:#ffffff}'),
    );
    expect(css.lastIndexOf('background:transparent')).toBeGreaterThan(css.indexOf('color:#111827'));
  });

  it('scopes every dark rule to the attribute, so a light document cannot be inverted by one', () => {
    // The dark rules now ship in EVERY document — that is exactly what lets
    // the scheme change without reloading the frame, and reloading is what
    // re-fired the message's tracking pixels. So the property that has to
    // hold is no longer "a light document contains no dark rules"; it is
    // that not one of them can match without the attribute.
    const doc = srcDocFor(HTML, 'light', '#030711');
    expect(doc).toContain('data-scheme="light"');
    expect(doc).toContain('html{color-scheme:light;background:#ffffff}');

    const css = /<style>([\s\S]*?)<\/style>/.exec(doc)![1]!;
    const darkRules = css
      .split('}')
      .filter((rule) => rule.includes('invert(1)') || rule.includes('--ground'));
    expect(darkRules.length).toBeGreaterThan(0);
    for (const rule of darkRules) expect(rule).toContain('[data-scheme="dark"]');
  });

  it('switches a loaded document in place, which is what avoids the reload', () => {
    // Records what a real documentElement would receive.
    const writes: Array<[string, string]> = [];
    const props: Array<[string, string]> = [];
    const doc = {
      documentElement: {
        setAttribute: (n: string, v: string) => writes.push([n, v]),
        style: { setProperty: (n: string, v: string) => props.push([n, v]) },
      },
    };

    expect(applySchemeTo(doc, 'dark', '#030711')).toBe(true);
    expect(writes).toEqual([['data-scheme', 'dark']]);
    expect(props).toEqual([['--ground', '#030711']]);

    expect(applySchemeTo(doc, 'light', '#030711')).toBe(true);
    expect(writes[1]).toEqual(['data-scheme', 'light']);
  });

  it('reports failure instead of silently leaving a message in the wrong scheme', () => {
    // The caller retries on load when this is false. Swallowing it would
    // strand a message in the previous theme with no way to notice.
    expect(applySchemeTo(null, 'dark', '#030711')).toBe(false);
    expect(applySchemeTo(undefined, 'dark', '#030711')).toBe(false);
    expect(applySchemeTo({ documentElement: null }, 'dark', '#030711')).toBe(false);
  });

  it('validates the ground on the way in, exactly as srcDocFor does', () => {
    const props: Array<[string, string]> = [];
    const doc = {
      documentElement: {
        setAttribute: () => {},
        style: { setProperty: (n: string, v: string) => props.push([n, v]) },
      },
    };
    applySchemeTo(doc, 'dark', 'red;}*{display:none');
    expect(props).toEqual([['--ground', DEFAULT_DARK_GROUND]]);
  });

  it('differs from the dark document ONLY by the root attribute', () => {
    // This is the property the whole no-reload arrangement rests on: if the
    // two documents differed anywhere else, switching would have to rebuild.
    const light = srcDocFor(HTML, 'light', '#030711');
    const dark = srcDocFor(HTML, 'dark', '#030711');
    expect(light).not.toBe(dark);
    expect(light.replace('data-scheme="light"', 'data-scheme="dark"')).toBe(dark);
  });

  it('still carries the CSP and sandbox-critical head in dark', () => {
    // Dark mode is a stylesheet concern and must not disturb the security
    // boundary; this asserts the two cannot drift apart.
    const doc = srcDocFor(HTML, 'dark');
    expect(doc).toContain('Content-Security-Policy');
    expect(doc).toContain('<base target="_blank">');
  });
});

/**
 * `safeGroundColor` — what may reach the message document's stylesheet.
 *
 * The value is this app's own palette token, not a sender's, so this is
 * not defending against an attacker. It is defending the one invariant
 * every other guard in this file rests on: that the `<style>` block
 * contains exactly what it is believed to contain. A value carrying `}`
 * could close the rule and open another inside a document whose entire
 * security story is a `default-src 'none'` CSP.
 */
describe('safeGroundColor', () => {
  it('accepts the notations a resolved custom property can actually hold', () => {
    for (const value of ['#030711', '#fff', '#030711ff', 'rgb(3, 7, 17)', 'rgba(3,7,17,0.5)', 'hsl(224 71% 4%)', 'hsla(224,71%,4%,1)']) {
      expect(safeGroundColor(value)).toBe(value);
    }
  });

  it('trims, because getPropertyValue returns a leading space', () => {
    expect(safeGroundColor('  hsl(224 71% 4%)  ')).toBe('hsl(224 71% 4%)');
  });

  it('refuses anything that could escape the declaration or reach the network', () => {
    for (const hostile of [
      '#030711}html{background:#fff',
      'red;}*{display:none',
      'url(https://tracker.example/x.png)',
      'var(--anything)',
      'expression(alert(1))',
      '/*',
      'blue',
      '',
    ]) {
      expect(safeGroundColor(hostile)).toBe(DEFAULT_DARK_GROUND);
    }
  });

  it('falls back rather than throwing when the palette cannot be read at all', () => {
    // A mis-read token should cost a slightly stale colour, never a
    // reader that will not render.
    expect(safeGroundColor(null)).toBe(DEFAULT_DARK_GROUND);
    expect(safeGroundColor(undefined)).toBe(DEFAULT_DARK_GROUND);
  });

  it('is what srcDocFor applies, so no caller can bypass it', () => {
    expect(srcDocFor('<p>x</p>', 'dark', 'red;}*{display:none')).toContain(
      `--ground:${DEFAULT_DARK_GROUND}`,
    );
    expect(srcDocFor('<p>x</p>', 'dark', 'red;}*{display:none')).not.toContain('display:none');
  });
});
