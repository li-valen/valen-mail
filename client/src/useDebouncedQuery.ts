import { useEffect, useState } from 'react';

import { SEARCH_DEBOUNCE_MS, clampSearchQuery } from './searchQuery';

/**
 * Turns what the user is typing into what the list should actually fetch.
 *
 * **STARTING A SEARCH WAITS; ENDING ONE DOES NOT.** A non-empty query is
 * held for `SEARCH_DEBOUNCE_MS` so a five-letter word costs one request
 * rather than five (see ./searchQuery.ts for why that number). An EMPTY
 * one is applied on the same tick, with no timer at all, because clearing
 * is the way back to the unfiltered list and a way back that takes a
 * fifth of a second to notice the ✕ was pressed feels broken in a way
 * that a fifth of a second before results appear does not. The asymmetry
 * is the whole reason this is a purpose-built hook rather than a generic
 * `useDebounce<T>`: the generic one has no idea which of its values means
 * "cancel".
 *
 * Clamping happens here rather than at the call site so the debounced
 * value is always something the server will accept — a whitespace-only
 * box collapses to `''` and reads as "not searching" instead of becoming
 * an ILIKE `%   %` that matches most of the mailbox.
 */
export function useDebouncedQuery(input: string): string {
  const [query, setQuery] = useState(() => clampSearchQuery(input));

  useEffect(() => {
    const next = clampSearchQuery(input);
    if (next === '') {
      // No timer, and no cleanup to schedule: React bails out of the
      // re-render when the value is already `''`, so this is idempotent
      // on every keystroke that leaves the box empty.
      setQuery('');
      return;
    }
    const timer = setTimeout(() => setQuery(next), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);

  return query;
}
