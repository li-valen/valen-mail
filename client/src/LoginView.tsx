import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError } from './api';
import './login.css';

/**
 * The sign-in surface (Task 3.5).
 *
 * One field, one button, one error line. The token is held in local state
 * only for as long as it takes to submit it; it is never written to
 * `localStorage`, never logged, and never placed in an error message. What
 * comes back from the server is an HttpOnly cookie this code cannot read.
 *
 * Visual values come from client/DESIGN.md: type scale, spacing, radius
 * and colour are tokens, and the error line is ACHROMATIC on purpose —
 * DESIGN.md §7.4 forbids the red banner, and colour in Postbox means a
 * read-state and nothing else. The focus ring and the reduced-motion floor
 * come from theme.css's global rules (§6), so nothing here re-implements
 * them; login.css only adds the one scoped reduced-motion end-state.
 */

interface LoginViewProps {
  /** Resolves once the session exists; rejects with an ApiError on a bad
   *  token so this view can render its error state. */
  readonly onSubmit: (token: string) => Promise<void>;
}

const EMPTY_MESSAGE = 'Enter the token before signing in.';

/**
 * Copy for every failure this form can produce. Names the problem and the
 * recovery (DESIGN.md §7.4) and, critically, never contains the submitted
 * value — an error string is the easiest place to leak a credential into a
 * console, a screenshot, or a bug report.
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
    <main className="login" aria-label="Sign in">
      <form className="login__form" onSubmit={handleSubmit} noValidate>
        <h1 className="login__headline">Postbox needs your token.</h1>
        <p className="login__sub prose">
          This browser is not signed in. Paste the sync service&rsquo;s API token once. Postbox
          keeps a signed session cookie for thirty days, never the token itself.
        </p>

        <label className="login__label" htmlFor={inputId}>
          API token
        </label>
        <input
          id={inputId}
          className="login__input"
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

        <button className="login__submit" type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </button>

        {/* Rendered only when there is something to say, so the alert fires
            once per failure rather than on every keystroke. */}
        {error !== null && (
          <p className="login__error" id={errorId} role="alert">
            {error}
          </p>
        )}
      </form>
    </main>
  );
}
