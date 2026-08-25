/**
 * The three response shapes every route in this service builds, and the
 * two freshness header sets they are built with.
 *
 * Extracted from ./routes.ts when ./push.ts became the second module that
 * needed them (Task 6). Copying `json()` into each route module is how two
 * routes end up sending subtly different headers for the same reason, and
 * the reason here is a cache-correctness one, not a formatting one.
 */

export function json(
  body: unknown,
  status = 200,
  extraHeaders: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

export function noContent(headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(null, { status: 204, headers });
}

/** Session responses must never be cached: one carries a `Set-Cookie` that
 *  establishes a credential, another one that revokes it, and a shared or
 *  browser cache replaying either is a correctness bug. */
export const NO_STORE: Readonly<Record<string, string>> = { 'cache-control': 'no-store' };

/**
 * Freshness directives for every route that returns mailbox data.
 *
 * This became necessary the moment the session cookie shipped, and it is
 * easy to miss why. When the only credential was an `Authorization`
 * header, no cache anywhere treats the response as shareable — the header
 * is not a cache key and its presence suppresses storage by default. An
 * ambient cookie now authorises the same responses, and they were going
 * out with no freshness directives at all.
 *
 * Exposure today is close to nil: Caddy's bare `reverse_proxy` does not
 * cache, and these responses carry no validators. But Task 6 adds a
 * service worker and Task 8 puts a static file server on this same origin,
 * and a naive `caches.put('/api/inbox', response)` would write four
 * mailboxes to the device's disk where nothing ever evicts them. Two
 * words now; awkward to retrofit after either lands.
 *
 * (Task 6 shipped that service worker with no fetch handler and no Cache
 * Storage use at all — client/public/sw.js, guarded by
 * client/tests/push-toggle.test.ts. These headers are the second line of
 * that defence, not the only one.)
 *
 * `private` bars a shared cache from storing it at all; `no-store` bars
 * every cache, private ones included. Both are stated because they fail
 * differently on the intermediaries that only understand one of them.
 */
export const PRIVATE_NO_STORE: Readonly<Record<string, string>> = {
  'cache-control': 'private, no-store',
};
