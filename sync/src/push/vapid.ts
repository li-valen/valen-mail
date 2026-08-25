/**
 * Web Push configuration and boundary validation (RFC 8292 VAPID,
 * RFC 8291 payload encryption).
 *
 * Deliberately dependency-free: nothing here imports `web-push`, so the
 * predicates below can be exercised — and the config parsed — without the
 * library being loaded at all. The one module that does load it is
 * ./send.ts.
 *
 * No third-party service is involved. Apple and Google operate the push
 * endpoints the browser hands us, but there is no account, no key issued
 * by either of them, and no bill: the keypair is generated locally, once,
 * and lives only in sync/.env.
 */

/**
 * A browser's push subscription, in the shape `PushSubscription.toJSON()`
 * produces and this service stores one row per (schema.sql
 * `push_subscriptions`).
 *
 * `endpoint` is a capability URL: whoever holds it can push to that
 * device. It is treated as a credential everywhere in this codebase — it
 * is never logged, never echoed in an error, and never returned by any
 * route.
 */
export interface PushSubscription {
  readonly endpoint: string;
  readonly keys: {
    readonly p256dh: string;
    readonly auth: string;
  };
}

/** The VAPID keypair plus the `sub` claim every signed JWT carries. */
export interface VapidConfig {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly subject: string;
}

/**
 * Postgres's btree index has a hard ~2704-byte row limit and `endpoint` is
 * this table's primary key, so an oversized endpoint is not merely
 * untidy — it fails the insert at runtime. Real FCM/APNs/Mozilla endpoints
 * are comfortably under 300 characters.
 */
export const MAX_ENDPOINT_LENGTH = 2048;

/** p256dh is a base64url P-256 point (~88 chars) and auth is 16 bytes
 *  (~22 chars). 256 is generous headroom, not a guess at the real size. */
export const MAX_KEY_LENGTH = 256;

/** Bound on the optional device label, which exists only so an operator
 *  can tell two rows apart. */
export const MAX_LABEL_LENGTH = 64;

/**
 * RFC 8292 §2.1: the JWT's `sub` claim identifies someone the push service
 * can contact, and must be a `mailto:` or `https:` URI. An https: URL is
 * used here rather than a mailto: so no personal address is embedded in
 * every JWT sent to Apple and Google.
 */
const DEFAULT_VAPID_SUBJECT = 'https://postbox-valen.duckdns.org';

/**
 * The two statuses that mean the browser permanently discarded this
 * subscription: the push service will never accept it again, so retrying
 * is pointless and the row should go.
 *
 * Everything else — 429, 500, 502, 503, a network error — is transient.
 * Pruning on one of those would silently unsubscribe a real phone, with
 * nothing anywhere in the product to notice it happened; the user would
 * simply stop getting notifications and have no way to tell why. That
 * asymmetry is why this is a two-element allowlist rather than a
 * `status >= 400` test.
 */
const GONE_STATUSES: ReadonlySet<number> = new Set([404, 410]);

export function shouldPruneOnStatus(status: number): boolean {
  return GONE_STATUSES.has(status);
}

/** True for a value that is a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string that is present, non-empty, and within `max`. */
function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/**
 * The push endpoint must be an absolute https: URL.
 *
 * `https:` is not decoration. The endpoint is a capability URL and the
 * payload it carries is the user's mail; sending either over plaintext
 * would hand both to anyone on the path. Every real push service issues
 * https: endpoints, so this rejects nothing legitimate.
 */
function isHttpsEndpoint(value: unknown): value is string {
  if (!isBoundedString(value, MAX_ENDPOINT_LENGTH)) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    // `new URL` throws on a relative or malformed string — that is a
    // rejection, not an exception to propagate out of a predicate.
    return false;
  }
}

/**
 * Narrow, hand-written boundary check on a subscription posted by the
 * browser — the same discipline ../api/opens.ts applies to the tracking
 * service's response, and for the same reason: this is a system boundary,
 * and no schema library is a dependency of this project.
 *
 * Every field checked here is one the send path structurally depends on.
 * `endpoint` is where the push goes and this table's primary key;
 * `keys.p256dh`/`keys.auth` are what RFC 8291 encrypts the payload with,
 * so a subscription missing either can never receive anything. There is no
 * fourth field to be lenient about.
 *
 * Never throws, for any input. It is called with `await request.json()`'s
 * result, which is `unknown` and attacker-shaped.
 */
export function isValidSubscription(value: unknown): value is PushSubscription {
  if (!isRecord(value)) return false;
  if (!isHttpsEndpoint(value.endpoint)) return false;

  const keys = value.keys;
  if (!isRecord(keys)) return false;
  return isBoundedString(keys.p256dh, MAX_KEY_LENGTH) && isBoundedString(keys.auth, MAX_KEY_LENGTH);
}

/** True for a `sub` claim RFC 8292 accepts. */
function isUsableSubject(value: string): boolean {
  if (value.startsWith('mailto:')) return value.length > 'mailto:'.length;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Reads VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT.
 *
 * Deliberately degrading rather than fail-closed, matching
 * ../config.ts's parseTrackingConfig and deliberately unlike the rule that
 * governs API_TOKEN. Email sync is this service's primary job and must not
 * be held hostage to a secondary feature: a missing API_TOKEN would
 * publish four real mailboxes, whereas a missing VAPID key only removes
 * push notifications. So this returns null and says so loudly, once, at
 * startup — the push routes then report unavailable and the client renders
 * the toggle as off rather than pretending it worked.
 *
 * `env` is only read; nothing here writes to it. No warning ever contains
 * a key value — an error message is the easiest place to leak a credential
 * into a log aggregator, and under systemd these land in the persistent
 * journal.
 */
export function parseVapidConfig(env: NodeJS.ProcessEnv): VapidConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;

  if (!publicKey || !privateKey) {
    console.warn(
      'config: VAPID_PUBLIC_KEY and/or VAPID_PRIVATE_KEY not set — push notifications are ' +
        'disabled and /api/push/key will report { available: false } until both are configured. ' +
        'Generate a pair with `npx web-push generate-vapid-keys`.',
    );
    return null;
  }

  const subject = env.VAPID_SUBJECT ?? DEFAULT_VAPID_SUBJECT;
  if (!isUsableSubject(subject)) {
    console.warn(
      'config: VAPID_SUBJECT must be a mailto: or https: URI (RFC 8292 §2.1) — push ' +
        'notifications are disabled. A malformed subject produces a JWT every push service ' +
        'rejects, which is worse than not being configured at all.',
    );
    return null;
  }

  return { publicKey, privateKey, subject };
}
