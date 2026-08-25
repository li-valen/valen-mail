import type { InboxCursor, InboxPage } from '../api';

/**
 * Pure decision logic for `InboxList.tsx`'s `loadMore`, split out for the
 * same reason `inboxDates.ts` is: this file never imports React, which is
 * what makes it testable under client/CLAUDE.md's standing constraint that
 * no test in this codebase renders a component.
 *
 * This does NOT cover the whole fix. `InboxList.tsx` still owns a
 * `useRef` counter (`selectionRef`) that is bumped once per {folder,
 * account} selection and read at both `loadMore`'s call time and its
 * resolution time — that wiring is component state and lifecycle, and is
 * not extracted here. What IS extracted, and IS the part worth pinning
 * with a test, is the decision every resolution must make once it has
 * both ids in hand: apply the page, or discard it entirely.
 */

/** Opaque id for "which {folder, account} selection was active when a
 *  `loadMore` request was issued." Just `InboxList.tsx`'s `selectionRef`
 *  counter — not a folder/account pair, because the counter is what lets a
 *  resolution compare itself against the CURRENT selection without racing
 *  a second read of `folder`/`account` state. */
export type SelectionId = number;

export type LoadMoreResolution =
  | { readonly kind: 'discard' }
  | { readonly kind: 'append'; readonly messages: InboxPage['messages']; readonly cursor: InboxCursor | null };

/**
 * Whether a resolved (or rejected) `loadMore` request still belongs to the
 * selection currently on screen.
 *
 * `requestedFor` is the `SelectionId` captured synchronously inside
 * `loadMore`, before the request went out; `currentSelection` is
 * `selectionRef.current` read again at resolution time, after whatever
 * `await` gap the request took. If the user has since switched folder or
 * account, `InboxList.tsx`'s selection-change effect has already bumped
 * the ref, so the two no longer match — this is the same race the
 * initial-fetch effect's local `cancelled` flag guards against, checked
 * here with a ref instead because `loadMore` is a `useCallback`, not part
 * of that effect, and cannot close over its local flag.
 */
export function isCurrentSelection(requestedFor: SelectionId, currentSelection: SelectionId): boolean {
  return requestedFor === currentSelection;
}

/**
 * Decides what a resolved `loadMore` page should do to list state. Returns
 * `{ kind: 'discard' }` for a page whose selection has been superseded —
 * the caller must then leave messages, cursor, AND the loading flag
 * completely untouched, not just skip the message append. Applying only
 * part of a stale page (e.g. still clearing the loading flag) is exactly
 * the bug this guards: it would leave the NEW selection's "Load more"
 * button reading its OLD state.
 *
 * Returns `{ kind: 'append', ... }` otherwise, carrying the page's
 * messages and cursor for the caller to fold in. Deliberately does NOT
 * take the previous message list and merge it here: `InboxList.tsx` must
 * still apply the append inside `setMessages`'s functional-update form to
 * avoid closing over a stale `messages` value (see that file's own comment
 * on the second-click race this predates).
 */
export function resolveLoadMorePage(
  requestedFor: SelectionId,
  currentSelection: SelectionId,
  page: InboxPage,
): LoadMoreResolution {
  if (!isCurrentSelection(requestedFor, currentSelection)) return { kind: 'discard' };
  return { kind: 'append', messages: page.messages, cursor: page.nextCursor };
}
