import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../api';
import type { ParsedMessage } from '../api';
import { messageCache } from '../messageCache';
import { loadMessage, readCachedMessage, refetchMessage } from '../messageLoader';
import { SKELETON_DELAY_MS } from '../motion';

/**
 * ONE MESSAGE'S BODY: fetch it, cache it, say when the wait is worth
 * mentioning, and offer a retry.
 *
 * Lifted verbatim out of MessageView.tsx when the reader learned to show a
 * whole conversation. It was a single inline effect there, which was right
 * while the reader showed exactly one message and wrong the moment it had
 * to show several — every message in a thread needs its own load, its own
 * error, and its own retry, and none of that can be a single component's
 * state any more.
 *
 * Nothing about the BEHAVIOUR changed in the move. The cache read is still
 * a `useState` initializer, and that is still the whole point (see below).
 */

/** Matches the shape of every other in-place failure in this app
 *  (App.tsx's SessionError, InboxList's messageFor): name what happened,
 *  never a stack trace, never a credential. */
export function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return `The sync service answered ${error.status}. This message could not be opened.`;
  }
  return "Valen Mail can't reach the sync service. This message could not be opened.";
}

export type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly parsed: ParsedMessage }
  | { readonly status: 'error'; readonly message: string };

export interface MessageBody {
  readonly load: LoadState;
  /** Whether the wait has gone on long enough to be worth telling the user
   *  about — see SKELETON_DELAY_MS in src/motion/tokens.ts. Without it, a
   *  fetch answered from the server's own cache in a few milliseconds still
   *  flashes a skeleton, which is the app announcing work it did not do. */
  readonly isSlow: boolean;
  readonly retry: () => void;
}

/**
 * `enabled` is what makes this usable for a COLLAPSED message: a thread of
 * twenty would otherwise fire twenty body fetches on open, for nineteen
 * bodies nobody has asked to see. Collapsed rows pass `false` and cost
 * nothing; expanding one flips it and the fetch starts then.
 */
export function useMessageBody(
  accountId: string,
  folder: string,
  uid: string,
  enabled = true,
): MessageBody {
  /**
   * THE WHOLE POINT OF THE CACHE, and the reason this is a `useState`
   * INITIALIZER rather than an effect.
   *
   * App.tsx keys the reader on the message, so opening one mounts it fresh
   * and this runs during that first render — before any paint. A message
   * already in the cache is therefore on screen in the first frame after
   * the click, with no loading state in between, which is what "instant"
   * actually means. Reading the cache in an effect instead would paint the
   * skeleton first and replace it a frame later: the same data, and still
   * a visible flash.
   *
   * `readCachedMessage` is a pure read and starts nothing, which is what
   * makes it safe here — React invokes an initializer during render, and
   * twice under StrictMode.
   */
  const [load, setLoad] = useState<LoadState>(() => {
    const cached = readCachedMessage(messageCache, { account_id: accountId, folder, uid });
    return cached === undefined ? { status: 'loading' } : { status: 'ready', parsed: cached };
  });
  const [attempt, setAttempt] = useState(0);
  const [isSlow, setIsSlow] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const target = { account_id: accountId, folder, uid };

    // A retry must fetch, whatever is cached — the cached copy is what the
    // user is retrying PAST when a previous attempt errored, and on the
    // error path there is nothing cached anyway.
    const outcome =
      attempt === 0
        ? loadMessage(messageCache, target)
        : { kind: 'pending' as const, parsed: refetchMessage(messageCache, target) };

    if (outcome.kind === 'cached') {
      // Already rendered by the initializer above on the mount that
      // matters. This branch is for the case a `key` does not remount on —
      // the same account and uid in a different folder, reachable from a
      // thread — where the identity changed but the component did not.
      // Compared by reference so an unchanged hit costs no render at all.
      setLoad((current) =>
        current.status === 'ready' && current.parsed === outcome.parsed
          ? current
          : { status: 'ready', parsed: outcome.parsed },
      );
      setIsSlow(false);
      return;
    }

    setLoad({ status: 'loading' });
    setIsSlow(false);
    const slowTimer = window.setTimeout(() => {
      if (!cancelled) setIsSlow(true);
    }, SKELETON_DELAY_MS);

    outcome.parsed.then(
      (parsed) => {
        if (cancelled) return;
        setLoad({ status: 'ready', parsed });
      },
      (error: unknown) => {
        if (cancelled) return;
        console.error('useMessageBody: message fetch failed', error);
        setLoad({ status: 'error', message: messageFor(error) });
      },
    );

    return () => {
      cancelled = true;
      window.clearTimeout(slowTimer);
    };
  }, [accountId, folder, uid, attempt, enabled]);

  const retry = useCallback(() => setAttempt((previous) => previous + 1), []);

  return { load, isSlow, retry };
}
