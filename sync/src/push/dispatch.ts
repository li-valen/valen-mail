import type { Db, MessageInput } from '../db';
import type { OpenEvent } from '../api/opens';
import { sendPush } from './send.ts';
import type { PushPayload, SendImpl } from './send';
import { isValidSubscription } from './vapid.ts';
import type { PushSubscription, VapidConfig } from './vapid';

/**
 * Turns synced mail and confirmed opens into the two kinds of push
 * notification this service sends. Everything here is pure with respect
 * to the network except `notifyNewMail`/`notifyOpens`, which are the only
 * two functions that touch `Db` (to read stored subscriptions and prune
 * dead ones) or call `sendPush`.
 *
 * This module never imports anything from imap/: `../imap/pool.ts` calls
 * `notifyNewMail` through an injected callback it holds no reference to
 * beyond that, and this module has no idea a `ConnectionPool` exists.
 */

/**
 * Same-origin paths client/public/sw.js's `sameOriginPath` resolves and
 * navigates to on notificationclick. This app still has no client-side
 * router — App.tsx seeds its view once, on mount, rather than routing on
 * navigation — but these are genuinely different destinations:
 * client/src/initialView.ts's `initialViewFromSearch` reads the `rail`
 * query param out of `location.search` in App.tsx's lazy `useState`
 * initializer, so `?rail=opens` opens straight onto the Opens view and
 * `/` opens onto the Inbox. sw.js only strips the URL fragment, never the
 * search string, so this query parameter survives the round trip a
 * `#hash` would not.
 */
const INBOX_URL = '/';
const OPENS_URL = '/?rail=opens';

/**
 * True only for a genuinely confirmed open. An `mpp` event is Apple's mail
 * privacy proxy prefetching the tracking pixel, not a person reading the
 * message — a phone buzzing for that would train the user to distrust
 * every notification this feature ever sends. Every other non-`open`
 * classification (`prefetch`, `scanner`, `self`, and anything not yet
 * invented) is equally not a confirmed human read, so the default branch
 * is `false` rather than an allowlist that a future classifier could slip
 * past by omission.
 */
export function shouldNotifyOpen(event: OpenEvent): boolean {
  return event.classification === 'open';
}

/**
 * True for a `deviceClass` worth showing to a person.
 *
 * Amendment 2: the tracking service's real wire value is the string
 * `'unknown'` (10 of 10 recorded events so far), never `null` in practice
 * — but both mean the same thing, "no attribution available", and a naive
 * `if (deviceClass)` truthiness check treats the non-empty string
 * `'unknown'` as present and prints it as if it were a fact. All three of
 * null, empty string, and the literal 'unknown' are treated as absent
 * here; only an actual device name (`'iPhone'`, `'macOS'`, ...) counts as
 * present.
 */
function hasDeviceContext(deviceClass: string | null): deviceClass is string {
  return deviceClass !== null && deviceClass.length > 0 && deviceClass !== 'unknown';
}

/**
 * Builds the "someone opened your mail" notification.
 *
 * `recipientEmail` is the only identifier `OpenEvent` actually carries for
 * who opened it — there is no separate display-name field on the wire —
 * so the email address is used as-is rather than fabricating a name that
 * was never in the data.
 */
export function buildOpenNotification(event: OpenEvent): PushPayload {
  const subject = event.subject && event.subject.length > 0 ? event.subject : '(no subject)';
  const device = hasDeviceContext(event.deviceClass) ? ` — opened on ${event.deviceClass}` : '';

  return {
    title: `${event.recipientEmail} opened your mail`,
    body: `${subject}${device}`,
    url: OPENS_URL,
    // Per event occurrence, not just per token: a second real open of the
    // same message is a second real thing that happened and should not
    // silently replace the first notification in the OS tray.
    tag: `open:${event.token}:${event.occurredAt}`,
  };
}

/**
 * Builds the "new mail arrived" notification. `message` is exactly what
 * `fetchHeaders`/`normalizeMessage` produce (imap/fetch.ts) — the same
 * shape the pool already persists via `Db.upsertMessage`, so there is no
 * second parsing of a raw IMAP envelope anywhere in this file.
 */
export function buildMailNotification(message: MessageInput): PushPayload {
  const from = message.fromName || message.fromEmail || 'New mail';
  const subject = message.subject && message.subject.length > 0 ? message.subject : '(no subject)';

  return {
    title: `${from} — ${subject}`,
    url: INBOX_URL,
    // Unique per message (never collapses two different new-mail
    // notifications into one), stable across a re-poll of the same UID
    // (never stacks a duplicate for a message already shown).
    tag: `mail:${message.accountId}:${message.folder}:${message.uid}`,
  };
}

/**
 * A message newer than this is not "new mail" worth buzzing for, even if
 * the pool's own UID-based novelty check (imap/pool.ts's
 * trackNewMessages, Amendment 3) decided it was never seen before. A late
 * UID for an old message — a flag change surfacing a row again, or a
 * message copied into the synced folder with an old original Date header
 * — must not read to the user as mail that "just arrived". One hour is
 * generous slack for real delivery delay while still refusing to notify
 * for anything that is, on its face, old.
 */
export const NEW_MAIL_SANITY_WINDOW_MS = 60 * 60 * 1000;

function isRecentEnough(date: Date | null, now: number): boolean {
  // No `date` at all means no basis for "this just arrived" — err toward
  // not notifying rather than guessing.
  if (!date) return false;
  return now - date.getTime() <= NEW_MAIL_SANITY_WINDOW_MS;
}

/** One row of `push_subscriptions`, exactly as Postgres returns it —
 *  `unknown`-typed because `Db.query` returns `any[]`, and this is a
 *  system boundary the same way a tracking-service response is
 *  (../api/opens.ts's `isValidOpenEvent`). */
interface SubscriptionRow {
  readonly endpoint: unknown;
  readonly p256dh: unknown;
  readonly auth: unknown;
}

/**
 * Reads every stored subscription and validates each one with the exact
 * predicate POST /api/push/subscribe uses to accept it in the first
 * place — a row already in this table was valid when it was written, but
 * "never trust external data" applies to reads from our own database too,
 * not just the tracking service's HTTP responses. A malformed row is
 * dropped rather than passed to `sendPush`, which expects a complete
 * `PushSubscription` and has no reason to re-validate one.
 */
async function loadSubscriptions(db: Db): Promise<readonly PushSubscription[]> {
  const rows = (await db.query(
    'select endpoint, p256dh, auth from push_subscriptions',
  )) as readonly SubscriptionRow[];

  const subscriptions: PushSubscription[] = [];
  for (const row of rows) {
    const candidate = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
    if (isValidSubscription(candidate)) subscriptions.push(candidate);
  }
  return subscriptions;
}

/**
 * Deletes one dead subscription. Failure here is logged and swallowed
 * rather than propagated: a prune that couldn't be written this cycle
 * will simply be retried the next time `sendPush` sees the same 404/410
 * for the same row, and letting a delete failure abort the rest of a
 * dispatch loop over other, live subscriptions would be strictly worse.
 */
async function pruneSubscription(db: Db, endpoint: string): Promise<void> {
  try {
    await db.query('delete from push_subscriptions where endpoint = $1', [endpoint]);
  } catch (error) {
    console.error('push: failed to prune a dead subscription', error);
  }
}

/**
 * Sends one payload to every stored subscription, pruning any the push
 * service says are gone. `sendPush` itself never throws (send.ts), so
 * this never needs its own try/catch per subscription — one dead device
 * already can't abort the loop over the rest.
 */
async function dispatchToAll(
  db: Db,
  vapid: VapidConfig,
  subscriptions: readonly PushSubscription[],
  payload: PushPayload,
  sendImpl?: SendImpl,
): Promise<void> {
  for (const subscription of subscriptions) {
    const result = sendImpl
      ? await sendPush(subscription, payload, vapid, sendImpl)
      : await sendPush(subscription, payload, vapid);
    if (result.prune) await pruneSubscription(db, subscription.endpoint);
  }
}

/**
 * Dispatches "new mail" pushes for whichever of `messages` are still
 * within the sanity window. `messages` is expected to already be the
 * genuinely-new subset the pool's `trackNewMessages` decided on — this
 * function does not know or care about UIDs or sync cycles, only about
 * whether a message's own `date` still reads as "just arrived".
 *
 * `sendImpl` is the same injectable seam `sendPush` itself exposes
 * (send.ts's `SendImpl`) — production never passes it, and it exists so a
 * test (and the pool's injected callback wiring in server.ts) can stub
 * the actual network call.
 */
export async function notifyNewMail(
  db: Db,
  vapid: VapidConfig,
  messages: readonly MessageInput[],
  sendImpl?: SendImpl,
): Promise<void> {
  const now = Date.now();
  const notifyWorthy = messages.filter((message) => isRecentEnough(message.date, now));
  if (notifyWorthy.length === 0) return;

  const subscriptions = await loadSubscriptions(db);
  if (subscriptions.length === 0) return;

  for (const message of notifyWorthy) {
    await dispatchToAll(db, vapid, subscriptions, buildMailNotification(message), sendImpl);
  }
}

/**
 * Dispatches "opened" pushes for whichever of `events` are confirmed
 * opens (`shouldNotifyOpen`). Recency filtering against a persisted
 * last-seen watermark is the opens poll's job (push/opens-poll.ts), not
 * this function's — by the time events reach here they are assumed to be
 * ones the poll has not already notified for.
 */
export async function notifyOpens(
  db: Db,
  vapid: VapidConfig,
  events: readonly OpenEvent[],
  sendImpl?: SendImpl,
): Promise<void> {
  const notifyWorthy = events.filter(shouldNotifyOpen);
  if (notifyWorthy.length === 0) return;

  const subscriptions = await loadSubscriptions(db);
  if (subscriptions.length === 0) return;

  for (const event of notifyWorthy) {
    await dispatchToAll(db, vapid, subscriptions, buildOpenNotification(event), sendImpl);
  }
}
