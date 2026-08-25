import { useCallback, useState } from 'react';
import LoginView from './LoginView';
import AppShell from './AppShell';
import type { AccountSummary, ViewId } from './AppShell';
import InboxList from './components/InboxList';
import OpensView from './components/OpensView';
import PushToggle from './components/PushToggle';
import { Alert, AlertDescription } from './ui/Alert';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { Skeleton } from './ui/Skeleton';
import { useSessionGate } from './useSessionGate';

/**
 * The app: an auth gate in front of Plunk's dashboard shell (see
 * AppShell.tsx for the port's provenance).
 *
 * Three things it must keep apart, because collapsing any two is a defect:
 * a browser with no session gets the login view, a service that cannot be
 * reached gets an in-place error with a retry, and neither is rendered as
 * a generic error page. In particular a non-401 NEVER produces a login
 * prompt — that would teach the user to type their token at anything that
 * asks (the rule itself lives in useSessionGate.ts/session.ts; this file
 * only renders its three outcomes).
 */

const SKELETON_ROW_COUNT = 6;

interface SessionErrorProps {
  readonly message: string;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
}

/**
 * A failure that a sign-in cannot fix, rendered in place at the top of the
 * content column with one retry control — never a modal, never a banner
 * that pushes content down and then disappears on its own.
 *
 * `onDismiss` exists because this banner and the notifications note were
 * the two surfaces flagged as "not dismissible, takes prime space".
 * Dismissing does not remove the retry: it removes the whole banner, and
 * the banner returns if a later attempt fails with a different message.
 */
function SessionError({ message, onRetry, onDismiss }: SessionErrorProps) {
  return (
    <Alert variant="destructive" className="mb-6">
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span className="flex-1 min-w-[12rem]">{message} Postbox has not loaded any mail.</span>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/** The content column while the session probe is still in flight: the same
 *  shaped skeleton the inbox itself uses, so the layout does not jump when
 *  the real list replaces it. Never a spinner. */
function ShellSkeleton() {
  return (
    <Card aria-hidden="true">
      <div className="divide-y divide-neutral-100">
        {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
          <div key={index} className="flex h-11 items-center gap-3 px-4">
            <Skeleton className="h-3 w-32 shrink-0" />
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="h-3 w-10 shrink-0" />
          </div>
        ))}
      </div>
    </Card>
  );
}

export default function App() {
  const { gate, signIn, retry } = useSessionGate();
  const [view, setView] = useState<ViewId>('inbox');
  const [accounts, setAccounts] = useState<readonly AccountSummary[]>([]);
  // Component-local, not persisted — keyed on the message text rather than
  // a plain boolean, so a retry that fails with a DIFFERENT message still
  // shows; only a repeat of the exact message the user already dismissed
  // stays hidden.
  const [dismissedErrorMessage, setDismissedErrorMessage] = useState<string | null>(null);

  // Stable identity: InboxList lists this in an effect's dependency array.
  const handleAccountsChange = useCallback((next: readonly AccountSummary[]) => {
    setAccounts(next);
  }, []);

  // Replaces the shell rather than overlaying it: there is nothing behind
  // this to look at, and a modal over an empty shell would only imply
  // there is.
  if (gate.status === 'login') {
    return <LoginView onSubmit={signIn} />;
  }

  const isAuthorized = gate.status === 'authorized';

  return (
    <AppShell
      view={view}
      onViewChange={setView}
      accounts={accounts}
      isBusy={gate.status === 'checking'}
      // Gated on `authorized`, not merely on the shell rendering: every
      // call PushToggle makes (/api/push/key, /api/push/subscribe) needs
      // the session cookie, so a toggle offered while the session is still
      // being checked — or after it failed — is a control whose only
      // possible outcome is a 401 rendered as "could not subscribe".
      sidebarFooter={isAuthorized ? <PushToggle /> : undefined}
    >
      {gate.status === 'error' && gate.message !== dismissedErrorMessage && (
        <SessionError
          message={gate.message}
          onRetry={retry}
          onDismiss={() => setDismissedErrorMessage(gate.message)}
        />
      )}

      {gate.status === 'checking' && <ShellSkeleton />}

      {isAuthorized &&
        (view === 'inbox' ? (
          <InboxList onAccountsChange={handleAccountsChange} />
        ) : (
          <OpensView />
        ))}
    </AppShell>
  );
}
