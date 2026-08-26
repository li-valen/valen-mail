import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CloudOff, Inbox, Send } from 'lucide-react';

import { ApiError, getFollowup } from '../api';
import type { FollowupRow as FollowupRowData, InboxCursor, InboxMessage } from '../api';
import { SCOPE_LABELS, emptyStateFor, filterRows, toReaderMessage } from '../followupCopy';
import type { FollowupScope } from '../followupCopy';
import { Alert, AlertDescription } from '../ui/Alert';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { cn } from '../ui/cn';
import { Settle } from '../motion';
import FollowupRow from './FollowupRow';
import { LIST_DIVIDERS, LIST_SURFACE } from './listSurface';

/**
 * Spec §7A's two missing views, as one page with a two-value scope.
 *
 * "Opened, no reply" — which the spec calls "the highest-signal follow-up
 * queue in the product, and the reason this client exists" — is the
 * DEFAULT. "Sent & waiting" is the same list with the predicate lifted,
 * still ranked by engagement rather than by date. They are not two
 * components and not two endpoints: one query answers both, and
 * `filterRows` (../followupCopy.ts) is the entire difference.
 *
 * WHY THE RANKING HAPPENS HERE AND THE PAGING HAPPENS ON THE SERVER.
 * A page has to be addressable by a stable key to be paginated at all,
 * and an engagement state is not stable — it changes the moment someone
 * opens the mail, which would shuffle rows between pages. So the server
 * returns the most recent sends under the inbox's own keyset cursor and
 * this view ranks what it was given. Loading more appends and re-ranks
 * the whole list, so a repeat-opened message three pages down still
 * climbs to the top once it is loaded.
 *
 * EVERY DISPLAY DECISION IS SOMEWHERE ELSE. The words, the ranking, the
 * filter, the empty states and the hand-off to the reader are all pure
 * functions in ../followupCopy.ts — client/CLAUDE.md's standing
 * constraint is that no test renders a component, so a rule that lives in
 * this file is a rule nothing can assert. What is left here is fetching,
 * state and layout.
 *
 * Visual vocabulary matches ./InboxList.tsx exactly (`LIST_SURFACE`,
 * `LIST_DIVIDERS`, the skeleton's shape, the error `Alert` with a retry,
 * the "Load more" control that hides itself when the cursor comes back
 * null) — this is a second list in the same product, not a second design.
 */

const PAGE_SIZE = 50;
const SKELETON_ROW_COUNT = 6;

const SCOPES: readonly FollowupScope[] = ['queue', 'all'];

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready' }
  | { readonly status: 'error'; readonly message: string };

/** Names the problem, never a stack trace and never a credential-bearing
 *  value — the same shape ./InboxList.tsx's own `messageFor` produces. */
function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return `The sync service answered ${error.status}. Sent mail could not load.`;
  }
  return "Postbox can't reach the sync service. Sent mail could not load.";
}

export interface FollowupViewProps {
  /** `null` = every account's sent mail merged. Owned by App.tsx, which
   *  is also where the sidebar's account switcher lives — the two are
   *  views of one selection. */
  readonly account: string | null;
  /** Opens one row in the reader. The row is widened into the reader's
   *  own `InboxMessage` shape by `toReaderMessage` — see that function
   *  for exactly which fields are real and which are empty. */
  readonly onOpenMessage: (message: InboxMessage) => void;
}

export default function FollowupView({ account, onOpenMessage }: FollowupViewProps) {
  const [scope, setScope] = useState<FollowupScope>('queue');
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [rows, setRows] = useState<readonly FollowupRowData[]>([]);
  const [cursor, setCursor] = useState<InboxCursor | null>(null);
  const [opensAvailable, setOpensAvailable] = useState(true);
  const [isLoadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Resolved once per mount, for the same reason ./InboxList.tsx and
  // ../useOpensFeed.ts resolve theirs once: relative times must not creep
  // forward while the tab sits open in the background for hours.
  const [now] = useState(() => Date.now());

  /** Supersedes a `loadMore` still in flight for a previous selection —
   *  the same discipline ./InboxList.tsx's `selectionRef` applies, and for
   *  the same reason: `loadMore` is a callback outside the fetch effect
   *  and cannot close over that effect's own `cancelled` flag. */
  const selectionRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    selectionRef.current += 1;
    const selection = selectionRef.current;

    setLoad({ status: 'loading' });
    setLoadMoreError(null);

    getFollowup({ limit: PAGE_SIZE, account })
      .then((page) => {
        if (cancelled || selection !== selectionRef.current) return;
        setRows(page.rows);
        setCursor(page.nextCursor);
        setOpensAvailable(page.opensAvailable);
        setLoad({ status: 'ready' });
      })
      .catch((error: unknown) => {
        if (cancelled || selection !== selectionRef.current) return;
        setLoad({ status: 'error', message: messageFor(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [account, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  const loadMore = useCallback(() => {
    if (cursor === null) return;
    const selection = selectionRef.current;
    setLoadingMore(true);
    setLoadMoreError(null);

    getFollowup({ limit: PAGE_SIZE, account, cursor })
      .then((page) => {
        if (selection !== selectionRef.current) return;
        // APPENDED, never replaced: ranking runs over everything loaded so
        // far, so a strongly-engaged message on page three climbs past a
        // silent one from page one the moment it arrives.
        setRows((previous) => [...previous, ...page.rows]);
        setCursor(page.nextCursor);
        setOpensAvailable(page.opensAvailable);
      })
      .catch((error: unknown) => {
        if (selection !== selectionRef.current) return;
        setLoadMoreError(messageFor(error));
      })
      .finally(() => {
        if (selection === selectionRef.current) setLoadingMore(false);
      });
  }, [account, cursor]);

  const visible = useMemo(() => filterRows(rows, scope), [rows, scope]);

  const openRow = useCallback(
    (row: FollowupRowData) => onOpenMessage(toReaderMessage(row)),
    [onOpenMessage],
  );

  const scopeNav = (
    /* Two buttons rather than a `<select>` or a tab set: there are exactly
       two, both are always available, and `aria-pressed` says which one is
       on without inventing a tab panel relationship that does not exist
       (the list below is the same region either way). */
    <div className="flex flex-wrap items-center gap-2">
      {SCOPES.map((id) => {
        const isActive = id === scope;
        return (
          <button
            key={id}
            type="button"
            onClick={() => setScope(id)}
            aria-pressed={isActive}
            className={cn(
              'cursor-pointer touch-manipulation rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              isActive
                ? 'bg-neutral-100 text-neutral-900 dark:bg-accent dark:text-accent-foreground'
                : 'text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900 dark:text-muted-foreground dark:hover:bg-accent dark:hover:text-accent-foreground',
            )}
          >
            {SCOPE_LABELS[id]}
          </button>
        );
      })}
      {load.status === 'ready' && visible.length > 0 && (
        <Badge variant="neutral" className="ml-auto font-mono text-[10px] font-medium">
          {visible.length}
        </Badge>
      )}
    </div>
  );

  function body() {
    if (load.status === 'loading') {
      return (
        <Card className={LIST_SURFACE} aria-busy="true">
          <p className="sr-only" role="status">
            Loading sent mail…
          </p>
          <div className={LIST_DIVIDERS} aria-hidden="true">
            {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
              <div key={index} className="flex h-16 items-center gap-3 px-3 lg:h-11 lg:px-4">
                <Skeleton className="h-4 w-4 shrink-0 rounded-full" />
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

    if (visible.length === 0) {
      // Three different reasons the list can be empty, and they must not
      // collapse into one message: the tracking service could not be read,
      // nothing is waiting, or nothing has been sent. `emptyStateFor`
      // owns every string; this picks the icon that goes with it.
      const copy = emptyStateFor(scope, opensAvailable);
      const icon = !opensAvailable ? CloudOff : scope === 'queue' ? Inbox : Send;
      return (
        <Settle>
          <Card className={LIST_SURFACE}>
            <EmptyState icon={icon} title={copy.title} description={copy.description} />
          </Card>
        </Settle>
      );
    }

    return (
      <Settle>
        <Card className={LIST_SURFACE}>
          <ul className={LIST_DIVIDERS}>
            {visible.map((row) => (
              <FollowupRow
                key={`${row.accountId}:${row.folder}:${row.uid}`}
                row={row}
                now={now}
                onOpen={openRow}
              />
            ))}
          </ul>
        </Card>
      </Settle>
    );
  }

  return (
    <div className="space-y-4">
      {scopeNav}
      {body()}

      {/* OUTSIDE `body()`, and that placement is the point: "Load more"
          has to survive the EMPTY branch. The queue scope hides most of
          what a page contains, so a first page of fifty sends can
          legitimately contain nothing opened-and-unanswered while the
          next page does — and an empty state saying "nothing is waiting
          on you" with no way to look further would be a conclusion drawn
          from one page. Offering the control alongside it keeps the
          claim scoped to what has actually been loaded. */}
      {load.status === 'ready' && cursor !== null && (
        <div className="space-y-3">
          <Button variant="outline" className="w-full" onClick={loadMore} disabled={isLoadingMore}>
            {isLoadingMore ? 'Loading…' : 'Load more'}
          </Button>
          {/* `<Settle>`, matching InboxList's own load-more failure and
              every other banner in this app. It was the one that
              materialised between two frames, directly under the button
              the user had just pressed. */}
          {loadMoreError !== null && (
            <Settle>
              <Alert variant="destructive">
                <AlertDescription>{loadMoreError}</AlertDescription>
              </Alert>
            </Settle>
          )}
        </div>
      )}
    </div>
  );
}
