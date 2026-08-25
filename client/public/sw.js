/**
 * Postbox service worker.
 *
 * It handles exactly two events — `push` and `notificationclick` — and it
 * is registered only when a person turns notifications on (see
 * src/components/PushToggle.tsx). Nothing else lives here.
 *
 * THERE IS DELIBERATELY NO `fetch` HANDLER AND NO USE OF THE CACHE STORAGE
 * API. This is not a stylistic preference and it must not be "improved"
 * into offline support. Postbox authorises /api/* with an ambient
 * HttpOnly cookie rather than an Authorization header, which means a
 * worker on this origin can read every mailbox response as plain,
 * already-authorised JSON. Storing one would write four real Gmail
 * accounts to the device's disk, where nothing ever evicts them; the
 * server sends `Cache-Control: private, no-store` on those routes for the
 * same reason. If offline support is ever genuinely wanted, it needs its
 * own design decision about what may be persisted, not a default
 * stale-while-revalidate handler added here in passing.
 *
 * Kept small for a second reason: a worker that throws is very hard to
 * evict from an installed PWA. Every path below either shows a
 * notification or falls back to one, and none of them can reject before it
 * does.
 *
 * Plain JavaScript, no build step: this file is served verbatim from the
 * site root, which is what gives it a scope of "/".
 */

/** Bump when this file changes so the new copy takes over deliberately. */
const SW_VERSION = 'postbox-sw-v1';

/** OS notifications truncate anyway; bounding here keeps a pathological
 *  subject from turning into an unreadable wall on Android. */
const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 300;

self.addEventListener('install', () => {
  // Take over immediately rather than waiting for every tab to close. The
  // alternative leaves a known-bad worker in control of an installed app
  // with no obvious way for its owner to replace it.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * Coerces a payload field to displayable text.
 *
 * Email subjects and sender names are written by whoever sent the mail, so
 * every value reaching a notification is attacker-authored. It reaches the
 * OS as TEXT: `showNotification` takes strings, not markup, and nothing in
 * this file ever builds HTML, sets innerHTML, or interpolates into a
 * template that would be parsed as one.
 */
function asText(value, fallback, maxLength) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.slice(0, maxLength);
}

/**
 * Reads the push body as JSON, or null. A push with no data, or with data
 * that is not JSON, still produces a notification — see showFromPush.
 */
function readPayload(data) {
  if (!data) return null;
  try {
    const parsed = data.json();
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch (error) {
    return null;
  }
}

/**
 * Resolves a payload's `url` to a same-origin path, or falls back to "/".
 *
 * The value arrives over the network. An installed PWA navigating to an
 * arbitrary absolute URL because a payload said so would turn a
 * notification into an open redirect with the app's own chrome around it,
 * so anything that does not resolve to this origin is discarded rather
 * than followed.
 */
function sameOriginPath(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return '/';
  try {
    const url = new URL(raw, self.location.origin);
    if (url.origin !== self.location.origin) return '/';
    return url.pathname + url.search;
  } catch (error) {
    return '/';
  }
}

/**
 * Always shows something.
 *
 * The browser granted this permission on the promise that every push
 * produces a user-visible notification, and Chrome will eventually revoke
 * the subscription of a worker that stays silent. So a malformed payload
 * degrades to a generic notification rather than to nothing at all.
 */
function showFromPush(data) {
  const payload = readPayload(data);
  const title = asText(payload && payload.title, 'Postbox', MAX_TITLE_LENGTH);
  const body = asText(payload && payload.body, '', MAX_BODY_LENGTH);

  return self.registration.showNotification(title, {
    body: body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    // A stable tag collapses repeats of the same thing instead of stacking
    // them; an absent one lets separate events stand separately.
    tag: asText(payload && payload.tag, undefined, MAX_TITLE_LENGTH),
    data: { url: sameOriginPath(payload && payload.url), version: SW_VERSION },
  });
}

self.addEventListener('push', (event) => {
  event.waitUntil(showFromPush(event.data));
});

/**
 * Focuses an already-open Postbox window, navigating it to the target, or
 * opens one if none exists. `includeUncontrolled` matters: a tab loaded
 * before this worker activated is not controlled by it but is still the
 * window the person means.
 */
async function openApp(target) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

  for (const client of windows) {
    if (typeof client.focus !== 'function') continue;
    if (typeof client.navigate === 'function') {
      try {
        await client.navigate(target);
      } catch (error) {
        // Navigation can be refused (a cross-origin history entry, a
        // window mid-unload). Focusing the existing window is still the
        // right outcome, so this is handled rather than propagated.
      }
    }
    return client.focus();
  }

  return self.clients.openWindow(target);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data;
  event.waitUntil(openApp(sameOriginPath(data && data.url)));
});
