import { FOLDER_LABELS } from './inboxFilters';
import type { FolderId } from './inboxFilters';

/**
 * Empty-state copy per folder + account (Plan 5 Task 3).
 *
 * THE PROBLEM THIS FILE EXISTS FOR. On a cold start GET /api/inbox
 * answers `200 []` for sent/spam/trash — indistinguishable from a
 * genuinely empty folder — until each account's first sync cycle
 * discovers those folders by IMAP special-use. The server collapses the
 * two cases on purpose (sync/src/api/inbox.ts's `resolveFolderFilter`:
 * an undiscovered kind contributes no pair, and zero pairs match zero
 * rows), and there is no second field on the response that pulls them
 * apart. The client therefore CANNOT know which one it is looking at.
 *
 * So the copy is the entire defence, and it has to hold in both
 * directions:
 *
 *  - Before the folder has ever produced a row, saying "Trash is empty"
 *    is a confident lie that sends the user looking for a bug in their
 *    mail rather than waiting ~a sync cycle.
 *  - After it has, a permanent "still syncing…" hedge is the opposite
 *    lie, and a worse one — it never resolves, so the user learns to
 *    ignore it.
 *
 * `everSynced` is the caller's best honest signal: "this folder has
 * produced at least one message in this session" (components/InboxList.tsx
 * tracks it). It is a proxy, not a fact about the server, and the copy is
 * written so that being wrong about it is survivable in either direction:
 * the hedged version still says what a still-empty folder would mean, and
 * the settled version never claims more than "nothing in what Postbox
 * keeps".
 */

export interface EmptyStateCopy {
  readonly title: string;
  readonly description: string;
}

/** The one claim the settled copy is allowed to make. Postbox keeps the
 *  newest 50 messages per account per folder, so "empty" here always
 *  means "empty within what was synced" — never "empty on the server". */
const KEEP_CLAIM = 'Postbox keeps the newest 50 messages per account for this folder.';

/** The three folders the sync loop DISCOVERS by IMAP special-use rather
 *  than knows by name — the only ones trap 3 applies to. INBOX is a
 *  literal folder needing no discovery, and Starred is a virtual flag
 *  query that is never synced at all. */
type DiscoveredFolder = 'sent' | 'spam' | 'trash';

/**
 * The hedge for a folder the sync loop discovers rather than knows: it
 * names the real mechanism and, crucially, says what a STILL-empty folder
 * after that would mean — so the message is useful on first read and
 * self-cancelling on the second.
 */
function discoveryHedged(folder: DiscoveredFolder): EmptyStateCopy {
  const label = FOLDER_LABELS[folder];
  return {
    title: `No ${label} mail synced yet`,
    description:
      `Postbox finds each account's ${label} folder on its first sync cycle. ` +
      `If it is still empty after that, ${label} really is empty.`,
  };
}

/** Settled copy — the folder has produced rows, so its emptiness is real. */
const SETTLED: Readonly<Record<FolderId, EmptyStateCopy>> = {
  inbox: {
    title: 'Inbox is empty',
    description: `Nothing has arrived here. ${KEEP_CLAIM}`,
  },
  starred: {
    title: 'No starred messages',
    description: 'Star a message in any folder — Sent included — and it collects here.',
  },
  sent: {
    title: 'No sent mail',
    description: `Nothing you sent is here. ${KEEP_CLAIM}`,
  },
  spam: {
    title: 'No spam',
    description: `Nothing has been filed as spam. ${KEEP_CLAIM}`,
  },
  trash: {
    title: 'Trash is empty',
    description: `Nothing deleted is here. ${KEEP_CLAIM}`,
  },
};

/**
 * Hedged copy — this folder has never produced a row in this session, so
 * "empty" is unproven.
 *
 * Every title ends in "yet" (asserted in tests/empty-state.test.ts), which
 * is the single word carrying the distinction: "No Trash mail synced yet"
 * makes a claim about POSTBOX, "Trash is empty" makes one about the
 * MAILBOX, and only the first is something this client can actually know.
 *
 * `inbox` and `starred` get their own hedges rather than the discovery
 * one: INBOX is a literal folder that needs no discovery, and Starred is
 * a virtual flag query across folders that is never synced at all.
 */
const HEDGED: Readonly<Record<FolderId, EmptyStateCopy>> = {
  inbox: {
    title: 'No mail synced yet',
    description: 'Postbox is still making its first pass over this mailbox. Messages appear here as it goes.',
  },
  starred: {
    title: 'No flagged mail synced yet',
    description:
      'Starred gathers flagged mail from every synced folder, and nothing has finished syncing yet.',
  },
  sent: discoveryHedged('sent'),
  spam: discoveryHedged('spam'),
  trash: discoveryHedged('trash'),
};

/**
 * Names the account filter as a CAUSE of the emptiness and points at the
 * control that lifts it. An empty view whose emptiness the user created
 * two clicks ago still reads as "there is no mail" unless the copy says
 * otherwise, and the way out has to be named, not implied.
 */
function accountScope(account: string): string {
  return ` Only ${account} is showing — choose All accounts to widen this.`;
}

export interface EmptyStateOptions {
  /** True once this folder has produced at least one message in this
   *  session. See the file header: a proxy for "the sync loop has reached
   *  this folder", not a fact the server reports. */
  readonly everSynced: boolean;
}

/**
 * The title and description to render when a folder+account view loads
 * with zero messages.
 *
 * Account scoping is applied uniformly to both states: `title` gains
 * "for {account}" and `description` gains the way back out, so a filtered
 * empty view never reads as a claim about the whole mailbox.
 */
export function emptyStateFor(
  folder: FolderId,
  account: string | null,
  { everSynced }: EmptyStateOptions,
): EmptyStateCopy {
  const base = everSynced ? SETTLED[folder] : HEDGED[folder];
  if (account === null) return base;
  return {
    title: `${base.title} for ${account}`,
    description: `${base.description}${accountScope(account)}`,
  };
}
