import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Mailbox } from 'lucide-react';
import { ApiError } from './api';
import { Button } from './ui/Button';
import { Card, CardContent } from './ui/Card';
import { Input } from './ui/Input';
import { Label } from './ui/Label';

/**
 * The sign-in surface, on Plunk's auth-page vocabulary (AGPL-3.0): a
 * centred `Card` on the `bg-neutral-50` app ground, with the `Label`,
 * `Input` and `Button` atoms.
 *
 * One field, one button, one error line. The token is held in local state
 * only for as long as it takes to submit it; it is never written to
 * `localStorage`, never logged, and never placed in an error message. What
 * comes back from the server is an HttpOnly cookie this code cannot read.
 */

interface LoginViewProps {
  /** Resolves once the session exists; rejects with an ApiError on a bad
   *  token so this view can render its error state. */
  readonly onSubmit: (token: string) => Promise<void>;
}

const EMPTY_MESSAGE = 'Enter the token before signing in.';

/**
 * Copy for every failure this form can produce. Names the problem and the
 * recovery and, critically, never contains the submitted value — an error
 * string is the easiest place to leak a credential into a console, a
 * screenshot, or a bug report.
 */
function messageFor(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return 'That token was not accepted. Check it and try again.';
  }
  if (error instanceof ApiError) {
    return `The sync service answered ${error.status}. Nothing was signed in.`;
  }
  return "Postbox can't reach the sync service. Nothing was signed in.";
}

export default function LoginView({ onSubmit }: LoginViewProps) {
  const inputId = useId();
  const errorId = useId();
  const [token, setToken] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (isSubmitting) return;

    const submitted = token.trim();
    if (submitted.length === 0) {
      setError(EMPTY_MESSAGE);
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      await onSubmit(submitted);
      setToken('');
      // Deliberately stays submitting on success: the gate re-runs the
      // original request after this resolves, and re-enabling the button
      // during that window invites a second submit of the same token.
    } catch (caught) {
      // Handled, not swallowed — and the caught value is never rendered or
      // logged verbatim, because the failing request carried a credential.
      setError(messageFor(caught));
      setIsSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-neutral-50 dark:bg-background px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-neutral-900 text-white dark:bg-primary dark:text-primary-foreground">
            <Mailbox className="h-4 w-4" aria-hidden="true" />
          </div>
          <span className="text-2xl font-bold text-neutral-900 dark:text-foreground">Postbox</span>
        </div>

        <Card>
          <CardContent className="pt-6">
            <form onSubmit={handleSubmit} noValidate className="space-y-4">
              <div className="space-y-1.5">
                <h1 className="text-lg font-semibold tracking-tight text-neutral-900 dark:text-foreground">
                  Postbox needs your token.
                </h1>
                <p className="text-sm leading-relaxed text-neutral-500 dark:text-muted-foreground">
                  This browser is not signed in. Paste the sync service&rsquo;s API token once.
                  Postbox keeps a signed session cookie for thirty days, never the token itself.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={inputId}>API token</Label>
                <Input
                  id={inputId}
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  autoComplete="current-password"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={isSubmitting}
                  aria-invalid={error !== null}
                  aria-describedby={error === null ? undefined : errorId}
                />
              </div>

              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? 'Signing in…' : 'Sign in'}
              </Button>

              {/* Rendered only when there is something to say, so the alert
                  fires once per failure rather than on every keystroke. */}
              {error !== null && (
                <p className="text-sm text-red-600" id={errorId} role="alert">
                  {error}
                </p>
              )}
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
