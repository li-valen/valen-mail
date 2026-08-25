import { ApiError } from './api';

/**
 * The browser's half of the hybrid credential (Task 3.5).
 *
 * The sync service accepts either `Authorization: Bearer <API_TOKEN>` or an
 * HttpOnly session cookie. This client uses only the cookie, and never
 * holds the token: the token is typed into the login view once, posted to
 * POST /api/session, and dropped. Nothing here writes it to
 * `localStorage`, to a module-level variable, or to a log — the cookie the
 * server sets in return is HttpOnly, so this code cannot read it back
 * either, which is the point.
 *
 * Same origin only. These paths are relative, so they resolve against
 * whatever origin served the bundle; this module must never learn a second
 * base URL.
 */

const SESSION_PATH = '/api/session';

/** `same-origin` (not `include`) because there is exactly one origin. It
 *  is what makes the browser attach the session cookie without this code
 *  ever touching it. */
const CREDENTIALS: RequestCredentials = 'same-origin';

/**
 * Turns a non-2xx into an ApiError carrying the status, so a caller can
 * tell 401 (sign in again) from 500 (the service is broken).
 *
 * The message deliberately names only the path and the status. The one
 * request that carries a credential is `createSession`, and the value it
 * submitted must never reach an error string that could end up in a
 * console, a bug report, or an error-reporting service.
 */
function assertOk(response: Response, path: string): void {
  if (!response.ok) {
    throw new ApiError(response.status, `${path} returned ${response.status}`);
  }
}

/**
 * Exchanges the API token for a session cookie.
 *
 * Throws ApiError(401) when the token is wrong, which is what the login
 * view renders its error state from. The token is passed straight through
 * to `fetch` and is not retained afterwards.
 */
export async function createSession(token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const response = await fetchImpl(SESSION_PATH, {
    method: 'POST',
    credentials: CREDENTIALS,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  assertOk(response, SESSION_PATH);
}

/**
 * Signs out by asking the server to clear the cookie. Throws on failure
 * rather than resolving quietly: a sign-out that silently did nothing
 * leaves the user believing they are signed out when they are not, which
 * is worse than an error they can see.
 */
export async function endSession(fetchImpl: typeof fetch = fetch): Promise<void> {
  const response = await fetchImpl(SESSION_PATH, { method: 'DELETE', credentials: CREDENTIALS });
  assertOk(response, SESSION_PATH);
}

/**
 * Resolves when the current cookie is accepted, throws ApiError(401) when
 * it is not. GET /api/session answers 204 straight out of the auth gate,
 * so this costs the server nothing — no database round trip, no mailbox
 * read — which is why the app asks this rather than fetching a page of
 * real mail just to discover it is signed out.
 */
export async function getSessionStatus(fetchImpl: typeof fetch = fetch): Promise<void> {
  const response = await fetchImpl(SESSION_PATH, { credentials: CREDENTIALS });
  assertOk(response, SESSION_PATH);
}

/** True only for the one failure that a sign-in can fix. A network error,
 *  a 500 or a 503 must NOT open a login prompt — asking for a password
 *  because the server is down teaches the user to type it into anything. */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/**
 * Runs an authenticated request, and if it 401s, signs in and retries it
 * once.
 *
 * `onUnauthorized` is expected to resolve only once a session exists — in
 * the app it resolves when the login view's submit succeeds, so the
 * original request is genuinely retried rather than replaced by a reload.
 *
 * Exactly one retry, deliberately: a second 401 means the credential is
 * being rejected for a reason a fresh sign-in did not fix, and the honest
 * response to that is to surface the error, not to loop.
 */
export async function withSession<T>(
  run: () => Promise<T>,
  onUnauthorized: () => Promise<void>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isUnauthorized(error)) throw error;
    await onUnauthorized();
    return run();
  }
}
