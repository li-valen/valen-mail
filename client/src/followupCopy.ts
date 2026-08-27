import type { EngagementState, FollowupRow, InboxMessage } from './api';

/**
 * Every display decision the follow-up queue makes, as pure functions.
 *
 * client/CLAUDE.md's standing constraint is that no test in this codebase
 * renders a component, so a rule that lives inside JSX is a rule nothing
 * can assert. The words, the ranking, the filter predicate and the
 * reader hand-off therefore all live here, and components/FollowupView.tsx
 * and components/FollowupRow.tsx are left with layout.
 *
 * THE VOICE, from the user's own direction: "dont show the MPP mail thing
 * just give me as much information as possible i dont need any liek side
 * notes. Do it like superhuman or mailspring does it." So every string
 * below says WHAT IS KNOWN — who, what, when, how many opens — and none
 * of them explains a measurement limitation to the reader.
 *
 * That is not the same as flattening the states. Spec §7A.2 requires an
 * honest unknown to render differently from a confident zero, and it
 * does: "No opens recorded" and "No signal yet" are different sentences
 * in different tones. What is gone is the paragraph that used to explain
 * why.
 */

/** The five states, in one place, so a loop over "every state" cannot
 *  silently miss one a future change adds. */
export const ENGAGEMENT_STATES: readonly EngagementState[] = [
  'opened-repeatedly',
  'opened-no-reply',
  'never-opened',
  'unverifiable',
  'opened-replied',
];

/**
 * How loud a row is.
 *
 *  - `waiting`  — read and unanswered. The queue. The only tone that
 *    means "this is yours to act on."
 *  - `quiet`    — nothing to act on yet, whether because nothing was
 *    recorded or because nothing can be known.
 *  - `resolved` — answered. Present in the full list for completeness,
 *    never a queue item.
 *
 * Deliberately NOT ReadState.tsx's `confirmed`/`unknown` pair: that
 * vocabulary grades ONE open event's trustworthiness, and this one grades
 * a whole message's status. Reusing the words would imply the two scales
 * mean the same thing.
 */
export type FollowupTone = 'waiting' | 'quiet' | 'resolved';

export interface EngagementCopy {
  /** The lead — the FIRST text in the row, before the recipient and long
   *  before the timestamp. The eye should land on the state. */
  readonly lead: string;
  readonly tone: FollowupTone;
}

/**
 * "We cannot tell", which is also the fallback for any state this build
 * does not recognise. Failing closed to the honest unknown rather than to
 * a confident state is the same discipline ReadState.tsx's `readStateFor`
 * applies to an unrecognised classification: a future value must never
 * default into a claim.
 */
const UNKNOWN_COPY: EngagementCopy = { lead: 'No signal yet', tone: 'quiet' };

/**
 * The words for one row.
 *
 * `openCount` is a parameter rather than folded into the state because
 * "Opened 3×" is the single most useful thing this product can say and it
 * needs the actual number. The `×` is U+00D7 MULTIPLICATION SIGN, not the
 * letter x — it is what Superhuman renders and it reads as a count rather
 * than a typo.
 *
 * A repeat state arriving with a count of 1 (which the server does not
 * emit, but which a future change could) falls back to the plain form
 * rather than rendering "Opened 1×".
 */
export function engagementCopy(state: EngagementState, openCount: number): EngagementCopy {
  switch (state) {
    case 'opened-repeatedly':
      return openCount > 1
        ? { lead: `Opened ${openCount}×, no reply`, tone: 'waiting' }
        : { lead: 'Opened, no reply', tone: 'waiting' };
    case 'opened-no-reply':
      return { lead: 'Opened, no reply', tone: 'waiting' };
    case 'opened-replied':
      return { lead: 'Replied', tone: 'resolved' };
    case 'never-opened':
      // A claim about OUR OWN RECORDS, never about the recipient. "Never
      // opened" would assert something about a person that a pixel cannot
      // establish; this asserts only what is in the log, which is true
      // whatever the recipient did.
      return { lead: 'No opens recorded', tone: 'quiet' };
    default:
      return UNKNOWN_COPY;
  }
}

/**
 * The ranking that makes this view different from every other mail
 * client: engagement first, date second.
 *
 * Repeat opens above a single open above silence, because that is
 * descending order of "someone is thinking about this". `unverifiable`
 * sits below `never-opened` — a row we cannot speak to is the least
 * actionable thing on the page, but it is still unresolved, so it stays
 * above `opened-replied`, which is last because a resolved thread is not
 * a queue item at all.
 */
export const ENGAGEMENT_RANK: Readonly<Record<EngagementState, number>> = {
  'opened-repeatedly': 0,
  'opened-no-reply': 1,
  'never-opened': 2,
  unverifiable: 3,
  'opened-replied': 4,
};

/** An unrecognised state ranks last rather than first — the same
 *  fail-closed direction `engagementCopy` takes. */
function rankOf(state: EngagementState): number {
  return ENGAGEMENT_RANK[state] ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Rows in view order: by engagement state, then newest first WITHIN a
 * state.
 *
 * Date is the tiebreak rather than the key, which is the whole inversion
 * this view exists for. Returns a new array; the input is only read
 * (`toSorted` is avoided for the same reason nothing else in this
 * codebase uses it — a copy then a sort is understood everywhere).
 */
export function rankRows(rows: readonly FollowupRow[]): readonly FollowupRow[] {
  return [...rows].sort((a, b) => {
    const byState = rankOf(a.state) - rankOf(b.state);
    return byState !== 0 ? byState : b.sentAtMs - a.sentAtMs;
  });
}

/**
 * Which list the reader is looking at.
 *
 *  - `queue` — spec §7A's "Opened, no reply": read and unanswered, and
 *    nothing else. The default, because it is the one the spec calls
 *    "the highest-signal follow-up queue in the product".
 *  - `all`   — spec §7A's "Sent & Waiting": everything sent, still ranked
 *    by engagement rather than by date.
 *
 * One list with a predicate, not two views: they differ by which states
 * survive, which is exactly one function.
 */
export type FollowupScope = 'queue' | 'all';

export const SCOPE_LABELS: Readonly<Record<FollowupScope, string>> = {
  queue: 'Opened, no reply',
  all: 'Sent & waiting',
};

/** The queue predicate: read, and still silent. */
export function isQueueRow(state: EngagementState): boolean {
  return state === 'opened-no-reply' || state === 'opened-repeatedly';
}

export function filterRows(
  rows: readonly FollowupRow[],
  scope: FollowupScope,
): readonly FollowupRow[] {
  const kept = scope === 'queue' ? rows.filter((row) => isQueueRow(row.state)) : rows;
  return rankRows(kept);
}

/** How many addresses to name before collapsing the rest into a count. */
const NAMED_RECIPIENTS = 1;

/**
 * Who it went to, in the space a row has for it.
 *
 * The address, not a display name: `to_emails` is all the send carries,
 * and inventing a name from a local part would be fabricating data. One
 * name plus "+2" is Gmail's own answer for the same width problem.
 */
export function formatRecipients(recipients: readonly string[]): string {
  const named = recipients.map((address) => address.trim()).filter((address) => address.length > 0);
  const [first] = named;
  if (first === undefined) return 'No recipients';
  const remaining = named.length - NAMED_RECIPIENTS;
  return remaining > 0 ? `${first} +${remaining}` : first;
}

export interface FollowupEmptyState {
  readonly title: string;
  readonly description: string;
}

/**
 * What an empty list says, and why it is four strings rather than one.
 *
 * An empty queue means one of two genuinely different things, and
 * conflating them hides an outage: either nothing is waiting on the user,
 * or read state could not be read at all and the queue is empty because
 * the input is missing. That is the same distinction
 * components/OpensFeed.tsx already draws between its `unavailable` and
 * `empty` states, and it is a LOAD state — what this surface currently
 * knows — not a measurement caveat about any particular message.
 */
export function emptyStateFor(
  scope: FollowupScope,
  opensAvailable: boolean,
): FollowupEmptyState {
  if (!opensAvailable) {
    return {
      title: "Valen Mail can't reach the tracking service.",
      description:
        'Read state is missing, not empty. This fills in again once the connection returns.',
    };
  }
  if (scope === 'queue') {
    return {
      title: 'Nothing is waiting on you.',
      description: 'Mail that was opened and never answered collects here.',
    };
  }
  return {
    title: 'No sent mail yet.',
    description: 'Mail you send shows up here, ranked by what happened next.',
  };
}

/**
 * The row, as the identity the reader opens a message by.
 *
 * components/MessageView.tsx takes an `InboxMessage`, and this view has a
 * `FollowupRow` — the same physical message, shaped by a different query.
 * Rather than teach the reader a second input type, the row is widened
 * into the shape it already accepts.
 *
 * WHAT IS REAL AND WHAT IS EMPTY, stated so nothing here is mistaken for
 * data. `account_id`/`folder`/`uid` are the identity the body fetch uses;
 * sender, recipients, subject and date are carried verbatim from the row
 * and are what the reader's header draws before its own fetch resolves.
 * `flags`, `labels`, `snippet` and `attachments` are EMPTY because this
 * query never asked for them — not because the message has none. The
 * consequences are bounded and visible: an unstarred star on a starred
 * message, and no paperclip until the body loads. Nothing here fabricates
 * a value that could be mistaken for a fact.
 */
export function toReaderMessage(row: FollowupRow): InboxMessage {
  return {
    account_id: row.accountId,
    uid: String(row.uid),
    message_id: null,
    thread_id: null,
    folder: row.folder,
    subject: row.subject,
    from_name: row.fromName,
    from_email: row.fromEmail,
    to_emails: row.recipients,
    cc_emails: [],
    date: new Date(row.sentAtMs).toISOString(),
    snippet: null,
    flags: [],
    labels: [],
    has_attach: false,
    size_bytes: null,
    attachments: [],
  };
}
