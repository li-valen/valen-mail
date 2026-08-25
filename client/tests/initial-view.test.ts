import { describe, it, expect } from 'vitest';
import { initialViewFromSearch } from '../src/initialView';

/**
 * Final fix wave, I1: the push deep link (`?rail=opens`,
 * sync/src/push/dispatch.ts's OPENS_URL) used to be inert — App.tsx
 * seeded `view` with the literal `'inbox'` regardless of the URL, so a
 * tap on "X opened your mail" landed on the Inbox anyway. Covered here in
 * isolation from App.tsx (client/CLAUDE.md's standing constraint: no test
 * in this codebase renders a component), against the pure function
 * App.tsx's lazy `useState` initializer now calls.
 */
describe('initialViewFromSearch', () => {
  it('defaults to inbox with no query string', () => {
    expect(initialViewFromSearch('')).toBe('inbox');
  });

  it('selects opens for the exact deep-link param dispatch.ts emits', () => {
    expect(initialViewFromSearch('?rail=opens')).toBe('opens');
  });

  // Guards bad values to inbox rather than rejecting a specific blocklist:
  // a typo, a stale link, or a future unrelated `rail` value must all land
  // somewhere real rather than on a view that does not exist.
  it('falls back to inbox for an unrecognised rail value', () => {
    expect(initialViewFromSearch('?rail=garbage')).toBe('inbox');
  });
});
