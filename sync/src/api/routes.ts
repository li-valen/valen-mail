import { timingSafeEqual } from 'node:crypto';
import type { Db, InboxCursor } from '../db';
import type { ConnectionPool } from '../imap/pool';
import type { ImapConnection } from '../imap/connection';
import type { TrackingConfig } from '../config';
import { fetchBodyPart, BodyPartTooLargeError, MAX_BODY_PART_BYTES } from '../imap/fetch.ts';
import { fetchOpens } from './opens.ts';
import { MAX_LIMIT, DEFAULT_LIMIT } from './limits.ts';
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
 * Clamps `limit` to [1, MAX_LIMIT] and falls back to DEFAULT_LIMIT for
 * anything that isn't a usable positive number — a missing param, a
 * non-numeric string, NaN, or a negative value — so a malformed or hostile
 * query string is handled rather than thrown on (Resolution 2).
 */
function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  const requested = Number(raw);
  if (!Number.isFinite(requested)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(requested)), MAX_LIMIT);
}

/** Ignores an unparsable `before` value rather than throwing — an
 *  unfiltered inbox read is a safe fallback for a malformed date. */
function parseBeforeDate(raw: string | null): Date | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Validates and converts a UID route parameter. Amendment 2: a UID coming
 * out of the database is a string (Postgres bigint), but a UID coming in
 * from a URL path is also a string that has never been validated as a
 * number at all — this is the one deliberate conversion point for that
 * value on the way into fetchBodyPart/db.query, rather than trusting it to
 * already look like the number it claims to be.
 */
function parsePositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Builds the unified inbox's keyset cursor from the query string.
 *
 * Two accepted shapes, deliberately:
 *  - `before` + `beforeAccount` + `beforeUid` — the full compound cursor.
 *    Lossless: it addresses an exact position in the total order, so rows
 *    that share a second-resolution Gmail timestamp with the previous
 *    page's last row are still returned.
 *  - `before` alone — backward tolerance for a client written against the
 *    old bare-timestamp API. It still filters correctly; it just remains
 *    tie-lossy, which is what that client already had.
 *
 * `beforeAccount`/`beforeUid` with no `before` is the NULL-date tail: those
 * rows sort last and have no timestamp to key on, so the cursor carries a
 * null date and the row comparison substitutes '-infinity'.
 */
function parseInboxCursor(url: URL): InboxCursor | null {
  const date = parseBeforeDate(url.searchParams.get('before'));
  const accountId = url.searchParams.get('beforeAccount');
  const uidRaw = url.searchParams.get('beforeUid');
  const uid = uidRaw === null ? null : parsePositiveInt(uidRaw);

  if (accountId && uid !== null) return { date, accountId, uid };
  if (date !== null) return { date, accountId: null, uid: null };
  return null;
}

interface NextCursor {
  readonly before: string | null;
  readonly beforeAccount: string;
  readonly beforeUid: string;
}

/**
 * The cursor a client should send to get the next page, or null when this
 * page is the last one. Emitting it (rather than expecting the client to
 * reconstruct it from the final row) is what makes lossless pagination the
 * default rather than something a client has to know to opt into.
 *
 * A short page means there is nothing after it. A full page might also be
 * the last one, in which case the client makes one extra request that
 * returns zero messages — the standard keyset trade, and strictly better
 * than the alternative of over-fetching by one row on every page.
 */
function nextCursorFrom(rows: readonly Record<string, unknown>[], limit: number): NextCursor | null {
  if (rows.length < limit) return null;
  const last = rows[rows.length - 1];
  if (!last || last.account_id === undefined || last.uid === undefined) return null;
  const date = last.date;
  return {
    before: date instanceof Date ? date.toISOString() : null,
    beforeAccount: String(last.account_id),
    beforeUid: String(last.uid),
  };
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

async function handleInbox(db: Db, url: URL): Promise<Response> {
  const limit = parseLimit(url.searchParams.get('limit'));
  const cursor = parseInboxCursor(url);
  const messages = await db.getUnifiedInbox({ limit, cursor });
  return json({ messages, nextCursor: nextCursorFrom(messages, limit) }, 200, PRIVATE_NO_STORE);
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

/**
 * Looks up a live connection for `accountId` and confirms the pool
 * considers it connected before any IMAP call is attempted, returning a
 * ready-to-send Response instead when it can't proceed. Shared by the body
 * and attachment handlers so both fail the same way for the same reasons.
 */
function resolveConnection(pool: ConnectionPool, accountId: string): ImapConnection | Response {
  const connection = pool.getConnection(accountId);
  if (!connection) return json({ error: 'unknown account' }, 404);

  const status = pool.status.get(accountId);
  if (status !== 'connected') {
    return json({ error: `account not connected (status: ${status ?? 'unknown'})` }, 503);
  }

  return connection;
}

/**
 * The one path by which the API pulls bytes off an IMAP connection. Three
 * things happen here that must happen together, which is why they are one
 * function rather than duplicated across the body and attachment handlers:
 *
 *  1. **The account's sync lock is held for the whole fetch.** The API and
 *     the IDLE loop drive the same imapflow client; without this, a
 *     download breaks IDLE, idleLoop's NOOP liveness probe queues behind
 *     the download, and a download longer than the probe's 15s timeout gets
 *     its own connection torn down as "dead". See
 *     ConnectionPool.withAccountLock.
 *  2. **The bytes are charged against the daily budget (spec L6).** These
 *     travel the same connection Gmail meters at ~2.5 GB/day. The sync loop
 *     charges a 2 KB estimate per header fetch; an API that could pull tens
 *     of megabytes unrecorded would make that accounting fiction. The
 *     reservation is the worst case (MAX_BODY_PART_BYTES) because the size
 *     is not known before the fetch; what gets recorded afterwards is the
 *     measured truth.
 *  3. **An oversized part is refused, not served.** fetchBodyPart aborts
 *     above the cap; this maps that to 413 rather than the 502 a generic
 *     IMAP failure gets, so a client can tell "too big" from "broken".
 *
 * Returns the bytes, or a ready-to-send Response for the two refusals.
 * A genuine IMAP error propagates to the caller's own 502 handling.
 */
async function fetchBudgetedPart(
  pool: ConnectionPool,
  connection: ImapConnection,
  accountId: string,
  folder: string,
  uid: number,
  partId?: string,
): Promise<Buffer | Response> {
  return pool.withAccountLock(accountId, async () => {
    const decision = await pool.byteBudget.reserve(accountId, MAX_BODY_PART_BYTES);
    if (!decision.allowed) {
      console.error(
        `api: daily byte budget exhausted for account "${accountId}", refusing on-demand ` +
          `fetch of uid ${uid} (requested ${MAX_BODY_PART_BYTES}, remaining ${decision.remaining})`,
      );
      return json({ error: 'daily download budget exhausted for this account' }, 429);
    }

    try {
      const bytes = await fetchBodyPart(connection, folder, uid, partId);
      await pool.byteBudget.record(accountId, bytes.length);
      return bytes;
    } catch (error) {
      if (error instanceof BodyPartTooLargeError) {
        // Those bytes really did cross the wire before the fetch aborted,
        // so charge them. The cap is a conservative floor for how many.
        await pool.byteBudget.record(accountId, error.limitBytes);
        console.error(
          `api: refusing oversized part for account "${accountId}" uid ${uid} ` +
            `part "${partId ?? '<whole message>'}": above ${error.limitBytes} bytes`,
        );
        return json(
          { error: `message part exceeds the ${error.limitBytes}-byte maximum` },
          413,
        );
      }
      throw error;
    }
  });
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
): (request: Request) => Promise<Response> {
  // One counter per router, created here rather than taken as a parameter:
  // production builds exactly one router, and giving each call its own
  // instance keeps tests from sharing a window and becoming order-dependent.
  const sessionLimiter = createFixedWindowLimiter();

  // Built once per router, same reasoning as sessionLimiter above: the
  // one-time "does STATIC_ROOT even exist" warning (./static.ts) must fire
  // once at startup, not on every request.
  const serveStaticRequest = createStaticHandler(staticRoot);

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
      return handleInbox(db, url);
    }

    if (path === '/api/opens') {
      return handleOpens(url, trackingConfig, fetchImpl);
    }

    if (path === '/api/push/key') {
      return handlePushKey(vapidConfig);
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
