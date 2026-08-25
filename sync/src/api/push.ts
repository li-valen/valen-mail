import type { Db } from '../db';
import { json, noContent, PRIVATE_NO_STORE } from './http.ts';
import { isValidSubscription, MAX_ENDPOINT_LENGTH, MAX_LABEL_LENGTH } from '../push/vapid.ts';
import type { VapidConfig } from '../push/vapid';

/**
 * The three Web Push routes, kept out of ./routes.ts on purpose: that file
 * is already 700+ lines and Task 8 has to extract a static-file module out
 * of it rather than grow it further. routes.ts keeps a thin branch per
 * route; the behaviour lives here.
 *
 * All three sit behind the router's auth gate, so every handler below has
 * already been proven to hold a credential. None of them ever returns or
 * logs a subscription endpoint: an endpoint is a capability URL, and
 * whoever holds one can push to that device.
 */

/**
 * GET /api/push/key — the VAPID public key the browser needs to call
 * `pushManager.subscribe()`.
 *
 * Always 200, even unconfigured, for the same reason /api/opens always
 * answers 200 when the tracking service is down: a non-2xx here would make
 * the client treat a perfectly working app as a failed load. `available`
 * carries the signal instead, and the client renders the toggle as off
 * rather than as broken.
 *
 * The PUBLIC key is public by construction — the browser sends it to the
 * push service on every subscribe. The private key exists in exactly one
 * place, `process.env`, and is never read by this module.
 */
export function handlePushKey(vapid: VapidConfig | null): Response {
  if (!vapid) {
    return json({ available: false, publicKey: null }, 200, PRIVATE_NO_STORE);
  }
  return json({ available: true, publicKey: vapid.publicKey }, 200, PRIVATE_NO_STORE);
}

/**
 * Parses a JSON request body, or returns a ready 400 instead of throwing.
 *
 * The parse error is discarded rather than attached, matching
 * handleCreateSession's reasoning in ./routes.ts: V8 embeds surrounding
 * source in "Unexpected token" messages, and on these routes the
 * surrounding source is a subscription endpoint.
 */
async function readJsonBody(request: Request, label: string): Promise<unknown | Response> {
  try {
    return await request.json();
  } catch {
    console.error(`api: rejected ${label} — request body was not valid JSON`);
    return json({ error: 'invalid request body' }, 400, PRIVATE_NO_STORE);
  }
}

/**
 * An optional, operator-facing device name ("iPhone", "laptop").
 *
 * Anything that is not a usable short string becomes null rather than
 * failing the whole request: the label is a convenience for telling two
 * rows apart, and refusing a subscription over it would break push for a
 * client that sent the field slightly wrong. Trimmed and bounded because
 * it is still external input.
 */
function parseLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_LABEL_LENGTH);
}

/**
 * POST /api/push/subscribe — stores (or refreshes) one browser's
 * subscription.
 *
 * Upsert, not insert: a browser re-subscribing after the push service
 * rotates its key material keeps the same endpoint but issues new
 * `p256dh`/`auth` values, and an insert would collide on the primary key
 * and leave the stale keys in place — silently undeliverable.
 *
 * Refuses with 503 when no VAPID keypair is configured. Storing a
 * subscription that can never be pushed to would make the client render
 * "on" for a feature that is off, which is exactly the kind of confident
 * wrong answer this product exists to refuse.
 */
export async function handlePushSubscribe(
  db: Db,
  request: Request,
  vapid: VapidConfig | null,
): Promise<Response> {
  if (!vapid) {
    console.error(
      'api: refusing POST /api/push/subscribe — no VAPID keypair configured (see ' +
        'VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY in .env.example)',
    );
    return json({ error: 'push notifications are not configured' }, 503, PRIVATE_NO_STORE);
  }

  const body = await readJsonBody(request, 'POST /api/push/subscribe');
  if (body instanceof Response) return body;

  // Read before the narrow below: `isValidSubscription` narrows `body` to
  // the four fields the send path needs, and `label` is deliberately not
  // one of them.
  const label = parseLabel(
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>).label
      : undefined,
  );

  if (!isValidSubscription(body)) {
    // Names the fields, never the values: the value here is the endpoint.
    console.error(
      'api: rejected POST /api/push/subscribe — body was not a subscription with an https ' +
        'endpoint and both p256dh and auth keys',
    );
    return json({ error: 'invalid subscription' }, 400, PRIVATE_NO_STORE);
  }

  await db.query(
    `insert into push_subscriptions (endpoint, p256dh, auth, label)
     values ($1, $2, $3, $4)
     on conflict (endpoint) do update
       set p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label`,
    [body.endpoint, body.keys.p256dh, body.keys.auth, label],
  );

  return noContent(PRIVATE_NO_STORE);
}

/**
 * DELETE /api/push/subscribe — forgets one browser's subscription.
 *
 * Works whether or not push is configured, which is the deliberate mirror
 * of subscribe's 503. If the keypair were removed while a device still
 * held a subscription, "turn it off" must still clear the stored row —
 * refusing here would leave a row nothing could ever delete.
 *
 * Deleting a row that does not exist is a success, not a 404. The client's
 * intent is "this device should not be subscribed", and that is already
 * true; a 404 would only make a working sign-out render as an error.
 */
export async function handlePushUnsubscribe(db: Db, request: Request): Promise<Response> {
  const body = await readJsonBody(request, 'DELETE /api/push/subscribe');
  if (body instanceof Response) return body;

  const endpoint =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>).endpoint
      : undefined;

  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > MAX_ENDPOINT_LENGTH) {
    console.error(
      'api: rejected DELETE /api/push/subscribe — body carried no usable string "endpoint"',
    );
    return json({ error: 'invalid endpoint' }, 400, PRIVATE_NO_STORE);
  }

  await db.query('delete from push_subscriptions where endpoint = $1', [endpoint]);
  return noContent(PRIVATE_NO_STORE);
}
