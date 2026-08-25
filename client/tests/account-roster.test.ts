import { describe, it, expect } from 'vitest';
import { foldAccountRoster, totalOf } from '../src/accountRoster';
import type { AccountSummary } from '../src/accountRoster';

/**
 * Plan 5 Task 3. The sidebar's account switcher is fed by the SAME loaded
 * pages the list renders (InboxList's `summarizeAccounts`) — there is no
 * roster endpoint, and adding one is out of this task's scope.
 *
 * That creates one problem worth a pure helper: the moment a user filters
 * to `harvard`, every loaded message is harvard's, so a switcher built
 * straight from the current page would drop every OTHER account row —
 * removing the very controls needed to switch back. Same for a folder
 * that is empty in this view.
 *
 * `foldAccountRoster` is the fix, with exactly one rule so it can never
 * quietly lie: the ROSTER only grows within a session, while every COUNT
 * always describes what is loaded right now.
 */
const KNOWN: readonly AccountSummary[] = [
  { id: 'harvard', count: 30 },
  { id: 'personal', count: 20 },
];

describe('foldAccountRoster', () => {
  it('is just the observed accounts when nothing is known yet', () => {
    expect(foldAccountRoster([], [{ id: 'harvard', count: 3 }])).toEqual([{ id: 'harvard', count: 3 }]);
  });

  it('keeps every known account visible when the view narrows to one of them', () => {
    const folded = foldAccountRoster(KNOWN, [{ id: 'harvard', count: 7 }]);
    expect(folded.map((account) => account.id)).toEqual(['harvard', 'personal']);
  });

  it('reports the CURRENT view count, never a stale one, for accounts still present', () => {
    expect(foldAccountRoster(KNOWN, [{ id: 'harvard', count: 7 }])[0]).toEqual({
      id: 'harvard',
      count: 7,
    });
  });

  it('reports 0 — the true count of what is loaded — for an account absent from the view', () => {
    const folded = foldAccountRoster(KNOWN, [{ id: 'harvard', count: 7 }]);
    expect(folded.find((account) => account.id === 'personal')).toEqual({ id: 'personal', count: 0 });
  });

  it('keeps the roster when a folder loads completely empty (an unsynced Trash)', () => {
    expect(foldAccountRoster(KNOWN, [])).toEqual([
      { id: 'harvard', count: 0 },
      { id: 'personal', count: 0 },
    ]);
  });

  it('adds an account first seen in a later page or folder', () => {
    const folded = foldAccountRoster(KNOWN, [{ id: 'work', count: 2 }]);
    expect(folded.map((account) => account.id)).toEqual(['harvard', 'personal', 'work']);
  });

  it('sorts by id so the sidebar never reorders itself as pages arrive', () => {
    const folded = foldAccountRoster([{ id: 'zeta', count: 1 }], [{ id: 'alpha', count: 1 }]);
    expect(folded.map((account) => account.id)).toEqual(['alpha', 'zeta']);
  });

  it('does not mutate either input', () => {
    const known = [{ id: 'harvard', count: 30 }];
    const observed = [{ id: 'personal', count: 4 }];
    foldAccountRoster(known, observed);
    expect(known).toEqual([{ id: 'harvard', count: 30 }]);
    expect(observed).toEqual([{ id: 'personal', count: 4 }]);
  });

  it('is idempotent — folding the same observation twice changes nothing', () => {
    const once = foldAccountRoster(KNOWN, [{ id: 'harvard', count: 7 }]);
    expect(foldAccountRoster(once, [{ id: 'harvard', count: 7 }])).toEqual(once);
  });
});

describe('totalOf', () => {
  it('sums the loaded counts for the All-accounts row', () => {
    expect(totalOf(KNOWN)).toBe(50);
  });

  it('is 0 for an empty roster', () => {
    expect(totalOf([])).toBe(0);
  });
});
