import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The browser's credential for this service.
 *
 * Why this exists at all: `createRouter` requires
 * `Authorization: Bearer <API_TOKEN>` on every /api route, Caddy injects no
 * header, and the browser client correctly refuses to embed a token in a
 * shipped JS bundle — so before this module every same-origin browser
 * request to the deployed service returned 401. Bearer auth is unchanged;
 * this is a SECOND accepted credential, not a replacement.
 *
 * Why not basic auth: an installed iOS PWA re-prompts for it in ways the
 * user cannot dismiss cleanly, and this is a phone-first daily-use app.
 * Why not a token in localStorage: readable by any XSS, and HttpOnly costs
 * the same.
 *
 * **The cookie deliberately does not contain API_TOKEN.** A cookie leaks
 * more easily than an Authorization header — into a proxy log, a browser
 * profile backup, a shared screenshot of devtools — and a leaked master
 * token here is four (soon up to ten) real mailboxes. What it carries
 * instead is a stateless, HMAC-signed, time-limited assertion:
 *
 *     v1.<expiresAtEpochMs>.<base64url HMAC-SHA256 over "v1.<expiresAt>">
 *
 * The HMAC key is derived from API_TOKEN rather than being API_TOKEN, so
 * the value in the cookie is a one-way function of the master credential
 * twice over. Verification recomputes the HMAC with `timingSafeEqual` and
 * then checks the clock. Because the expiry is inside the signed payload,
 * a client cannot extend its own session by editing the cookie.
 *
 * No session store, no database table, no revocation list: rotating
 * API_TOKEN invalidates every outstanding session at once, which for a
 * single-user personal service is the whole revocation story that is
 * needed. `node:crypto` is used directly and is correct here — unlike the
 * Edge-hosted tracking service, this is plain Node.
 */

/** The only version this module mints or accepts. A future format change
 *  bumps this, and every cookie carrying the old prefix stops verifying —
 *  which is the intended migration path: users log in once more. */
const SESSION_VERSION = 'v1';

/**
 * 30 days.
 *
 * The trade is stated plainly because both ends of it are real. A short
 * lifetime (hours, or a day) means re-typing a 64-hex-character token on a
 * phone keyboard several times a week, which in practice pushes that token
 * into a notes app or a screenshot — a strictly worse place than an
 * HttpOnly cookie. A never-expiring cookie means a device that is lost,
 * sold, or handed to someone stays authorized forever.
 *
 * 30 days lands where a personal, single-user, install-to-home-screen app
 * belongs: log in about once a month, and every outstanding session dies
 * the moment API_TOKEN is rotated. Server-set HttpOnly cookies are not
 * subject to Safari's 7-day script-writable-storage cap, so this survives
 * on an installed iOS PWA.
 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE_NAME = 'postbox_session';

/**
 * `SameSite=Strict` is deliberate: nothing legitimately navigates to this
 * app from another site, and a notification click (Task 6) is
 * same-origin-initiated, so the cookie still rides along. `Secure` is
 * correct even in local development — browsers exempt `localhost` from the
 * HTTPS requirement. `Path=/` because Task 8 serves the client itself from
 * this origin.
 */
const COOKIE_ATTRIBUTES = 'Path=/; HttpOnly; Secure; SameSite=Strict';

/** Domain separation: the HMAC key is a function of API_TOKEN, never
 *  API_TOKEN itself, so this key can never be confused with — or used to
 *  recover — the bearer credential. */
const SESSION_KEY_INFO = 'postbox/session-cookie/v1';

/** base64url alphabet, unpadded. `Buffer.from(x, 'base64url')` silently
 *  discards characters outside it, so a shape check happens before the
 *  decode rather than trusting the decode to reject anything. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function deriveSessionKey(apiToken: string): Buffer {
  return createHmac('sha256', apiToken).update(SESSION_KEY_INFO).digest();
}

/** Signs the version and the expiry together. The expiry being inside the
 *  signed payload is what stops a client editing its own cookie to grant
 *  itself a longer session. */
function signPayload(apiToken: string, version: string, expiresAt: string): Buffer {
  return createHmac('sha256', deriveSessionKey(apiToken)).update(`${version}.${expiresAt}`).digest();
}

/** Mints a session value that expires SESSION_TTL_MS after `nowMs`. */
export function mintSessionValue(apiToken: string, nowMs: number): string {
  const expiresAt = String(nowMs + SESSION_TTL_MS);
  const signature = signPayload(apiToken, SESSION_VERSION, expiresAt).toString('base64url');
  return `${SESSION_VERSION}.${expiresAt}.${signature}`;
}

/**
 * True only for a value this service minted, that has not been altered,
 * and that has not yet expired. Never throws on a malformed value — a
 * hostile cookie is ordinary input, not an exceptional condition.
 *
 * The signature is checked before the clock so that reaching the expiry
 * comparison at all already proves authenticity; an "expired" value that
 * never verified would otherwise be indistinguishable from a genuinely
 * lapsed one, in the code and in its tests.
 */
export function verifySessionValue(value: string, apiToken: string, nowMs: number): boolean {
  const parts = value.split('.');
  if (parts.length !== 3) return false;

  const [version, expiresAtRaw, signature] = parts as [string, string, string];
  if (version !== SESSION_VERSION) return false;
  if (!/^\d+$/.test(expiresAtRaw)) return false;
  if (!BASE64URL.test(signature)) return false;

  const provided = Buffer.from(signature, 'base64url');
  const expected = signPayload(apiToken, version, expiresAtRaw);
  // timingSafeEqual throws on a length mismatch, so the length check must
  // come first; it leaks nothing the caller does not already know.
  if (provided.length !== expected.length) return false;
  if (!timingSafeEqual(provided, expected)) return false;

  return nowMs < Number(expiresAtRaw);
}

/**
 * Pulls this service's cookie out of a `Cookie:` header, or null.
 *
 * Deliberately minimal rather than a general RFC 6265 parser: the only
 * cookie this service reads is its own, whose value is base64url and
 * therefore contains no `;`, no `=` (base64url is unpadded) and no
 * quoting. The first matching name wins.
 */
export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;

  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    const value = pair.slice(separator + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/** True when `request` carries a session cookie this service will accept. */
export function requestHasValidSession(request: Request, apiToken: string, nowMs: number): boolean {
  const value = readSessionCookie(request);
  return value !== null && verifySessionValue(value, apiToken, nowMs);
}

const SESSION_MAX_AGE_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

/** The `Set-Cookie` value that establishes a session. `Max-Age` mirrors
 *  the signed expiry, so the browser and the server agree on when the
 *  credential dies rather than the browser holding a cookie the server has
 *  already stopped honouring. */
export function buildSessionCookie(value: string): string {
  return `${SESSION_COOKIE_NAME}=${value}; Max-Age=${SESSION_MAX_AGE_SECONDS}; ${COOKIE_ATTRIBUTES}`;
}

/** The `Set-Cookie` value that removes it. The attributes must match the
 *  ones it was set with or the browser keeps the original alongside this
 *  one and the sign-out silently does nothing. */
export function buildClearedSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Max-Age=0; ${COOKIE_ATTRIBUTES}`;
}
