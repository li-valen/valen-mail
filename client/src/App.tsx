import LoginView from './LoginView';
import InboxList from './components/InboxList';
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
          {/* Visually hidden, not absent: day rules render as <h2> inside
              InboxList, and with no <h1> anywhere in the shell a screen
              reader's document outline started at level 2. DESIGN.md's
              layout calls for no visible page title (client/DESIGN.md has
              no chrome for one), so this gives the outline a real root
              without adding anything to look at. */}
          <h1 className="visually-hidden">Inbox</h1>
          {gate.status === 'error' && <SessionError message={gate.message} onRetry={retry} />}
          {gate.status === 'authorized' && <InboxList />}
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
