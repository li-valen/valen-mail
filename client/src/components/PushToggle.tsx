import { useCallback, useEffect, useState } from 'react';
import { Bell, BellOff, X } from 'lucide-react';
import { detectPushCapability, readPushEnvironment } from '../pushSupport';
import type { PushCapability } from '../pushSupport';
import { enablePush, disablePush, readPushState, browserPushDeps } from '../pushSubscribe';
import './PushToggle.css';

/**
 * The control that turns Web Push on for this browser.
 *
 * Four things it renders, and collapsing any two of them is a defect — the
 * same discipline client/DESIGN.md §7 states for empty vs. loading vs.
 * unavailable:
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
 * is raised in ../pushSubscribe.ts, reachable only from the click handler
 * below, because both Safari and Chrome refuse a permission request that
 * is not attached to a user gesture — quietly, resolving to "default" with
 * nothing logged. A second call site here would be free to drift into a
 * mount effect, which is exactly the shape that fails, so
 * client/tests/push-toggle.test.ts asserts the Notification permission API
 * is named nowhere in this file at all.
 *
 * Not in DESIGN.md §6's component inventory (that table predates this
 * task); built on its tokens and its rules — achromatic like all chrome,
 * the shared focus ring, `--hit-min` touch target, no icon standing in for
 * a label.
 *
 * **The dismiss button (Amendment 1: "density & ergonomics").** With no
 * other toolbar content built yet (App.tsx's own comment: AccountFilter,
 * ThemeToggle, and the rail toggle are all still Task-4/5-shaped gaps),
 * a browser in the `ios-install` / `unsupported` / `blocked` state
 * rendered NOTHING but this note in the 56px toolbar, permanently, with
 * no way to put it away — exactly the "notifications banner is not
 * dismissible and takes prime space" root cause the amendment names.
 * `isNoteDismissed` is component-local state, not persisted (the task's
 * own spec): it resets on reload, which is fine — the note is low-value
 * once read once per session, not something that needs to stay hidden
 * forever. Deliberately scoped to only this non-`available` branch: the
 * `failure` note in the `available` branch below is a direct response to
 * an action the user just took (a toggle click that failed), which is a
 * different kind of message and stays as it was.
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
  // them per render would run a matchMedia query on every keystroke
  // elsewhere in the toolbar.
  const [capability, setCapability] = useState<PushCapability>(() =>
    detectPushCapability(readPushEnvironment()),
  );
  const [isOn, setOn] = useState(false);
  const [isBusy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [isNoteDismissed, setNoteDismissed] = useState(false);

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
      <div className="push-toggle push-toggle--banner">
        <p className="push-toggle__note">{NOTES[capability]}</p>
        <button
          type="button"
          className="push-toggle__dismiss"
          onClick={() => setNoteDismissed(true)}
          aria-label="Dismiss notification message"
        >
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <div className="push-toggle">
      <button
        type="button"
        role="switch"
        aria-checked={isOn}
        aria-busy={isBusy}
        disabled={isBusy}
        className="push-toggle__switch"
        onClick={onToggle}
      >
        {/* Decorative: the visible label beside it carries the meaning, so
            the icon must not be announced twice (DESIGN.md §6 #20). */}
        {isOn ? (
          <Bell size={18} strokeWidth={1.5} aria-hidden="true" />
        ) : (
          <BellOff size={18} strokeWidth={1.5} aria-hidden="true" />
        )}
        <span className="push-toggle__label">Notifications</span>
        {/* The track is pure decoration — `role="switch"` plus
            `aria-checked` on the button is what actually carries the
            state, so this is hidden rather than announced as a second
            control. */}
        <span className="push-toggle__track" aria-hidden="true">
          <span className="push-toggle__knob" />
        </span>
      </button>

      {failure !== null && (
        <p className="push-toggle__note" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}
