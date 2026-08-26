import { timingSafeEqual } from 'node:crypto';
import type { Db } from '../db';
import type { ConnectionPool } from '../imap/pool';
import type { AccountConfig, TrackingConfig } from '../config';
import { fetchBudgetedPart, parsePositiveInt, resolveConnection } from './fetch-part.ts';
import { fetchOpens } from './opens.ts';
import { parseLimit } from './limits.ts';
import { handleInbox } from './inbox.ts';
import { handleSearch } from './search.ts';
import { handleFollowup } from './followup.ts';
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  mintSessionValue,
  requestHasValidSession,
} from './session.ts';
import { createFixedWindowLimiter } from './rate-limit.ts';
import type { RateLimiter } from './rate-limit';
import { json, noContent, NO_STORE, PRIVATE_NO_STORE } from './http.ts';
import { handlePushKey, handlePushSubscribe, handlePushUnsubscribe } from './push.ts';
import type { VapidConfig } from '../push/vapid';
import { handleIdentities } from './identities.ts';
import { handleMessage } from './message.ts';
import { handleSetFlag } from './flags.ts';
import { MessageCache } from './message-cache.ts';
import {
  handleSend,
  SEND_RATE_LIMIT_MAX_ATTEMPTS,
  SEND_RATE_LIMIT_WINDOW_MS,
} from './send.ts';
import type { Transports } from '../send/transports';
import { createStaticHandler, defaultStaticRoot } from './static.ts';

/**
 * Constant-time comparison. A plain `===` short-circuits on the first
 * differing byte, leaking token length and prefix through response timing.
 * This endpoint fronts four (soon up to ten) real mailboxes on the public
 * internet — `timingSafeEqual` throws on a length mismatch, so the length
 * check must happen first, and that check itself leaks nothing the caller
 * doesn't already know (their own input's length).
 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * RFC 7235 makes the auth-scheme token case-insensitive ("Bearer",
 * "bearer" and "BEARER" are the same scheme) and allows more than one SP
 * between the scheme and the credential. A case-sensitive `startsWith`
 * rejected conforming clients with a 401 that looks exactly like a wrong
 * token, which is close to undiagnosable from the client side.
 *
 * `\S+` for the credential is deliberate: a bearer token68 cannot contain
 * whitespace, so trailing whitespace is stripped rather than folded into
 * the token and compared (which could only ever fail).
 */
function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  const match = /^\s*bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1]! : null;
}

/**
 * Decodes one route-capture segment, or returns null on malformed
 * percent-encoding (e.g. a lone "%") instead of letting decodeURIComponent
 * throw inside the handler. createRouter's declared contract is "always
 * resolves to a Response" — an uncaught URIError here would violate that
 * for any caller that doesn't wrap it in its own try/catch the way
 * server.ts happens to (a bare fetch-style caller, which is exactly the
 * shape this signature mimics, would see an unhandled rejection instead).
 */
function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * Decodes every capture in `raw`, in order, or returns a ready 400
 * Response the moment one fails to decode — keeping the try/catch to this
 * one place rather than one per route.
 */
function decodeSegments(raw: readonly string[]): readonly string[] | Response {
  const decoded: string[] = [];
  for (const value of raw) {
    const result = decodeSegment(value);
    if (result === null) return json({ error: 'invalid path segment' }, 400);
    decoded.push(result);
  }
  return decoded;
}

/**
 * Builds an RFC 6266 Content-Disposition value for a filename that a Gmail
 * sender controls, not us.
 *
 * Two halves, both required:
 *  - `filename="..."` is a quoted-string, so it must be Latin-1 and must
 *    not contain a quote, a backslash or a CR/LF. Everything outside
 *    printable ASCII becomes `_`. Without this, a perfectly ordinary
 *    Japanese or accented filename (発表資料.pdf, résumé.pdf) produces a
 *    header value outside Latin-1, and BOTH the Response constructor
 *    (ByteString conversion) and Node's ServerResponse.writeHead
 *    (ERR_INVALID_CHAR) throw — turning an attachment download into a 502.
 *  - `filename*=UTF-8''...` carries the real name for any modern client.
 *    encodeURIComponent leaves `!'()*` unescaped, but RFC 5987's attr-char
 *    set excludes them, so they are percent-encoded here explicitly.
 */
function contentDispositionFor(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()!*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * POST /api/session — trades the API token for a session cookie.
 *
 * This is the one route reachable without an existing credential, because
 * it is how a browser obtains one; it authenticates from its own body
 * instead. Nothing about the submitted value is ever logged or echoed —
 * not a prefix, not a length, not a fragment in a JSON parse error. The
 * only thing recorded is that a rejection happened, which an operator
 * needs and an attacker learns nothing from.
 *
 * `tokenMatches` (not `===`) for the same reason the bearer path uses it:
 * this endpoint is an unauthenticated oracle on the public internet, and a
 * short-circuiting comparison leaks the token's prefix through timing.
 *
 * Rate limited, and it is the only route that is — see ./rate-limit.ts for
 * why the limiter is scoped here and nowhere else. Every non-204 outcome
 * charges the window, including a malformed body: leaving 400s uncounted
 * would hand an attacker a free channel to probe from.
 */
async function handleCreateSession(
  request: Request,
  apiToken: string,
  limiter: RateLimiter,
  nowMs: number,
): Promise<Response> {
  const decision = limiter.check(nowMs);
  if (!decision.allowed) {
    console.error(
      'api: refusing POST /api/session — too many failed attempts in the current window',
    );
    return json({ error: 'too many requests' }, 429, {
      ...NO_STORE,
      'retry-after': String(decision.retryAfterSeconds),
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // The parse error itself is discarded rather than attached: V8 embeds
    // surrounding source in "Unexpected token" messages, and on this route
    // the surrounding source is the credential.
    console.error('api: rejected POST /api/session — request body was not valid JSON');
    limiter.recordFailure(nowMs);
    return json({ error: 'invalid request body' }, 400, NO_STORE);
  }

  const submitted =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>).token : undefined;

  if (typeof submitted !== 'string' || submitted.length === 0) {
    console.error('api: rejected POST /api/session — body carried no non-empty string "token"');
    limiter.recordFailure(nowMs);
    return json({ error: 'invalid request body' }, 400, NO_STORE);
  }

  if (!tokenMatches(submitted, apiToken)) {
    console.error('api: rejected POST /api/session — submitted token did not match API_TOKEN');
    limiter.recordFailure(nowMs);
    return json({ error: 'unauthorized' }, 401, NO_STORE);
  }

  return noContent({
    ...NO_STORE,
    'set-cookie': buildSessionCookie(mintSessionValue(apiToken, Date.now())),
  });
}

/**
 * DELETE /api/session — revokes the browser's copy.
 *
 * Runs after the auth gate, so it works for whichever credential got the
 * caller in: a bearer-authenticated `curl` clearing a stale cookie and a
 * cookie-authenticated browser signing itself out take the same path. The
 * cookie is stateless, so "revoke" means "tell the browser to drop it";
 * a copy captured off the wire stays valid until its signed expiry, which
 * is the trade a store-free session makes and the reason the lifetime is
 * bounded at all. Rotating API_TOKEN is the hard revocation.
 */
function handleDeleteSession(): Response {
  return noContent({ ...NO_STORE, 'set-cookie': buildClearedSessionCookie() });
}

/**
 * Either accepted credential (Task 3.5). The bearer path is checked first
 * and is byte-for-byte the behaviour every existing test, deploy script
 * and `curl` invocation already depends on; the cookie is an additional
 * way in for the browser, never a replacement.
 */
function isAuthorized(request: Request, apiToken: string): boolean {
  const bearer = extractBearerToken(request);
  if (bearer !== null && tokenMatches(bearer, apiToken)) return true;
  return requestHasValidSession(request, apiToken, Date.now());
}

async function handleHealth(pool: ConnectionPool): Promise<Response> {
  // Resolution 1: account ids and statuses only — no email addresses, no
  // message counts, nothing beyond what an operator needs to see which
  // accounts are connected versus reconnecting. This is the one route
  // served without a token, so it must stay incapable of leaking mailbox
  // contents by construction, not just by convention.
  const accounts = [...pool.status.entries()].map(([id, status]) => ({ id, status }));
  return json({ ok: true, accounts });
}

/**
 * Proxies open events from the tracking service so the browser client
 * holds one base URL and one token (this service's own), never the
 * tracking service's. Always answers 200 — never a non-2xx status to
 * signal a tracking outage, which would make the client treat a perfectly
 * working inbox load as a failed page load. `available` is what Task 5's
 * rail branches on to distinguish "tracking is down" from "nobody has
 * opened anything yet"; folding both into `opens: []` with no flag would
 * make those indistinguishable, which is exactly the defect Amendment 1
 * fixes upstream in fetchOpens's own return type.
 *
 * `tracking` is null when TRACKING_BASE_URL/TRACKING_READ_TOKEN were not
 * configured at startup (config.ts logs that loudly once already) — that
 * is handled the same way as a live fetchOpens failure, without making a
 * network call at all.
 */
async function handleOpens(
  url: URL,
  tracking: TrackingConfig | null,
  fetchImpl?: typeof fetch,
): Promise<Response> {
  if (!tracking) {
    return json({ opens: [], available: false }, 200, PRIVATE_NO_STORE);
  }

  const limit = parseLimit(url.searchParams.get('limit'));
  const result = await fetchOpens(limit, {
    baseUrl: tracking.baseUrl,
    token: tracking.readToken,
    fetchImpl,
  });

  if (!result.ok) {
    return json({ opens: [], available: false }, 200, PRIVATE_NO_STORE);
  }
  return json({ opens: result.opens, available: true }, 200, PRIVATE_NO_STORE);
}

async function handleThread(db: Db, threadId: string): Promise<Response> {
  // Resolution 3: an unknown thread id is not distinguished from an empty
  // one. A 404 here would let a caller probe which thread ids exist across
  // the unified inbox; returning 200 with an empty array either way removes
  // that signal.
  const messages = await db.getThread(threadId);
  return json({ messages }, 200, PRIVATE_NO_STORE);
}

async function handleBody(
  pool: ConnectionPool,
  accountId: string,
  folder: string,
  uidRaw: string,
): Promise<Response> {
  const uid = parsePositiveInt(uidRaw);
  if (uid === null) return json({ error: 'invalid uid' }, 400);

  const resolved = resolveConnection(pool, accountId);
  if (resolved instanceof Response) return resolved;

  try {
    // No partId: fetchBodyPart falls through to imapflow's own "whole raw
    // message" download when the part is omitted (see imap/fetch.ts). That
    // includes every attachment, which is exactly why the size cap in
    // fetchBudgetedPart matters most on this route.
    const bytes = await fetchBudgetedPart(pool, resolved, accountId, folder, uid);
    if (bytes instanceof Response) return bytes;
    return new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'message/rfc822', ...PRIVATE_NO_STORE },
    });
  } catch (error) {
    console.error(`api: failed to fetch body for account "${accountId}" uid ${uid}`, error);
    return json({ error: 'failed to fetch message body' }, 502);
  }
}

interface AttachmentMetaRow {
  readonly filename: string | null;
  readonly mime_type: string | null;
}

/**
 * Best-effort metadata lookup so the response can carry a real
 * Content-Type/filename instead of a bare octet-stream. Uses `Db.query`
 * with placeholders — never string-built SQL from route parameters
 * (Resolution 4) — and tolerates a miss (attachment metadata predates this
 * row, or was never recorded) by falling back to generic values rather than
 * failing the whole request.
 *
 * Kept outside the account lock: this is a Postgres round trip, not an
 * IMAP one, so it does not need to be serialised against the sync cycle.
 */
async function lookupAttachmentMeta(
  db: Db,
  accountId: string,
  folder: string,
  uid: number,
  partId: string,
): Promise<AttachmentMetaRow | null> {
  const rows = await db.query(
    'select filename, mime_type from attachments where account_id = $1 and folder = $2 and uid = $3 and part_id = $4',
    [accountId, folder, uid, partId],
  );
  return (rows[0] as AttachmentMetaRow | undefined) ?? null;
}

async function handleAttachment(
  db: Db,
  pool: ConnectionPool,
  accountId: string,
  folder: string,
  uidRaw: string,
  partId: string,
): Promise<Response> {
  const uid = parsePositiveInt(uidRaw);
  if (uid === null) return json({ error: 'invalid uid' }, 400);
  if (!partId) return json({ error: 'invalid part id' }, 400);

  const resolved = resolveConnection(pool, accountId);
  if (resolved instanceof Response) return resolved;

  const meta = await lookupAttachmentMeta(db, accountId, folder, uid, partId);

  try {
    const bytes = await fetchBudgetedPart(pool, resolved, accountId, folder, uid, partId);
    if (bytes instanceof Response) return bytes;
    const headers: Record<string, string> = {
      'content-type': meta?.mime_type ?? 'application/octet-stream',
      ...PRIVATE_NO_STORE,
    };
    if (meta?.filename) {
      headers['content-disposition'] = contentDispositionFor(meta.filename);
    }
    return new Response(bytes, { status: 200, headers });
  } catch (error) {
    console.error(
      `api: failed to fetch attachment for account "${accountId}" uid ${uid} part "${partId}"`,
      error,
    );
    return json({ error: 'failed to fetch attachment' }, 502);
  }
}

/**
 * Builds the request handler for the unified-inbox JSON API. Every route
 * except GET /api/health and POST /api/session requires a credential
 * (Amendment 1: three arguments — auth cannot be optional on a service
 * fronting four mailboxes containing 60,000+ messages on the public
 * internet).
 *
 * Task 3.5 makes that credential a choice of two, never a replacement:
 * `Authorization: Bearer <API_TOKEN>` exactly as before, or the HMAC-signed
 * session cookie in ./session.ts, which is how a browser authenticates
 * without a token embedded in a shipped JS bundle. POST /api/session mints
 * one, DELETE /api/session clears it, and GET /api/session is the
 * zero-cost "am I signed in?" probe that falls out of the gate itself.
 *
 * Route order below is load-bearing: the two pre-auth routes, then the
 * gate, then the authenticated write, then every GET. This is now the body
 * of `handleApiRoute`, reachable only for `/api/*` — Task 8's dispatcher
 * (at the bottom of this function) sends everything else to ./static.ts
 * instead, which requires no credential at all.
 *
 * /api/health is gated on GET the same as every other route is gated on
 * its own method —
 * a non-GET request to it falls through to the ordinary auth-then-404
 * path below rather than being special-cased forever. Auth is checked
 * before any other route is matched, so an unauthenticated caller gets the
 * same 401 for a real route and a typo'd one — never a 404 that would
 * confirm a route exists before proving the caller is allowed to ask.
 *
 * `trackingConfig` and `fetchImpl` back the /api/opens proxy (Task 2).
 * `trackingConfig` is null when TRACKING_BASE_URL/TRACKING_READ_TOKEN were
 * not configured at startup — config.ts has already logged that loudly.
 * `fetchImpl` is not a production knob: production always uses the real
 * global `fetch` (the default). It exists so tests can inject a stub and
 * exercise this route without a live network call, mirroring the
 * FetchOpensDeps.fetchImpl pattern in opens.ts itself.
 *
 * `accounts` backs GET /api/identities (Plan 4 Task 2) — see
 * ./identities.ts. Appended as the LAST parameter with a `[]` default,
 * same as `vapidConfig` and `staticRoot` were before it: every existing
 * caller of this function (tests included) keeps compiling unchanged, and
 * a router built with no accounts degrades to an empty identities list
 * rather than throwing.
 *
 * `transports` backs POST /api/send (Plan 4 Task 3) — see ./send.ts —
 * and is appended after `accounts` for the same reason. `null` is a
 * supported state: the route answers 503 rather than throwing, which is
 * how every test in this repo that does not care about sending keeps
 * building a router with no SMTP at all. `fetchImpl`, already present
 * above for the /api/opens proxy, is reused for that route's token mint:
 * both talk to the SAME tracking deployment, so a test that stubs one
 * origin has no reason to stub it twice.
 */
export function createRouter(
  db: Db,
  pool: ConnectionPool,
  apiToken: string,
  trackingConfig: TrackingConfig | null = null,
  fetchImpl?: typeof fetch,
  vapidConfig: VapidConfig | null = null,
  // Task 8: where the built client lives. Defaults to sync/public resolved
  // from ./static.ts's own module location (never the process cwd — see
  // that module's doc comment). Tests pass a fixture directory instead.
  staticRoot: string = defaultStaticRoot(),
  accounts: readonly AccountConfig[] = [],
  transports: Transports | null = null,
): (request: Request) => Promise<Response> {
  // One counter per router, created here rather than taken as a parameter:
  // production builds exactly one router, and giving each call its own
  // instance keeps tests from sharing a window and becoming order-dependent.
  const sessionLimiter = createFixedWindowLimiter();

  // A SECOND, independent counter for POST /api/send — same mechanism,
  // its own window and its own budget (./send.ts documents both numbers).
  // Deliberately not the instance above: a burst of sends must never
  // spend the budget that lets the owner sign in.
  const sendLimiter = createFixedWindowLimiter(
    SEND_RATE_LIMIT_MAX_ATTEMPTS,
    SEND_RATE_LIMIT_WINDOW_MS,
  );

  // Built once per router, same reasoning as sessionLimiter above: the
  // one-time "does STATIC_ROOT even exist" warning (./static.ts) must fire
  // once at startup, not on every request.
  const serveStaticRequest = createStaticHandler(staticRoot);

  // The parsed-message cache, built once per router for the same reason
  // the two limiters above are: production builds exactly one router, and
  // giving each call its own instance keeps tests from sharing warm state
  // and becoming order-dependent. Not a constructor parameter, because
  // nothing outside this file has any reason to hold one — the two routes
  // that touch it are both below. Everything about it (the byte ceiling
  // and its arithmetic, the LRU, both invalidation triggers) lives in
  // ./message-cache.ts; this line is the whole of its presence here.
  const messageCache = new MessageCache();

  /**
   * Everything that was, before Task 8, this function's entire body —
   * unchanged in content, only moved. `path` is guaranteed by the
   * dispatcher below to be `/api` or to start with `/api/`; nothing here
   * needed to change to keep that guarantee true.
   */
  async function handleApiRoute(request: Request, url: URL, path: string): Promise<Response> {
    if (path === '/api/health' && request.method === 'GET') {
      return handleHealth(pool);
    }

    // The only /api route served before the auth gate other than health:
    // it IS the gate's entrance for a browser, and it authenticates from
    // its own body. Everything else below requires a credential already.
    if (path === '/api/session' && request.method === 'POST') {
      return handleCreateSession(request, apiToken, sessionLimiter, Date.now());
    }

    if (!isAuthorized(request, apiToken)) {
      return json({ error: 'unauthorized' }, 401);
    }

    // Ahead of the GET-only check below because signing out is the one
    // authenticated write this service accepts.
    if (path === '/api/session' && request.method === 'DELETE') {
      return handleDeleteSession();
    }

    // Task 6's two writes, for the same reason and in the same place: a
    // browser subscribing to push and unsubscribing from it. Both must be
    // matched before the GET-only check below, or they fall through to the
    // 404 it returns.
    if (path === '/api/push/subscribe' && request.method === 'POST') {
      return handlePushSubscribe(db, request, vapidConfig);
    }

    if (path === '/api/push/subscribe' && request.method === 'DELETE') {
      return handlePushUnsubscribe(db, request);
    }

    // Plan 4 Task 3's write, matched before the GET-only check below for
    // the same reason the two push writes are: it would otherwise fall
    // through to that 404.
    if (path === '/api/send' && request.method === 'POST') {
      return handleSend(request, {
        accounts,
        transports,
        trackingConfig,
        limiter: sendLimiter,
        nowMs: Date.now(),
        fetchImpl,
      });
    }

    // The first route in this service that WRITES to a real mailbox, and
    // the reason it is matched here rather than below: like the push and
    // send writes above, it would otherwise fall through to the GET-only
    // 404. Matched on PATCH alone, so any other method on this path takes
    // that same 404 rather than a special-cased 405 — the convention every
    // non-GET route in this file already follows.
    //
    // Everything it does lives in ./flags.ts, including the refusal of any
    // flag name other than the two supported ones. Deliberately AFTER the
    // auth gate and before the GET-only check; deliberately not reachable
    // by GET at all.
    const flagsMatch = path.match(/^\/api\/message\/([^/]+)\/([^/]+)\/([^/]+)\/flags$/);
    if (flagsMatch && request.method === 'PATCH') {
      const decoded = decodeSegments([flagsMatch[1] ?? '', flagsMatch[2] ?? '']);
      if (decoded instanceof Response) return decoded;
      const [accountId, folder] = decoded;
      return handleSetFlag(
        db, pool, request, accountId!, folder!, flagsMatch[3] ?? '', messageCache,
      );
    }

    if (request.method !== 'GET') {
      return json({ error: 'not found' }, 404);
    }

    // Reaching here already proves a usable credential, so the handler is
    // the empty success itself: this is how the client asks "am I still
    // signed in?" without fetching a page of real mail to find out.
    if (path === '/api/session') {
      return noContent(NO_STORE);
    }

    if (path === '/api/inbox') {
      return handleInbox(db, pool, accounts, url);
    }

    // Plan 7 Task 1's free-text search. A sibling of /api/inbox, not a
    // variant of it: same auth gate, same cursor shape, same folder and
    // account filters, one extra `q`. Everything it does lives in
    // ./search.ts — see that module for why the two share code rather
    // than resembling each other.
    if (path === '/api/search') {
      return handleSearch(db, pool, accounts, url);
    }

    if (path === '/api/opens') {
      return handleOpens(url, trackingConfig, fetchImpl);
    }

    // Plan 10 — spec 7A's "Sent & Waiting" / "Opened, no reply". A third
    // sibling of /api/inbox and /api/search: same auth gate, same cursor
    // shape, same `account` filter. It is the only route that reads BOTH
    // this service's Postgres and the tracking service in one request,
    // which is why it takes `trackingConfig` and `fetchImpl` the way
    // handleOpens above does. Everything it does lives in ./followup.ts.
    if (path === '/api/followup') {
      return handleFollowup(db, pool, accounts, trackingConfig, url, { fetchImpl });
    }

    if (path === '/api/push/key') {
      return handlePushKey(vapidConfig);
    }

    if (path === '/api/identities') {
      return handleIdentities(accounts);
    }

    const threadMatch = path.match(/^\/api\/thread\/([^/]+)$/);
    if (threadMatch) {
      const decoded = decodeSegments([threadMatch[1] ?? '']);
      if (decoded instanceof Response) return decoded;
      return handleThread(db, decoded[0]!);
    }

    const bodyMatch = path.match(/^\/api\/message\/([^/]+)\/([^/]+)\/([^/]+)\/body$/);
    if (bodyMatch) {
      const decoded = decodeSegments([bodyMatch[1] ?? '', bodyMatch[2] ?? '']);
      if (decoded instanceof Response) return decoded;
      const [accountId, folder] = decoded;
      const uidRaw = bodyMatch[3] ?? '';
      return handleBody(pool, accountId!, folder!, uidRaw);
    }

    // Plan 6 Task 1's parsed message. Matched AFTER the `/body` pattern
    // above, which is what keeps raw RFC822 access exactly where it was:
    // the two patterns are disjoint (`/body` suffix or not), so the order
    // is belt-and-braces rather than load-bearing. Thin by construction —
    // everything this route does lives in ./message.ts.
    const parsedMessageMatch = path.match(/^\/api\/message\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (parsedMessageMatch) {
      const decoded = decodeSegments([parsedMessageMatch[1] ?? '', parsedMessageMatch[2] ?? '']);
      if (decoded instanceof Response) return decoded;
      const [accountId, folder] = decoded;
      // pixelBase is TRACKING_BASE_URL: the render path strips our own
      // tracking pixel out of the Sent copy (spec 5.6, ./strip-pixel.ts).
      const uidRaw = parsedMessageMatch[3] ?? '';
      return handleMessage(
        db, pool, accountId!, folder!, uidRaw, trackingConfig?.baseUrl ?? null, messageCache,
      );
    }

    const attachmentMatch = path.match(/^\/api\/attachment\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (attachmentMatch) {
      const decoded = decodeSegments([
        attachmentMatch[1] ?? '',
        attachmentMatch[2] ?? '',
        attachmentMatch[4] ?? '',
      ]);
      if (decoded instanceof Response) return decoded;
      const [accountId, folder, partId] = decoded;
      const uidRaw = attachmentMatch[3] ?? '';
      return handleAttachment(db, pool, accountId!, folder!, uidRaw, partId!);
    }

    return json({ error: 'not found' }, 404);
  }

  /**
   * The dispatcher, and the whole of what Task 8 adds at this level.
   * `/api` and every `/api/*` path go to handleApiRoute above — byte for
   * byte the same routing, same auth gate, same final 404 as before this
   * task. Anything else is a static asset or a client-side route and goes
   * to ./static.ts, which requires no credential.
   *
   * The order here is load-bearing (pre-flight FINDING 2): if this
   * `isApiPath` check were removed, or the two branches swapped, an
   * unauthenticated `GET /api/inbox` would reach the static handler first
   * and come back 200-with-index.html (nothing about "/api/inbox" looks
   * like a non-HTML asset, so it would hit the SPA fallback) instead of
   * 401. tests/static-routing.test.ts's "does not shadow /api/*" cases
   * fail immediately under that mutation — see task-8-report.md for the
   * exact reasoning.
   */
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    const isApiPath = path === '/api' || path.startsWith('/api/');

    if (isApiPath) {
      return handleApiRoute(request, url, path);
    }

    return serveStaticRequest(request.method, path);
  };
}
