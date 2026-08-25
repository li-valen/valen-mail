import { describe, it, expect, vi } from 'vitest';
import swSource from '../public/sw.js?raw';
import pushToggleSource from '../src/components/PushToggle.tsx?raw';
import {
  detectPushCapability,
  isIosDevice,
  isStandaloneDisplay,
  urlBase64ToUint8Array,
} from '../src/pushSupport';
import type { PushEnvironment } from '../src/pushSupport';
import { enablePush, disablePush, readPushState } from '../src/pushSubscribe';
import { getPushKey, savePushSubscription, deletePushSubscription } from '../src/pushApi';
import { ApiError } from '../src/api';

/**
 * Task 6 — the client half of Web Push.
 *
 * client/CLAUDE.md's standing constraint holds: no test in Plan 3 renders
 * a component. So the decisions worth testing are pulled out of
 * PushToggle.tsx into pure modules (pushSupport, pushSubscribe, pushApi)
 * and tested directly, and the two properties that can only be stated
 * about the component and the service worker as FILES are asserted with
 * the `?raw`-import-and-regex technique tests/theme-tokens.test.ts and
 * tests/opens-rail-static-guards.test.ts already use — each with a
 * synthetic-fixture test proving the regex would really catch the bug it
 * exists to catch.
 */

const DESKTOP_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPADOS_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const WINDOWS_EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0';

const CAPABLE: PushEnvironment = {
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  isIos: false,
  isStandalone: false,
  permission: 'default',
};

describe('isIosDevice', () => {
  it('is true for an iPhone', () => {
    expect(isIosDevice({ userAgent: IPHONE_SAFARI, maxTouchPoints: 5 })).toBe(true);
  });

  it('is true for iPadOS 13+, which reports a Macintosh user agent', () => {
    // The only thing separating this string from a real Mac is the touch
    // point count. Without it, every iPad falls into the desktop branch
    // and is told to subscribe, which Safari refuses with an opaque error.
    expect(isIosDevice({ userAgent: IPADOS_SAFARI, maxTouchPoints: 5 })).toBe(true);
  });

  it('is FALSE for a desktop Mac, which also reports Macintosh', () => {
    // Hazard 4's other direction: a desktop browser must never be shown
    // the "Add to Home Screen" instructions. macOS reports 0 touch points.
    expect(isIosDevice({ userAgent: IPADOS_SAFARI, maxTouchPoints: 0 })).toBe(false);
    expect(isIosDevice({ userAgent: DESKTOP_CHROME, maxTouchPoints: 0 })).toBe(false);
  });

  it('is false for Windows, including a touchscreen laptop', () => {
    expect(isIosDevice({ userAgent: WINDOWS_EDGE, maxTouchPoints: 10 })).toBe(false);
  });

  it('tolerates a missing maxTouchPoints', () => {
    expect(isIosDevice({ userAgent: DESKTOP_CHROME })).toBe(false);
    expect(isIosDevice({ userAgent: IPHONE_SAFARI })).toBe(true);
  });
});

describe('isStandaloneDisplay', () => {
  it('trusts the standard display-mode media query', () => {
    expect(isStandaloneDisplay({ matchesStandaloneMedia: true })).toBe(true);
  });

  it("trusts Safari's non-standard navigator.standalone when it is exactly true", () => {
    expect(isStandaloneDisplay({ matchesStandaloneMedia: false, navigatorStandalone: true })).toBe(
      true,
    );
  });

  it('is false when neither signal is present', () => {
    // `navigator.standalone` is `undefined` outside Safari, and `undefined`
    // must read as "not standalone", never as truthy-by-absence.
    expect(isStandaloneDisplay({ matchesStandaloneMedia: false })).toBe(false);
    expect(isStandaloneDisplay({ matchesStandaloneMedia: false, navigatorStandalone: false })).toBe(
      false,
    );
  });
});

describe('detectPushCapability', () => {
  it('is "available" on a capable browser that has not been asked yet', () => {
    expect(detectPushCapability(CAPABLE)).toBe('available');
  });

  it('is "available" on a capable browser that already granted permission', () => {
    expect(detectPushCapability({ ...CAPABLE, permission: 'granted' })).toBe('available');
  });

  it('is "ios-install" on iOS outside a Home Screen install', () => {
    // Checked BEFORE the API check on purpose: iOS only exposes
    // PushManager/Notification inside an installed web app, so an
    // API-first order reports "unsupported" and the user never learns
    // that installing is what unlocks it.
    expect(
      detectPushCapability({
        ...CAPABLE,
        isIos: true,
        isStandalone: false,
        hasPushManager: false,
        hasNotification: false,
      }),
    ).toBe('ios-install');
  });

  it('is not "ios-install" once iOS is installed to the Home Screen', () => {
    expect(detectPushCapability({ ...CAPABLE, isIos: true, isStandalone: true })).toBe('available');
  });

  it('never reports "ios-install" for a desktop browser, whatever navigator.standalone says', () => {
    expect(detectPushCapability({ ...CAPABLE, isIos: false, isStandalone: false })).toBe(
      'available',
    );
    expect(
      detectPushCapability({
        ...CAPABLE,
        isIos: false,
        isStandalone: false,
        hasPushManager: false,
      }),
    ).toBe('unsupported');
  });

  it('is "unsupported" when any of the three APIs is missing', () => {
    expect(detectPushCapability({ ...CAPABLE, hasServiceWorker: false })).toBe('unsupported');
    expect(detectPushCapability({ ...CAPABLE, hasPushManager: false })).toBe('unsupported');
    expect(detectPushCapability({ ...CAPABLE, hasNotification: false })).toBe('unsupported');
  });

  it('is "blocked" when the browser has already been told no', () => {
    expect(detectPushCapability({ ...CAPABLE, permission: 'denied' })).toBe('blocked');
  });

  it('reports an installed-but-ancient iOS as unsupported rather than available', () => {
    expect(
      detectPushCapability({
        ...CAPABLE,
        isIos: true,
        isStandalone: true,
        hasPushManager: false,
      }),
    ).toBe('unsupported');
  });

  it('does not mutate the environment it is given', () => {
    const env = { ...CAPABLE };
    const before = { ...env };
    detectPushCapability(env);
    expect(env).toEqual(before);
  });
});

describe('urlBase64ToUint8Array', () => {
  it('decodes an unpadded base64url VAPID key to raw bytes', () => {
    // "hello" -> base64 "aGVsbG8=" -> base64url unpadded "aGVsbG8"
    expect(Array.from(urlBase64ToUint8Array('aGVsbG8'))).toEqual([104, 101, 108, 108, 111]);
  });

  it('translates the base64url alphabet, which plain atob would get wrong', () => {
    // 0xfb 0xff decodes from "-_8" only if - and _ become + and /.
    expect(Array.from(urlBase64ToUint8Array('-_8'))).toEqual([251, 255]);
  });

  it('produces the 65 bytes a real P-256 application server key is', () => {
    const key = 'B'.repeat(87);
    expect(urlBase64ToUint8Array(key)).toHaveLength(65);
  });

  it('throws on input that is not base64 at all, rather than returning garbage', () => {
    expect(() => urlBase64ToUint8Array('***')).toThrow();
  });
});

interface FakeSubscription {
  endpoint: string;
  unsubscribe: () => Promise<boolean>;
  toJSON: () => unknown;
}

function makeFakeSubscription(endpoint = 'https://push.example/abc'): FakeSubscription {
  return {
    endpoint,
    unsubscribe: async () => true,
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
  };
}

describe('enablePush', () => {
  function makeDeps(overrides: Record<string, unknown> = {}) {
    const order: string[] = [];
    const saved: unknown[] = [];
    const deps = {
      requestPermission: async () => {
        order.push('requestPermission');
        return 'granted' as NotificationPermission;
      },
      getPublicKey: async () => {
        order.push('getPublicKey');
        return 'aGVsbG8';
      },
      registerWorker: async () => {
        order.push('registerWorker');
        return {
          pushManager: {
            subscribe: async () => {
              order.push('subscribe');
              return makeFakeSubscription();
            },
          },
        };
      },
      saveSubscription: async (subscription: unknown) => {
        order.push('saveSubscription');
        saved.push(subscription);
      },
      ...overrides,
    };
    return { deps, order, saved };
  }

  it('asks for permission FIRST, before touching any other API', async () => {
    // Hazard 3: the permission prompt has to happen inside the user
    // gesture. Anything awaited before it breaks the gesture in Safari and
    // Chrome alike, and the failure is silent.
    const { deps, order } = makeDeps();
    const result = await enablePush(deps as never);
    expect(result.ok).toBe(true);
    expect(order[0]).toBe('requestPermission');
    expect(order).toEqual([
      'requestPermission',
      'getPublicKey',
      'registerWorker',
      'subscribe',
      'saveSubscription',
    ]);
  });

  it('stops at a denied permission and registers no service worker', async () => {
    const { deps, order } = makeDeps({
      requestPermission: async () => {
        order.push('requestPermission');
        return 'denied' as NotificationPermission;
      },
    });
    const result = await enablePush(deps as never);
    expect(result).toEqual({
      ok: false,
      reason: 'permission-denied',
      message: expect.any(String),
    });
    expect(order).toEqual(['requestPermission']);
  });

  it('stops at a dismissed prompt ("default") the same way', async () => {
    const { deps, order } = makeDeps({
      requestPermission: async () => {
        order.push('requestPermission');
        return 'default' as NotificationPermission;
      },
    });
    expect((await enablePush(deps as never)).ok).toBe(false);
    expect(order).toEqual(['requestPermission']);
  });

  it('stops when the server has no VAPID key and registers no service worker', async () => {
    const { deps, order } = makeDeps({
      getPublicKey: async () => {
        order.push('getPublicKey');
        return null;
      },
    });
    const result = await enablePush(deps as never);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('not-configured');
    expect(order).toEqual(['requestPermission', 'getPublicKey']);
  });

  it('sends the browser subscription to the server on success', async () => {
    const { deps, saved } = makeDeps();
    await enablePush(deps as never);
    expect(saved).toEqual([{ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } }]);
  });

  it('subscribes with userVisibleOnly, which Chrome requires', async () => {
    let options: unknown;
    const { deps } = makeDeps({
      registerWorker: async () => ({
        pushManager: {
          subscribe: async (given: unknown) => {
            options = given;
            return makeFakeSubscription();
          },
        },
      }),
    });
    await enablePush(deps as never);
    expect((options as { userVisibleOnly: boolean }).userVisibleOnly).toBe(true);
  });

  it('reports a failure instead of throwing when subscribe rejects', async () => {
    const { deps } = makeDeps({
      registerWorker: async () => ({
        pushManager: {
          subscribe: async () => {
            throw new Error('AbortError: registration failed');
          },
        },
      }),
    });
    const result = await enablePush(deps as never);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('failed');
  });

  it('never puts the subscription endpoint into the message it returns', async () => {
    const secretEndpoint = 'https://push.example/SECRET-SUBSCRIPTION-PATH';
    const { deps } = makeDeps({
      saveSubscription: async () => {
        throw new ApiError(500, `POST failed for ${secretEndpoint}`);
      },
      registerWorker: async () => ({
        pushManager: { subscribe: async () => makeFakeSubscription(secretEndpoint) },
      }),
    });
    const result = await enablePush(deps as never);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).not.toContain('SECRET-SUBSCRIPTION-PATH');
  });
});

describe('disablePush', () => {
  it('unsubscribes the browser and clears the server row', async () => {
    const order: string[] = [];
    const subscription = {
      endpoint: 'https://push.example/abc',
      unsubscribe: async () => {
        order.push('unsubscribe');
        return true;
      },
      toJSON: () => ({}),
    };
    const deleted: string[] = [];
    const result = await disablePush({
      getSubscription: async () => subscription,
      deleteSubscription: async (endpoint: string) => {
        order.push('deleteSubscription');
        deleted.push(endpoint);
      },
    } as never);
    expect(result.ok).toBe(true);
    expect(order).toEqual(['unsubscribe', 'deleteSubscription']);
    expect(deleted).toEqual(['https://push.example/abc']);
  });

  it('is a no-op success when the browser holds no subscription', async () => {
    const deleted: string[] = [];
    const result = await disablePush({
      getSubscription: async () => null,
      deleteSubscription: async (endpoint: string) => {
        deleted.push(endpoint);
      },
    } as never);
    expect(result.ok).toBe(true);
    expect(deleted).toEqual([]);
  });

  it('reports a failure instead of throwing when the server delete fails', async () => {
    const result = await disablePush({
      getSubscription: async () => makeFakeSubscription(),
      deleteSubscription: async () => {
        throw new ApiError(500, 'boom');
      },
    } as never);
    expect(result.ok).toBe(false);
  });
});

describe('readPushState', () => {
  it('is true when the browser already holds a subscription', async () => {
    expect(await readPushState({ getSubscription: async () => makeFakeSubscription() } as never)).toBe(
      true,
    );
  });

  it('is false when it does not', async () => {
    expect(await readPushState({ getSubscription: async () => null } as never)).toBe(false);
  });

  it('is false, not a rejection, when the lookup itself fails', async () => {
    expect(
      await readPushState({
        getSubscription: async () => {
          throw new Error('no service worker');
        },
      } as never),
    ).toBe(false);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('pushApi', () => {
  it('getPushKey returns the public key', async () => {
    const fetchImpl = vi.fn(async (_path: string, _init?: RequestInit) =>
      jsonResponse({ available: true, publicKey: 'pub' }),
    );
    expect(await getPushKey(fetchImpl as never)).toBe('pub');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/push/key');
  });

  it('getPushKey returns null when the server reports push unavailable', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ available: false, publicKey: null }));
    expect(await getPushKey(fetchImpl as never)).toBeNull();
  });

  it('getPushKey returns null on a malformed body rather than a broken key', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ available: true, publicKey: 42 }));
    expect(await getPushKey(fetchImpl as never)).toBeNull();
  });

  it('getPushKey throws ApiError on a non-2xx, so a 401 stays distinguishable', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 }));
    await expect(getPushKey(fetchImpl as never)).rejects.toBeInstanceOf(ApiError);
  });

  it('savePushSubscription POSTs same-origin with the subscription as the body', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await savePushSubscription({ endpoint: 'https://push.example/x' }, fetchImpl as never);
    const [path, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/push/subscribe');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(init.body as string)).toEqual({ endpoint: 'https://push.example/x' });
  });

  it('savePushSubscription throws ApiError on a non-2xx rather than reporting success', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }));
    await expect(
      savePushSubscription({ endpoint: 'https://push.example/x' }, fetchImpl as never),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('deletePushSubscription DELETEs the endpoint', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await deletePushSubscription('https://push.example/x', fetchImpl as never);
    const [path, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/push/subscribe');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body as string)).toEqual({ endpoint: 'https://push.example/x' });
  });

  it('never names an endpoint in the error it throws', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
    const error = await savePushSubscription(
      { endpoint: 'https://push.example/SECRET-SUBSCRIPTION-PATH' },
      fetchImpl as never,
    ).catch((caught: unknown) => caught);
    expect(String((error as Error).message)).not.toContain('SECRET-SUBSCRIPTION-PATH');
  });
});

/**
 * Hazard 1. Task 3.5 moved /api/* from an `Authorization` header (which no
 * cache treats as shareable) to an ambient cookie, and the mailbox routes
 * now send `Cache-Control: private, no-store` precisely because a service
 * worker on this origin could otherwise write four real mailboxes to the
 * device's disk. "Add offline support" is the most natural thing in the
 * world to volunteer while writing a service worker; these guards are what
 * stops it being volunteered later.
 */
const FETCH_HANDLER = /addEventListener\(\s*['"`]fetch['"`]/;
const CACHE_STORAGE = /\bcaches\b/;
const PUSH_HANDLER = /addEventListener\(\s*['"`]push['"`]/;
const CLICK_HANDLER = /addEventListener\(\s*['"`]notificationclick['"`]/;
const VERSION_MARKER = /SW_VERSION\s*=\s*['"`][^'"`]+['"`]/;

describe('sw.js — the service worker is push-only', () => {
  it('registers no fetch handler', () => {
    expect(swSource).not.toMatch(FETCH_HANDLER);
  });

  it('never touches the Cache Storage API', () => {
    expect(swSource).not.toMatch(CACHE_STORAGE);
  });

  it('does handle push', () => {
    expect(swSource).toMatch(PUSH_HANDLER);
  });

  it('does handle notificationclick', () => {
    expect(swSource).toMatch(CLICK_HANDLER);
  });

  it('carries a version marker, so a broken worker can be replaced deliberately', () => {
    expect(swSource).toMatch(VERSION_MARKER);
  });

  it('shows a notification on every push, with no branch that can skip it', () => {
    expect(swSource).toMatch(/showNotification\(/);
  });

  it('resolves the click target against its own origin instead of trusting the payload', () => {
    // The notification's `data.url` arrives over the network. Opening it
    // unchecked would let a payload navigate an installed PWA anywhere.
    expect(swSource).toMatch(/self\.location\.origin/);
  });
});

describe('the sw.js guards themselves (not vacuous)', () => {
  it('flags a worker that adds a fetch handler', () => {
    expect("self.addEventListener('fetch', (e) => {});").toMatch(FETCH_HANDLER);
    expect('self.addEventListener("fetch", (e) => {});').toMatch(FETCH_HANDLER);
  });

  it('flags a worker that opens a cache', () => {
    expect("const c = await caches.open('v1');").toMatch(CACHE_STORAGE);
    expect("caches.match(request)").toMatch(CACHE_STORAGE);
  });

  it('does not false-positive on the singular word "cache" in a comment', () => {
    expect('// this worker never writes to a cache').not.toMatch(CACHE_STORAGE);
  });

  it('would fail a worker with no push handler', () => {
    expect("self.addEventListener('install', () => {});").not.toMatch(PUSH_HANDLER);
  });
});

/**
 * Hazard 3, stated about the component as a file: `requestPermission`
 * lives in pushSubscribe.ts and is reachable only from the toggle's click
 * handler. A copy of it inside PushToggle.tsx would be free to drift into
 * a mount effect, where Safari and Chrome both refuse the prompt quietly.
 */
const REQUEST_PERMISSION = /requestPermission/;
const SWITCH_ROLE = /role=["']switch["']/;
const ARIA_CHECKED = /aria-checked=/;
const CONTROLLED_SWITCH = /<Switch\b[\s\S]*?\bchecked=\{/;

describe('PushToggle.tsx — semantics and the permission gesture', () => {
  it('never calls Notification.requestPermission itself', () => {
    expect(pushToggleSource).not.toMatch(REQUEST_PERMISSION);
  });

  it('exposes its state as a switch, not just as a pressed-looking button', () => {
    expect(pushToggleSource).toMatch(SWITCH_ROLE);
    expect(pushToggleSource).toMatch(ARIA_CHECKED);
  });

  it('never builds HTML from a value it did not author', () => {
    expect(pushToggleSource).not.toMatch(/dangerouslySetInnerHTML/);
  });

  it('tells an iOS user how to install rather than failing opaquely', () => {
    expect(pushToggleSource).toMatch(/Add to Home Screen/);
  });

  /**
   * Added in task 7.6, when the hand-rolled toggle was restyled onto the
   * ported Plunk `Switch` atom (a wrapper around Radix's switch primitive).
   *
   * Radix routes `onCheckedChange` through `useControllableState`, which
   * calls it SYNCHRONOUSLY inside the click handler only while the switch
   * is controlled. Left uncontrolled, the identical callback is fired from
   * a `React.useEffect` — one task later, after the user gesture has
   * expired — and `Notification.requestPermission()` downstream is then
   * refused silently by both Safari and Chrome. A future edit that drops
   * the `checked` prop would look harmless and break push everywhere, so
   * the prop is pinned here rather than left to review.
   */
  it('keeps the switch controlled, which is what keeps the permission prompt inside the gesture', () => {
    expect(pushToggleSource).toMatch(CONTROLLED_SWITCH);
  });
});

describe('the PushToggle guards themselves (not vacuous)', () => {
  it('flags a component that requests permission inline', () => {
    expect('useEffect(() => { Notification.requestPermission(); }, []);').toMatch(
      REQUEST_PERMISSION,
    );
  });

  it('flags a toggle with no switch semantics', () => {
    expect('<button type="button" className="push-toggle">On</button>').not.toMatch(SWITCH_ROLE);
  });

  it('flags an uncontrolled Switch, and passes a controlled one', () => {
    expect('<Switch onCheckedChange={onToggle} />').not.toMatch(CONTROLLED_SWITCH);
    expect('<Switch checked={isOn} onCheckedChange={onToggle} />').toMatch(CONTROLLED_SWITCH);
  });
});

// =====================================================================
// Fix round 1
// =====================================================================

/**
 * Fix 5. Neither the rendered message nor the CONSOLE may carry a
 * subscription endpoint.
 *
 * The returned-message half was already covered; this is the console
 * half, which was not. `console.error('...', error)` printed the raw
 * object, and a DOMException from `subscribe()`/`unsubscribe()` can name
 * the endpoint in its message — a capability URL, readable by anyone who
 * sees a screenshot or a pasted bug report.
 */
describe('push logging never carries an endpoint', () => {
  const SECRET = 'https://push.example/SECRET-SUBSCRIPTION-PATH';

  /** What a browser really throws here: the endpoint is in `message`,
   *  never in `name`. */
  function domExceptionLike(): Error {
    const error = new Error(`Registration failed for ${SECRET}`);
    error.name = 'NotAllowedError';
    return error;
  }

  function captureConsole() {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    return { lines, restore: () => spy.mockRestore() };
  }

  it('enablePush logs the error TYPE, not an endpoint-bearing message', async () => {
    const { lines, restore } = captureConsole();
    await enablePush({
      requestPermission: async () => 'granted' as NotificationPermission,
      getPublicKey: async () => 'aGVsbG8',
      registerWorker: async () => ({
        pushManager: {
          subscribe: async () => {
            throw domExceptionLike();
          },
        },
      }),
      saveSubscription: async () => {},
    } as never);
    restore();

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join(' ')).not.toContain('SECRET-SUBSCRIPTION-PATH');
    // Still diagnostic: NotAllowedError, AbortError and NotSupportedError
    // are three different problems with three different fixes.
    expect(lines.join(' ')).toContain('NotAllowedError');
  });

  it('disablePush logs the error TYPE, not an endpoint-bearing message', async () => {
    const { lines, restore } = captureConsole();
    await disablePush({
      getSubscription: async () => ({
        endpoint: SECRET,
        unsubscribe: async () => {
          throw domExceptionLike();
        },
        toJSON: () => ({}),
      }),
      deleteSubscription: async () => {},
    } as never);
    restore();

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join(' ')).not.toContain('SECRET-SUBSCRIPTION-PATH');
  });

  it('readPushState logs the error TYPE, not an endpoint-bearing message', async () => {
    const { lines, restore } = captureConsole();
    await readPushState({
      getSubscription: async () => {
        throw domExceptionLike();
      },
    } as never);
    restore();

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join(' ')).not.toContain('SECRET-SUBSCRIPTION-PATH');
  });

  it('reports an ApiError with its status, which is safe, and no body', async () => {
    const { lines, restore } = captureConsole();
    await readPushState({
      getSubscription: async () => {
        throw new ApiError(503, `/api/push/subscribe returned 503 for ${SECRET}`);
      },
    } as never);
    restore();

    expect(lines.join(' ')).toContain('503');
    expect(lines.join(' ')).not.toContain('SECRET-SUBSCRIPTION-PATH');
  });
});

/**
 * Fix 7. `showNotification` rejects if permission was revoked between
 * subscribing and delivery, and `openWindow` can be refused. An unhandled
 * rejection inside a worker is invisible from the app and cannot be
 * debugged from it, so every `waitUntil` ends in a `.catch`.
 */
const WAIT_UNTIL = /waitUntil\(/;

describe('sw.js — no unhandled rejection can escape a handler', () => {
  const waitUntilLines = swSource.split(String.fromCharCode(10)).filter((line) => WAIT_UNTIL.test(line));

  it('has the waitUntil calls this worker is supposed to have', () => {
    // Guards the guard below: if the handlers were rewritten to drop
    // waitUntil entirely, filtering would yield an empty list and the
    // per-line assertion would pass vacuously.
    expect(waitUntilLines).toHaveLength(3);
  });

  it('catches on every one of them', () => {
    for (const line of waitUntilLines) {
      expect(line, `waitUntil without a .catch: ${line.trim()}`).toMatch(/\.catch\(/);
    }
  });

  it('no longer claims nothing can reject', () => {
    // The old header comment asserted "none of them can reject", which was
    // wrong about showNotification specifically.
    expect(swSource).not.toMatch(/none of them can reject/);
  });
});

describe('the waitUntil guard itself (not vacuous)', () => {
  it('flags a waitUntil with no catch', () => {
    const buggy = '  event.waitUntil(showFromPush(event.data));';
    expect(WAIT_UNTIL.test(buggy)).toBe(true);
    expect(buggy).not.toMatch(/\.catch\(/);
  });
});
