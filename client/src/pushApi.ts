import { ApiError } from './api';

/**
 * The three Web Push calls against the sync service
 * (sync/src/api/push.ts).
 *
 * A sibling of ./session.ts rather than an addition to ./api.ts, and for
 * the same reason that file exists: these are the only requests in the
 * client that are not GETs of mailbox data, and ./api.ts's helpers are
 * built around `getJson`. Same rules apply — relative paths only, so they
 * resolve against whatever origin served the bundle, and
 * `credentials: 'same-origin'` so the HttpOnly session cookie rides along
 * without this code ever touching it.
 *
 * Nothing here logs a subscription endpoint or puts one in an error
 * message. An endpoint is a capability URL: whoever reads one out of a
 * console or a bug report can push to that device.
 */

const KEY_PATH = '/api/push/key';
const SUBSCRIBE_PATH = '/api/push/subscribe';

const CREDENTIALS: RequestCredentials = 'same-origin';

/** Names the path and the status, never the body. */
function assertOk(response: Response, path: string): void {
  if (!response.ok) {
    throw new ApiError(response.status, `${path} returned ${response.status}`);
  }
}

/**
 * Fetches the VAPID public key.
 *
 * Returns null when the server reports push unconfigured — that is a
 * state, not a failure, and GET /api/push/key answers 200 with
 * `{ available: false }` for it, exactly as /api/opens does for a tracking
 * outage. A malformed body also returns null rather than a key the
 * browser would fail to subscribe with far away from here.
 *
 * Still throws ApiError on a non-2xx, so a 401 stays distinguishable from
 * "the feature is off" — the first means the session expired and the
 * second does not.
 */
export async function getPushKey(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const response = await fetchImpl(KEY_PATH, { credentials: CREDENTIALS });
  assertOk(response, KEY_PATH);

  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null) return null;

  const record = body as Record<string, unknown>;
  if (record.available !== true) return null;
  return typeof record.publicKey === 'string' && record.publicKey.length > 0
    ? record.publicKey
    : null;
}

/**
 * Stores this browser's subscription server-side.
 *
 * `subscription` is whatever `PushSubscription.toJSON()` produced. It is
 * passed straight through rather than reshaped: the server validates it
 * at its own boundary (sync/src/push/vapid.ts `isValidSubscription`), and
 * a client-side reshape would be a second place for the wire format to
 * drift.
 *
 * Throws on failure rather than resolving quietly — a subscribe that
 * silently did nothing leaves the toggle reading "on" for a device that
 * will never be notified.
 */
export async function savePushSubscription(
  subscription: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(SUBSCRIBE_PATH, {
    method: 'POST',
    credentials: CREDENTIALS,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(subscription),
  });
  assertOk(response, SUBSCRIBE_PATH);
}

/** Forgets this browser's subscription server-side. Throws on failure for
 *  the same reason `savePushSubscription` does. */
export async function deletePushSubscription(
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(SUBSCRIBE_PATH, {
    method: 'DELETE',
    credentials: CREDENTIALS,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  });
  assertOk(response, SUBSCRIBE_PATH);
}
