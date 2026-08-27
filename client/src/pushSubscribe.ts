import { getPushKey, savePushSubscription, deletePushSubscription } from './pushApi';
import { urlBase64ToUint8Array } from './pushSupport';
import { ApiError } from './api';

/**
 * Turning push on and off, as three functions with their dependencies
 * injected.
 *
 * The injection is what makes the ordering rule below testable at all:
 * `Notification.requestPermission()` MUST be the first thing the click
 * handler awaits, because Safari and Chrome both refuse a permission
 * request that is not attached to a user gesture — and they refuse it
 * quietly, with a promise that resolves to "default" and no error anywhere
 * to explain it. A test can prove the call order; nothing else can.
 *
 * This is also why the permission call lives here rather than inside
 * PushToggle.tsx: a copy in the component is free to drift into a mount
 * effect, which is exactly the shape that fails.
 */

/**
 * A log-safe description of a caught error (fix round 1).
 *
 * `console.error('...', error)` printed the raw object, and a
 * `DOMException` from `pushManager.subscribe()` or `unsubscribe()` can
 * name the subscription endpoint in its message. An endpoint is a
 * capability URL — whoever reads one out of a console, a screenshot, or a
 * pasted bug report can push to that device — so ./pushApi.ts's header
 * rule ("nothing here logs an endpoint") has to hold on this side of the
 * boundary too, not just for the requests.
 *
 * The error's TYPE is what is actually diagnostic here (`NotAllowedError`
 * vs `AbortError` vs `NotSupportedError` are three different problems with
 * three different fixes), and the type is exactly the part that carries no
 * endpoint. `ApiError` additionally contributes its status, which is
 * likewise safe — its own message is only a path plus a status code.
 */
function describeError(error: unknown): string {
  if (error instanceof ApiError) return `ApiError (status ${error.status})`;
  if (error instanceof Error) return error.name;
  return 'a non-Error value';
}

/** Where the service worker is served from. Site root, so its scope is
 *  "/" — a worker registered from a subdirectory can only receive pushes
 *  for that subdirectory. */
const SERVICE_WORKER_PATH = '/sw.js';

/** The subset of `PushSubscription` used here. Structural rather than the
 *  DOM type so a test can supply one without a browser. */
export interface BrowserSubscription {
  readonly endpoint: string;
  unsubscribe(): Promise<boolean>;
  toJSON(): unknown;
}

export interface WorkerRegistration {
  readonly pushManager: {
    subscribe(options: {
      userVisibleOnly: boolean;
      applicationServerKey: Uint8Array;
    }): Promise<BrowserSubscription>;
  };
}

export interface EnablePushDeps {
  readonly requestPermission: () => Promise<NotificationPermission>;
  readonly getPublicKey: () => Promise<string | null>;
  readonly registerWorker: () => Promise<WorkerRegistration>;
  readonly saveSubscription: (subscription: unknown) => Promise<void>;
}

export type EnableFailure = 'permission-denied' | 'not-configured' | 'failed';

export type EnableResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: EnableFailure; readonly message: string };

/**
 * Copy for each failure, written as a sentence a person can act on rather
 * than as a status. Never interpolates anything from the failure itself —
 * the value in scope at that point is a subscription endpoint.
 */
const FAILURE_MESSAGES: Readonly<Record<EnableFailure, string>> = {
  'permission-denied': 'This browser did not grant permission to show notifications.',
  'not-configured': 'Valen Mail has no push keys configured, so it cannot send notifications yet.',
  failed: 'Valen Mail could not subscribe this browser to notifications.',
};

function failure(reason: EnableFailure): EnableResult {
  return { ok: false, reason, message: FAILURE_MESSAGES[reason] };
}

/**
 * Turns push on for this browser.
 *
 * Order is the contract:
 *  1. Ask for permission. First, before anything else is awaited.
 *  2. Only then fetch the server's public key — no key, no subscription
 *     worth creating, and no service worker worth installing.
 *  3. Register the worker. Deliberately not at app start: a worker is hard
 *     to evict from an installed PWA, so one is only ever installed for
 *     someone who asked for notifications.
 *  4. Subscribe, and hand the result to the server.
 *
 * Never throws. Every failure is a value the toggle renders, because the
 * alternative is an unhandled rejection in a click handler and a control
 * that silently does nothing.
 */
export async function enablePush(deps: EnablePushDeps): Promise<EnableResult> {
  const permission = await deps.requestPermission();
  if (permission !== 'granted') return failure('permission-denied');

  try {
    const publicKey = await deps.getPublicKey();
    if (publicKey === null) return failure('not-configured');

    const registration = await deps.registerWorker();
    const subscription = await registration.pushManager.subscribe({
      // Required by Chrome, and an honest description of what this does:
      // every push Valen Mail sends produces a visible notification.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    await deps.saveSubscription(subscription.toJSON());
    return { ok: true };
  } catch (error) {
    // Neither the returned message nor the log line carries the error's
    // own text: the returned one is rendered on screen and the logged one
    // lands in a console, and a DOMException from `subscribe` can name the
    // endpoint. The type is the diagnostic part and is endpoint-free.
    console.error(`push: could not subscribe this browser — ${describeError(error)}`);
    return failure('failed');
  }
}

export interface DisablePushDeps {
  readonly getSubscription: () => Promise<BrowserSubscription | null>;
  readonly deleteSubscription: (endpoint: string) => Promise<void>;
}

export type DisableResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * Turns push off.
 *
 * Local `unsubscribe()` first, then the server row. That order is chosen
 * for what happens when the second step fails: the browser is already
 * unsubscribed, so no further notification can arrive, and the stale
 * server row is self-correcting — the next push to it returns 410 and the
 * dispatcher prunes it (sync/src/push/vapid.ts `shouldPruneOnStatus`).
 * The reverse order leaves the opposite: a server that has forgotten the
 * device while the device keeps its subscription.
 *
 * No subscription at all is a success. The intent is "this device should
 * not be subscribed", and it already is not.
 */
export async function disablePush(deps: DisablePushDeps): Promise<DisableResult> {
  try {
    const subscription = await deps.getSubscription();
    if (subscription === null) return { ok: true };

    await subscription.unsubscribe();
    await deps.deleteSubscription(subscription.endpoint);
    return { ok: true };
  } catch (error) {
    console.error(`push: could not fully unsubscribe this browser — ${describeError(error)}`);
    return { ok: false, message: 'Valen Mail could not turn notifications off completely.' };
  }
}

export interface ReadPushStateDeps {
  readonly getSubscription: () => Promise<BrowserSubscription | null>;
}

/**
 * Whether this browser currently holds a subscription.
 *
 * Answers false rather than rejecting when the lookup itself fails. This
 * runs on mount to decide which way the switch is drawn, and a browser
 * with no worker registered throws here; "not subscribed" is both the
 * truth in that case and the safe thing to render.
 */
export async function readPushState(deps: ReadPushStateDeps): Promise<boolean> {
  try {
    return (await deps.getSubscription()) !== null;
  } catch (error) {
    console.error(`push: could not read the current subscription state — ${describeError(error)}`);
    return false;
  }
}

/**
 * The live wiring: the same three flows, bound to the real browser APIs
 * and to ./pushApi.ts.
 *
 * `navigator.serviceWorker.ready` rather than the registration returned by
 * `register()`: the returned object can still be `installing`, and
 * `pushManager.subscribe()` on a worker that has not activated fails.
 */
export const browserPushDeps = {
  requestPermission: (): Promise<NotificationPermission> => Notification.requestPermission(),
  getPublicKey: (): Promise<string | null> => getPushKey(),
  registerWorker: async (): Promise<WorkerRegistration> => {
    await navigator.serviceWorker.register(SERVICE_WORKER_PATH);
    return (await navigator.serviceWorker.ready) as unknown as WorkerRegistration;
  },
  saveSubscription: (subscription: unknown): Promise<void> => savePushSubscription(subscription),
  /**
   * Reads the existing subscription WITHOUT registering a worker.
   * `getRegistration()` resolves to undefined when none exists, which is
   * the "push has never been turned on here" case and must not install
   * one as a side effect of asking.
   */
  getSubscription: async (): Promise<BrowserSubscription | null> => {
    const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_PATH);
    if (!registration) return null;
    return (await registration.pushManager.getSubscription()) as BrowserSubscription | null;
  },
  deleteSubscription: (endpoint: string): Promise<void> => deletePushSubscription(endpoint),
};
