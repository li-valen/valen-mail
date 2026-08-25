import type { InboxMessage } from './api';
import { messageKey } from './components/messageBody';

/**
 * The registry `resolveOpenTarget` (components/openEvents.ts) searches
 * to turn an open event's `messageId` into a message the reader can open
 * (task V3, Ask 2) — accumulated from whatever GET /api/inbox pages
 * InboxList.tsx has ACTUALLY fetched this session, across every folder
 * and account the user has visited. No new endpoint: the task brief is
 * explicit that a lookup route is a different, backend lane, so this is
 * built entirely out of data already on the wire for another reason.
 *
 * FOLDS rather than replaces, for the identical reason accountRoster.ts
 * does (see that file's own header — this is the same fix, one domain
 * over). InboxList reports whichever folder/account is CURRENTLY
 * selected, and it fully UNMOUNTS — destroying its own `messages` state
 * — the moment App.tsx's view leaves `'inbox'` for `'opens'`, which is
 * exactly the surface (the Opens page) where a user browsing a longer
 * history is most likely to click a row. A plain "replace on every
 * report" would mean an open only resolves while InboxList happens to be
 * showing the one folder — almost always Sent, since that is where a
 * tracked send's own copy lives (see openEvents.ts's `resolveOpenTarget`
 * doc comment) — and forgets it the instant the user looks anywhere
 * else, including the Opens page itself. Folding means: once a message
 * has been loaded ONCE this session, in ANY folder, it stays resolvable
 * for the rest of the session, even after the component that loaded it
 * has unmounted.
 *
 * Deduplicated by `messageKey` (`account_id:uid` — true row identity),
 * deliberately NOT by `message_id`: two DIFFERENT rows can legitimately
 * carry the SAME RFC Message-ID (the same send synced into two of the
 * user's own accounts; Gmail's per-label UIDs putting one message under
 * both `inbox` and `starred`), and `resolveOpenTarget` needs every one of
 * those candidates present to disambiguate correctly — collapsing them
 * here would silently make that disambiguation impossible instead of
 * merely rare.
 *
 * Pure and non-mutating — same contract as `foldAccountRoster`: both
 * inputs are only read, a new array comes back, and folding the same
 * observation twice is a no-op (idempotent), which matters because React
 * may call this from a render pass that changed nothing.
 */
export function foldMessageIndex(
  known: readonly InboxMessage[],
  observed: readonly InboxMessage[],
): readonly InboxMessage[] {
  const byKey = new Map<string, InboxMessage>(known.map((message) => [messageKey(message), message]));
  for (const message of observed) {
    byKey.set(messageKey(message), message);
  }
  return [...byKey.values()];
}
