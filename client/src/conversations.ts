import type { InboxMessage } from './api';
import { messageKey } from './components/messageBody';
import { rowLayoutFor } from './components/messageRowLayout';

/**
 * WHAT A CONVERSATION IS, AND WHAT ONE ROW SAYS ABOUT IT — as pure data
 * and injected predicates, with no React anywhere near it.
 *
 * client/CLAUDE.md's standing constraint is that no test in this project
 * renders a component, so a decision made inside a row's JSX is a
 * decision no test can reach. Every decision this feature makes therefore
 * lives here: which messages are one conversation, which of them the row
 * stands for, what the row says when the senders differ, and when the
 * conversation counts as unread, starred or selectable. The component
 * renders what this returns and decides nothing.
 *
 * ---------------------------------------------------------------------
 * THE KEY IS `(account_id, thread_id)`, AND THAT IS THE SINGLE MOST
 * IMPORTANT LINE IN THIS FILE.
 * ---------------------------------------------------------------------
 * `thread_id` is Gmail's X-GM-THRID, a decimal counter allocated PER
 * MAILBOX. Two of this user's four accounts routinely hold the same
 * thread id for two entirely unrelated conversations. Keyed on
 * `thread_id` alone, a Harvard advising thread and a personal one collapse
 * into a single row — and then archiving that row archives mail from an
 * account the user was not even looking at, silently, in one click. Every
 * key this module builds carries the account, and
 * sync/src/db.ts's `conversationKey` carries it in SQL for the same
 * reason.
 *
 * A message with NO `thread_id` is a conversation of ONE, never a member
 * of a shared null bucket. The `t`/`u` prefixes keep real thread ids and
 * synthesised per-message ones in disjoint spaces, so no collision
 * between them is possible.
 *
 * ---------------------------------------------------------------------
 * ORDER IS THE SERVER'S, MEMBERSHIP IS THE SERVER'S, EVERYTHING ELSE IS
 * HERE.
 * ---------------------------------------------------------------------
 * `groupIntoConversations` groups by FIRST APPEARANCE and does not sort
 * conversations. That is not laziness: GET /api/conversations answers
 * newest-first (sync/src/db.ts's INBOX_ORDER), so the first row of a
 * conversation IS its newest message, and first-appearance order is
 * already conversation-by-recency order. Re-sorting here would mean
 * carrying a second copy of a comparator that has to agree with Postgres
 * exactly — including that a NULL date sorts LAST rather than first, the
 * bug schema.sql's keyset index exists to document — and a copy that
 * drifts renders a list that looks unsorted for reasons nobody can see.
 *
 * The REPRESENTATIVE is a different matter and is decided here, by an
 * explicit maximum over the members rather than by taking position zero,
 * so it is a rule a test can hold rather than a coincidence of arrival
 * order.
 */

/** The middle-elision mark in a participants label. A single character
 *  rather than three dots so it costs one glyph of a 160px column. */
const PARTICIPANT_ELLIPSIS = '…';

/**
 * How many participants a row names in full before it elides the middle.
 *
 * TWO. The desktop sender column is 160px; three short first names plus
 * their separators already crowd it and four truncate to something that
 * ends mid-word. Who STARTED a conversation and who spoke LAST are the
 * two facts that let a user recognise it in a list — everyone in between
 * is what the count beside the names is for.
 */
const NAMES_BEFORE_ELISION = 2;

export interface Conversation {
  /**
   * The REPRESENTATIVE'S `messageKey`, not the conversation key.
   *
   * Deliberate, and load-bearing in three places: it is the row's React
   * key, the keyboard cursor's key (src/keyboard/selection.ts), and the
   * `data-message-key` App.tsx queries to restore focus when the reader
   * closes. All three are already message keys, and a conversation whose
   * newest message changes really has become a different row.
   */
  readonly key: string;
  /** The row's message: the newest member. See `newestFirst`. */
  readonly representative: InboxMessage;
  /** Every loaded member, newest first. Within the current filter — see
   *  the route's own doc comment: the inbox view's conversation is the
   *  thread's INBOX messages, and a search's is its matching ones. */
  readonly messages: readonly InboxMessage[];
  /** `messages.length`, named because it is what the row prints and what
   *  a bulk action acts on. The two are the same number BY
   *  CONSTRUCTION — there is no truncated member list anywhere, so the
   *  badge can never promise more than an archive would take. */
  readonly count: number;
}

/**
 * A NUL rather than `:` between the account and the thread.
 *
 * Account ids are free-form config values, so an account literally named
 * `a:t1` would key identically to account `a`, thread `t1`. A NUL can
 * appear in neither an account id (config.ts requires a non-empty string,
 * and these are `primary`/`harvard`/…) nor a Gmail thread id (decimal
 * digits), so the two spaces cannot meet.
 */
const KEY_SEPARATOR = '\u0000';

/** The conversation a message belongs to — see this file's header for why
 *  the account is half of it. */
export function conversationKeyFor(message: InboxMessage): string {
  const thread =
    message.thread_id === null || message.thread_id === ''
      ? `u${message.uid}`
      : `t${message.thread_id}`;
  return `${message.account_id}${KEY_SEPARATOR}${thread}`;
}

/**
 * A message's place in the total order GET /api/inbox and
 * GET /api/conversations both sort by, as a comparable pair.
 *
 * `date` is nullable, and a NULL sorts LAST — matching Postgres's
 * `coalesce(date, '-infinity')`, which is there because a bare `order by
 * date desc` puts NULLs FIRST and pinned every unparseable-Date message
 * above all real mail (schema.sql, messages_unified_keyset).
 *
 * `uid` is a bigint on the wire and therefore a STRING, so it is compared
 * numerically rather than lexicographically ("9" > "10" as text). Safe:
 * IMAP uids are uint32 by RFC 3501, so `Number` is lossless — the same
 * reasoning sync/src/db.ts applies at its own bigint boundaries.
 *
 * `account_id` is NOT part of this, because everything that uses it
 * compares messages WITHIN one conversation, where the account is
 * constant by construction (see `conversationKeyFor`).
 */
function sortKeyOf(message: InboxMessage): readonly [number, number] {
  const parsed = message.date === null ? Number.NaN : new Date(message.date).getTime();
  return [Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed, Number(message.uid)];
}

/**
 * The members of one conversation, newest first — and therefore the
 * decision about which one the row stands for, since the representative
 * is the first element.
 *
 * **THE NEWEST, NOT THE OLDEST, AND NOT THE ONE THAT ARRIVED FIRST IN
 * THE ARRAY.** The list is ordered by recency, so a row that showed its
 * conversation's OLDEST message would carry a timestamp that disagrees
 * with the row's own position — the list would read as unsorted — and it
 * would show a subject and preview from before everything that has
 * happened since. Gmail shows the newest for the same reason.
 *
 * Never mutates its input: `[...messages]` before the sort, because the
 * caller's array is the loaded page and a list sorted in place under
 * React is a list React cannot tell has changed.
 */
export function newestFirst(messages: readonly InboxMessage[]): readonly InboxMessage[] {
  return [...messages].sort((a, b) => {
    const [aDate, aUid] = sortKeyOf(a);
    const [bDate, bUid] = sortKeyOf(b);
    if (aDate !== bDate) return bDate - aDate;
    return bUid - aUid;
  });
}

/**
 * Collapses a loaded list into conversations, in the order the list gave
 * them.
 *
 * Total by construction: an empty list produces no conversations, and
 * every input message ends up in exactly one — nothing is dropped, so
 * `conversations.reduce((n, c) => n + c.count, 0)` always equals
 * `messages.length`. That is what makes "the badge says what an archive
 * takes" a property rather than an intention.
 */
export function groupIntoConversations(
  messages: readonly InboxMessage[],
): readonly Conversation[] {
  const order: string[] = [];
  const buckets = new Map<string, InboxMessage[]>();

  for (const message of messages) {
    const key = conversationKeyFor(message);
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      order.push(key);
      buckets.set(key, [message]);
    } else {
      bucket.push(message);
    }
  }

  return order.map((key) => {
    const members = newestFirst(buckets.get(key)!);
    // Non-null by construction: a key is only in `order` because a
    // message created its bucket.
    const representative = members[0]!;
    return {
      key: messageKey(representative),
      representative,
      messages: members,
      count: members.length,
    };
  });
}

/** Every member's `messageKey` — what a bulk action ticks, hides and
 *  moves. In list order, so a partially-failed batch fails in a pattern
 *  the user can read down their own screen (../bulkSelection.ts). */
export function conversationMessageKeys(conversation: Conversation): readonly string[] {
  return conversation.messages.map(messageKey);
}

/**
 * **ONE UNREAD MESSAGE AMONG TWELVE READ ONES MAKES THE CONVERSATION
 * UNREAD.** Anything else hides new mail behind a row that looks dealt
 * with, which is the whole failure collapsing a list can introduce.
 *
 * The predicate is INJECTED rather than `isUnread` being called here,
 * because the honest answer depends on state this module must not know
 * about: App.tsx's optimistic `seenOverrides` (see
 * ./components/messageFlags.ts's `resolveUnread`, and note that an absent
 * override falls back to `flags` rather than to "read"). The caller
 * passes a resolver that already accounts for them; this file owns only
 * the word "some".
 *
 * The real case, from this mailbox: the 40-message `masterman` thread has
 * its two newest messages unread and thirty-eight read.
 */
export function isConversationUnread(
  conversation: Conversation,
  isUnreadOf: (message: InboxMessage) => boolean,
): boolean {
  return conversation.messages.some(isUnreadOf);
}

/** The same "any of them" rule for `\Flagged`, and Gmail's: a thread with
 *  one starred message shows a star. */
export function isConversationStarred(
  conversation: Conversation,
  isStarredOf: (message: InboxMessage) => boolean,
): boolean {
  return conversation.messages.some(isStarredOf);
}

/** …and for the paperclip. A conversation whose fourth message carried
 *  the attachment still has one; reading it off the representative alone
 *  would hide it the moment anyone replied. */
export function conversationHasAttachment(conversation: Conversation): boolean {
  return conversation.messages.some((message) => message.has_attach);
}

/**
 * **EVERY member must be actionable, not just the representative.**
 *
 * `every`, deliberately, and it is the difference between an honest
 * control and a silently partial one. The Starred view is a flag query
 * across folders (../mailboxActions.ts's `canMoveFrom`), so one
 * conversation there can hold an INBOX message and a Sent one; ticking it
 * on the strength of the representative alone would arm an "Archive" that
 * moves some of what the row stands for and quietly refuses the rest.
 * Offering nothing is the answer this codebase already gives everywhere
 * an action is not available where it was attempted.
 */
export function isConversationSelectable(
  conversation: Conversation,
  canSelectOne: (message: InboxMessage) => boolean,
): boolean {
  return conversation.messages.every(canSelectOne);
}

/** One sender's display text — the SAME resolution one row already uses,
 *  imported rather than restated so a single-participant conversation is
 *  byte-identical to the ungrouped row it replaces. */
function displayNameOf(message: InboxMessage): string {
  return rowLayoutFor(message).sender;
}

/**
 * Who a participant IS, for de-duplication.
 *
 * The ADDRESS where there is one, so the same person counts once across
 * the display-name changes a long thread accumulates ("Ann" on Monday,
 * "Ann Lei" on Friday, "Ann Lei (Google Docs)" from a share
 * notification). Falls back to the display text, lower-cased, when a
 * message carries no address at all.
 */
function identityOf(message: InboxMessage): string {
  const address = message.from_email;
  if (address !== null && address.trim().length > 0) return address.trim().toLowerCase();
  return displayNameOf(message).toLowerCase();
}

/**
 * Everyone who has spoken in this conversation, OLDEST FIRST, de-duped.
 *
 * Two passes rather than one, and each direction earns its keep:
 *
 *  - ORDER comes from the oldest end, because that is how a conversation
 *    reads — who started it, then who joined — and it is what Gmail
 *    shows.
 *  - the NAME comes from the newest message that person sent, because a
 *    display name that changed mid-thread should render as whatever they
 *    call themselves NOW. It also makes the single-participant case
 *    exactly `rowLayoutFor(representative).sender`, i.e. byte-identical
 *    to the row this replaces.
 */
export function participantsOf(conversation: Conversation): readonly string[] {
  const names = new Map<string, string>();
  for (const message of conversation.messages) {
    const identity = identityOf(message);
    if (!names.has(identity)) names.set(identity, displayNameOf(message));
  }

  const seen = new Set<string>();
  const ordered: string[] = [];
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const identity = identityOf(conversation.messages[index]!);
    if (seen.has(identity)) continue;
    seen.add(identity);
    ordered.push(names.get(identity)!);
  }
  return ordered;
}

/**
 * A participant's short form: the first word of their display name, or
 * the local part of a bare address.
 *
 * ONLY EVER USED WHERE THERE IS MORE THAN ONE PARTICIPANT. A conversation
 * with one sender prints their full name, because that is what the
 * ungrouped row prints and this feature is additive — shortening it would
 * change every single-message row in the list, which is 99% of them.
 */
function shortNameOf(name: string): string {
  const space = name.indexOf(' ');
  if (space > 0) return name.slice(0, space);
  const at = name.indexOf('@');
  if (at > 0) return name.slice(0, at);
  return name;
}

/**
 * What the sender column prints.
 *
 * One participant  -> their full name, unchanged from the ungrouped row.
 * Two              -> `Ann, Bob` — both first names, oldest first.
 * Three or more    -> `Ann, …, Zed` — who started it and who spoke last.
 *
 * The elision is a MIDDLE elision rather than a trailing one because the
 * newest speaker is the one the row's timestamp, subject and preview all
 * belong to; dropping them would print names that no part of the rest of
 * the row refers to. How many were elided is not spelled out here — the
 * count beside these names already says how big the conversation is.
 */
export function participantsLabel(conversation: Conversation): string {
  const participants = participantsOf(conversation);
  const first = participants[0];
  if (first === undefined) return displayNameOf(conversation.representative);
  if (participants.length === 1) return first;

  const short = participants.map(shortNameOf);
  if (short.length <= NAMES_BEFORE_ELISION) return short.join(', ');
  return `${short[0]}, ${PARTICIPANT_ELLIPSIS}, ${short[short.length - 1]}`;
}

/**
 * Gmail's `(3)` — or `null` for a conversation of one.
 *
 * NULL, NOT `'(1)'`, and not an empty string. 99% of the rows in this
 * inbox are conversations of one, and a badge on every one of them would
 * be chrome restating "this is a message" forty-nine times per page; an
 * empty string would still render a node carrying its parent's gap. The
 * absence is what keeps the collapsed list looking like the list the user
 * already approved.
 */
export function conversationCountLabel(count: number): string | null {
  return count > 1 ? `(${count})` : null;
}

/**
 * What a screen reader hears in place of the bare number, which on its
 * own is read as part of the sender's name ("Ann Lei 3").
 *
 * Says MESSAGES rather than "conversations" because the number counts
 * messages, and because that is the noun every downstream sentence uses —
 * the bulk bar's "40 selected", the receipt's "Archived 40 messages."
 */
export function conversationCountAnnouncement(count: number): string | null {
  return count > 1 ? `${count} messages in this conversation. ` : null;
}

/**
 * ONE ROW EACH — the array the keyboard cursor walks, the reader's
 * neighbour prefetch reads, and `j`/`k` index into.
 *
 * The cursor must step over what is DRAWN, not over what is loaded: a
 * cursor that walked all forty members of a collapsed conversation would
 * spend thirty-nine presses of `j` on rows nobody can see.
 */
export function representativesOf(
  conversations: readonly Conversation[],
): readonly InboxMessage[] {
  return conversations.map((conversation) => conversation.representative);
}

/**
 * EVERY loaded message — the array the selection, the prune and every
 * batch are resolved against, because all three are per message even
 * though a row is per conversation.
 *
 * In list order (conversation by conversation, newest member first), so a
 * partially-failed batch fails in a pattern the user can read down their
 * own screen — the same reason ./bulkSelection.ts's `selectedMessages`
 * preserves list order.
 */
export function allMessagesOf(
  conversations: readonly Conversation[],
): readonly InboxMessage[] {
  return conversations.flatMap((conversation) => conversation.messages);
}

/**
 * From ANY loaded message's key to the whole conversation it belongs to.
 *
 * Keyed by every MEMBER rather than only by the representative, because
 * both callers need both directions: `x` and `e` arrive with the
 * representative (it is the row), while "select all" walks the flattened
 * message list and asks the same question of members that have no row of
 * their own.
 *
 * A message this index does not know about resolves to itself at the call
 * site, which is the honest answer for a row that arrived from somewhere
 * other than the list.
 */
export function membersByMessageKey(
  conversations: readonly Conversation[],
): ReadonlyMap<string, readonly InboxMessage[]> {
  const index = new Map<string, readonly InboxMessage[]>();
  for (const conversation of conversations) {
    for (const member of conversation.messages) {
      index.set(messageKey(member), conversation.messages);
    }
  }
  return index;
}
