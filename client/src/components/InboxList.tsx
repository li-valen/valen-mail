import { useCallback, useEffect, useMemo, useState } from 'react';
import { Inbox as InboxIcon } from 'lucide-react';
import { ApiError, getInbox } from '../api';
import type { InboxCursor, InboxMessage } from '../api';
import type { AccountSummary } from '../AppShell';
import { Alert, AlertDescription } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import MessageRow from './MessageRow';
import { groupByDay } from './inboxDates';

// Re-exported so `InboxList.tsx` stays the one public entry point for both
// the component and the pure logic it renders with — tests import
// `formatWhen`/`groupByDay` from here, per task-4-brief.md's interface.
export { formatWhen, groupByDay } from './inboxDates';
export type { DayGroup } from './inboxDates';

/** Matches the empty-state copy's own claim ("the newest 50 messages per
 *  account") — the same number used for every page, not just the first. */
const PAGE_SIZE = 50;
const SKELETON_ROW_COUNT = 6;

/** Real copy, not a generic "no results" line. It is honest about a real
 *  limitation: today the sync service only ever backfills the newest 50
 *  messages per account, so a truly new mailbox looking "empty" here is
 *  expected, not a bug. */
const EMPTY_COPY = 'Nothing yet — the server syncs the newest 50 messages per account';

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
  /** Reports the accounts present in the loaded pages up to the shell.
   *  Must be referentially stable (the caller wraps it in `useCallback`),
   *  because it is an effect dependency. */
  readonly onAccountsChange?: (accounts: readonly AccountSummary[]) => void;
}

/**
 * The home view: the chronological, four-account-merged inbox. Fetches its
 * own first page on mount, groups it by local calendar day (newest first),
 * and loads more pages by passing the previous page's `nextCursor` straight
 * back to `getInbox` — never a `before` string reconstructed from the last
 * row, which is lossy across a shared timestamp.
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
export default function InboxList({ onAccountsChange }: InboxListProps) {
  const [messages, setMessages] = useState<readonly InboxMessage[]>([]);
  const [cursor, setCursor] = useState<InboxCursor | null>(null);
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Resolved once per mount/retry, not per render: every row in one list
  // agrees on what "today" means, and a page that stays open for hours
  // does not silently relabel a message from "Today" to "Yesterday" out
  // from under the reader mid-scroll.
  const [now] = useState(() => new Date());

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: 'loading' });

    getInbox(PAGE_SIZE, null).then(
      (page) => {
        if (cancelled) return;
        setMessages(page.messages);
        setCursor(page.nextCursor);
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
  }, [attempt]);

  const accounts = useMemo(() => summarizeAccounts(messages), [messages]);

  useEffect(() => {
    onAccountsChange?.(accounts);
  }, [accounts, onAccountsChange]);

  const loadMore = useCallback(() => {
    if (isLoadingMore || cursor === null) return;
    setIsLoadingMore(true);
    setLoadMoreError(null);

    getInbox(PAGE_SIZE, cursor).then(
      (page) => {
        // Functional update: a load-more that lands after a fast second
        // click (guarded above, but also after any future retry path)
        // must append to the latest list, not a stale closure over it.
        setMessages((previous) => [...previous, ...page.messages]);
        setCursor(page.nextCursor);
        setIsLoadingMore(false);
      },
      (error: unknown) => {
        console.error('InboxList: load-more fetch failed', error);
        setLoadMoreError(messageFor(error));
        setIsLoadingMore(false);
      },
    );
  }, [cursor, isLoadingMore]);

  const retry = useCallback(() => setAttempt((previous) => previous + 1), []);

  if (load.status === 'loading') {
    return (
      <Card aria-busy="true">
        <p className="sr-only" role="status">
          Loading messages…
        </p>
        <div className="divide-y divide-neutral-100" aria-hidden="true">
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
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>{load.message}</span>
          <Button variant="outline" size="sm" onClick={retry}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (messages.length === 0) {
    return (
      <Card>
        <EmptyState icon={InboxIcon} title="Inbox is empty" description={EMPTY_COPY} />
      </Card>
    );
  }

  const groups = groupByDay(messages, now);

  return (
    <div className="space-y-6">
      {groups.map((group) => (
        // A plain grouping div, not a landmark <section> — the <h2> below
        // already gives it heading structure, and a labelled <section> per
        // day would register one ARIA "region" landmark per group,
        // cluttering landmark navigation for no benefit.
        <div key={group.day}>
          <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-neutral-500">
            {group.day}
          </h2>
          <Card>
            <ul className="divide-y divide-neutral-100">
              {group.messages.map((message) => (
                <MessageRow key={`${message.account_id}:${message.uid}`} message={message} now={now} />
              ))}
            </ul>
          </Card>
        </div>
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
    </div>
  );
}
