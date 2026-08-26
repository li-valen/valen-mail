import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SearchX } from 'lucide-react';
import { ApiError, getInbox, getSearch } from '../api';
import type { InboxCursor, InboxMessage, InboxPage } from '../api';
import type { AccountSummary } from '../accountRoster';
import { emptyStateFor, searchEmptyStateFor } from '../emptyState';
import { FOLDER_ICONS } from '../folderIcons';
import { headingFor } from '../inboxFilters';
import type { FolderId, InboxFilter } from '../inboxFilters';
import { Alert, AlertDescription } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { Settle, SettleGroup } from '../motion';
import MessageRow from './MessageRow';
import { groupByDay } from './inboxDates';
import { LIST_DIVIDERS, LIST_SURFACE } from './listSurface';
import { isCurrentSelection, resolveLoadMorePage } from './inboxPaging';
import { messageKey } from './messageBody';

// Re-exported so `InboxList.tsx` stays the one public entry point for both
// the component and the pure logic it renders with — tests import
// `formatWhen`/`groupByDay` from here, per task-4-brief.md's interface.
export { formatWhen, groupByDay } from './inboxDates';
export type { DayGroup } from './inboxDates';

/** Matches the empty-state copy's own claim ("the newest 50 messages per
 *  account for this folder", ../emptyState.ts) — the same number used for
 *  every page, not just the first. */
const PAGE_SIZE = 50;
const SKELETON_ROW_COUNT = 6;

/* `LIST_SURFACE` and `LIST_DIVIDERS` moved to ./listSurface.ts when the
   reader's attachment and thread lists adopted the same treatment — see
   that file for the reasoning, which is unchanged. */

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready' }
  | { readonly status: 'error'; readonly message: string };

/** Same shape of message as App.tsx's SessionError and LoginView's
 *  messageFor — names the problem, not a stack trace, and never repeats a
 *  credential-bearing value. */
function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return `The sync service answered ${error.status}. The inbox could not load.`;
  }
  return "Postbox can't reach the sync service. The inbox could not load.";
}

/**
 * How many messages each account contributes to what is currently loaded.
 * Feeds the shell's sidebar account list. Derived from the pages already
 * fetched rather than from a new endpoint — `src/api.ts` is plumbing this
 * task does not change, and "how many of the loaded messages are yours" is
 * a claim the loaded messages can actually support.
 *
 * Sorted by id so the sidebar does not reorder itself as pages arrive.
 */
function summarizeAccounts(messages: readonly InboxMessage[]): readonly AccountSummary[] {
  const counts = new Map<string, number>();
  for (const message of messages) {
    counts.set(message.account_id, (counts.get(message.account_id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export interface InboxListProps {
  /** Which mail to show. Owned by App.tsx, because the shell's sidebar
   *  and this list are two views of the SAME selection and neither can
   *  own state the other renders from. Destructured to primitives below
   *  so the fetch effect depends on the two VALUES rather than on this
   *  object's identity. */
  readonly filter: InboxFilter;
  /** Reports the accounts present in the loaded pages up to the shell.
   *  Must be referentially stable (the caller wraps it in `useCallback`),
   *  because it is an effect dependency. */
  readonly onAccountsChange?: (accounts: readonly AccountSummary[]) => void;
  /** Reports the currently loaded message rows up to App.tsx (task V3),
   *  the SAME shape and SAME "current filter's pages" scope as
   *  `onAccountsChange` above — App.tsx folds what it receives into
   *  `messageIndex.ts`'s registry, which is what lets a Recent-opens
   *  click (Ask 2) resolve a message this list loaded for an unrelated
   *  reason, in an earlier folder, possibly after this component has
   *  since unmounted. Optional and referentially-stable for the same
   *  reason `onAccountsChange` is: it is an effect dependency. */
  readonly onMessagesChange?: (messages: readonly InboxMessage[]) => void;
  /** Opens one row in the reader. Required, not optional: as of Plan 6
   *  a row IS a control, and a list rendered with nowhere for it to go
   *  is exactly the defect that task exists to fix. Handed straight to
   *  MessageRow. */
  readonly onOpenMessage: (message: InboxMessage) => void;
  /**
   * The DEBOUNCED, clamped search query, or `''` for "not searching".
   *
   * Owned by App.tsx alongside folder and account, and a peer of them
   * rather than a mode: a search is the same list with one more filter
   * on it, drawn by the same rows, grouped by the same days and paged by
   * the same cursor. That is true on the wire too — sync/src/api/search.ts
   * is /api/inbox with one extra WHERE clause — which is why this
   * component gained a branch rather than a sibling.
   */
  readonly search: string;
  /** Clears the search from inside the results banner. The other two ways
   *  out (the field's own ✕, and Esc) live in components/SearchBar.tsx;
   *  this is the one that is visible from where the results are. */
  readonly onClearSearch: () => void;
}

/**
 * The home view: the chronological, account-merged mail list. Fetches its
 * own first page on mount AND whenever the selection changes, groups it by
 * local calendar day (newest first), and loads more pages by passing the
 * previous page's `nextCursor` straight back to `getInbox` — never a
 * `before` string reconstructed from the last row, which is lossy across a
 * shared timestamp.
 *
 * As of Plan 5 Task 3 it renders whichever `filter` App.tsx hands down —
 * one of five folders, merged across accounts or narrowed to one. The
 * folder and the account are ORTHOGONAL: `{folder:'sent',
 * account:'harvard'}` is an ordinary combination, and changing either one
 * refetches from page 1 without disturbing the other.
 *
 * States: a shaped Skeleton list while the first page is in flight (never a
 * spinner), Plunk's `EmptyState` molecule when the service answered with
 * zero messages, an in-place `Alert` with a retry Button on a fetch failure
 * (never a modal, never a banner that pushes content and disappears), and
 * otherwise the grouped list plus a "Load more" control that hides itself
 * once `nextCursor` comes back null.
 *
 * Visual vocabulary ported from Plunk (AGPL-3.0): the
 * `rounded-lg border … divide-y divide-neutral-100` row list of
 * `apps/web/src/pages/contacts/index.tsx`, wrapped in the `Card` atom.
 */
export default function InboxList({
  filter,
  onAccountsChange,
  onMessagesChange,
  onOpenMessage,
  search,
  onClearSearch,
}: InboxListProps) {
  const { folder, account } = filter;
  const isSearching = search !== '';
  const [messages, setMessages] = useState<readonly InboxMessage[]>([]);
  const [cursor, setCursor] = useState<InboxCursor | null>(null);
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  /**
   * Folders that have produced at least one message in this session — the
   * client's only available answer to TRAP 3 (see ../emptyState.ts).
   *
   * GET /api/inbox returns `200 []` for a Sent/Spam/Trash whose IMAP
   * special-use folder the sync loop has not discovered yet, which is
   * byte-identical to a genuinely empty one. Having SEEN a row here is
   * proof the folder synced; having seen none proves nothing either way,
   * and the copy is written to be honest about exactly that much.
   *
   * Keyed by folder, not by folder+account: one account's Trash yielding
   * rows is proof the sync loop reaches Trash, which is the claim the
   * copy actually makes.
   */
  const [syncedFolders, setSyncedFolders] = useState<readonly FolderId[]>([]);
  // Resolved once per mount/retry, not per render: every row in one list
  // agrees on what "today" means, and a page that stays open for hours
  // does not silently relabel a message from "Today" to "Yesterday" out
  // from under the reader mid-scroll.
  const [now] = useState(() => new Date());
  /**
   * Bumped once per {folder, account} selection — the fetch effect below
   * does it on every run, including the initial mount. `loadMore` reads
   * this synchronously right before it fetches, and again inside its
   * `.then`/`.catch`: if the two reads disagree, the selection moved on
   * while the request was in flight, and the page must be discarded (see
   * ./inboxPaging's `resolveLoadMorePage`).
   *
   * A `ref`, not state: this is read inside async callbacks where a
   * captured state value would just be a stale closure — the whole point
   * is to see the CURRENT selection, not the one active when `loadMore`
   * was called — and bumping it must not itself cause a render (the
   * effect's own `setLoad`/`setCursor`/etc. already do that).
   *
   * This is the same discipline the fetch effect's local `cancelled` flag
   * already uses, generalized: `loadMore` is a `useCallback` outside that
   * effect, so it cannot close over its local flag and needs a
   * ref-held equivalent instead.
   */
  const selectionRef = useRef(0);

  // Refetches whenever the selection changes, and only then: `folder` and
  // `account` are primitives, so a re-render that hands down an
  // equivalent-but-new `filter` object does not refetch.
  //
  // Deliberately does NOT clear `messages` up front. The skeleton below
  // already hides the list while `status === 'loading'`, so stale rows are
  // never visible — but they keep feeding the sidebar's account counts,
  // which would otherwise blink to zero on every folder switch.
  useEffect(() => {
    let cancelled = false;
    // A new selection supersedes any `loadMore` still in flight for the
    // previous one — bumped BEFORE the request below goes out, so even a
    // resolution that lands on the very next tick already sees a
    // mismatch. `isLoadingMore` is reset here too: it is the OLD
    // selection's "Load more" button state, and without this it would
    // stay stuck at "Loading…" on the new selection until the stale
    // request settles — resolveLoadMorePage discards that settlement's
    // page, but discarding also means it correctly skips the
    // `setIsLoadingMore(false)` that would otherwise have cleared it.
    selectionRef.current += 1;
    setLoad({ status: 'loading' });
    setLoadMoreError(null);
    setIsLoadingMore(false);

    fetchPage(search, { limit: PAGE_SIZE, folder, account }).then(
      (page) => {
        if (cancelled) return;
        setMessages(page.messages);
        setCursor(page.nextCursor);
        if (page.messages.length > 0) {
          setSyncedFolders((previous) =>
            previous.includes(folder) ? previous : [...previous, folder],
          );
        }
        setLoad({ status: 'ready' });
      },
      (error: unknown) => {
        if (cancelled) return;
        console.error('InboxList: initial inbox fetch failed', error);
        setLoad({ status: 'error', message: messageFor(error) });
      },
    );

    return () => {
      cancelled = true;
    };
    // `search` is a dependency for the same reason `folder` and `account`
    // are: it selects which mail the list shows. Including it here is
    // also what makes a query change bump `selectionRef` below, so a
    // `loadMore` still in flight for the PREVIOUS query is discarded by
    // the machinery that already existed rather than by a second one.
  }, [folder, account, search, attempt]);

  const accounts = useMemo(() => summarizeAccounts(messages), [messages]);

  useEffect(() => {
    onAccountsChange?.(accounts);
  }, [accounts, onAccountsChange]);

  useEffect(() => {
    onMessagesChange?.(messages);
  }, [messages, onMessagesChange]);

  const loadMore = useCallback(() => {
    if (isLoadingMore || cursor === null) return;
    // Captured now, before the request goes out, so the resolution below
    // can tell whether the selection it was issued for is still current.
    // See `selectionRef` above and ./inboxPaging's `resolveLoadMorePage`.
    const selectionId = selectionRef.current;
    setIsLoadingMore(true);
    setLoadMoreError(null);

    // TRAP 1. `cursor` came from a response and carries NO memory of the
    // folder or account that produced it — the server rebuilds it from the
    // last row alone (sync/src/api/inbox.ts's `nextCursorFrom`). Sending it
    // without `folder`/`account` pages into the default unfiltered inbox
    // with a perfectly ordinary 200, so page 2 of Sent would be page 2 of
    // Inbox and nothing would report it. They travel together here, and
    // `InboxRequest` is shaped so they cannot travel apart.
    fetchPage(search, { limit: PAGE_SIZE, folder, account, cursor }).then(
      (page) => {
        // TRAP 2. The user may have switched folder/account while this
        // request was in flight — the fetch effect above can cancel its
        // OWN stale requests via `cancelled`, but has no way to cancel a
        // promise this callback owns instead. Applying the page anyway
        // would splice the OLD selection's rows onto the NEW selection's
        // list, and the next `loadMore` click would page the wrong
        // folder/account again right after. `resolveLoadMorePage` discards
        // the page entirely once the selection has moved on; the loading
        // flag was already reset by the fetch effect in that case, so this
        // branch must not touch any state, including it.
        const resolution = resolveLoadMorePage(selectionId, selectionRef.current, page);
        if (resolution.kind === 'discard') return;
        // Functional update: a load-more that lands after a fast second
        // click (guarded above, but also after any future retry path)
        // must append to the latest list, not a stale closure over it.
        setMessages((previous) => [...previous, ...resolution.messages]);
        setCursor(resolution.cursor);
        setIsLoadingMore(false);
      },
      (error: unknown) => {
        // Same TRAP 2 discard, for the rejection path.
        if (!isCurrentSelection(selectionId, selectionRef.current)) return;
        console.error('InboxList: load-more fetch failed', error);
        setLoadMoreError(messageFor(error));
        setIsLoadingMore(false);
      },
    );
  }, [cursor, isLoadingMore, folder, account, search]);

  const retry = useCallback(() => setAttempt((previous) => previous + 1), []);
  // What the polite live region says. Derived, not stored: it has to
  // change whenever the result set does, and a state variable would be
  // one more thing that can disagree with what is on screen.
  //
  // NAMES THE QUERY AND THE SCOPE. "12 results" alone is useless to
  // someone who cannot see the field they typed into — the whole point of
  // announcing is to confirm WHAT was searched as much as how much came
  // back. `search` is user text and reaches the DOM only as a JSX text
  // child, which React escapes.
  const scopeLabel = headingFor(folder, account);
  const liveMessage = !isSearching
    ? ''
    : load.status === 'loading'
      ? `Searching ${scopeLabel} for ${search}`
      : load.status === 'error'
        ? `Search failed for ${search}`
        : `${messages.length}${cursor !== null ? '+' : ''} ${
            messages.length === 1 ? 'result' : 'results'
          } for ${search} in ${scopeLabel}`;

  /**
   * The "you are looking at search results" affordance, and the way back.
   *
   * ALWAYS RENDERED WHILE SEARCHING — including over the skeleton and
   * over the error state. A banner that vanished for the ~200ms the next
   * query is in flight would blink on every pause in typing, and worse,
   * the way out would disappear at exactly the moment a user who mistyped
   * wants it.
   *
   * The count is deliberately loose: `50+` rather than `50`, because
   * `nextCursor` is the only thing this client knows about how much more
   * there is, and reporting a page size as a total is the kind of precise
   * wrong number that reads as authoritative.
   */
  const banner = !isSearching ? null : (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="min-w-0 flex-1 text-sm text-neutral-700 dark:text-muted-foreground">
        <SearchX className="mr-1.5 inline h-4 w-4 align-[-3px] text-neutral-400 dark:text-muted-foreground" aria-hidden="true" />
        Results for{' '}
        <span className="font-semibold text-neutral-900 dark:text-foreground">{search}</span> in{' '}
        {scopeLabel}
      </p>
      <Button variant="outline" size="sm" onClick={onClearSearch}>
        Clear search
      </Button>
    </div>
  );

  /**
   * The list's four states, as one function rather than four early
   * returns: the banner and the live region above have to survive all of
   * them, and four `return <>{banner}…</>` copies is exactly how two of
   * them would eventually drift.
   */
  function body() {
    // NOT animated, deliberately, and this is the one branch in the file
    // where the right answer is "no motion" (Plan 7 Task 2). The skeleton
    // is what tells the user their sidebar click — or their keystroke —
    // registered; anything that fades it in delays that acknowledgement
    // by exactly as long as the fade. It appears on the same frame as the
    // click, and the CONTENT that replaces it is what settles in.
    // Instant, then smooth — never the other way round.
    //
    // App.tsx no longer wraps this component in a keyed `<Settle>`, which
    // is what makes the sentence above true from EVERY origin rather than
    // only from a within-inbox click. See that file's view-swap comment.
    if (load.status === 'loading') {
      return (
        <Card className={LIST_SURFACE} aria-busy="true">
          <p className="sr-only" role="status">
            Loading messages…
          </p>
          <div className={LIST_DIVIDERS} aria-hidden="true">
            {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
              <div key={index} className="flex h-14 items-center gap-3 px-3 lg:h-11 lg:px-4">
                <Skeleton className="h-9 w-9 shrink-0 rounded-full lg:hidden" />
                <Skeleton className="hidden h-3 w-32 shrink-0 lg:block" />
                <Skeleton className="h-3 flex-1" />
                <Skeleton className="h-3 w-10 shrink-0" />
              </div>
            ))}
          </div>
        </Card>
      );
    }

    if (load.status === 'error') {
      return (
        <Settle>
          <Alert variant="destructive">
            <AlertDescription className="flex flex-wrap items-center gap-3">
              <span>{load.message}</span>
              <Button variant="outline" size="sm" onClick={retry}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        </Settle>
      );
    }

    if (messages.length === 0) {
      // Copy per folder AND per account, and honest in both directions —
      // never "Trash is empty" for a Trash that has never synced, never a
      // permanent "still syncing…" for one that has. While a search is
      // running the same two causes reappear in a different costume ("no
      // matches" vs "nothing here to match against yet") and
      // `searchEmptyStateFor` tells them apart with the same
      // `everSynced` proxy. ../emptyState.ts owns every string.
      const everSynced = syncedFolders.includes(folder);
      const copy = isSearching
        ? searchEmptyStateFor(search, { folder, everSynced })
        : emptyStateFor(folder, account, { everSynced });
      return (
        <Settle>
          <Card className={LIST_SURFACE}>
            <EmptyState
              icon={isSearching ? SearchX : FOLDER_ICONS[folder]}
              title={copy.title}
              description={copy.description}
            />
          </Card>
        </Settle>
      );
    }

    const groups = groupByDay(messages, now);

    return (
      /*
       * PLAN 7 TASK 2 — the mail settling into place.
       *
       * NO `key`, ON PURPOSE. This branch is only reachable from
       * `status: 'loading'` or `'error'`, both of which render something
       * else entirely, so React mounts this wrapper fresh every time a
       * selection resolves and the entrance replays without being told to.
       * Keying it on `{folder, account}` instead would fire one extra time
       * per folder click — on the render where the folder has changed but
       * the fetch effect has not yet run, i.e. against the OLD list — and
       * animate content that is about to be replaced by the skeleton.
       *
       * THE STAGGER IS PER DAY GROUP, NEVER PER ROW. A page is 50 messages;
       * at any per-row delay worth seeing that is seconds of animation and
       * 50 simultaneously-compositing layers, on the one surface in this app
       * that must never feel slow. Day groups number two to six, so the
       * cascade is legible, costs under 200ms end to end, and composites a
       * handful of layers. `settleGroupVariantsFor` drops the stagger
       * entirely past its cap rather than compressing it — see
       * src/motion/tokens.ts's MAX_STAGGERED_GROUPS — and contributes no
       * transform of its own, so a group travels LIFT_PX rather than twice
       * it (src/motion/variants.ts).
       *
       * "Load more" appends pages WITHOUT re-keying this wrapper, so
       * already-visible groups never re-animate; a genuinely new day group
       * mounts under an already-`visible` parent and inherits the entrance,
       * which is the behaviour we want for free.
       */
      <Settle className="space-y-6" groupCount={groups.length}>
        {groups.map((group) => (
          // A plain grouping div, not a landmark <section> — the <h2> below
          // already gives it heading structure, and a labelled <section> per
          // day would register one ARIA "region" landmark per group,
          // cluttering landmark navigation for no benefit. `SettleGroup`
          // renders exactly that div, plus the variant wiring that makes it
          // one step of the cascade.
          <SettleGroup key={group.day}>
            {/* `px-3 lg:px-4` puts the day label on the same vertical
                line as the text of the rows beneath it at BOTH
                breakpoints — it used to sit at `px-1`, hanging twelve
                pixels to the left of every sender name in the card below
                it. One alignment line down the column. */}
            <h2 className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-muted-foreground lg:px-4">
              {group.day}
            </h2>
            <Card className={LIST_SURFACE}>
              <ul className={LIST_DIVIDERS}>
                {group.messages.map((message) => (
                  <MessageRow
                    key={messageKey(message)}
                    message={message}
                    now={now}
                    onOpen={onOpenMessage}
                  />
                ))}
              </ul>
            </Card>
          </SettleGroup>
        ))}

        {cursor !== null && (
          <div className="space-y-3">
            <Button variant="outline" className="w-full" onClick={loadMore} disabled={isLoadingMore}>
              {isLoadingMore ? 'Loading…' : 'Load more'}
            </Button>
            {loadMoreError !== null && (
              <Alert variant="destructive">
                <AlertDescription>{loadMoreError}</AlertDescription>
              </Alert>
            )}
          </div>
        )}
      </Settle>
    );
  }

  return (
    <>
      {/* PERMANENTLY MOUNTED, not conditional on `isSearching`. A live
          region announces CHANGES to its own contents, so one that mounts
          at the same moment it gains text is a region assistive tech was
          not watching when the text arrived — the first search of a
          session, which is the one that most needs announcing, would be
          silent. Empty while nothing is being searched. */}
      <p className="sr-only" role="status" aria-live="polite">
        {liveMessage}
      </p>
      {banner}
      {body()}
    </>
  );
}

/** One page of whatever the list is currently showing: the unfiltered
 *  folder, or a search within it.
 *
 *  Both answer the SAME `InboxPage` shape, which is not a coincidence to
 *  rely on quietly — sync/src/api/search.ts reuses /api/inbox's own
 *  `getUnifiedInbox`, `nextCursorFrom` and folder resolution, so the two
 *  routes order and paginate identically by construction. That is what
 *  lets one component render, group and page both. */
function fetchPage(
  search: string,
  request: {
    readonly limit: number;
    readonly folder: FolderId;
    readonly account: string | null;
    readonly cursor?: InboxCursor | null;
  },
): Promise<InboxPage> {
  if (search === '') return getInbox(request);
  return getSearch({ ...request, q: search });
}
