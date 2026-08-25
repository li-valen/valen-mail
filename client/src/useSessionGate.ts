import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';
import { createSession, getSessionStatus, withSession } from './session';

/**
 * Decides whether the app can talk to the sync service, and if it cannot,
 * whether that is because it needs a token or because the service is down.
 *
 * Those two must not collapse into one another. A login prompt shown for a
 * 503 teaches the user to type their token at anything that asks, so only
 * a 401 opens it (see `isUnauthorized` in ./session.ts); every other
 * failure surfaces as an error with a retry.
 *
 * The retry-the-original-request contract lives here: `withSession` runs
 * the probe, and its `onUnauthorized` callback returns a promise that this
 * hook holds open until the login view submits successfully. The request
 * is then genuinely re-run, rather than the page being reloaded.
 */

export type SessionGate =
  | { readonly status: 'checking' }
  | { readonly status: 'authorized' }
  | { readonly status: 'login' }
  | { readonly status: 'error'; readonly message: string };

export interface SessionGateControls {
  readonly gate: SessionGate;
  /** Submits a token. Rejects with the ApiError so the login view renders
   *  its own error state; never resolves on a rejected token. */
  readonly signIn: (token: string) => Promise<void>;
  /** Re-runs the whole check after a non-401 failure. */
  readonly retry: () => void;
}

/**
 * `withSession` only ever surfaces a 401 here after a sign-in that the
 * server itself accepted — the retry it performs 401'd anyway. That has
 * one realistic cause and it is worth naming, because the symptom
 * otherwise looks like a rejected token the user knows is correct: the
 * session cookie is `Secure`, so a browser discards it over plain HTTP on
 * a real hostname (localhost is exempt), and it needs cookies enabled for
 * the site at all.
 */
function messageFor(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return 'Signing in worked, but the session was not kept. Postbox needs HTTPS (localhost aside) and cookies enabled for this site.';
  }
  if (error instanceof ApiError) {
    return `The sync service answered ${error.status}.`;
  }
  return "Postbox can't reach the sync service.";
}

export function useSessionGate(): SessionGateControls {
  const [gate, setGate] = useState<SessionGate>({ status: 'checking' });
  const [attempt, setAttempt] = useState(0);
  // Held between "the probe 401'd" and "the login view succeeded". Resolving
  // it is what lets withSession retry the ORIGINAL request.
  const pendingSignIn = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    setGate({ status: 'checking' });

    void withSession(
      () => getSessionStatus(),
      () =>
        new Promise<void>((resolve) => {
          // A probe left over from a superseded effect must unwind rather
          // than claim the login view; it will fail its retry and be
          // ignored by the cancelled guard below.
          if (cancelled) {
            resolve();
            return;
          }
          setGate({ status: 'login' });
          pendingSignIn.current = resolve;
        }),
    ).then(
      () => {
        if (!cancelled) setGate({ status: 'authorized' });
      },
      (error: unknown) => {
        if (cancelled) return;
        console.error('session: could not establish a session with the sync service', error);
        setGate({ status: 'error', message: messageFor(error) });
      },
    );

    return () => {
      cancelled = true;
      pendingSignIn.current = null;
    };
  }, [attempt]);

  const signIn = useCallback(async (token: string): Promise<void> => {
    await createSession(token);

    const resolve = pendingSignIn.current;
    pendingSignIn.current = null;
    if (resolve) {
      resolve();
      return;
    }
    // No request was waiting on this sign-in (the probe was superseded
    // between the 401 and the submit). Re-run the check rather than
    // leaving the user looking at a login form they just satisfied.
    setAttempt((previous) => previous + 1);
  }, []);

  const retry = useCallback((): void => {
    setAttempt((previous) => previous + 1);
  }, []);

  return { gate, signIn, retry };
}
