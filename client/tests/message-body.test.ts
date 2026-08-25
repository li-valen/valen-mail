import { describe, expect, it } from 'vitest';
import {
  IFRAME_SANDBOX,
  attachmentUrl,
  bodyKind,
  contentSecurityPolicyFor,
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

  it('blocks remote images by default — img-src permits only data: and cid:', () => {
    const policy = policyOf(srcDocFor(HTML));
    expect(policy).toContain('img-src data: cid:');
    expect(policy).not.toContain('https:');
    expect(policy).not.toContain('http:');
    expect(policy).toBe(contentSecurityPolicyFor(false));
  });

  it('permits remote images only when explicitly asked, and says so in img-src', () => {
    const policy = policyOf(srcDocFor(HTML, { allowRemote: true }));
    expect(policy).toContain('img-src data: cid: https: http:');
    expect(policy).toBe(contentSecurityPolicyFor(true));
  });

  /**
   * Non-vacuity for the flip above: if `allowRemote` were ever ignored —
   * a dropped argument, a default that stopped being read — both branches
   * would produce identical documents and every assertion above would
   * still pass on the blocking one. This is the test that notices.
   */
  it('produces DIFFERENT documents for the two states (the flag is actually read)', () => {
    expect(srcDocFor(HTML, { allowRemote: true })).not.toBe(srcDocFor(HTML, { allowRemote: false }));
    expect(srcDocFor(HTML, {})).toBe(srcDocFor(HTML, { allowRemote: false }));
  });

  it('denies everything else in both states — scripts, objects, frames, forms, base', () => {
    for (const doc of [srcDocFor(HTML), srcDocFor(HTML, { allowRemote: true })]) {
      expect(doc).toContain("default-src 'none'");
      expect(doc).toContain("script-src 'none'");
      expect(doc).toContain("object-src 'none'");
      expect(doc).toContain("frame-src 'none'");
      expect(doc).toContain("form-action 'none'");
      expect(doc).toContain("base-uri 'none'");
    }
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
    expect(srcDocFor('<p>x</p>', { allowRemote: true })).not.toContain('allow-scripts');
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

describe('contentSecurityPolicyFor', () => {
  it('changes exactly one directive between the two states', () => {
    const blocked = contentSecurityPolicyFor(false).split('; ');
    const allowed = contentSecurityPolicyFor(true).split('; ');
    expect(allowed.length).toBe(blocked.length);
    const differing = blocked.filter((directive, index) => directive !== allowed[index]);
    expect(differing).toEqual(['img-src data: cid:']);
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
