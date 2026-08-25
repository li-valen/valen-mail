import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, getInbox } from '../api';
import type { InboxCursor, InboxMessage } from '../api';
import type { AccountSummary } from '../accountRoster';
import { emptyStateFor } from '../emptyState';
import { FOLDER_ICONS } from '../folderIcons';
import type { FolderId, InboxFilter } from '../inboxFilters';
import { Alert, AlertDescription } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { Settle, SettleGroup } from '../motion';
import MessageRow from './MessageRow';
import { groupByDay } from './inboxDates';
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
}: InboxListProps) {
  const { folder, account } = filter;
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

    getInbox({ limit: PAGE_SIZE, folder, account }).then(
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
  }, [folder, account, attempt]);

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
    getInbox({ limit: PAGE_SIZE, folder, account, cursor }).then(
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
  }, [cursor, isLoadingMore, folder, account]);

  const retry = useCallback(() => setAttempt((previous) => previous + 1), []);

  // NOT animated, deliberately, and this is the one branch in the file
  // where the right answer is "no motion" (Plan 7 Task 2). The skeleton
  // is what tells the user their sidebar click registered; anything that
  // fades it in delays that acknowledgement by exactly as long as the
  // fade. It appears on the same frame as the click, and the CONTENT that
  // replaces it is what settles in. Instant, then smooth — never the
  // other way round.
  if (load.status === 'loading') {
    return (
      <Card aria-busy="true">
        <p className="sr-only" role="status">
          Loading messages…
        </p>
        <div className="divide-y divide-neutral-100 dark:divide-border" aria-hidden="true">
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
    // permanent "still syncing…" for one that has. ../emptyState.ts owns
    // every string and the reasoning behind it.
    const copy = emptyStateFor(folder, account, { everSynced: syncedFolders.includes(folder) });
    return (
      <Settle>
        <Card>
          <EmptyState icon={FOLDER_ICONS[folder]} title={copy.title} description={copy.description} />
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
     * src/motion/tokens.ts's MAX_STAGGERED_GROUPS.
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
          <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-muted-foreground">
            {group.day}
          </h2>
          <Card>
            <ul className="divide-y divide-neutral-100 dark:divide-border">
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
