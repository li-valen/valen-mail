import { useCallback, useEffect, useState } from 'react';
import { ApiError, getInbox } from '../api';
import type { InboxCursor, InboxMessage } from '../api';
import MessageRow from './MessageRow';
import { groupByDay } from './inboxDates';
import './InboxList.css';

// Re-exported so `InboxList.tsx` stays the one public entry point for both
// the component and the pure logic it renders with — tests import
// `formatWhen`/`groupByDay` from here, per task-4-brief.md's interface.
export { formatWhen, groupByDay } from './inboxDates';
export type { DayGroup } from './inboxDates';

/** Matches the empty-state copy's own claim ("the newest 50 messages per
 *  account") — the same number used for every page, not just the first. */
const PAGE_SIZE = 50;
const SKELETON_ROW_COUNT = 6;

/** Real copy, not a generic "no results" line — client/DESIGN.md has no
 *  empty-state text for a totally empty inbox (its §7.2 copy is for the
 *  *rail*, and its inbox-empty variant is for a filter matching nothing,
 *  which does not apply here since accounts are never filtered). This
 *  string is task-4-brief.md's own instruction, verbatim, including that
 *  it is honest about a real limitation: today the sync service only ever
 *  backfills the newest 50 messages per account, so a truly new mailbox
 *  looking "empty" here is expected, not a bug. */
const EMPTY_COPY = 'Nothing yet — the server syncs the newest 50 messages per account';

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready' }
  | { readonly status: 'error'; readonly message: string };

/** Same shape of message as App.tsx's SessionError and LoginView's
 *  messageFor — names the problem, not a stack trace, and never repeats a
 *  credential-bearing value (there is none in this path, but the pattern
 *  is kept consistent with the rest of the client). */
function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return `The sync service answered ${error.status}. The inbox could not load.`;
  }
  return "Postbox can't reach the sync service. The inbox could not load.";
}

/**
 * The home view (client/DESIGN.md §6, component #5): the chronological,
 * four-account-merged inbox. Fetches its own first page on mount, groups
 * it by local calendar day (newest first), and loads more pages by
 * passing the previous page's `nextCursor` straight back to `getInbox`
 * (task-4-brief.md Amendment 1) — never a `before` string reconstructed
 * from the last row, which is lossy across a shared timestamp.
 *
 * States, per DESIGN.md's component inventory (#5: default / loading /
 * empty / error): a shaped skeleton while the first page is in flight
 * (§7.1 — never a spinner), the exact empty copy above when the service
 * answered with zero messages, an in-place retry line on a fetch failure
 * (§7.4 — never a modal, never a banner that pushes content and
 * disappears), and otherwise the grouped list plus a "Load more" control
 * that hides itself once `nextCursor` comes back null.
 */
export default function InboxList() {
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
      <div className="inbox-list" aria-busy="true">
        <p className="visually-hidden" role="status">
          Loading messages…
        </p>
        {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
          <div key={index} className="inbox-list__skeleton-row" aria-hidden="true" />
        ))}
      </div>
    );
  }

  if (load.status === 'error') {
    return (
      <p className="inbox-list__error" role="alert">
        {load.message}{' '}
        <button type="button" className="inbox-list__retry" onClick={retry}>
          Try again
        </button>
      </p>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="inbox-list__empty">
        <p className="inbox-list__empty-copy prose">{EMPTY_COPY}</p>
      </div>
    );
  }

  const groups = groupByDay(messages, now);

  return (
    <div className="inbox-list">
      {groups.map((group) => (
        // A plain grouping div, not a landmark <section> — the <h2> below
        // already gives it heading structure (screen-reader "jump by
        // heading" navigation), and a labelled <section> per day would
        // register one ARIA "region" landmark per group, cluttering
        // landmark navigation for no benefit over the heading it would
        // duplicate.
        <div className="inbox-list__day" key={group.day}>
          <h2 className="day-rule__label">{group.day}</h2>
          <ul className="inbox-list__rows">
            {group.messages.map((message) => (
              <MessageRow key={`${message.account_id}:${message.uid}`} message={message} now={now} />
            ))}
          </ul>
        </div>
      ))}

      {cursor !== null && (
        <div className="inbox-list__load-more">
          <button
            type="button"
            className="inbox-list__load-more-button"
            onClick={loadMore}
            disabled={isLoadingMore}
          >
            {isLoadingMore ? 'Loading…' : 'Load more'}
          </button>
          {loadMoreError !== null && (
            <p className="inbox-list__error" role="alert">
              {loadMoreError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
