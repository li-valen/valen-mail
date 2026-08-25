import webpush from 'web-push';
import { shouldPruneOnStatus } from './vapid.ts';
import type { PushSubscription, VapidConfig } from './vapid';

/**
 * The one place this service talks to a push service.
 *
 * `web-push` is the single new dependency this project takes, and it earns
 * it: Web Push requires ECDSA P-256 JWT signing (RFC 8292) and AES128GCM
 * payload encryption with an ECDH-derived key (RFC 8291). Hand-rolling
 * that is the textbook don't-roll-your-own-crypto case, and unlike the
 * constant-time compare in tracking/ — written by hand because the Edge
 * platform forbade a library — nothing here prevents using one.
 *
 * Still no third-party service: the endpoint comes from the browser, the
 * keypair was generated locally, and there is no account anywhere. $0.
 */

/**
 * What a notification carries over the wire. Kept to what the service
 * worker (client/public/sw.js) actually reads — a bigger payload is not
 * free: RFC 8291 caps the encrypted record, and every push service
 * enforces roughly a 4 KB ceiling on it.
 *
 * `title` and `body` are attacker-authored: they come from an email
 * subject and a sender name. They reach the OS notification as TEXT via
 * `showNotification`, and the service worker never builds markup from
 * them. `url` is resolved against the app's own origin in the worker
 * before it is ever navigated to.
 */
export interface PushPayload {
  readonly title: string;
  readonly body?: string;
  readonly url?: string;
  readonly tag?: string;
}

/**
 * The outcome of one send.
 *
 * `prune` is a recommendation to the caller, not an action taken here:
 * deleting a row belongs with whatever owns the dispatch loop (Task 7),
 * and keeping the crypto path free of database access is what lets this
 * be tested without one.
 */
export interface PushResult {
  readonly ok: boolean;
  readonly prune: boolean;
}

/** Seconds a push service may hold an undelivered notification. Four
 *  hours: a mail notification that surfaces a day later is noise, not
 *  news, and the message is still in the inbox either way. */
const TTL_SECONDS = 4 * 60 * 60;

/** The push service is a third party on its own network path; a hung
 *  connection must not hang whatever loop is dispatching. Same reasoning
 *  and same value as ../api/opens.ts's REQUEST_TIMEOUT_MS. */
const REQUEST_TIMEOUT_MS = 5000;

/** `web-push`'s own send, isolated behind a type so a test can inject a
 *  stub — the same shape as opens.ts's `fetchImpl`. Production always
 *  uses the default; this is not a runtime knob. */
export type SendImpl = (
  subscription: PushSubscription,
  payload: string,
  options: Readonly<Record<string, unknown>>,
) => Promise<{ readonly statusCode: number }>;

const defaultSendImpl: SendImpl = (subscription, payload, options) =>
  webpush.sendNotification(subscription, payload, options as never);

/**
 * Reads a numeric `statusCode` off a rejected value without assuming it is
 * a `WebPushError` — a DNS failure or an abort rejects with a plain Error
 * that has no status at all, and that must not be read as "prune".
 */
function statusCodeOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' ? status : null;
}

/**
 * Sends one notification.
 *
 * Never throws: a dispatch loop iterating over every stored subscription
 * must not have one dead device abort the rest. Every failure is reported
 * as `{ ok: false }` plus the prune recommendation, and logged with a
 * status but never with the endpoint — the endpoint is a capability URL,
 * so anyone who reads it out of a log can push to that device.
 *
 * Neither `subscription` nor `payload` is mutated; the payload is
 * serialised into a new string and the subscription is passed through
 * read-only.
 */
export async function sendPush(
  subscription: PushSubscription,
  payload: PushPayload,
  vapid: VapidConfig,
  sendImpl: SendImpl = defaultSendImpl,
): Promise<PushResult> {
  try {
    await sendImpl(subscription, JSON.stringify(payload), {
      vapidDetails: {
        subject: vapid.subject,
        publicKey: vapid.publicKey,
        privateKey: vapid.privateKey,
      },
      TTL: TTL_SECONDS,
      timeout: REQUEST_TIMEOUT_MS,
    });
    return { ok: true, prune: false };
  } catch (error) {
    const status = statusCodeOf(error);
    const prune = status !== null && shouldPruneOnStatus(status);

    // The status and the decision, and nothing else. The error object
    // itself is deliberately NOT attached: `WebPushError` carries the
    // `endpoint` as a property, and console.error prints it.
    console.error(
      `push: send failed with status ${status ?? 'none'} — ` +
        `${prune ? 'subscription is gone, recommending prune' : 'transient, keeping subscription'}`,
    );
    return { ok: false, prune };
  }
}
