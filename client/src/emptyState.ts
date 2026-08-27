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
 * the settled version never claims more than "nothing in what Valen Mail
 * keeps".
 */

export interface EmptyStateCopy {
  readonly title: string;
  readonly description: string;
}

/** The one claim the settled copy is allowed to make. Valen Mail keeps the
 *  newest 50 messages per account per folder, so "empty" here always
 *  means "empty within what was synced" — never "empty on the server". */
const KEEP_CLAIM = 'Valen Mail keeps the newest 50 messages per account for this folder.';

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
      `Valen Mail finds each account's ${label} folder on its first sync cycle. ` +
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
    description: 'Valen Mail is still making its first pass over this mailbox. Messages appear here as it goes.',
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

/**
 * The other emptiness: a SEARCH that returned nothing.
 *
 * Lives beside `emptyStateFor` rather than in its own file because it is
 * the same problem with the same shape, and the two must not drift in
 * voice: a zero-result search has the same two indistinguishable causes a
 * zero-row folder does, and `everSynced` is the same session-scoped proxy
 * for telling them apart.
 *
 *  - The folder has produced mail and none of it matched. That is a fact
 *    about the QUERY, and the only case where "No matches for grant" is a
 *    true sentence.
 *  - The folder has never produced a row this session, so there was
 *    nothing to match against. That is a fact about POSTBOX. Saying "no
 *    matches" here sends the user away believing their mail does not
 *    contain a word it certainly does — the most expensive wrong answer
 *    a search box can give, because it ends the search.
 *
 * THE THIRD OBLIGATION, particular to this feature. The server searches
 * `subject`, `from_name`, `from_email` and `snippet` — but snippets exist
 * only on mail synced since Plan 7 Task 1, and every row already in the
 * database has `snippet: null` permanently (backfill was out of scope).
 * A phrase from the BODY of older mail therefore cannot match, however
 * certainly it is there. The settled copy is exactly where a user would
 * otherwise conclude "it isn't in my mail", so that is where the limit is
 * stated.
 */

export interface SearchEmptyStateOptions {
  readonly folder: FolderId;
  /** Same meaning as `EmptyStateOptions.everSynced`: this folder has
   *  produced at least one message in this session. */
  readonly everSynced: boolean;
}

/**
 * Title and description for a search that came back with zero rows.
 *
 * `query` is echoed verbatim into both fields. It is user-controlled text
 * and it leaves here as a PLAIN STRING, so the only thing the caller can
 * do with it is interpolate it as a JSX text child, which React escapes.
 * Nothing here builds markup and nothing downstream is given the chance
 * to (tests/search-empty-state.test.ts holds that).
 */
export function searchEmptyStateFor(
  query: string,
  { folder, everSynced }: SearchEmptyStateOptions,
): EmptyStateCopy {
  const label = FOLDER_LABELS[folder];

  if (!everSynced) {
    return {
      title: `Nothing in ${label} to search yet`,
      description:
        `${label} has not produced a message in Valen Mail this session, so there is nothing ` +
        `for "${query}" to match against yet — this is not the same as finding nothing. ` +
        `Clear the search once ${label} has filled in, and try again.`,
    };
  }

  return {
    title: `No matches for "${query}" in ${label}`,
    description:
      `Valen Mail searched senders, subjects and previews in ${label}. Previews exist only on ` +
      'recently synced mail, so a phrase from an older message\u2019s body will not match. ' +
      'Clear the search to go back to the full list.',
  };
}
