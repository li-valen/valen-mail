/**
 * Which rows in a polled feed are GENUINELY new, and which have simply
 * been re-delivered by the next response.
 *
 * THE DEFECT THIS EXISTS TO PREVENT. The opens feed refetches on a timer
 * (src/useOpensFeed.ts). Every response produces a brand-new array of
 * brand-new objects, so "animate rows in" applied naively re-animates the
 * entire list on every tick — a feed that twitches every 30 seconds while
 * the user is reading something else. Keying on array INDEX makes it
 * worse in a way that looks like it works: prepend one event and every
 * index shifts, so every row is "new" forever.
 *
 * The fix is identity, held across renders. `scanNewEntries` is the pure
 * half of it: given the keys seen so far and the keys on screen now, it
 * answers which are new and what the next "seen" set should be. The
 * React half — a ref, and an effect that advances it — lives at the call
 * site (src/components/OpensFeed.tsx), because a ref is not something a
 * pure function can own.
 *
 * FIRST SCAN ANIMATES NOTHING. `seen === null` means this feed has never
 * rendered a loaded response: everything on screen is the initial load,
 * fifty rows of it, and animating fifty rows in one at a time is the
 * exact opposite of what "only new rows animate" is asking for. The first
 * scan therefore records every key and reports none as new; the panel as
 * a whole gets one settle instead. Only the SECOND response onward can
 * produce a new row.
 *
 * SEEN GROWS, NEVER REPLACES. A response is capped at fifty events, so an
 * older event can fall out of the window and reappear later (a shorter
 * response, a different classification mix). Replacing the set each tick
 * would make that reappearance "new" and animate a row the user has
 * already seen. The set is therefore a union, bounded in practice by how
 * many distinct events one session observes — strings, in the hundreds at
 * worst.
 */

export interface NewEntryScan {
  /** What `seen` should become before the next scan. A superset of the
   *  `seen` handed in — see the file header on why it never shrinks. */
  readonly seen: ReadonlySet<string>;
  /** The subset of `keys` that had never been seen before, and only
   *  those. Empty on the very first scan, by design. */
  readonly newKeys: ReadonlySet<string>;
}

/**
 * @param seen  every key recorded by previous scans, or `null` if this
 *              feed has not scanned yet (the first-load case above).
 * @param keys  the keys currently on screen, in render order.
 */
export function scanNewEntries(seen: ReadonlySet<string> | null, keys: readonly string[]): NewEntryScan {
  if (seen === null) return { seen: new Set(keys), newKeys: new Set() };

  const newKeys = new Set<string>();
  for (const key of keys) {
    if (!seen.has(key)) newKeys.add(key);
  }

  // Nothing new: hand the SAME set back rather than a copy, so a call
  // site memoising on the scan's identity is not re-run by a poll that
  // changed nothing.
  if (newKeys.size === 0) return { seen, newKeys };

  return { seen: new Set([...seen, ...newKeys]), newKeys };
}
