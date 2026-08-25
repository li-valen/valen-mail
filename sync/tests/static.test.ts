import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import { createStaticHandler, defaultStaticRoot } from '../src/api/static.ts';

/**
 * Unit-level coverage for ./static.ts (Task 8), exercised directly against
 * a fixture tree under tests/fixtures/static/ — never sync/public, which a
 * concurrent agent building client/ can rewrite at any moment (see this
 * task's brief). Router-level wiring (does static shadow /api/*, does the
 * dispatcher order hold) lives in tests/static-routing.test.ts instead;
 * this file is about the serving rules in isolation: content types, cache
 * policy, containment, and the missing-root degradation.
 *
 * Every test here is written to fail if the behaviour it names were
 * deleted or inverted — a handler that always answered 200, or one that
 * never checked containment, would fail more than one of these.
 */

const FIXTURE_ROOT = path.resolve(import.meta.dirname, 'fixtures', 'static');

// A file that exists one level ABOVE the fixture root, so a traversal
// attempt has something real to try to reach. If any traversal test below
// ever reads this content back, the containment check has failed.
const SECRET_MARKER = 'SECRET-OUTSIDE-ROOT-42a9';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createStaticHandler — serving a real fixture tree', () => {
  const serve = createStaticHandler(FIXTURE_ROOT);

  it('serves index.html at the bare root path', async () => {
    const response = await serve('GET', '/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toContain('fixture index.html');
  });

  it('serves index.html directly and marks it no-cache', async () => {
    const response = await serve('GET', '/index.html');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  // Closes the reader iframe's self-navigation gap (task-p6t2-report.md's
  // "Residual gap"): a `<meta http-equiv="refresh">` inside a message body
  // cannot be stopped by the CSP `<meta>` inside its own srcdoc (a document
  // cannot restrict where it navigates itself) or by any sandbox token (a
  // meta-refresh is declarative, not scripting). `frame-src` on THIS
  // document — the one that creates the reader's iframe — is enforced
  // against every later navigation of that nested browsing context
  // regardless of who triggers it, which is what actually closes it. See
  // ../src/api/static.ts's CONTENT_SECURITY_POLICY doc comment for the
  // full reasoning, including the empirical browser check behind it.
  it('serves index.html with a frame-src \'none\' Content-Security-Policy header', async () => {
    const response = await serve('GET', '/index.html');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toBe("frame-src 'none'");
  });

  it('serves the bare root path with the same CSP header, not just /index.html directly', async () => {
    const response = await serve('GET', '/');
    expect(response.headers.get('content-security-policy')).toBe("frame-src 'none'");
  });

  it('the SPA fallback (a client-side route with no matching file) also carries the CSP header', async () => {
    const response = await serve('GET', '/thread/abc123');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("frame-src 'none'");
  });

  // Non-vacuity + scope: proves the header is not a blanket addition to
  // every response. If CONTENT_SECURITY_POLICY's conditional were dropped
  // (always attached) this would fail; if it were never attached at all,
  // the three tests above would fail instead — together they pin the
  // header to exactly the html responses, nothing else.
  it('does not send a Content-Security-Policy header on non-html responses', async () => {
    const asset = await serve('GET', '/assets/app-Abc123.js');
    const worker = await serve('GET', '/sw.js');
    const manifest = await serve('GET', '/manifest.webmanifest');
    expect(asset.headers.get('content-security-policy')).toBeNull();
    expect(worker.headers.get('content-security-policy')).toBeNull();
    expect(manifest.headers.get('content-security-policy')).toBeNull();
  });

  it('serves sw.js with no-cache — a stale service worker is nearly impossible to evict', async () => {
    const response = await serve('GET', '/sw.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it('serves manifest.webmanifest with no-cache', async () => {
    const response = await serve('GET', '/manifest.webmanifest');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/manifest+json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it('serves a hashed asset with a year-long immutable cache', async () => {
    const response = await serve('GET', '/assets/app-Abc123.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('serves a nested file at any depth, with no special cache directive', async () => {
    const response = await serve('GET', '/nested/dir/file.txt');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toContain('nested fixture file');
    // Not one of the three no-cache paths and not under /assets/, so no
    // Cache-Control is set at all — this would fail if every response
    // were wrongly given the same directive regardless of path.
    expect(response.headers.get('cache-control')).toBeNull();
  });

  it('sends X-Content-Type-Options: nosniff on every static response, hit or miss', async () => {
    const hit = await serve('GET', '/sw.js');
    const miss = await serve('GET', '/assets/gone.js');
    expect(hit.headers.get('x-content-type-options')).toBe('nosniff');
    expect(miss.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves a file whose extension is outside the known map as application/octet-stream', async () => {
    const response = await serve('GET', '/data.xyz');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('a non-HTML asset miss is 404, never index.html (a JS 404 must not smell like HTML)', async () => {
    const response = await serve('GET', '/assets/gone.js');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).not.toContain('html');
  });

  it('an extensionless client-side route falls back to index.html, not 404', async () => {
    const response = await serve('GET', '/thread/abc123');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-cache');
    // nosniff is claimed to apply to "every static response" — the SPA
    // fallback is its own code path (tryServeFile called with a forced
    // cache-control from a synthesized /index.html lookup, not the
    // requested path), so it gets its own assertion rather than trusting
    // the hit/miss test above to have covered it by implication.
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toContain('fixture index.html');
  });

  it('HEAD returns the same headers as GET but no body', async () => {
    const head = await serve('HEAD', '/assets/app-Abc123.js');
    const get = await serve('GET', '/assets/app-Abc123.js');
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe(get.headers.get('content-type'));
    expect(head.headers.get('content-length')).toBe(get.headers.get('content-length'));
    expect(await head.text()).toBe('');
  });

  it('HEAD on the SPA fallback also carries no body', async () => {
    const response = await serve('HEAD', '/thread/abc');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  it('refuses a POST to a static path — GET/HEAD only', async () => {
    const response = await serve('POST', '/index.html');
    expect(response.status).toBe(404);
  });

  it('a plain "../" traversal never escapes the root', async () => {
    const response = await serve('GET', '/../secret-outside-root.txt');
    // secret-outside-root.txt has a non-html extension, so containment
    // failure routes it through the asset-miss branch: 404, and — the
    // property that actually matters — never the SECRET_MARKER text.
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).not.toContain(SECRET_MARKER);
  });

  it('a URL-encoded "../" traversal (%2e%2e) never escapes the root either', async () => {
    const response = await serve('GET', '/%2e%2e/secret-outside-root.txt');
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).not.toContain(SECRET_MARKER);
  });

  it('a deeper encoded traversal that actually reaches real /etc/passwd still fails closed', async () => {
    // Enough "%2e%2e/" segments to overshoot the filesystem root regardless
    // of how deep this checkout happens to be nested — path.resolve just
    // stops popping once it reaches "/", so this reliably targets the
    // REAL /etc/passwd on both macOS and Linux. That is deliberate: a
    // shallower traversal that lands on a nonexistent intermediate path
    // would pass this test whether or not containment worked, which is not
    // a real assertion. With containment intact this never even attempts
    // to read /etc/passwd — the request falls back to index.html because
    // "passwd" has no extension. If containment were removed, this test
    // would instead receive 200 with real /etc/passwd bytes (it starts
    // with "root:" on every POSIX system) and fail on the line below.
    const traversal = '/%2e%2e'.repeat(20) + '/etc/passwd';
    const response = await serve('GET', traversal);
    expect([200, 404]).toContain(response.status);
    const body = await response.text();
    expect(body).not.toContain('root:'); // the giveaway line of a real /etc/passwd
    if (response.status === 200) {
      expect(body).toContain('fixture index.html');
    }
  });

  it('a null byte in the path is rejected, not passed through to the filesystem', async () => {
    const response = await serve('GET', '/index.html%00.js');
    // ".js" on the decoded last segment marks it asset-like, so this is a
    // deterministic 404 rather than a fallback — and, more importantly,
    // never a thrown error from a null byte reaching fs.readFile.
    expect(response.status).toBe(404);
  });

  it('a leading "//" is treated as relative to root, never as its own filesystem root', async () => {
    // The classic "absolute-path trick" named in Task 8's containment
    // requirement: a naive `path.resolve(root, pathname)` with the
    // leading slashes left intact could hand path.resolve something that
    // LOOKS like a second absolute path and have it win. Stripping every
    // leading "/" before resolving (see resolvePathWithinRoot) means
    // "//etc/passwd" resolves to "<root>/etc/passwd" — contained, just
    // nonexistent — not to the real /etc/passwd. No extension on the last
    // segment means a miss here falls back to the SPA shell rather than
    // 404ing, and that fallback body is the real assertion: it must be
    // the fixture's own index.html, never real /etc/passwd content.
    const response = await serve('GET', '//etc/passwd');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('fixture index.html');
    expect(body).not.toContain('root:');
  });
});

describe('createStaticHandler — missing static root', () => {
  it('warns once at construction and degrades to 404 rather than throwing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const serve = createStaticHandler('/nonexistent-postbox-static-root-for-tests');
    // The warning is fired without being awaited by design (construction
    // must never block startup on a filesystem stat) — vi.waitFor polls
    // until it lands rather than assuming any fixed number of ticks, which
    // made this flaky under full-suite load where the event loop is busier.
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(1));
    expect(warnSpy.mock.calls[0]?.[0]).toContain('nonexistent-postbox-static-root-for-tests');

    const indexAttempt = await serve('GET', '/');
    const assetAttempt = await serve('GET', '/assets/whatever.js');
    expect(indexAttempt.status).toBe(404);
    expect(assetAttempt.status).toBe(404);
  });
});

describe('defaultStaticRoot', () => {
  it('resolves to sync/public relative to this module, not the process cwd', () => {
    const expected = path.resolve(import.meta.dirname, '..', 'public');
    expect(defaultStaticRoot({} as NodeJS.ProcessEnv)).toBe(expected);
  });

  it('honours STATIC_ROOT when set, resolved to an absolute path', () => {
    const root = defaultStaticRoot({ STATIC_ROOT: './some/relative/path' } as NodeJS.ProcessEnv);
    expect(path.isAbsolute(root)).toBe(true);
    expect(root.endsWith(path.join('some', 'relative', 'path'))).toBe(true);
  });
});
