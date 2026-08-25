/**
 * What this browser can actually do with Web Push, worked out as pure
 * functions of what the environment reports.
 *
 * Split out of PushToggle.tsx so it can be tested: client/CLAUDE.md's
 * standing constraint is that no test in Plan 3 renders a component, and
 * the branch that matters most here — iOS outside a Home Screen install —
 * is impossible to reach from a test runner otherwise.
 */

/**
 * The four states the toggle can be in before anyone touches it.
 *
 * `ios-install` is the one that shapes the UI. Safari only permits
 * `PushManager.subscribe()` from a web app installed to the Home Screen;
 * calling it from a Safari tab fails with an error a person cannot act on.
 * So that case renders instructions instead of a control.
 */
export type PushCapability = 'available' | 'ios-install' | 'unsupported' | 'blocked';

export interface PushEnvironment {
  readonly hasServiceWorker: boolean;
  readonly hasPushManager: boolean;
  readonly hasNotification: boolean;
  readonly isIos: boolean;
  readonly isStandalone: boolean;
  readonly permission: NotificationPermission;
}

/** The subset of `navigator` that iOS detection reads. Passed in rather
 *  than read from the global so a test can describe a device. */
export interface DeviceHints {
  readonly userAgent: string;
  readonly maxTouchPoints?: number;
}

/**
 * True only for a real iOS/iPadOS device.
 *
 * Two halves, both needed. iPhone and iPod still name themselves in the
 * user agent. **iPadOS 13 and later do not** — an iPad reports a
 * Macintosh user agent that is character-for-character what a desktop Mac
 * sends, and the only thing that separates them is the touch point count
 * (an iPad reports 5; macOS reports 0, because no Mac has a touchscreen).
 *
 * Both directions are load-bearing. Missing the iPad half sends every iPad
 * down the "just subscribe" path, where Safari refuses with an opaque
 * error. Getting the Mac half wrong shows a desktop browser "Share → Add
 * to Home Screen" instructions for a menu it does not have.
 */
export function isIosDevice(hints: DeviceHints): boolean {
  if (/\b(iPhone|iPad|iPod)\b/.test(hints.userAgent)) return true;
  const isMacLike = /\bMacintosh\b/.test(hints.userAgent);
  return isMacLike && (hints.maxTouchPoints ?? 0) > 1;
}

/** The two independent signals that the app is running installed rather
 *  than in a browser tab. */
export interface StandaloneHints {
  /** `matchMedia('(display-mode: standalone)').matches` — the standard. */
  readonly matchesStandaloneMedia: boolean;
  /** `navigator.standalone` — non-standard, Safari only, `undefined`
   *  everywhere else. Compared against `true` explicitly so `undefined`
   *  can never read as truthy-by-absence. */
  readonly navigatorStandalone?: boolean;
}

export function isStandaloneDisplay(hints: StandaloneHints): boolean {
  if (hints.matchesStandaloneMedia) return true;
  return hints.navigatorStandalone === true;
}

/**
 * The order of these checks is the whole point.
 *
 * iOS is tested FIRST, before the API check, because iOS only exposes
 * `Notification` and `PushManager` inside an installed web app. An
 * API-first order therefore reports "this browser cannot do
 * notifications" to the exact person who is one Share-sheet tap away from
 * being able to — the most useful thing to say, said backwards.
 *
 * `env` is only read; nothing here mutates it.
 */
export function detectPushCapability(env: PushEnvironment): PushCapability {
  if (env.isIos && !env.isStandalone) return 'ios-install';
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return 'unsupported';
  if (env.permission === 'denied') return 'blocked';
  return 'available';
}

/**
 * Reads the live environment. The one impure function in this module, and
 * the reason every other one takes its inputs as arguments.
 */
export function readPushEnvironment(): PushEnvironment {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: 'PushManager' in window,
    hasNotification: 'Notification' in window,
    isIos: isIosDevice({ userAgent: nav.userAgent, maxTouchPoints: nav.maxTouchPoints }),
    isStandalone: isStandaloneDisplay({
      matchesStandaloneMedia: window.matchMedia('(display-mode: standalone)').matches,
      navigatorStandalone: nav.standalone,
    }),
    permission: 'Notification' in window ? Notification.permission : 'default',
  };
}

/**
 * Converts the server's base64url VAPID public key into the raw bytes
 * `pushManager.subscribe()` wants for `applicationServerKey`.
 *
 * Not decoration: base64url swaps `+/` for `-_` and drops the padding, so
 * handing the string to `atob` unchanged silently decodes to different
 * bytes for roughly a third of all keys — producing a subscription the
 * push service rejects at send time, long after anyone would connect the
 * two. Throws on genuinely undecodable input rather than returning
 * garbage.
 */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
