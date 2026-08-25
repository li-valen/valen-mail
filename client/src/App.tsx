import LoginView from './LoginView';
import { useSessionGate } from './useSessionGate';
import './shell.css';

/**
 * The app shell: an inbox region and a rail region, per client/DESIGN.md
 * §4.1's grid ("toolbar rail" / "inbox rail"). Renders no real content —
 * Task 4 fills the inbox with InboxList, Task 5 fills the rail with
 * OpensRail.
 *
 * The toolbar is an empty landmark for the same reason: DESIGN.md §6
 * component #2 specs an account filter, theme toggle, and rail toggle for
 * it, none of which this task builds.
 *
 * Task 3.5 adds the auth gate in front of it. Three things it must keep
 * apart, because collapsing any two is a defect: a browser with no session
 * gets the login view, a service that cannot be reached gets an in-place
 * error with a retry, and neither is rendered as a generic error page.
 */

interface SessionErrorProps {
  readonly message: string;
  readonly onRetry: () => void;
}

/**
 * A failure that a sign-in cannot fix, rendered in place at the top of the
 * inbox with one retry control (DESIGN.md §7.4) — never a modal, never a
 * red banner that pushes content down and disappears. Task 4 owns the
 * richer per-account sync-failure surface; this is the shell-level case.
 */
function SessionError({ message, onRetry }: SessionErrorProps) {
  return (
    <p className="shell__error" role="alert">
      {message} Postbox has not loaded any mail.{' '}
      <button type="button" className="shell__retry" onClick={onRetry}>
        Try again
      </button>
    </p>
  );
}

export default function App() {
  const { gate, signIn, retry } = useSessionGate();

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
      </header>

      <main className="inbox" aria-label="Inbox" aria-busy={gate.status === 'checking'}>
        <div className="inbox__inner">
          {gate.status === 'error' && <SessionError message={gate.message} onRetry={retry} />}
          {/* Task 4: InboxList */}
        </div>
      </main>

      <aside className="rail" aria-label="Opens tracking">
        {/*
          Task 5: OpensRail.

          Ruling from task-3-brief.md: `self`-classified events are
          suppressed from the rail's list but counted, shown as one muted
          line ("N views from you") rather than dropped silently. DESIGN.md
          itself does not specify this affordance's exact placement or copy
          (its §9 flags the underlying question and offers this as the
          alternative to hiding self-views outright, without picking exact
          wording), so per the task's own instruction this slot is left for
          Task 5 rather than guessed here.
        */}
      </aside>
    </div>
  );
}
