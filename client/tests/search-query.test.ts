import { describe, it, expect } from 'vitest';
import {
  MAX_QUERY_LENGTH,
  SEARCH_DEBOUNCE_MS,
  buildSearchParams,
  clampSearchQuery,
  isSearchHotkey,
} from '../src/searchQuery';
import { buildInboxParams } from '../src/inboxFilters';
import type { InboxCursor } from '../src/api';

/**
 * Plan 7 Task 3. `buildSearchParams` is to GET /api/search what
 * `buildInboxParams` is to GET /api/inbox — the ONE place a {query,
 * folder, account, cursor} selection becomes a query string — and it is a
 * SEPARATE function rather than a flag on the other one because the two
 * routes disagree about exactly one default, in the direction that fails
 * silently.
 *
 * The four traps asserted below:
 *
 *  - TRAP A (this route's own, and the reason this file exists) — an
 *    ABSENT `folder` means EVERY folder to /api/search and means INBOX to
 *    /api/inbox (sync/src/api/search.ts's `resolveSearchFolder` against
 *    sync/src/api/inbox.ts's `parseFolderParam`). `buildInboxParams`
 *    omits `folder=inbox` precisely because it is redundant there;
 *    copying that habit here would turn "search Inbox" into "search the
 *    whole mailbox" with a 200 and no complaint.
 *  - TRAP B — `?account=` (empty string) is a 400 on BOTH routes.
 *  - TRAP C — `nextCursor` carries no filter identity on either route, so
 *    a paged search must re-send q + folder + account with it.
 *  - TRAP D — `q` over MAX_QUERY_LENGTH is a 400, NOT a truncation
 *    (sync/src/api/search.ts's `parseQueryParam` refuses the raw value
 *    before trimming). The clamp therefore has to happen here, on the way
 *    out, or a user pasting a long line gets an error instead of a
 *    search.
 */
describe('buildSearchParams', () => {
  it('sends the query it was given', () => {
    expect(buildSearchParams({ q: 'invoice' })).toBe('q=invoice&folder=inbox');
  });

  it('percent-encodes a query rather than shipping raw delimiters', () => {
    // A `&` in the box must not become a second parameter, and `%` must
    // not become a broken escape. URLSearchParams owns this; asserted so
    // a future hand-rolled concatenation cannot pass.
    expect(buildSearchParams({ q: 'a&b=c' })).toBe('q=a%26b%3Dc&folder=inbox');
    expect(buildSearchParams({ q: '100% off' })).toBe('q=100%25+off&folder=inbox');
  });

  // TRAP A — the one difference from buildInboxParams, in both directions.
  it('ALWAYS sends folder, including the inbox — absent means "every folder" here', () => {
    expect(buildSearchParams({ q: 'x', folder: 'inbox' })).toBe('q=x&folder=inbox');
    expect(buildSearchParams({ q: 'x', folder: 'sent' })).toBe('q=x&folder=sent');
    expect(buildSearchParams({ q: 'x' })).toContain('folder=inbox');
  });

  it('differs from buildInboxParams on exactly that default, which is the point', () => {
    // Stated as a comparison so the divergence is a documented assertion
    // rather than an accident someone later "fixes".
    expect(buildInboxParams({ folder: 'inbox' })).toBe('');
    expect(buildSearchParams({ q: 'x', folder: 'inbox' })).toContain('folder=inbox');
  });

  // TRAP B — the `params.set('account', selected ?? '')` idiom, again.
  it('OMITS account entirely for null and for the empty string', () => {
    expect(buildSearchParams({ q: 'x', account: null })).toBe('q=x&folder=inbox');
    expect(buildSearchParams({ q: 'x', account: '' })).toBe('q=x&folder=inbox');
  });

  it('sends account when one is selected, alongside the folder', () => {
    expect(buildSearchParams({ q: 'x', folder: 'sent', account: 'harvard' })).toBe(
      'q=x&folder=sent&account=harvard',
    );
  });

  it('sends limit when given and omits it when not', () => {
    expect(buildSearchParams({ q: 'x', limit: 50 })).toBe('q=x&limit=50&folder=inbox');
    expect(buildSearchParams({ q: 'x' })).not.toContain('limit');
  });

  // TRAP C.
  it('carries folder and account alongside a cursor, never the cursor alone', () => {
    const cursor: InboxCursor = {
      before: '2026-08-20T10:00:00.000Z',
      beforeAccount: 'harvard',
      beforeUid: '42',
    };
    const params = buildSearchParams({ q: 'grant', folder: 'sent', account: 'harvard', cursor });
    expect(params).toContain('q=grant');
    expect(params).toContain('folder=sent');
    expect(params).toContain('account=harvard');
    expect(params).toContain('before=2026-08-20T10%3A00%3A00.000Z');
    expect(params).toContain('beforeAccount=harvard');
    expect(params).toContain('beforeUid=42');
  });

  it('forwards a NULL-date-tail cursor exactly as received (no `before`)', () => {
    // Rows with no Date header sort last and are reachable only by a
    // cursor with `before: null`. Reconstructing one from a row is
    // impossible, so the field has to survive the round trip untouched.
    const cursor: InboxCursor = { before: null, beforeAccount: 'primary', beforeUid: '7' };
    const params = buildSearchParams({ q: 'x', cursor });
    expect(params).not.toContain('before=');
    expect(params).toContain('beforeAccount=primary');
    expect(params).toContain('beforeUid=7');
  });

  // TRAP D.
  it(`clamps q to ${MAX_QUERY_LENGTH} characters rather than letting the server 400`, () => {
    const long = 'x'.repeat(MAX_QUERY_LENGTH + 40);
    const params = new URLSearchParams(buildSearchParams({ q: long }));
    expect(params.get('q')).toHaveLength(MAX_QUERY_LENGTH);
  });

  it('clamps on the RAW length, the same value the server measures', () => {
    // sync/src/api/search.ts checks `raw.length > MAX_QUERY_LENGTH`
    // BEFORE trimming, so a value that is only short after trimming is
    // still a 400. Clamping first and trimming second is what matches.
    const padded = `${' '.repeat(60)}${'y'.repeat(MAX_QUERY_LENGTH)}`;
    const params = new URLSearchParams(buildSearchParams({ q: padded }));
    expect((params.get('q') ?? '').length).toBeLessThanOrEqual(MAX_QUERY_LENGTH);
  });

  it('agrees with the server on the cap', () => {
    expect(MAX_QUERY_LENGTH).toBe(200);
  });
});

/**
 * The client-side half of `parseQueryParam`: what counts as a query worth
 * sending at all. A whitespace-only box is a 400 on the wire, so it never
 * leaves here — the caller reads `''` and shows the unfiltered list.
 */
describe('clampSearchQuery', () => {
  it('trims surrounding whitespace', () => {
    expect(clampSearchQuery('  invoice  ')).toBe('invoice');
  });

  it('answers the empty string for a blank or whitespace-only box', () => {
    expect(clampSearchQuery('')).toBe('');
    expect(clampSearchQuery('   ')).toBe('');
    expect(clampSearchQuery('\n\t ')).toBe('');
  });

  it('never exceeds the cap, whitespace included in the measurement', () => {
    expect(clampSearchQuery('z'.repeat(500))).toHaveLength(MAX_QUERY_LENGTH);
    expect(clampSearchQuery(`${'  '}${'z'.repeat(500)}`).length).toBeLessThanOrEqual(
      MAX_QUERY_LENGTH,
    );
  });

  it('leaves interior whitespace alone — a two-word search is two words', () => {
    expect(clampSearchQuery('  section change  ')).toBe('section change');
  });
});

/**
 * ⌘K / Ctrl-K, as a pure predicate over the three fields that decide it.
 *
 * WHY ONLY THE MODIFIED FORM. A bare-key shortcut ('/' or 'k') is the one
 * that steals typing from a focused composer body, and this app has a
 * composer. Requiring Meta or Control means the chord is unreachable by
 * accident while typing prose, so the handler needs no "is the user in a
 * text field?" special case — which is the check that always eventually
 * misses a case (contenteditable, a shadow root, a native date picker).
 *
 * Esc is deliberately NOT here: it is bound on the input itself, never on
 * the window. Compose.tsx already owns window-level Esc, and a second
 * global listener would close the composer AND clear the search from one
 * press.
 */
describe('isSearchHotkey', () => {
  it('fires on Meta+K (macOS) and Control+K (elsewhere)', () => {
    expect(isSearchHotkey({ key: 'k', metaKey: true, ctrlKey: false, altKey: false })).toBe(true);
    expect(isSearchHotkey({ key: 'k', metaKey: false, ctrlKey: true, altKey: false })).toBe(true);
  });

  it('accepts the capital the platform reports when Shift is down or CapsLock is on', () => {
    expect(isSearchHotkey({ key: 'K', metaKey: true, ctrlKey: false, altKey: false })).toBe(true);
  });

  it('ignores a bare k — the keystroke a user typing a message presses', () => {
    expect(isSearchHotkey({ key: 'k', metaKey: false, ctrlKey: false, altKey: false })).toBe(false);
  });

  it('ignores Alt/Option chords, which belong to the platform', () => {
    expect(isSearchHotkey({ key: 'k', metaKey: true, ctrlKey: false, altKey: true })).toBe(false);
  });

  it('ignores every other key, modified or not', () => {
    expect(isSearchHotkey({ key: 'j', metaKey: true, ctrlKey: false, altKey: false })).toBe(false);
    expect(isSearchHotkey({ key: 'Escape', metaKey: false, ctrlKey: false, altKey: false })).toBe(
      false,
    );
  });
});

describe('SEARCH_DEBOUNCE_MS', () => {
  /**
   * 220ms. Long enough that a five-letter word issues ONE request rather
   * than five (median inter-keystroke interval while touch-typing is
   * ~150–200ms, so 220 lands in the pause between words rather than
   * between letters); short enough that the result is on screen well
   * inside the ~400ms at which a wait becomes something the user notices
   * they are doing.
   *
   * Pinned rather than merely commented so "just make it snappier" cannot
   * quietly become one request per keystroke against four real mailboxes.
   */
  it('sits in the one-request-per-pause band', () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(220);
    expect(SEARCH_DEBOUNCE_MS).toBeGreaterThanOrEqual(150);
    expect(SEARCH_DEBOUNCE_MS).toBeLessThanOrEqual(300);
  });
});
