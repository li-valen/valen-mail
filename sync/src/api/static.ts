import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Static file serving for the built web client (Task 8, Plan 3).
 *
 * Pulled out of ./routes.ts on purpose — that file is already ~680 lines
 * and this is a genuinely separate concern with its own rules: path
 * resolution, containment against traversal, content types, cache policy,
 * and the SPA fallback. routes.ts keeps exactly one call into here, made
 * only for a path that has already been proven NOT to start with `/api/`
 * (see createRouter's dispatcher) — nothing in this module ever needs to
 * know what an API route looks like, and nothing here requires a
 * credential: static files are public by design, the API keeps its own
 * auth entirely untouched.
 *
 * No in-memory cache layer, deliberately (YAGNI at personal-tool traffic):
 * every request re-reads the file with plain `node:fs/promises`. A cache
 * is exactly the kind of thing that goes stale the moment a redeploy
 * replaces `sync/public` out from under a running process, and this
 * service already has enough of those bugs to avoid without inventing a
 * new one.
 */

const NO_CACHE = 'no-cache';

/** Vite's own cache-busting scheme: a hashed asset's filename changes the
 *  moment its content does, so a year-long cache is correct, not reckless. */
const IMMUTABLE_LONG_CACHE = 'public, max-age=31536000, immutable';

const NOSNIFF = 'nosniff';

/**
 * The three paths (plus the extensionless directory root, which always
 * resolves to `/index.html` — see resolvePathWithinRoot) that must never be
 * cached beyond revalidation.
 *
 * `sw.js`: a cached service worker is close to impossible to evict from an
 * installed PWA — see sync/deploy/README.md §14 for the failure mode this
 * avoids. `index.html`: it references the current build's hashed asset
 * filenames, so a stale cached copy points at assets a redeploy already
 * deleted. `manifest.webmanifest`: cheap to keep fresh, and nothing about
 * it benefits from a long cache the way a hashed asset does.
 */
const NO_CACHE_ROOT_RELATIVE_PATHS = new Set<string>([
  '/index.html',
  '/sw.js',
  '/manifest.webmanifest',
]);

/** Content types for every extension Task 8 is known to need, plus
 *  `text/javascript` for both `.js` and `.mjs` (Vite emits `.js`; `.mjs` is
 *  included because nothing about this map should silently regress if that
 *  changes). Anything else falls back to DEFAULT_CONTENT_TYPE. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/**
 * Resolves `sync/public` relative to THIS module's own file location, not
 * the process's current working directory — the systemd unit sets
 * `WorkingDirectory=/opt/postbox/sync`, but nothing here should depend on
 * that holding true forever, and it is trivially wrong in, say, a test
 * runner invoked from the repo root. `STATIC_ROOT` overrides it outright
 * when set, which is how a deploy could relocate the built client without
 * a code change.
 *
 * `import.meta.dirname` for "this module's own location" mirrors
 * scripts/check-runtime.ts's SYNC_ROOT, the one other place in this
 * codebase that needed a cwd-independent path.
 */
export function defaultStaticRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.STATIC_ROOT;
  if (override) return path.resolve(override);
  // sync/src/api/static.ts -> sync/public
  return path.resolve(import.meta.dirname, '..', '..', 'public');
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] ?? DEFAULT_CONTENT_TYPE;
}

function cacheControlFor(rootRelativePath: string): string | null {
  if (NO_CACHE_ROOT_RELATIVE_PATHS.has(rootRelativePath)) return NO_CACHE;
  if (rootRelativePath.startsWith('/assets/')) return IMMUTABLE_LONG_CACHE;
  return null;
}

interface ResolvedPath {
  readonly absolutePath: string;
  /** Root-relative, always starting with `/`, always `/`-separated even on
   *  a platform whose path.sep isn't `/` — used only for the two
   *  extension-agnostic cache-policy checks above, so it must match the
   *  literal URL shape those checks are written against. */
  readonly rootRelativePath: string;
}

/**
 * Decodes and resolves a request path against `root`, or returns null the
 * moment anything looks unsafe — never partially trusting a suspicious
 * input. Every failure mode here is a deliberate fail-closed, matching the
 * accumulated constraint (Task 8, point 5): traversal, encoded traversal,
 * absolute-path tricks and null bytes must all fail closed to the SPA
 * fallback or a 404, never to a file outside root.
 *
 * The containment check is the load-bearing line: `path.resolve` collapses
 * every `..` segment BEFORE the prefix check runs, so `path.join` (which
 * normalizes but does not clamp to a base) would not be safe here — only
 * resolve-then-compare is.
 */
function resolvePathWithinRoot(root: string, pathname: string): ResolvedPath | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Malformed percent-encoding (e.g. a lone "%"). Fails closed exactly
    // like a traversal attempt: the caller falls through to the SPA
    // fallback or a 404, never to decodeURIComponent's partial result.
    return null;
  }

  // A decoded null byte cannot be part of any real filename on the target
  // filesystems (Linux/macOS both reject it), so treating it as unsafe
  // input here — rather than letting it reach `readFile` and surface as
  // some fs-level error — keeps the "why this failed" reasoning in one
  // place.
  if (decoded.includes('\0')) return null;

  // `pathname` always starts with "/" (URL.pathname's contract). Stripping
  // every leading slash before resolving means the segment is ALWAYS
  // treated as relative to `root` — an attacker-supplied "//etc/passwd" or
  // similar cannot be interpreted as its own filesystem root the way it
  // could if passed to path.resolve as a second absolute-looking argument.
  const relative = decoded.replace(/^\/+/, '');
  const absolutePath = path.resolve(root, relative);

  const isWithinRoot = absolutePath === root || absolutePath.startsWith(root + path.sep);
  if (!isWithinRoot) return null;

  const rootRelativePath = `/${path.relative(root, absolutePath).split(path.sep).join('/')}`;
  return { absolutePath, rootRelativePath };
}

/**
 * Distinguishes "this 404 should fall back to index.html" (a client-side
 * route like `/thread/abc`, or the bare `/`) from "this 404 is a real
 * miss" (a hashed asset that no longer exists, e.g. after a redeploy).
 *
 * Serving index.html for the second case would trade a clean 404 for a
 * baffling MIME error in the browser — the client asked for
 * `text/javascript` and got `text/html` — so the two cases must not share
 * a response. The heuristic is deliberately about the REQUESTED path, not
 * the resolved file: an extension other than `.html` on the last path
 * segment means "this was meant to be an asset", full stop, matched or not.
 */
function looksLikeNonHtmlAsset(pathname: string): boolean {
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dotIndex = lastSegment.lastIndexOf('.');
  if (dotIndex <= 0) return false; // no extension, or a dotfile with none
  return lastSegment.slice(dotIndex).toLowerCase() !== '.html';
}

function notFound(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': NOSNIFF },
  });
}

/**
 * Reads one file and builds its Response, or returns null on a miss —
 * ENOENT (file does not exist) and EISDIR/ENOTDIR (path names a directory,
 * e.g. a bare `/assets/` request) are both ordinary "try the next thing"
 * outcomes, not errors to log. Anything else (EACCES chief among them) is
 * unexpected and IS logged — an operator needs to know the process cannot
 * read a file it should be able to, and a silent 404 would hide that.
 *
 * `forcedCacheControl` exists for exactly one caller: the SPA fallback,
 * which must always answer `no-cache` — the same freshness rule as a
 * direct `/index.html` request — regardless of what path the browser
 * actually asked for.
 */
async function tryServeFile(
  resolved: ResolvedPath,
  isHead: boolean,
  forcedCacheControl?: string,
): Promise<Response | null> {
  let data: Buffer;
  try {
    data = await readFile(resolved.absolutePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'EISDIR' && code !== 'ENOTDIR') {
      console.error(`static: failed to read "${resolved.absolutePath}"`, error);
    }
    return null;
  }

  const cacheControl = forcedCacheControl ?? cacheControlFor(resolved.rootRelativePath);
  const headers: Record<string, string> = {
    'content-type': contentTypeFor(resolved.absolutePath),
    'x-content-type-options': NOSNIFF,
    'content-length': String(data.length),
  };
  if (cacheControl) headers['cache-control'] = cacheControl;

  return new Response(isHead ? null : data, { status: 200, headers });
}

/**
 * Fires once, at handler construction, and never blocks it — createRouter
 * calls createStaticHandler synchronously at startup, so this warning is
 * best-effort and asynchronous rather than something the server waits on.
 * Matches the rest of this service's degradation philosophy: a client
 * that has not been built yet is a loud warning, never a crash.
 */
async function warnIfRootMissing(root: string): Promise<void> {
  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      console.warn(
        `static: STATIC_ROOT "${root}" exists but is not a directory — static files will ` +
          'not be served until this is fixed',
      );
    }
  } catch {
    console.warn(
      `static: STATIC_ROOT "${root}" does not exist — the client has not been built yet ` +
        '(see sync/deploy/README.md §15); serving the API only until it is',
    );
  }
}

/**
 * Builds the static-file request handler for one `root`. Called once per
 * router (mirrors createRouter's own `sessionLimiter`), so the startup
 * warning above fires once, not per request.
 *
 * The returned function answers unconditionally — it always resolves to a
 * Response, matching every other piece of this router — and requires no
 * credential: the caller (createRouter's dispatcher) only ever reaches
 * this for a path already proven not to start with `/api/`.
 */
export function createStaticHandler(
  root: string,
): (method: string, pathname: string) => Promise<Response> {
  const normalizedRoot = path.resolve(root);
  void warnIfRootMissing(normalizedRoot);

  return async (method: string, pathname: string): Promise<Response> => {
    const upperMethod = method.toUpperCase();
    if (upperMethod !== 'GET' && upperMethod !== 'HEAD') {
      return notFound();
    }
    const isHead = upperMethod === 'HEAD';

    const resolved = resolvePathWithinRoot(normalizedRoot, pathname);
    if (resolved) {
      const served = await tryServeFile(resolved, isHead);
      if (served) return served;
    }

    // No file at the requested path (a miss, a traversal attempt, a
    // directory, or undecodable input all land here identically — see
    // resolvePathWithinRoot's own doc comment for why that unification is
    // deliberate). A non-HTML asset never falls back to index.html.
    if (looksLikeNonHtmlAsset(pathname)) {
      return notFound();
    }

    const fallback = resolvePathWithinRoot(normalizedRoot, '/index.html');
    const served = fallback ? await tryServeFile(fallback, isHead, NO_CACHE) : null;
    return served ?? notFound();
  };
}
