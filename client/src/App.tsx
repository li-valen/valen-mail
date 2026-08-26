import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import LoginView from './LoginView';
import AppShell from './AppShell';
import type { ViewId } from './AppShell';
import type { AccountSummary } from './accountRoster';
import { foldAccountRoster } from './accountRoster';
import { DEFAULT_FILTER } from './inboxFilters';
import type { FolderId } from './inboxFilters';
import type { InboxMessage, OpenEvent } from './api';
import { foldMessageIndex } from './messageIndex';
import { messagePrefetcher } from './messagePrefetch';
import Compose, { DISCARD_DRAFT_PROMPT } from './components/Compose';
import type { ResultSummary } from './components/composeResults';
import InboxList from './components/InboxList';
import MessageView from './components/MessageView';
import SentNotice from './components/SentNotice';
import { messageKey } from './components/messageBody';
import { resolveOpenTarget } from './components/openEvents';
import OpensRail from './components/OpensRail';
import OpensView from './components/OpensView';
import PushToggle from './components/PushToggle';
import ThemeToggle from './components/ThemeToggle';
import { Alert, AlertDescription } from './ui/Alert';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { Skeleton } from './ui/Skeleton';
import { cn } from './ui/cn';
import { Settle } from './motion';
import { initialViewFromSearch } from './initialView';
import { useDebouncedQuery } from './useDebouncedQuery';
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
 *
 * And owns the INBOX FILTER (Plan 5 Task 3): which folder and which
 * account the list is showing. Here for the same reason as everything
 * else above — the sidebar renders the selection and the list fetches
 * from it, so neither of those two can own it. Two `useState`s in the
 * shape the reader view and the theme controller already use; no store,
 * no router, no context.
 *
 * FOLDER AND ACCOUNT ARE ORTHOGONAL. `{folder: 'sent', account:
 * 'harvard'}` is an ordinary combination, so `changeFolder` never touches
 * the account and `changeAccount` never touches the folder. Both DO close
 * the reader, for the same reason `changeView` does: coming back to a list
 * and finding a message from a folder you left still open reads as the app
 * having ignored the click.
 *
 * Also owns the RECENT-OPENS CLICK-TO-OPEN registry (task V3, Ask 2):
 * `messageIndex`, folded from every InboxList report regardless of which
 * folder/account produced it (`messageIndex.ts`'s `foldMessageIndex`),
 * and `handleOpenEvent`, which resolves a clicked open event against it
 * (`resolveOpenTarget`, components/openEvents.ts) and either opens the
 * result through the SAME `openMessage` an inbox row uses, or shows
 * `OpenNotFoundNotice` when it can't. This lives here for the same
 * reason message selection does: OpensFeed.tsx (rendered from either
 * OpensRail.tsx or OpensView.tsx) does not itself hold the loaded-message
 * registry OR the reader's `selected` state, so it cannot resolve or act
 * on a click by itself — it only ever reports which event was activated.
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

/**
 * Task V3, Ask 2's honest failure state, verbatim per the task brief's own
 * suggested phrasing ("That message isn't in the synced window", extended
 * here into a full, actionable sentence). Fires from `handleOpenEvent`
 * below when `resolveOpenTarget` (components/openEvents.ts) answers
 * `not-found` — most often because the message an open event points at
 * lives in a folder (almost always Sent) `messageIndex` has not seen this
 * session yet. A dead click — nothing visibly happening — is the outcome
 * the task brief explicitly rules out, so this says so instead.
 */
const OPEN_NOT_FOUND_MESSAGE =
  "That message isn't in the synced window — open Sent to load it, then try again.";

interface OpenNotFoundNoticeProps {
  readonly onDismiss: () => void;
}

/**
 * Same dismissible-banner shape as SessionError above and SentNotice.tsx
 * — `role="status"`, not Alert's own default `role="alert"`, because this
 * is not an application error interrupting the user, just an honest "not
 * yet": announced politely, not assertively. Rendered ABOVE the per-view
 * content (see the render below), so it is visible regardless of whether
 * the click that triggered it came from the rail (beside the Inbox) or
 * the full Opens page.
 */
function OpenNotFoundNotice({ onDismiss }: OpenNotFoundNoticeProps) {
  return (
    <Alert role="status" className="mb-6">
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span className="flex-1 min-w-[12rem]">{OPEN_NOT_FOUND_MESSAGE}</span>
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
  const [folder, setFolder] = useState<FolderId>(DEFAULT_FILTER.folder);
  // null = every account merged, which is the default view and the ONE
  // value that must reach the wire as an absent param rather than an
  // empty one — see inboxFilters.ts's trap 2.
  const [account, setAccount] = useState<string | null>(DEFAULT_FILTER.account);
  // The RAW search box, updated on every keystroke, and the DEBOUNCED,
  // clamped query the list actually fetches with. Two values, one owner,
  // for the same reason folder and account live here: the top bar renders
  // the field and the list fetches from it, so neither of those two can
  // own it. The debounce lives in a hook rather than in the field so that
  // exactly one value in this app is ever "the query", and it is the one
  // the list and the results banner both read.
  const [searchInput, setSearchInput] = useState('');
  const searchQuery = useDebouncedQuery(searchInput);
  const [accounts, setAccounts] = useState<readonly AccountSummary[]>([]);
  // The registry `resolveOpenTarget` (components/openEvents.ts) searches
  // when a Recent-opens row is clicked (task V3, Ask 2) — folded from
  // whatever InboxList has actually loaded this session, the SAME
  // "grows only" shape `accounts` above gets from `foldAccountRoster`,
  // for the identical reason (messageIndex.ts's own header has the full
  // case). Deliberately NOT scoped to the currently selected folder: a
  // tracked send's own message lives in Sent, not whichever folder is on
  // screen when its "recent open" row gets clicked.
  const [messageIndex, setMessageIndex] = useState<readonly InboxMessage[]>([]);
  /**
   * The CURRENT list, in list order — what InboxList last reported,
   * unfolded.
   *
   * A second copy of the same report, and the two are not redundant:
   * `messageIndex` above grows forever across folders and accounts (that
   * is its job) and therefore has no meaningful ORDER, while the reader's
   * adjacent-message prefetch needs exactly the order the user is looking
   * at — "the row after this one" is only defined against one list.
   * Replaced on every report rather than folded, for the same reason.
   */
  const [visibleMessages, setVisibleMessages] = useState<readonly InboxMessage[]>([]);
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
  // The all-ok confirmation for a send. Held HERE rather than in
  // Compose.tsx because the composer closes on success — a confirmation
  // rendered inside it would appear and vanish in the same frame.
  const [sentNotice, setSentNotice] = useState<ResultSummary | null>(null);
  // The Ask-2 honest-failure banner (OpenNotFoundNotice above): true for
  // exactly the span between a Recent-opens click that `resolveOpenTarget`
  // could not resolve and the user dismissing it, or a LATER click that
  // resolves successfully (`handleOpenEvent` clears it either way before
  // acting) — never left showing after a click that actually worked.
  const [isOpenNotFoundVisible, setIsOpenNotFoundVisible] = useState(false);
  // The sidebar's Compose button, so closing the composer returns focus
  // to what opened it (AppShell's `composeRef` documents what happens at
  // widths where that button is not focusable).
  const composeTriggerRef = useRef<HTMLButtonElement | null>(null);
  // Where to go back to when the composer closes. Opening Compose from
  // the Opens page and landing on the Inbox afterwards would read as the
  // app having forgotten where the user was.
  const viewBeforeComposeRef = useRef<ViewId>('inbox');
  // Whether the open composer holds anything worth losing. A ref, not
  // state: it must never cause a render, and it is read exactly once, in
  // the click handler of a sidebar control.
  const isComposeDirtyRef = useRef(false);

  // Stable identity: InboxList lists this in an effect's dependency array.
  //
  // FOLDED, not replaced. InboxList reports the accounts present in the
  // pages it currently holds, and the moment a filter narrows those to one
  // account a straight `setAccounts(next)` would delete every other
  // account's row — removing the controls needed to switch back, and
  // emptying the switcher entirely on a folder that has not synced.
  // accountRoster.ts holds the one rule that fixes it.
  const handleAccountsChange = useCallback((next: readonly AccountSummary[]) => {
    setAccounts((known) => foldAccountRoster(known, next));
  }, []);

  // Same fold shape as handleAccountsChange above, for `messageIndex`
  // instead of the account roster — see that state's own comment and
  // messageIndex.ts's header for why this grows across folders/accounts
  // rather than replacing on every report.
  const handleMessagesChange = useCallback((next: readonly InboxMessage[]) => {
    setMessageIndex((known) => foldMessageIndex(known, next));
    // The same report, kept in order — see `visibleMessages`. Storing the
    // array by reference means an unchanged list is a no-op update React
    // bails out of rather than a render.
    setVisibleMessages(next);
  }, []);

  // One object for InboxList, rebuilt only when a selection actually
  // changes — the list destructures it back to primitives for its fetch
  // effect, so this is about readability at the call site rather than
  // about render count.
  const filter = useMemo(() => ({ folder, account }), [folder, account]);

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

  /**
   * Task V3, Ask 2: activating a Recent-opens row. Resolution is pure and
   * synchronous (`resolveOpenTarget`, components/openEvents.ts) — there is
   * no fetch in this path and therefore no loading state that could hang,
   * only `found` (open it, exactly like clicking an inbox row) or
   * `not-found` (say so — see OpenNotFoundNotice above for why a dead
   * click is not an acceptable third option). Clears any STALE
   * not-found banner from an earlier click first, either way, so a
   * successful click after a failed one never leaves the old banner
   * showing over the reader it just opened.
   */
  const handleOpenEvent = useCallback(
    (event: OpenEvent) => {
      setIsOpenNotFoundVisible(false);
      const target = resolveOpenTarget(event, messageIndex);
      if (target.kind === 'found') {
        openMessage(target.message);
        return;
      }
      setIsOpenNotFoundVisible(true);
    },
    [messageIndex, openMessage],
  );

  /**
   * Leaves the reader and forgets where the list was. Shared by all three
   * navigation handlers below, because all three land the user on a
   * DIFFERENT list than the one whose scroll offset and focused row are
   * currently recorded — restoring either onto the new list would scroll
   * to a position that never meant anything there and focus a row that is
   * no longer rendered.
   */
  const leaveReader = useCallback(() => {
    setSelected(null);
    openedKeyRef.current = null;
    listScrollRef.current = 0;
    // Every one of these three handlers lands the user on a DIFFERENT
    // list, so the reader's adjacent-message guesses are about rows that
    // are no longer anywhere on screen. Cancelling drops them off the
    // wire and — via the generation guard in src/messagePrefetch.ts —
    // makes any that already resolved harmless rather than merely late.
    messagePrefetcher.cancelAll();
  }, []);

  /**
   * Asks before a sidebar click throws away an unsent draft, and answers
   * false if the user says no.
   *
   * Compose.tsx asks the SAME question (with the same wording — it owns
   * the string) for Esc and its own Cancel button. This is the other half:
   * a folder click while composing would otherwise discard the draft
   * silently, which is the same unacceptable loss by a different route.
   */
  const canLeaveCompose = useCallback((): boolean => {
    if (view !== 'compose') return true;
    if (!isComposeDirtyRef.current) return true;
    return window.confirm(DISCARD_DRAFT_PROMPT);
  }, [view]);

  // Changing view closes the reader: coming back to the mail list later
  // and finding a message still open — one the user navigated away from —
  // reads as the app having ignored the navigation.
  const changeView = useCallback(
    (next: ViewId) => {
      if (next === 'compose') {
        // Remembered before the switch, and only from a non-compose view,
        // so a second Compose click while composing cannot make the
        // composer its own return destination.
        if (view !== 'compose') viewBeforeComposeRef.current = view;
        isComposeDirtyRef.current = false;
        // A new message supersedes the last one's confirmation; leaving
        // it up would have the shell reporting an older send above a
        // composer the user is filling in now.
        setSentNotice(null);
        leaveReader();
        setView('compose');
        return;
      }
      if (!canLeaveCompose()) return;
      isComposeDirtyRef.current = false;
      leaveReader();
      setView(next);
    },
    [view, canLeaveCompose, leaveReader],
  );

  /** Leaves the composer WITHOUT asking — Compose.tsx has already asked,
   *  or there was nothing to ask about (a completed send). */
  const closeCompose = useCallback(() => {
    isComposeDirtyRef.current = false;
    setView(viewBeforeComposeRef.current);
    composeTriggerRef.current?.focus();
  }, []);

  const handleSent = useCallback((summary: ResultSummary) => {
    setSentNotice(summary);
  }, []);

  const handleComposeDirtyChange = useCallback((isDirty: boolean) => {
    isComposeDirtyRef.current = isDirty;
  }, []);

  // Selecting a folder ALSO returns to the list view: the five folders are
  // the mail nav, so picking one from the Opens page means "show me that
  // mail", not "remember it for later". The account filter is untouched.
  const changeFolder = useCallback(
    (next: FolderId) => {
      if (!canLeaveCompose()) return;
      isComposeDirtyRef.current = false;
      leaveReader();
      setView('inbox');
      setFolder(next);
    },
    [canLeaveCompose, leaveReader],
  );

  // Same, from the other axis: the folder is untouched, so
  // folder=sent + account=harvard is reachable in either click order.
  const changeAccount = useCallback(
    (next: string | null) => {
      if (!canLeaveCompose()) return;
      isComposeDirtyRef.current = false;
      leaveReader();
      setView('inbox');
      setAccount(next);
    },
    [canLeaveCompose, leaveReader],
  );

  /**
   * Typing in the search box.
   *
   * STARTING A SEARCH IS NAVIGATION, and is treated as exactly that:
   * results are mail, mail lives in the list view, and a search run from
   * the Opens page or from the composer that quietly filtered a list
   * nobody could see would be the dead interaction this codebase keeps
   * refusing elsewhere. So the first keystroke of a new search closes the
   * reader and returns to the list, through the SAME
   * `canLeaveCompose()` guard a folder click goes through — and if the
   * user declines to discard their draft, the box does not change either,
   * so the refusal leaves nothing half-applied.
   *
   * Only the FIRST keystroke does this (`searchInput === ''`). Every
   * subsequent one is refining a search already on screen, and re-running
   * navigation per character would ask about the draft once per letter.
   */
  const handleSearchChange = useCallback(
    (next: string) => {
      if (next !== '' && searchInput === '') {
        if (!canLeaveCompose()) return;
        isComposeDirtyRef.current = false;
        leaveReader();
        setView('inbox');
      }
      setSearchInput(next);
    },
    [searchInput, canLeaveCompose, leaveReader],
  );

  const clearSearch = useCallback(() => setSearchInput(''), []);

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
    // `folder`/`account` are dependencies so that changing either one runs
    // this too: `leaveReader` has already zeroed the saved offset, so this
    // pass scrolls the new list to the top instead of leaving the reader
    // at the old list's offset.
  }, [selected, folder, account]);

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
      folder={folder}
      onFolderChange={changeFolder}
      account={account}
      onAccountChange={changeAccount}
      accounts={accounts}
      searchValue={searchInput}
      onSearchChange={handleSearchChange}
      isBusy={gate.status === 'checking'}
      contentRef={contentRef}
      composeRef={composeTriggerRef}
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

      {/* PLAN 7 TASK 3 — both notices SETTLE IN rather than appearing
          between two frames. They are the app answering something the
          user just did (a send completed; a Recent-opens row could not be
          resolved), and an answer that materialises fully-formed at the
          top of the column reads as a page that reloaded rather than as a
          reply. `<Settle>` is 180ms of the same fade-and-lift every other
          arriving surface uses, and it removes itself entirely under
          `prefers-reduced-motion`.

          Keyed so a SECOND send re-plays it: without the key the element
          persists across summaries and the new confirmation would swap in
          silently under an animation that had already run. There is no
          exit animation, deliberately — dismissing is the user's own
          action and they do not need it confirmed back to them slowly. */}
      {isAuthorized && sentNotice !== null && (
        <Settle key={`sent-${sentNotice.sentCount}-${sentNotice.failedCount}`}>
          <SentNotice summary={sentNotice} onDismiss={() => setSentNotice(null)} />
        </Settle>
      )}

      {isAuthorized && isOpenNotFoundVisible && (
        <Settle>
          <OpenNotFoundNotice onDismiss={() => setIsOpenNotFoundVisible(false)} />
        </Settle>
      )}

      {/*
        PLAN 7 TASK 2/3 — the view swap, and why there is NO wrapper here
        any more.

        This block used to be `<Settle key={view} lift={false}>`, one fade
        replayed on every view change. The motion review caught what that
        costs: the wrapper also covers InboxList's LOADING branch, so
        arriving at a folder from Opens or from the composer faded the
        SKELETON in over 180ms, while clicking between folders — which
        does not change `view`, so the wrapper never remounted — showed it
        on the next frame. One gesture, two different feelings depending
        on where the user came from, and the slower one contradicts the
        rule the skeleton exists to serve: instant, then smooth.

        Removing it costs nothing, because every branch below already
        animates its own arrival at the moment its own content is ready:
        Compose is wrapped in `<Panel>`, MessageView is wrapped in
        `<Panel>`, OpensView's feed and OpensRail both carry `<Settle>`
        inside OpensFeed, and InboxList carries `<Settle>` around its
        resolved list and deliberately NOT around its skeleton. Content
        now settles when it arrives rather than when the view changes,
        which is also the more honest signal.

        It also retires the `lift={false}` workaround: with no wrapper
        there is no resting transform above OpensRail's `position: sticky`
        column, so nothing can un-stick it.
      */}
      {isAuthorized && (
        <>
          {view === 'compose' ? (
          // Replaces the list rather than overlaying it, for the same
          // reason MessageView does: writing a message is the whole task
          // while it is open. See Compose.tsx's header for why this is a
          // view and not a dialog.
          <Compose
            onClose={closeCompose}
            onSent={handleSent}
            onDirtyChange={handleComposeDirtyChange}
          />
        ) : view === 'inbox' ? (
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
                <InboxList
                  filter={filter}
                  onAccountsChange={handleAccountsChange}
                  onMessagesChange={handleMessagesChange}
                  onOpenMessage={openMessage}
                  search={searchQuery}
                  onClearSearch={clearSearch}
                />
              </div>
              <OpensRail feed={feed} onOpenEvent={handleOpenEvent} />
            </div>

            {selected !== null && (
              // Keyed on the message so switching to another one (from
              // the reader's thread rows) REMOUNTS rather than mutates:
              // the body refetches, and "load remote images" resets to
              // off, which is the required per-message default.
              <MessageView
                key={messageKey(selected)}
                message={selected}
                // The list the reader was opened FROM, so it can warm the
                // rows either side of this one. Harmless when the reader
                // was opened from somewhere else (a thread row, an opens
                // event): MessageView finds no match and prefetches
                // nothing rather than guessing at a neighbour in a list
                // the user is not in.
                neighbours={visibleMessages}
                now={now}
                onBack={closeMessage}
                onOpen={openMessage}
              />
            )}
          </>
        ) : (
          <OpensView feed={feed} onOpenEvent={handleOpenEvent} />
        )}
        </>
      )}
    </AppShell>
  );
}
