import { useCallback, useEffect, useId, useState } from 'react';
import { Bell, BellOff, X } from 'lucide-react';
import { detectPushCapability, readPushEnvironment } from '../pushSupport';
import type { PushCapability } from '../pushSupport';
import { enablePush, disablePush, readPushState, browserPushDeps } from '../pushSubscribe';
import { Button } from '../ui/Button';
import { Label } from '../ui/Label';
import { Switch } from '../ui/Switch';

/**
 * The control that turns Web Push on for this browser. It lives in the
 * shell's sidebar footer, where Plunk's DashboardLayout puts Settings and
 * the account menu.
 *
 * Four things it renders, and collapsing any two of them is a defect:
 *
 *  - **iOS, not installed.** Safari only permits `PushManager.subscribe()`
 *    from a Home Screen-installed web app. This case renders the
 *    instruction instead of a control, because offering a switch that
 *    cannot work — and fails with an error nobody can act on — is the
 *    confident-wrong-answer this product exists to refuse.
 *  - **Unsupported.** The browser has no service worker or no PushManager.
 *  - **Blocked.** Permission was already refused; only browser settings
 *    can undo that, and pretending a switch would help is a lie.
 *  - **Available.** A real switch.
 *
 * **The permission prompt is deliberately never raised in this file.** It
 * is raised in ../pushSubscribe.ts, reachable only from the change handler
 * below, because both Safari and Chrome refuse a permission request that
 * is not attached to a user gesture — quietly, resolving to "default" with
 * nothing logged. A second call site here would be free to drift into a
 * mount effect, which is exactly the shape that fails, so
 * client/tests/push-toggle.test.ts asserts the Notification permission API
 * is named nowhere in this file at all.
 *
 * **Why `checked` is not optional on the Switch below.** The ported atom
 * (../ui/Switch.tsx, from Plunk, AGPL-3.0) wraps Radix's switch primitive,
 * whose `onCheckedChange` runs SYNCHRONOUSLY inside the click handler only
 * while the component is controlled. Left uncontrolled, Radix fires the
 * same callback from a `useEffect` — a task later, after the gesture has
 * expired, which is precisely the silent failure above. push-toggle.test.ts
 * pins the `checked` prop statically for that reason.
 *
 * **Why `role`/`aria-checked` are also written out here.** Radix already
 * sets both, and spreads caller props last, so these two are redundant at
 * runtime. They are stated anyway so the toggle's switch semantics are
 * pinned at THIS call site — the one file push-toggle.test.ts can read —
 * rather than depending on a transitive library's internals staying put.
 *
 * **The dismiss button.** A browser in the `ios-install` / `unsupported` /
 * `blocked` state would otherwise render a permanent, unremovable note in
 * the sidebar footer. `isNoteDismissed` is component-local state, not
 * persisted: it resets on reload, which is fine — the note is low-value
 * once read once per session. Deliberately scoped to only this
 * non-`available` branch: the `failure` note in the `available` branch is
 * a direct response to an action the user just took, which is a different
 * kind of message.
 */

/** Copy for the three states that are not a control. Written as what is
 *  true and what to do about it, never as an error code. */
const NOTES: Readonly<Record<Exclude<PushCapability, 'available'>, string>> = {
  'ios-install': 'Share → Add to Home Screen, then open Postbox from there to turn on notifications.',
  unsupported: 'This browser cannot show notifications.',
  blocked: 'Notifications are blocked for Postbox in this browser’s settings.',
};

export default function PushToggle() {
  // Read once. None of these facts change without a reload, and re-reading
  // them per render would run a matchMedia query on every render elsewhere
  // in the shell.
  const [capability, setCapability] = useState<PushCapability>(() =>
    detectPushCapability(readPushEnvironment()),
  );
  const [isOn, setOn] = useState(false);
  const [isBusy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [isNoteDismissed, setNoteDismissed] = useState(false);
  const switchId = useId();

  useEffect(() => {
    if (capability !== 'available') return;
    let cancelled = false;
    // Reads the existing subscription; deliberately does NOT register a
    // service worker (see browserPushDeps.getSubscription). A worker is
    // installed only for someone who actually asked for notifications.
    readPushState(browserPushDeps).then((subscribed) => {
      if (!cancelled) setOn(subscribed);
    });
    return () => {
      cancelled = true;
    };
  }, [capability]);

  const onToggle = useCallback(() => {
    // Not an async function: everything before the first `await` inside
    // enablePush must stay in the click's own task, and a synchronous
    // entry point makes that impossible to lose to a stray await added
    // here later. The two setState calls schedule; they do not await.
    setBusy(true);
    setFailure(null);

    if (isOn) {
      void disablePush(browserPushDeps).then(async (result) => {
        // Re-read rather than assume: if unsubscribe succeeded and only
        // the server call failed, this device really is off, and the
        // switch must say so while the message explains the rest.
        setOn(await readPushState(browserPushDeps));
        if (!result.ok) setFailure(result.message);
        setBusy(false);
      });
      return;
    }

    void enablePush(browserPushDeps).then((result) => {
      if (result.ok) {
        setOn(true);
      } else {
        setFailure(result.message);
        // A refusal at the prompt turns "available" into "blocked" for
        // good; re-deriving means the next render stops offering a switch
        // that can no longer do anything.
        setCapability(detectPushCapability(readPushEnvironment()));
      }
      setBusy(false);
    });
  }, [isOn]);

  if (capability !== 'available') {
    if (isNoteDismissed) return null;
    return (
      <div className="flex items-start gap-2 rounded-lg bg-neutral-50 p-3">
        <p className="flex-1 text-xs leading-relaxed text-neutral-600">{NOTES[capability]}</p>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-neutral-500"
          onClick={() => setNoteDismissed(true)}
        >
          <X aria-hidden="true" />
          <span className="sr-only">Dismiss notification message</span>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <Label
          htmlFor={switchId}
          className="flex cursor-pointer items-center gap-3 text-neutral-600 select-none"
        >
          {/* Decorative: the visible label beside it carries the meaning, so
              the icon must not be announced twice. */}
          {isOn ? (
            <Bell className="h-5 w-5" aria-hidden="true" />
          ) : (
            <BellOff className="h-5 w-5" aria-hidden="true" />
          )}
          Notifications
        </Label>
        <Switch
          id={switchId}
          role="switch"
          aria-checked={isOn}
          aria-busy={isBusy}
          checked={isOn}
          disabled={isBusy}
          onCheckedChange={onToggle}
        />
      </div>

      {failure !== null && (
        <p className="px-3 text-xs leading-relaxed text-red-600" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}
