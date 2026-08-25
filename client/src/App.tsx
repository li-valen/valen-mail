import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import LoginView from './LoginView';
import AppShell from './AppShell';
import type { AccountSummary, ViewId } from './AppShell';
import type { InboxMessage } from './api';
import InboxList from './components/InboxList';
import MessageView from './components/MessageView';
import { messageKey } from './components/messageBody';
import OpensRail from './components/OpensRail';
import OpensView from './components/OpensView';
import PushToggle from './components/PushToggle';
import ThemeToggle from './components/ThemeToggle';
import { Alert, AlertDescription } from './ui/Alert';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { Skeleton } from './ui/Skeleton';
import { cn } from './ui/cn';
import { initialViewFromSearch } from './initialView';
import { useOpensFeed } from './useOpensFeed';
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
 *
 * Also owns the ONE opens poller (`useOpensFeed`, task V1) for the whole
 * authorized session, called unconditionally alongside the other hooks
 * above and gated internally on `isAuthorized` — never per-view. The
 * Inbox view renders it as a rail beside the message list (OpensRail.tsx)
 * and the Opens nav destination renders it as a page (OpensView.tsx);
 * both read the SAME `feed` value, so there is exactly one fetch/poll
 * cycle regardless of which view is showing. See useOpensFeed.ts for why
 * this used to live inside OpensView.tsx and no longer does.
 *
 * Also owns MESSAGE SELECTION (Plan 6): which row the reader is showing,
 * and the two things that make Back honest — the list's scroll position
 * and the focused row. Selection lives here rather than in InboxList
 * because the reader REPLACES the list in the content column, and a
 * component cannot sensibly own the state that decides whether it is the
 * thing being rendered.
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
      <div className="divide-y divide-neutral-100 dark:divide-border">
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
  // Computed before the `login` early return below (rather than after,
  // where the pre-V1 code had it) because useOpensFeed must be called
  // unconditionally on every render — rules of hooks — and it needs this
  // value to know whether to poll.
  const isAuthorized = gate.status === 'authorized';
  const feed = useOpensFeed(isAuthorized);
  // Lazy initializer: seeds the view from a push notification's deep link
  // (`?rail=opens`, sync/src/push/dispatch.ts's OPENS_URL) on first mount,
  // without re-reading location.search on every render.
  const [view, setView] = useState<ViewId>(() => initialViewFromSearch(location.search));
  const [accounts, setAccounts] = useState<readonly AccountSummary[]>([]);
  // Component-local, not persisted — keyed on the message text rather than
  // a plain boolean, so a retry that fails with a DIFFERENT message still
  // shows; only a repeat of the exact message the user already dismissed
  // stays hidden.
  const [dismissedErrorMessage, setDismissedErrorMessage] = useState<string | null>(null);
  // null = the list is showing; a row = the reader is showing that row.
  const [selected, setSelected] = useState<InboxMessage | null>(null);
  // Resolved once per mount, for the same reason InboxList resolves its
  // own: every relative timestamp the reader renders agrees on what
  // "today" means for as long as the app stays open.
  const [now] = useState(() => new Date());
  // The scrolling column (AppShell's <main>), plus what to put back when
  // the reader closes. Refs, not state: neither value should ever cause a
  // render, and both are read exactly once, inside a layout effect.
  const contentRef = useRef<HTMLElement | null>(null);
  const listScrollRef = useRef(0);
  const openedKeyRef = useRef<string | null>(null);

  // Stable identity: InboxList lists this in an effect's dependency array.
  const handleAccountsChange = useCallback((next: readonly AccountSummary[]) => {
    setAccounts(next);
  }, []);

  const openMessage = useCallback(
    (next: InboxMessage) => {
      // Only the FIRST open records where the list was. Opening another
      // message from the reader's own thread rows must not overwrite that
      // with the READER's scroll position — Back would then return to the
      // list at an offset that never meant anything.
      if (selected === null) {
        listScrollRef.current = contentRef.current?.scrollTop ?? 0;
        openedKeyRef.current = messageKey(next);
      }
      setSelected(next);
    },
    [selected],
  );

  const closeMessage = useCallback(() => setSelected(null), []);

  // Changing view closes the reader: coming back to Inbox later and
  // finding a message still open — one the user navigated away from —
  // reads as the app having ignored the navigation.
  const changeView = useCallback((next: ViewId) => {
    setSelected(null);
    setView(next);
  }, []);

  /**
   * Restores the list exactly as it was left, and is the whole of what
   * "Back" has to get right.
   *
   * A LAYOUT effect, not a passive one: the list is re-shown in the same
   * commit this runs after, so setting `scrollTop` here happens before
   * the browser paints and the user never sees the list flash at the top
   * before jumping down.
   *
   * It works at all because InboxList stays MOUNTED behind the reader
   * (hidden, not unmounted — see the render below): its pages, its
   * cursor and therefore its full scroll height are already there when
   * this runs. Unmounting it would mean re-fetching on Back and
   * restoring a scroll position onto a skeleton half its height.
   *
   * Focus moves before the scroll and with `preventScroll`, so returning
   * focus to the row cannot fight the restore it is meant to accompany.
   * Keyboard users get back the row they opened, not the top of the page.
   */
  useLayoutEffect(() => {
    const column = contentRef.current;
    if (column === null) return;

    if (selected !== null) {
      column.scrollTop = 0;
      return;
    }

    const key = openedKeyRef.current;
    if (key !== null) {
      const row = document.querySelector<HTMLElement>(`[data-message-key="${CSS.escape(key)}"]`);
      row?.focus({ preventScroll: true });
    }
    column.scrollTop = listScrollRef.current;
  }, [selected]);

  // Replaces the shell rather than overlaying it: there is nothing behind
  // this to look at, and a modal over an empty shell would only imply
  // there is.
  if (gate.status === 'login') {
    return <LoginView onSubmit={signIn} />;
  }

  return (
    <AppShell
      view={view}
      onViewChange={changeView}
      accounts={accounts}
      isBusy={gate.status === 'checking'}
      contentRef={contentRef}
      // ThemeToggle renders unconditionally: it is a device preference,
      // not a mailbox operation, so it needs no session. PushToggle stays
      // gated on `authorized`, not merely on the shell rendering: every
      // call it makes (/api/push/key, /api/push/subscribe) needs the
      // session cookie, so a toggle offered while the session is still
      // being checked — or after it failed — is a control whose only
      // possible outcome is a 401 rendered as "could not subscribe".
      sidebarFooter={
        <>
          <ThemeToggle />
          {isAuthorized && <PushToggle />}
        </>
      }
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
          // The list state is two columns at desktop (the shell's own
          // `lg:` breakpoint): the message list (flex, shrinks first)
          // plus OpensRail, which is `hidden` below `lg:` and simply
          // occupies no space there — this row does not need its own
          // responsive direction change. Below `lg:` the Opens nav item
          // is the only way to reach the feed; the old collapsed bottom
          // strip is not coming back.
          //
          // The reader state is ONE column at every width, rail included:
          // reading a message is the whole task while it is open, and a
          // 5xl column of email beats a narrowed one beside a feed of
          // opens on the user's own sends, which is a different job.
          <>
            {/* HIDDEN, NOT UNMOUNTED, while the reader is open. This is
                what makes Back instant and lossless: no second fetch, no
                lost "Load more" pages, and a scroll height that is
                already correct when the layout effect above restores the
                position. `hidden` is display:none, so it is out of the
                tab order and the accessibility tree too. */}
            <div className={cn('flex gap-6', selected !== null && 'hidden')}>
              <div className="min-w-0 flex-1">
                <InboxList onAccountsChange={handleAccountsChange} onOpenMessage={openMessage} />
              </div>
              <OpensRail feed={feed} />
            </div>

            {selected !== null && (
              // Keyed on the message so switching to another one (from
              // the reader's thread rows) REMOUNTS rather than mutates:
              // the body refetches, and "load remote images" resets to
              // off, which is the required per-message default.
              <MessageView
                key={messageKey(selected)}
                message={selected}
                now={now}
                onBack={closeMessage}
                onOpen={openMessage}
              />
            )}
          </>
        ) : (
          <OpensView feed={feed} />
        ))}
    </AppShell>
  );
}
