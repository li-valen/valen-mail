import { useState } from 'react';
import { X } from 'lucide-react';
import LoginView from './LoginView';
import InboxList from './components/InboxList';
import OpensRail from './components/OpensRail';
import PushToggle from './components/PushToggle';
import { useSessionGate } from './useSessionGate';
import './shell.css';

/**
 * The app shell: an inbox region and a rail region, per client/DESIGN.md
 * §4.1's grid ("toolbar rail" / "inbox rail"). Task 4 fills the inbox with
 * InboxList; Task 5 fills the rail with OpensRail.
 *
 * The toolbar is still an empty landmark: DESIGN.md §6 component #2 specs
 * an account filter, theme toggle, and rail toggle for it, none of which
 * this task builds — the account is shown per-row as a label, not as a
 * toolbar filter control (task-4-brief.md: "all four accounts are always
 * merged").
 *
 * Task 3.5 adds the auth gate in front of it. Three things it must keep
 * apart, because collapsing any two is a defect: a browser with no session
 * gets the login view, a service that cannot be reached gets an in-place
 * error with a retry, and neither is rendered as a generic error page.
 */

interface SessionErrorProps {
  readonly message: string;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
}

/**
 * A failure that a sign-in cannot fix, rendered in place at the top of the
 * inbox with one retry control (DESIGN.md §7.4) — never a modal, never a
 * red banner that pushes content down and disappears. Task 4 owns the
 * richer per-account sync-failure surface; this is the shell-level case.
 *
 * Amendment 1 ("density & ergonomics") adds `onDismiss`: this and the
 * notifications banner (PushToggle.tsx) were the two banners flagged as
 * "not dismissible, takes prime space" — see App()'s own comment on the
 * dismiss state for why dismissal does not also remove the retry link.
 */
function SessionError({ message, onRetry, onDismiss }: SessionErrorProps) {
  return (
    <div className="shell__banner" role="alert">
      <p className="shell__banner-text">
        {message} Postbox has not loaded any mail.{' '}
        <button type="button" className="shell__retry" onClick={onRetry}>
          Try again
        </button>
      </p>
      <button type="button" className="shell__dismiss" onClick={onDismiss} aria-label="Dismiss">
        <X size={14} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </div>
  );
}

export default function App() {
  const { gate, signIn, retry } = useSessionGate();
  // Amendment 1: component-local, not persisted (the task's own spec for
  // this banner's dismiss state) — keyed on the message text rather than
  // a plain boolean, so a retry that fails with a DIFFERENT message still
  // shows; only a repeat of the exact message the user already dismissed
  // stays hidden.
  const [dismissedErrorMessage, setDismissedErrorMessage] = useState<string | null>(null);

  // Replaces the shell rather than overlaying it: there is nothing behind
  // this to look at, and a modal over an empty grid would only imply there
  // is.
  if (gate.status === 'login') {
    return <LoginView onSubmit={signIn} />;
  }

  return (
    <div className="shell">
      <header className="toolbar" aria-label="Toolbar">
        {/* Task 4+: AccountFilter, ThemeToggle, rail toggle
            (client/DESIGN.md §6, component #2 Toolbar). */}
        {/* Task 6. Gated on `authorized` like InboxList and OpensRail,
            not merely on the shell rendering: every call it makes
            (/api/push/key, /api/push/subscribe) needs the session cookie,
            so a toggle offered while the session is still being checked —
            or after it failed — is a control whose only possible outcome
            is a 401 rendered as "could not subscribe". */}
        {gate.status === 'authorized' && <PushToggle />}
      </header>

      <main className="inbox" aria-label="Inbox" aria-busy={gate.status === 'checking'}>
        <div className="inbox__inner">
          {/* Visually hidden, not absent: day rules render as <h2> inside
              InboxList, and with no <h1> anywhere in the shell a screen
              reader's document outline started at level 2. DESIGN.md's
              layout calls for no visible page title (client/DESIGN.md has
              no chrome for one), so this gives the outline a real root
              without adding anything to look at. */}
          <h1 className="visually-hidden">Inbox</h1>
          {gate.status === 'error' && gate.message !== dismissedErrorMessage && (
            <SessionError
              message={gate.message}
              onRetry={retry}
              onDismiss={() => setDismissedErrorMessage(gate.message)}
            />
          )}
          {gate.status === 'authorized' && <InboxList />}
        </div>
      </main>

      {/*
        OpensRail (Task 5) renders its own `<aside class="rail">` — the
        one place `grid-area: rail` is claimed — plus the <1080px
        collapsed strip and its expanded sheet as siblings of it, all
        three sharing one fetch. See OpensRail.tsx's own doc comment.

        Self-classified events are suppressed from the rail's list but
        counted, shown as one muted "N views from you" line rather than
        dropped silently (task-5-brief.md Amendment 2).
      */}
      {gate.status === 'authorized' && <OpensRail />}
    </div>
  );
}
