import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import LoginView from './LoginView';
import AppShell from './AppShell';
import type { ViewId } from './AppShell';
import type { AccountSummary } from './accountRoster';
import { foldAccountRoster } from './accountRoster';
import { DEFAULT_FILTER } from './inboxFilters';
import type { FolderId } from './inboxFilters';
import type { InboxMessage, OpenEvent, ParsedMessage } from './api';
import { moveMessage, setMessageFlag } from './api';
import { foldMessageIndex } from './messageIndex';
import {
  allMessagesOf,
  membersByMessageKey,
  representativesOf,
} from './conversations';
import type { Conversation } from './conversations';
import { messageCache } from './messageCache';
import { loadMessage, targetFor } from './messageLoader';
import { messagePrefetcher } from './messagePrefetch';
import {
  canMoveFrom,
  canUndo,
  hideMessage,
  moveFailureFor,
  revealMessage,
  undoFailureFor,
  unavailableHereFor,
  UNDO_WINDOW_MS,
  type MoveDestination,
  type PendingUndo,
} from './mailboxActions';
import UndoNotice, { UndoBar } from './components/UndoNotice';
import BulkActionBar from './components/BulkActionBar';
import { moveTargetsFor } from './bulkActions';
import { markReadOnOpen } from './readOnOpen';
import { useBulkSelection } from './useBulkSelection';
import { replyKey } from './replyDraft';
import type { ReplyMode, ReplySource } from './replyDraft';
import Compose, { DISCARD_DRAFT_PROMPT } from './components/Compose';
import type { ResultSummary } from './components/composeResults';
import InboxList from './components/InboxList';
import MessageView from './components/MessageView';
import SentNotice from './components/SentNotice';
import { messageKey } from './components/messageBody';
import {
  resolveStar,
  resolveUnread,
  withFlagOverrides,
  withoutFlagOverrides,
  withStar,
  withoutStar,
} from './components/messageFlags';
import ShortcutHelp from './components/ShortcutHelp';
import { NO_SELECTION, reconcileSelection, snapshotSelection } from './keyboard/selection';
import type { SelectionResult } from './keyboard/selection';
import { revealRow } from './keyboard/revealRow';
import { useKeyboardShortcuts } from './keyboard/useKeyboardShortcuts';
import { resolveOpenTarget } from './components/openEvents';
import OpensRail from './components/OpensRail';
import OpensView from './components/OpensView';
import FollowupView from './components/FollowupView';
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
   * The CURRENT list, in list order — what InboxList last reported, as
   * CONVERSATIONS.
   *
   * A second copy of the same report, and the two are not redundant:
   * `messageIndex` above grows forever across folders and accounts (that
   * is its job) and therefore has no meaningful ORDER, while the reader's
   * adjacent-message prefetch needs exactly the order the user is looking
   * at — "the row after this one" is only defined against one list.
   * Replaced on every report rather than folded, for the same reason.
   *
   * Conversations rather than messages because the two derived views
   * below have to agree with what is drawn: the cursor walks ROWS and the
   * selection acts on MESSAGES, and holding only one of them would make
   * the other a lookup that can be wrong.
   */
  const [conversations, setConversations] = useState<readonly Conversation[]>([]);
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
  /**
   * THE KEYBOARD CURSOR — which row `j`/`k` are on, held as a
   * `{key, index}` pair.
   *
   * Owned here for the same reason `selected` is: `j`/`k` keep working
   * while the reader has REPLACED the list, so the list component cannot
   * own the state that decides what the reader shows next.
   *
   * THE KEY IS THE CURSOR AND THE INDEX IS A CONVENIENCE. Everything that
   * survives a list change is decided from the key (keyboard/selection.ts
   * has the three cases and why they differ); the index exists because
   * `j` means "+1" and because a clamp needs somewhere to clamp FROM.
   * They are written together, always, so they cannot drift.
   */
  const [cursor, setCursor] = useState<SelectionResult>({ key: null, index: NO_SELECTION });
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  /**
   * Stars this session has set, keyed by `messageKey`, drawn over
   * whatever `flags` says (components/messageFlags.ts's `resolveStar`).
   *
   * OPTIMISTIC, AND REVERTED ON FAILURE. The PATCH writes to the user's
   * real Gmail and takes an IMAP round trip; a star that waited for it
   * would feel broken next to a keystroke. An entry is added the instant
   * `s` is pressed and REMOVED — not inverted — if the write fails, so
   * the row falls back to the truth rather than to the opposite of it.
   */
  const [starOverrides, setStarOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  /** A star the server refused, held until dismissed. Never silent: a
   *  keystroke that appeared to work and did not is the worst outcome
   *  available for a write path. */
  const [starError, setStarError] = useState<string | null>(null);
  /**
   * Read-state this session has changed, keyed by `messageKey` and drawn
   * over whatever `flags` says (components/messageFlags.ts's
   * `resolveUnread`).
   *
   * The `starOverrides` contract exactly, for `\Seen` instead of
   * `\Flagged`, including the revert rule: a failed write DELETES the
   * entry rather than inverting it, so the row falls back to the truth.
   * TWO WRITERS, and they are the same mechanism on purpose: the bulk
   * bar's mark read/unread, and `openMessage` below marking one message
   * read because a person actually opened it (../src/readOnOpen.ts).
   *
   * Declared with their state rather than down beside the bulk overlays,
   * because `openMessage` is defined hundreds of lines earlier and a
   * `useCallback` declared after it could not appear in its dependency
   * array without a temporal-dead-zone throw at render.
   */
  const [seenOverrides, setSeenOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());

  const applySeen = useCallback((keys: readonly string[], seen: boolean) => {
    setSeenOverrides((overrides) => withFlagOverrides(overrides, keys, seen));
  }, []);

  const revertSeen = useCallback((keys: readonly string[]) => {
    setSeenOverrides((overrides) => withoutFlagOverrides(overrides, keys));
  }, []);

  /**
   * Read by `openMessage` to ask whether the message it is opening is
   * still unread, WITHOUT taking a dependency on the map.
   *
   * The same discipline as `cursorRef` below and for a sharper reason:
   * `openMessage` is handed to InboxList, the reader and the opens rail,
   * so a new identity re-renders all three — and this map changes on
   * every single mark-read, which would mean each open invalidated the
   * callback that performed it.
   */
  const seenOverridesRef = useRef(seenOverrides);
  seenOverridesRef.current = seenOverrides;
  /**
   * Rows this session has archived, trashed or reported, keyed by
   * `messageKey` and drawn over the list by filtering
   * (components/InboxList.tsx's `visible`).
   *
   * OPTIMISTIC, AND ROLLED BACK ON FAILURE — the same contract
   * `starOverrides` above carries, and here it matters more: a star that
   * silently failed leaves a wrong icon, while an archive that silently
   * failed leaves a message the user believes they have dealt with and
   * which is still sitting in their inbox. The key is REMOVED (never
   * inverted) when the move fails, so the row returns to exactly where it
   * was in the list rather than to some reconstruction of it.
   */
  const [hiddenKeys, setHiddenKeys] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * The move the user can still take back, or null.
   *
   * ONE AT A TIME, deliberately. Gmail's undo is a single bar and a
   * single action; a queue of them would mean the user pressing "Undo"
   * without knowing which of three archives it applies to. A second move
   * replaces the first — whose effect stands, because the move already
   * happened and only the AFFORDANCE expires.
   */
  const [pendingUndo, setPendingUndo] = useState<PendingUndo | null>(null);
  /** A move (or an undo) the mailbox refused, held until dismissed. Same
   *  in-place shape as `starError`, and never a toast. */
  const [moveError, setMoveError] = useState<string | null>(null);
  /**
   * What the composer is replying TO, or null for a plain new message.
   *
   * Held here rather than in Compose.tsx because it is decided BEFORE the
   * composer exists — by a button in the reader or by `r`/`a`/`f` from
   * anywhere — and because it must survive the composer being closed and
   * reopened on a different message.
   */
  const [replySource, setReplySource] = useState<ReplySource | null>(null);
  /** A reply whose message body could not be fetched. Same dismissible,
   *  in-place shape as `starError`: the composer never opened, and
   *  saying nothing would leave a keystroke looking dead. */
  const [replyError, setReplyError] = useState<string | null>(null);
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
  /** Which reply attempt is current — see `startReply` on why a token
   *  rather than an abort. */
  const replyAttemptRef = useRef(0);
  /**
   * The bulk bar's "dismiss the undo offer", read by `performMove`.
   *
   * A REF because of declaration order and stability, not laziness:
   * `performMove` is defined above `useBulkSelection` (it is what the
   * reader's buttons and the single-message keyboard path call) and is
   * deliberately dependency-free, so it cannot close over the hook's
   * handler. The ref is written on every render, immediately after the
   * hook returns.
   */
  const dismissBulkUndoRef = useRef<() => void>(() => {});

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
  //
  // The index is folded from EVERY MEMBER, not from the rows: a
  // Recent-opens click names one message, and a message that is the
  // fourth reply in a collapsed conversation is still loaded and still
  // openable. Folding only the representatives would make those clicks
  // answer "not in the synced window" about mail that is right there.
  const handleConversationsChange = useCallback((next: readonly Conversation[]) => {
    setMessageIndex((known) => foldMessageIndex(known, allMessagesOf(next)));
    // The same report, kept in order — see `conversations`. Storing the
    // array by reference means an unchanged list is a no-op update React
    // bails out of rather than a render.
    setConversations(next);
  }, []);

  // One object for InboxList, rebuilt only when a selection actually
  // changes — the list destructures it back to primitives for its fetch
  // effect, so this is about readability at the call site rather than
  // about render count.
  const filter = useMemo(() => ({ folder, account }), [folder, account]);

  /**
   * THE ROWS — one message per drawn row, which is each conversation's
   * newest.
   *
   * Everything that indexes by CURSOR POSITION reads this: `j`/`k`, the
   * star, the reply trio, `Enter`/`o`, and the reader's neighbour
   * prefetch. A cursor that walked every loaded message would spend
   * thirty-nine presses of `j` inside a forty-message conversation that
   * draws as one row.
   */
  const visibleMessages = useMemo(() => representativesOf(conversations), [conversations]);
  /**
   * EVERY LOADED MESSAGE, in list order — what the bulk selection is
   * resolved and pruned against, because a move is one request per
   * message however few rows they occupy.
   */
  const selectableMessages = useMemo(() => allMessagesOf(conversations), [conversations]);
  /** From any loaded message's key to its whole conversation. Feeds
   *  `expandConversation` below. */
  const conversationMembers = useMemo(() => membersByMessageKey(conversations), [conversations]);

  /**
   * Every message the row for `message` stands for.
   *
   * Falls back to the message ITSELF for anything this list does not
   * know — a thread row inside the reader, a Recent-opens click — which
   * is the honest answer: a row that is not in the list stands for
   * nothing but itself.
   */
  const expandConversation = useCallback(
    (message: InboxMessage): readonly InboxMessage[] =>
      conversationMembers.get(messageKey(message)) ?? [message],
    [conversationMembers],
  );

  /** The current list as `messageKey`s, in list order — the array the
   *  cursor indexes into and the one `reconcileSelection` compares
   *  against. Memoised on `visibleMessages`, which is replaced by
   *  reference only when the list actually changed. */
  const visibleKeys = useMemo(() => visibleMessages.map(messageKey), [visibleMessages]);

  // Read inside the reconciliation effect below, which must NOT re-run
  // when the cursor moves — only when the LIST changes. A dependency on
  // `cursor` would make every `j` re-reconcile against itself.
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  /** The keys as they were on the previous reconciliation, which is what
   *  makes "same list, one row gone" distinguishable from "different
   *  list" (keyboard/selection.ts's head-key test). */
  const previousKeysRef = useRef<readonly string[]>([]);
  /**
   * Whether the next cursor change was caused by a KEYSTROKE, and
   * therefore earns a focus move and a scroll.
   *
   * THE WHOLE "DO NOT FIGHT THE USER" MECHANISM lives in this flag.
   * Reconciliation moves the cursor too — a folder click sends it to row
   * 0 — and scrolling or stealing focus for that would yank the page away
   * from the sidebar button the user just pressed. Only `j`/`k` and the
   * reader's own navigation set this.
   */
  const shouldRevealRef = useRef(false);

  /**
   * THE ONE FUNNEL EVERY REAL OPEN GOES THROUGH — a list row, a thread
   * row inside the reader, a click in the opens rail — and therefore the
   * only place a message may be marked read.
   *
   * **NOT IN THE LOADER, AND THAT IS THE WHOLE POINT.**
   * ./messagePrefetch.ts warms hovered and adjacent messages through
   * `fetchMessage`; a mark-read that hung off the fetch would clear mail
   * the user merely swept a pointer past. Hanging it off the OPEN also
   * gets the cached case right for free: this runs whether or not
   * anything went to the network, so a message the reader paints from
   * cache on the first frame is marked read exactly like a cold one.
   *
   * The decision, the optimistic write and the rollback are all in
   * ./readOnOpen.ts — nothing here decides anything, per client/CLAUDE.md.
   * `resolveUnread` is what it asks, rather than `message.flags`, so a
   * re-open of a message this session already marked read writes nothing.
   */
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

      const key = messageKey(next);
      void markReadOnOpen(next, {
        isUnread: resolveUnread(next, seenOverridesRef.current, key),
        key,
        setSeen: applySeen,
        revertSeen,
        onError: (error) => console.error('App: marking the opened message read failed', error),
      });
    },
    [selected, applySeen, revertSeen],
  );

  const closeMessage = useCallback(() => setSelected(null), []);

  /**
   * Keeps the cursor pointing at the same MESSAGE while the list changes
   * under it — an append from "Load more", a wholesale swap from a folder
   * or search change, or a row that has gone missing from an otherwise
   * unchanged list. keyboard/selection.ts owns the three answers and why
   * they differ; this effect only supplies the two snapshots.
   *
   * The previous snapshot is built from `previousKeysRef`, i.e. the array
   * the current index was computed against, so `previousKeys[index]` is
   * the cursor's own key by construction rather than by coincidence.
   */
  useLayoutEffect(() => {
    const previousKeys = previousKeysRef.current;
    previousKeysRef.current = visibleKeys;

    const next = reconcileSelection(
      snapshotSelection(previousKeys, cursorRef.current.index),
      visibleKeys,
    );
    setCursor((current) =>
      current.key === next.key && current.index === next.index ? current : next,
    );
  }, [visibleKeys]);

  /**
   * Brings the cursor's row on screen, but ONLY after a keystroke asked
   * for it — see `shouldRevealRef`.
   *
   * A layout effect, matching the Back-restore below: the row has already
   * rendered with its new selection treatment in this commit, and
   * scrolling before paint means the user never sees the list at the old
   * offset first.
   */
  useLayoutEffect(() => {
    if (!shouldRevealRef.current) return;
    shouldRevealRef.current = false;
    // The list is `hidden` behind the reader, so its rows are out of the
    // layout and out of the accessibility tree — there is nothing to
    // focus or scroll to, and `revealRow` would simply find nothing.
    if (selected !== null || cursor.key === null) return;
    revealRow(cursor.key);
  }, [cursor, selected]);

  /** Moves the cursor to a row index, and marks the move as
   *  keyboard-driven so the row is focused and scrolled to. */
  const moveCursor = useCallback(
    (index: number) => {
      const key = visibleKeys[index];
      if (key === undefined) return;
      shouldRevealRef.current = true;
      setCursor({ key, index });
    },
    [visibleKeys],
  );

  /**
   * Moves the cursor because a row took FOCUS — Tab, or a screen reader
   * walking the list.
   *
   * Deliberately does NOT set `shouldRevealRef`: the browser has already
   * put this row where the user can see it, and asking for a second
   * scroll would be this app second-guessing the platform's own focus
   * scrolling.
   */
  const selectMessage = useCallback(
    (message: InboxMessage) => {
      const key = messageKey(message);
      const index = visibleKeys.indexOf(key);
      if (index === NO_SELECTION) return;
      setCursor((current) =>
        current.key === key && current.index === index ? current : { key, index },
      );
    },
    [visibleKeys],
  );

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
        // The sidebar's Compose button means a NEW message. Without this,
        // clicking it after a reply would open a composer still carrying
        // the previous message's threading headers, and the "new" message
        // would land inside an old conversation.
        setReplySource(null);
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
    setReplySource(null);
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
   * `s` — star or unstar whichever message is in hand.
   *
   * WHICH MESSAGE: the open one if the reader is showing, otherwise the
   * row under the cursor. keyboard/shortcuts.ts guarantees at least one
   * of those exists before it emits the action, so the early return here
   * is a belt on top of that rather than the only thing standing between
   * a keystroke and a crash.
   *
   * OPTIMISTIC, THEN HONEST. The override goes in immediately; a failed
   * PATCH removes it (never inverts it) so the row falls back to what
   * `flags` actually says, and says so in a dismissible banner. A write
   * to the user's real Gmail that silently did nothing is the one outcome
   * this must not have — see sync/src/api/flags.ts, which is equally
   * explicit that this route is the only one that changes real state.
   */
  const toggleStar = useCallback(() => {
    const target = selected ?? visibleMessages[cursor.index];
    if (target === undefined) return;

    const key = messageKey(target);
    const next = !resolveStar(target, starOverrides, key);
    setStarError(null);
    setStarOverrides((overrides) => withStar(overrides, key, next));

    setMessageFlag(target.account_id, target.folder, target.uid, 'flagged', next).catch(
      (error: unknown) => {
        console.error('App: star write failed', error);
        setStarOverrides((overrides) => withoutStar(overrides, key));
        setStarError(
          next
            ? "That message could not be starred — Postbox couldn't reach your mailbox."
            : "That message could not be unstarred — Postbox couldn't reach your mailbox.",
        );
      },
    );
  }, [selected, visibleMessages, cursor.index, starOverrides]);


  /**
   * `e`, `#`, the reader's two buttons and a row's hover controls: get
   * ONE message out of the inbox.
   *
   * OPTIMISTIC, THEN HONEST — the same three beats `toggleStar` above
   * uses, and the rollback is the load-bearing one. The row is hidden the
   * instant the key is pressed, because an archive that waited for an
   * IMAP round trip would feel broken next to a keystroke; and it comes
   * BACK if the move fails, because a message that stays gone in the UI
   * while it is still in the inbox is a lie the user cannot detect. See
   * mailboxActions.ts.
   *
   * THE READER CLOSES on success and only on success. Archiving what you
   * are reading and being left staring at it is the interaction Gmail
   * gets right by returning you to the list; being thrown back to the
   * list for a move that then FAILED would be worse than not moving at
   * all, so the close waits for the answer.
   *
   * NOTHING HERE IS BULK. One call, one message — the same sentence
   * sync/src/api/move.ts and src/api.ts both make, for the same reason.
   */
  const performMove = useCallback(
    (target: InboxMessage, destination: MoveDestination) => {
      setMoveError(null);
      // Only the keyboard can reach this: the reader's buttons and a
      // row's hover controls are ABSENT outside the inbox rather than
      // present and inert. Said out loud rather than silently ignored,
      // because a bare key that appears to do nothing is the failure this
      // codebase refuses everywhere else. See mailboxActions.ts's
      // `canMoveFrom` for why Sent in particular must not be archivable.
      if (!canMoveFrom(target.folder)) {
        setMoveError(unavailableHereFor(destination));
        return;
      }

      const key = messageKey(target);
      // A second move supersedes the first undo offer rather than queuing
      // behind it — see `pendingUndo`. The BULK bar is dismissed for the
      // same reason and in the same breath: two undo bars would leave the
      // user pressing "Undo" without knowing which one it applies to.
      setPendingUndo(null);
      dismissBulkUndoRef.current();
      setHiddenKeys((hidden) => hideMessage(hidden, key));

      moveMessage(target.account_id, target.folder, target.uid, { to: destination }).then(
        (result) => {
          // The reader is closed HERE rather than beside the optimistic
          // hide, so a refused move leaves the user exactly where they
          // were, reading the message that did not go anywhere.
          setSelected((current) => (current !== null && messageKey(current) === key ? null : current));
          if (!canUndo(result)) return;
          setPendingUndo({
            key,
            accountId: target.account_id,
            destination,
            // Non-null by `canUndo`, which is the ONLY thing that decides
            // whether an undo may be offered at all.
            ticket: result.undo!,
          });
        },
        (error: unknown) => {
          console.error('App: mailbox move failed', error);
          setHiddenKeys((hidden) => revealMessage(hidden, key));
          setMoveError(moveFailureFor(destination));
        },
      );
    },
    [],
  );

  /**
   * Puts the message back where it came from.
   *
   * The SAME primitive in the other direction: the server issued the
   * ticket (which folder the message is in now, its new uid there, and
   * the logical kind it came from), and this replays it verbatim. Nothing
   * here constructs a destination — see src/api.ts's `moveMessage`.
   *
   * **THE ROW THAT COMES BACK CARRIES A STALE UID, AND THAT IS
   * DELIBERATE.** A MOVE renumbers the message, so the row this reveals
   * addresses a uid that no longer exists in INBOX; the correct row
   * arrives from the server on the next sync cycle (the restored message
   * lands at the top of INBOX's uid range, well inside the window
   * sync/src/imap/fetch.ts reads). Revealing the stale row is still the
   * right trade: the user sees their message come back in the same frame
   * they pressed Undo, and the only exposure is opening THAT row inside
   * the sync window, which lands on the reader's existing
   * could-not-be-loaded state with a retry. The alternative — leaving the
   * row hidden and telling the user it worked — is the dead interaction
   * this codebase refuses everywhere else.
   */
  const undoMove = useCallback((undo: PendingUndo) => {
    setPendingUndo(null);
    setMoveError(null);
    moveMessage(undo.accountId, undo.ticket.folder, String(undo.ticket.uid), {
      to: 'undo',
      origin: undo.ticket.origin,
    }).then(
      () => {
        setHiddenKeys((hidden) => revealMessage(hidden, undo.key));
      },
      (error: unknown) => {
        console.error('App: undo of a mailbox move failed', error);
        // The row stays hidden, because the message really is still in
        // the folder it was moved to. Saying so is the whole point: the
        // failure copy for this is a DIFFERENT sentence from a failed
        // move, since the message is not where a failed move would have
        // left it.
        setMoveError(undoFailureFor(undo.destination));
      },
    );
  }, []);

  /**
   * The undo offer expires; the MOVE does not.
   *
   * A cosmetic timer, exactly like the chord hint's in
   * keyboard/useKeyboardShortcuts.ts: if it never fired (a backgrounded
   * tab throttling timeouts, which browsers do aggressively) the bar
   * would simply stay on screen and still work. Keyed on the pending
   * undo's identity so a second move restarts the window rather than
   * inheriting the remainder of the first.
   */
  useEffect(() => {
    if (pendingUndo === null) return;
    const timer = setTimeout(() => setPendingUndo(null), UNDO_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [pendingUndo]);

  /**
   * BULK SELECTION — which rows are ticked, and what a batch does to
   * them.
   *
   * Every decision lives in the pure modules the hook calls
   * (bulkSelection.ts, bulkRunner.ts, bulkActions.ts); the hook holds the
   * state and the async, and App.tsx holds only the four overlays a batch
   * has to write through, because InboxList and the reader both draw from
   * them and neither can own state the other renders.
   *
   * The two `useCallback`s below take ARRAYS of keys rather than being
   * called per row: forty separate `setHiddenKeys` updates would be forty
   * new `Set` identities and forty passes over a fifty-row list.
   *
   * `applySeen`/`revertSeen` are the same shape and are declared up beside
   * `seenOverrides` itself, because `openMessage` — which is defined long
   * before this point — now writes through them too. A `useCallback` here
   * would be in its own temporal dead zone by the time that dependency
   * array was evaluated.
   */
  const hideKeys = useCallback((keys: readonly string[]) => {
    if (keys.length === 0) return;
    setHiddenKeys((hidden) => {
      const next = new Set(hidden);
      for (const key of keys) next.add(key);
      return next;
    });
  }, []);

  const revealKeys = useCallback((keys: readonly string[]) => {
    if (keys.length === 0) return;
    setHiddenKeys((hidden) => {
      const next = new Set(hidden);
      for (const key of keys) next.delete(key);
      return next;
    });
  }, []);

  const clearSingleUndo = useCallback(() => setPendingUndo(null), []);

  const bulk = useBulkSelection({
    // EVERY loaded message, not one per row — see the hook's own
    // `messages` doc. The cursor row is the conversation's
    // representative, and `expand` turns it back into the conversation.
    messages: selectableMessages,
    cursorMessage: visibleMessages[cursor.index] ?? null,
    expand: expandConversation,
    hideKeys,
    revealKeys,
    setSeen: applySeen,
    revertSeen,
    clearSingleUndo,
  });
  dismissBulkUndoRef.current = bulk.dismissUndo;

  /**
   * `e`/`#`: the same "which message is in hand" rule `s` and the reply
   * trio use, WIDENED so that a selection wins over the cursor.
   *
   * The three cases and the reasoning behind them live in
   * bulkActions.ts's `moveTargetsFor`, which is where they are tested;
   * this is the switch over its answer and nothing else. Note that a
   * SELECTION of one still takes the batch path — otherwise the tick and
   * the bar would be left on screen over a row that has already gone.
   */
  const moveMessageInHand = useCallback(
    (destination: MoveDestination) => {
      const targets = moveTargetsFor({
        inHand: selected ?? visibleMessages[cursor.index] ?? null,
        isReaderOpen: selected !== null,
        selection: bulk.selection,
      });
      if (targets.kind === 'none') return;
      if (targets.kind === 'selection') {
        bulk.move(destination);
        return;
      }
      /*
       * A ROW STANDS FOR ITS WHOLE CONVERSATION; THE READER STANDS FOR
       * ONE MESSAGE.
       *
       * In the list, `e` on a forty-message conversation has to archive
       * forty — archiving only the row's own message would leave the row
       * exactly where it was, one shorter, and read as a key that did
       * nothing. Gmail archives the conversation for the same reason.
       *
       * In the READER it is the message that is on screen, and only it.
       * This app's reader shows ONE message with the rest of the thread
       * stacked with it (components/ThreadMessage.tsx), so archiving
       * thirty-nine messages the user is not reading would be an action
       * about something other than what they are looking at. That is the
       * same rule `moveTargetsFor` already applies to a selection behind
       * an open reader, extended to the conversation behind it.
       */
      const group = selected === null ? expandConversation(targets.message) : [targets.message];
      if (group.length > 1) {
        // The batch path, not a loop of single moves: the bounded runner,
        // the partial-failure accounting, the rollback and the one undo
        // bar all already exist and all already apply.
        bulk.moveMessages(group, destination);
        return;
      }
      performMove(targets.message, destination);
    },
    [selected, visibleMessages, cursor.index, performMove, bulk, expandConversation],
  );

  /** The reader's two buttons, bound to the message the reader is
   *  showing. Same function the keyboard reaches, so the two cannot
   *  diverge. */
  const moveSelected = useCallback(
    (destination: MoveDestination) => {
      if (selected === null) return;
      performMove(selected, destination);
    },
    [selected, performMove],
  );

  /**
   * A list row's own hover controls, which name their row directly rather
   * than going through the cursor — a mouse user never moved it.
   *
   * Acts on the whole CONVERSATION, exactly as `e` does from the list and
   * for the same reason: the button sits on a row that says "(40)", so
   * moving one of the forty would be a control that contradicts its own
   * label.
   */
  const moveFromRow = useCallback(
    (message: InboxMessage, destination: MoveDestination) => {
      const group = expandConversation(message);
      if (group.length > 1) {
        bulk.moveMessages(group, destination);
        return;
      }
      performMove(message, destination);
    },
    [performMove, expandConversation, bulk],
  );

  /**
   * `r`, `a`, `f` and the reader's three buttons: open the composer on a
   * message.
   *
   * THE PARSED MESSAGE IS REQUIRED, WHICH IS WHY THIS IS ASYNC. A reply
   * needs the body to quote and — the whole point of Plan 9 — the
   * `Message-ID` and `References` to thread with, and an `InboxMessage`
   * row carries none of the three. `loadMessage` answers from the cache
   * when it can, which is the overwhelmingly common case: the reader
   * populated it on open, and messagePrefetch warmed the neighbours. A
   * cache hit takes the synchronous branch and the composer is open in
   * the same frame as the keystroke.
   *
   * STALENESS IS GUARDED BY A TOKEN, not by a cancelled promise. If the
   * user presses `r`, changes their mind, moves to another message and
   * presses `r` again before the first fetch lands, the first response
   * must not open a composer on a message they have left. Each attempt
   * takes the next token and only the current one is allowed to act.
   *
   * THE READER IS NOT CLOSED. `changeView` closes it, deliberately, for
   * every OTHER navigation; a reply is the one case where the message
   * behind the composer is the thing being answered, so `selected`
   * survives and Cancel returns the user to what they were reading.
   */
  const startReply = useCallback(
    (message: InboxMessage, mode: ReplyMode) => {
      if (!canLeaveCompose()) return;

      const token = replyAttemptRef.current + 1;
      replyAttemptRef.current = token;
      setReplyError(null);

      const open = (parsed: ParsedMessage) => {
        if (replyAttemptRef.current !== token) return;
        setReplySource({ mode, accountId: message.account_id, parsed });
        isComposeDirtyRef.current = false;
        // A new reply supersedes the last send's confirmation, matching
        // what `changeView` does for the sidebar's Compose button.
        setSentNotice(null);
        // Read from the render's own `view`, never from inside a state
        // updater: React may invoke an updater twice under StrictMode, and
        // writing a ref from one is a side effect in a function that must
        // not have any.
        if (view !== 'compose') viewBeforeComposeRef.current = view;
        setView('compose');
      };

      const outcome = loadMessage(messageCache, targetFor(message));
      if (outcome.kind === 'cached') {
        open(outcome.parsed);
        return;
      }
      outcome.parsed.then(open, (error: unknown) => {
        if (replyAttemptRef.current !== token) return;
        console.error('App: could not load the message to reply to', error);
        setReplyError(
          "That message could not be opened for a reply — Postbox couldn't reach your mailbox.",
        );
      });
    },
    [canLeaveCompose, view],
  );

  /** `r`/`a`/`f`: the same "which message is in hand" rule `s` uses, and
   *  the same belt-and-braces early return — keyboard/shortcuts.ts has
   *  already guaranteed one exists. */
  const replyToMessageInHand = useCallback(
    (mode: ReplyMode) => {
      const target = selected ?? visibleMessages[cursor.index];
      if (target === undefined) return;
      startReply(target, mode);
    },
    [selected, visibleMessages, cursor.index, startReply],
  );

  /** The reader's own buttons, bound to the message the reader is
   *  showing. Same function the keyboard reaches, so the two cannot
   *  diverge. */
  const replyToSelected = useCallback(
    (mode: ReplyMode) => {
      if (selected === null) return;
      startReply(selected, mode);
    },
    [selected, startReply],
  );

  /** `Enter`/`o`, and `j`/`k` from inside the reader: move the cursor and
   *  open in one step. Opening the message ALREADY on screen is skipped
   *  rather than re-run — at the ends of the list `j`/`k` clamp to the
   *  current row, and remounting the reader on the same message would
   *  re-fetch a body the user is already reading. */
  const openAt = useCallback(
    (index: number) => {
      const target = visibleMessages[index];
      if (target === undefined) return;
      const key = messageKey(target);
      if (selected !== null && messageKey(selected) === key) return;
      setCursor({ key, index });
      openMessage(target);
    },
    [visibleMessages, selected, openMessage],
  );

  /**
   * The whole keyboard, installed once for the authorized session.
   *
   * Everything this passes down is either state this component already
   * owns or a handler it already had — `changeFolder` is the same
   * function the sidebar calls, so `g i` and a click on Inbox cannot
   * diverge. The one genuinely new behaviour is `toggleStar` above.
   */
  const { chordKey } = useKeyboardShortcuts(
    {
      isComposerOpen: view === 'compose',
      isHelpOpen,
      isReaderOpen: selected !== null,
      listLength: visibleMessages.length,
      selectedIndex: cursor.index,
    },
    {
      onSelect: moveCursor,
      onOpen: openAt,
      onCloseReader: closeMessage,
      onToggleStar: toggleStar,
      onReply: replyToMessageInHand,
      onMailboxMove: moveMessageInHand,
      onToggleSelection: bulk.toggleCursorRow,
      onGoFolder: changeFolder,
      onOpenHelp: () => setIsHelpOpen(true),
      onCloseHelp: () => setIsHelpOpen(false),
    },
  );

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

    column.scrollTop = listScrollRef.current;

    /**
     * WHICH ROW GETS FOCUS BACK — the cursor's, falling back to the one
     * that was opened.
     *
     * The cursor wins because `j`/`k` STEP while the reader is open (see
     * keyboard/shortcuts.ts's `moveFrom`), so "the row they opened" and
     * "the row they were reading" come apart the moment the user
     * navigates from inside the reader. Landing back on the first one
     * would send the next `j` over ground they just covered.
     * `openedKeyRef` remains the fallback for the reader opened from
     * somewhere with no list cursor at all — a Recent-opens click, a
     * thread row.
     *
     * Read through `cursorRef` rather than depending on `cursor`: this
     * effect also restores the list's SCROLL offset, and re-running it on
     * every cursor move would snap the list back to the saved position
     * every time the user pressed `j`.
     */
    const key = cursorRef.current.key ?? openedKeyRef.current;
    if (key !== null) {
      // Focuses with `preventScroll` and then nudges with
      // `block: 'nearest'` — which does nothing when the restored offset
      // already has the row on screen, and only closes the gap when the
      // user stepped far enough in the reader to leave it behind.
      revealRow(key);
    }
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
      // The reader REPLACES the list, so below `lg:` the shell strips back
      // to the message itself. See AppShell's `isReading` for what that
      // hides and why the desktop is untouched.
      isReading={selected !== null}
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

      {/* A star the mailbox refused. Same dismissible in-place shape as
          the two banners above — never a toast, never silent. The
          optimistic override has ALREADY been rolled back by the time
          this renders, so the row beneath it is showing the truth while
          this explains why it changed back. */}
      {isAuthorized && starError !== null && (
        <Settle>
          <Alert variant="destructive" className="mb-6">
            <AlertDescription className="flex flex-wrap items-center gap-3">
              <span className="flex-1 min-w-[12rem]">{starError}</span>
              <Button variant="ghost" size="sm" onClick={() => setStarError(null)}>
                Dismiss
              </Button>
            </AlertDescription>
          </Alert>
        </Settle>
      )}

      {/* "Archived. — Undo."

          THE WHOLE REASON THE ACTION IS SAFE TO USE. An archive you
          cannot take back is frightening enough that people stop using it
          and let the inbox grow again, which is precisely the problem
          this task exists to solve.

          Above the two failure banners and below the send confirmation,
          because it is the most recent thing the user did. Keyed on the
          hidden row so a SECOND archive re-plays the entrance rather than
          silently swapping the text under an animation that already ran —
          same reasoning, same shape, as `sentNotice` above. */}
      {/* THE BATCH RECEIPT. Same banner shape and same slot as the
          single-message one below, because they are the same statement at
          two sizes — and never both at once: starting either dismisses
          the other, so the user is never asked to guess which "Undo"
          they are looking at.

          The Undo button is ABSENT rather than disabled when a batch
          produced no tickets at all (every message was already gone from
          the mailbox): the rows are correctly hidden and there is
          genuinely nothing to put back. Keyed on the batch so a second
          one replays the entrance rather than swapping the text under an
          animation that already ran. */}
      {isAuthorized && bulk.undo !== null && bulk.undoNotice !== null && (
        <Settle key={`bulk-undo-${bulk.undo.id}`}>
          <UndoBar
            notice={bulk.undoNotice}
            undoLabel={bulk.undoLabel ?? 'Undo'}
            isUndoable={bulk.isUndoable}
            onUndo={bulk.runUndo}
            onDismiss={bulk.dismissUndo}
          />
        </Settle>
      )}

      {/* **THE PARTIAL BATCH, SAID OUT LOUD.** The one banner in this app
          whose absence would be a data-integrity bug rather than a
          usability one: thirty-seven of forty archived and three not,
          with the three silently still in the inbox, is a state the user
          cannot detect by looking. The rows have ALREADY come back by the
          time this renders, so this explains rows that are visibly there
          rather than announcing something invisible. */}
      {isAuthorized && bulk.error !== null && (
        <Settle>
          <Alert variant="destructive" className="mb-6">
            <AlertDescription className="flex flex-wrap items-center gap-3">
              <span className="flex-1 min-w-[12rem]">{bulk.error}</span>
              <Button variant="ghost" size="sm" onClick={bulk.dismissError}>
                Dismiss
              </Button>
            </AlertDescription>
          </Alert>
        </Settle>
      )}

      {isAuthorized && pendingUndo !== null && (
        <Settle key={`undo-${pendingUndo.key}`}>
          <UndoNotice
            undo={pendingUndo}
            onUndo={undoMove}
            onDismiss={() => setPendingUndo(null)}
          />
        </Settle>
      )}

      {/* A move the mailbox refused, or an undo that could not put the
          message back, or a key pressed where the action is not offered.
          Same dismissible in-place shape as the star failure above — and
          for a FAILED move the optimistic removal has ALREADY been rolled
          back by the time this renders, so the row is back in the list
          beneath it while this explains why. */}
      {isAuthorized && moveError !== null && (
        <Settle>
          <Alert variant="destructive" className="mb-6">
            <AlertDescription className="flex flex-wrap items-center gap-3">
              <span className="flex-1 min-w-[12rem]">{moveError}</span>
              <Button variant="ghost" size="sm" onClick={() => setMoveError(null)}>
                Dismiss
              </Button>
            </AlertDescription>
          </Alert>
        </Settle>
      )}

      {/* A reply whose message could not be fetched, so the composer never
          opened. Dismissible and in place, exactly like the star failure
          above: a keystroke that appeared to do nothing is the failure
          this app refuses to ship silently. */}
      {isAuthorized && replyError !== null && (
        <Settle>
          <Alert variant="destructive" className="mb-6">
            <AlertDescription className="flex flex-wrap items-center gap-3">
              <span className="flex-1 min-w-[12rem]">{replyError}</span>
              <Button variant="ghost" size="sm" onClick={() => setReplyError(null)}>
                Dismiss
              </Button>
            </AlertDescription>
          </Alert>
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
            /* Keyed on the message being answered so switching from a
               reply to a forward — or replying to a different message
               without closing in between — REMOUNTS rather than leaving
               the previous draft's recipients in place. The seeding
               effect in Compose.tsx runs once per mount by design. */
            key={replyKey(replySource)}
            reply={replySource ?? undefined}
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
                {/* ONLY WHEN SOMETHING IS TICKED — see BulkActionBar's
                    header on why it is absent rather than disabled. It
                    sits INSIDE the list column rather than up with the
                    banners so that its sticky top edge is the list's own
                    scroll context and its select-all box lines up with
                    the checkbox column of the rows beneath it. */}
                {bulk.count > 0 && (
                  <BulkActionBar
                    count={bulk.count}
                    countLabel={bulk.countLabel}
                    isEverythingSelected={bulk.isEverythingSelected}
                    onSelectAll={bulk.selectAllVisible}
                    onClear={bulk.clear}
                    onMove={bulk.move}
                    onMarkSeen={bulk.markSeen}
                  />
                )}
                <InboxList
                  filter={filter}
                  onAccountsChange={handleAccountsChange}
                  onConversationsChange={handleConversationsChange}
                  onOpenMessage={openMessage}
                  search={searchQuery}
                  onClearSearch={clearSearch}
                  selectedKey={cursor.key}
                  onSelectMessage={selectMessage}
                  starOverrides={starOverrides}
                  hiddenKeys={hiddenKeys}
                  onMailboxMove={moveFromRow}
                  seenOverrides={seenOverrides}
                  selectedKeys={bulk.selectedKeys}
                  onToggleSelect={bulk.toggle}
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
                isStarred={resolveStar(selected, starOverrides, messageKey(selected))}
                onToggleStar={toggleStar}
                onReply={replyToSelected}
                /* ABSENT, not disabled, for a message the actions do not
                   apply to — a Starred row that lives in Sent or Spam.
                   A control that is visible and refuses is a worse answer
                   than one that was never offered. */
                onMailboxMove={canMoveFrom(selected.folder) ? moveSelected : undefined}
              />
            )}
          </>
        ) : view === 'followup' ? (
          /*
           * Spec 7A's follow-up queue, with its OWN reader beside it
           * rather than a hand-off to the Inbox's.
           *
           * The list is HIDDEN, not unmounted, while a message is open —
           * the same `hidden` (display:none, so out of the tab order and
           * the accessibility tree) the Inbox branch above uses, and for
           * the same reason: Back returns to the queue instantly, with
           * its scope, its loaded pages and its ranking intact. Routing
           * this through `setView('inbox')` instead would have Back land
           * the user in a mailbox they never asked for.
           */
          <>
            <div className={cn(selected !== null && 'hidden')}>
              <FollowupView account={account} onOpenMessage={openMessage} />
            </div>
            {selected !== null && (
              <MessageView
                key={messageKey(selected)}
                message={selected}
                now={now}
                onBack={closeMessage}
                backLabel="Back to follow-up"
                isStarred={resolveStar(selected, starOverrides, messageKey(selected))}
                onToggleStar={toggleStar}
                onReply={replyToSelected}
                /* NEVER here. The follow-up queue is built out of SENT
                   mail, and on Gmail archiving a sent message removes the
                   Sent label — it would delete a row out of the very
                   feature the user is looking at. mailboxActions.ts's
                   `canMoveFrom` carries the full case. */
              />
            )}
          </>
        ) : (
          <OpensView feed={feed} onOpenEvent={handleOpenEvent} />
        )}
        </>
      )}

      {/* THE CHORD HINT — what a half-finished `g` looks like.
          Without it a chord is a hidden mode: the user presses `g`,
          nothing happens, and the next key does something they did not
          expect. `lg:` only, for the same reason the help overlay is —
          there is no keyboard below it. `aria-live="polite"` so the state
          is announced rather than only drawn. */}
      {chordKey !== null && (
        <div
          className="pointer-events-none fixed bottom-6 right-6 z-40 hidden items-center gap-2 rounded-md border border-border bg-card px-3 py-2 shadow-md lg:flex"
          role="status"
          aria-live="polite"
        >
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium text-foreground">
            {chordKey}
          </kbd>
          <span className="text-xs text-muted-foreground">then i, s or t</span>
        </div>
      )}

      {isHelpOpen && <ShortcutHelp onClose={() => setIsHelpOpen(false)} />}
    </AppShell>
  );
}
