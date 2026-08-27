import { describe, expect, it } from 'vitest';
import { isCurrentSelection, resolveLoadMorePage } from '../src/components/inboxPaging';
import type { InboxCursor, InboxMessage, InboxPage } from '../src/api';

/**
 * I3 fix (Valen Mail whole-branch review). `InboxList.tsx`'s `loadMore` can
 * resolve after the user has switched {folder, account}: without a guard,
 * the stale page gets appended to whatever list is now on screen (one
 * folder's rows spliced onto another's), and the stale request's
 * `setIsLoadingMore(false)` masks or corrupts the new selection's own
 * loading state.
 *
 * These two functions are the pure decision at the center of that fix —
 * "does this resolution still belong to the selection on screen" and
 * "what should applying it do." The `useRef` counter that produces the two
 * ids being compared, and the `useEffect`/`useCallback` wiring that reads
 * it, are component state and lifecycle and are NOT covered here — this
 * codebase's tests never render a component (client/CLAUDE.md's standing
 * constraint). See InboxList.tsx's `selectionRef` and `loadMore` for that
 * half, and the report for why it is not independently unit-testable.
 */

function buildMessage(uid: string): InboxMessage {
  return {
    account_id: 'primary',
    uid,
    message_id: null,
    thread_id: null,
    folder: 'INBOX',
    subject: null,
    from_name: null,
    from_email: null,
    to_emails: [],
    cc_emails: [],
    date: null,
    snippet: null,
    flags: [],
    labels: [],
    has_attach: false,
    size_bytes: null,
    attachments: [],
  };
}

const CURSOR: InboxCursor = { before: '2026-08-20T00:00:00Z', beforeAccount: 'primary', beforeUid: '9' };

function buildPage(overrides: Partial<InboxPage> = {}): InboxPage {
  return {
    messages: [buildMessage('10'), buildMessage('11')],
    nextCursor: CURSOR,
    ...overrides,
  };
}

describe('isCurrentSelection', () => {
  it('is true when the requested and current selection ids match', () => {
    expect(isCurrentSelection(3, 3)).toBe(true);
  });

  it('is false when the current selection has moved on from the requested one', () => {
    expect(isCurrentSelection(3, 4)).toBe(false);
  });

  // Pins strict equality, not e.g. an accidental `<=`: a counter that only
  // ever increases would make "current < requested" impossible in
  // practice, but the check itself must not silently tolerate it.
  it('is false when the current id is behind the requested one', () => {
    expect(isCurrentSelection(4, 3)).toBe(false);
  });
});

describe('resolveLoadMorePage', () => {
  it('applies the page — carrying its exact messages and cursor — when the selection is still current', () => {
    const page = buildPage();
    const result = resolveLoadMorePage(1, 1, page);
    expect(result).toEqual({ kind: 'append', messages: page.messages, cursor: page.nextCursor });
  });

  it('carries a null cursor through unchanged (last page)', () => {
    const page = buildPage({ nextCursor: null });
    const result = resolveLoadMorePage(1, 1, page);
    expect(result).toEqual({ kind: 'append', messages: page.messages, cursor: null });
  });

  // The core of the fix: once the user has switched folder/account, the
  // fetch effect has bumped `selectionRef` past the id `loadMore` captured
  // before it fetched. The page must be discarded ENTIRELY — not applied
  // with an empty message list, not applied with just the cursor — so the
  // caller has nothing to act on but a no-op.
  it('discards the page entirely once the selection has moved on', () => {
    const page = buildPage();
    const result = resolveLoadMorePage(1, 2, page);
    expect(result).toEqual({ kind: 'discard' });
  });

  it('still discards when the page would otherwise be a real, non-empty page — staleness overrides content', () => {
    const page = buildPage({ messages: [buildMessage('999')], nextCursor: CURSOR });
    const result = resolveLoadMorePage(5, 6, page);
    expect(result.kind).toBe('discard');
  });
});
