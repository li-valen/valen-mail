import type { Db, InboxCursor, InboxFolderFilter } from '../db';
import { buildInboxFilter, INBOX_ORDER } from '../db.ts';
import type { OpenEvent, OpensResult } from '../api/opens';
import { nextCursorFrom, type NextCursor } from '../api/inbox.ts';
import { isOwnAddress } from '../addresses.ts';
import { classifyWithEvidence, type EngagementState, type OpensEvidence } from './classify.ts';

/**
 * Spec §7A's two missing views — "Sent & Waiting" and "Opened, no reply" —
 * as ONE query with a state on every row. They are not two subsystems:
 * the follow-up queue is this list filtered to the states that are still
 * open, which is a predicate the client applies, not a second join.
 *
 * WHERE EACH HALF OF THE JOIN LIVES, AND WHY IT IS SPLIT THAT WAY.
 *
 * Postgres does the part only Postgres can: selecting the user's sent
 * mail, gathering every LATER sender in each message's thread, ordering,
 * and paginating. That is a self-join over `messages` on an indexed
 * column, and pulling threads into memory to do it would be absurd.
 *
 * TypeScript does the two JUDGEMENTS, and that is deliberate rather than
 * a compromise:
 *
 *  - "Which of those later senders is me?" — because `isOwnAddress`
 *    (../addresses.ts) is the same rule push/dispatch.ts suppresses
 *    self-opens with, and re-expressing it as `lower(trim(...)) <> all(...)`
 *    in SQL would be a second copy of a load-bearing rule, free to drift
 *    from the first. It is also the rule this feature is most likely to
 *    get quietly wrong, and a rule tested through a fake `Db` is a rule
 *    whose deletion makes a test fail on every `npm test` — not only on
 *    the machines that happen to have a scratch Postgres.
 *  - "Which opens belong to this message?" — because opens are not in
 *    this database at all. They live in the tracking service (a separate
 *    Vercel + Neon deployment) and arrive over HTTP via
 *    `fetchOpens`. `queryFollowup` takes them as an argument rather than
 *    fetching them, so this module stays free of the network and the
 *    route (../api/followup.ts) owns the one call.
 *
 * NO NEW STORAGE, and no changes to tracking/. The consequence is an
 * evidence HORIZON — the tracking service answers with its newest N
 * events and nothing older — and that horizon is carried honestly rather
 * than ignored: see `opensEvidenceFrom` and ./classify.ts's
 * `classifyWithEvidence`.
 */

/**
 * Message columns plus every LATER sender in the same thread.
 *
 * `array_agg(distinct r.from_email)` inside a LATERAL rather than a
 * GROUP BY over a join: the aggregate is per outer row, so the outer
 * query keeps returning exactly one row per sent message no matter how
 * long the thread is, and the probe rides `messages_thread`
 * (thread_id, date asc) — the index that already exists.
 *
 * `r.date > m.date` is a STRICT comparison, which is what excludes the
 * message from its own aggregate and what makes "later" mean later. A
 * NULL date on either side yields NULL, so it contributes nothing —
 * correct, since a message with no timestamp cannot be placed before or
 * after anything.
 *
 * `coalesce(..., '{}'::text[])` matters for the same reason
 * db.ts's MESSAGE_SELECT coalesces its json_agg: an aggregate over zero
 * rows is NULL, and the shaper below should see an empty list rather
 * than have to treat null as a third case.
 *
 * The alias is `m`, and it must stay `m`: `buildInboxFilter` and
 * `INBOX_ORDER` both write clauses against that name.
 */
const FOLLOWUP_SELECT = `
  select m.account_id, m.uid, m.folder, m.message_id, m.subject,
         m.from_name, m.from_email, m.to_emails, m.cc_emails, m.date,
         coalesce(later.senders, '{}'::text[]) as later_senders
  from messages m
  left join lateral (
    select array_agg(distinct r.from_email) as senders
    from messages r
    where r.thread_id = m.thread_id
      and r.from_email is not null
      and r.date > m.date
  ) later on true`;

/**
 * Messages with no parseable `Date:` header are excluded outright.
 *
 * This view is ranked by engagement OVER TIME: without an age there is no
 * grace period to evaluate, so such a row could only ever render as
 * permanently "cannot tell" — while forcing a nullable timestamp through
 * `ClassifyInput`, the wire row and the client's formatting for a case
 * that, in a Sent folder, is the user's own outgoing mail missing its own
 * Date header. The inbox keeps those rows (in its "No date" group)
 * because the inbox is a record of what exists; this is a queue of what
 * to act on.
 *
 * It also keeps the keyset cursor honest: with no NULL-date tail, the
 * cursor comparison inherited from the inbox never has to address one.
 */
const DATED_ONLY = 'm.date is not null';

/** One row of the follow-up queue, as it goes on the wire. */
export interface FollowupRow {
  readonly accountId: string;
  readonly uid: number;
  readonly folder: string;
  readonly subject: string | null;
  /** Which identity sent it. Carried so the client can open the row in
   *  the reader without inventing a sender for the user's own mail — the
   *  reader's header is drawn from these fields before its body fetch
   *  resolves. */
  readonly fromName: string | null;
  readonly fromEmail: string | null;
  /** `to` and `cc` folded into one list — who this went to, which is what
   *  a follow-up row leads with. */
  readonly recipients: readonly string[];
  /** Epoch ms, NOT an ISO string. Matches `OpenEvent.occurredAt` and
   *  every other timestamp this system puts on the wire. */
  readonly sentAtMs: number;
  /** Confirmed opens only, own-address opens already excluded. */
  readonly openCount: number;
  readonly distinctRecipientOpens: number;
  readonly lastOpenAtMs: number | null;
  readonly hasReply: boolean;
  /**
   * NOT derivable by the client, and that is the point: the grace period
   * and the evidence horizon are honesty rules (§7A.2), and they belong
   * on the side that knows how much of the opens history it actually got
   * to read. A client that recomputed this from `openCount` alone would
   * reintroduce exactly the "not opened" / "cannot tell" conflation the
   * spec forbids.
   */
  readonly state: EngagementState;
}

export interface FollowupPage {
  readonly rows: readonly FollowupRow[];
  readonly nextCursor: NextCursor | null;
  /** False when the tracking service could not be read. The client shows
   *  the list either way — a sent-mail list is still useful without open
   *  data — and every row honestly reads as unknown. */
  readonly opensAvailable: boolean;
}

export interface FollowupQueryOptions {
  /** Every configured account's own address. */
  readonly ownAddresses: readonly string[];
  readonly limit: number;
  readonly cursor: InboxCursor | null;
  /** Already resolved from the API's logical 'sent' to each account's own
   *  discovered native folder — see ../api/inbox.ts's resolveFolderFilter. */
  readonly folder: InboxFolderFilter;
  readonly accountId: string | null;
  /** Whatever `fetchOpens` answered, failures included. */
  readonly opens: OpensResult;
  /** The limit that fetch ASKED for, which is what makes a full page
   *  detectable — see `opensEvidenceFrom`. */
  readonly opensLimit: number;
  readonly nowMs: number;
}

/**
 * Strips the OPTIONAL RFC 5322 angle-bracket delimiters a Message-ID may
 * or may not be wrapped in.
 *
 * NOT a defensive guess. `messages.message_id` is parsed straight off the
 * synced `Message-ID:` header and carries the brackets, per that header's
 * own syntax; the tracking service's `messageId` is stored without them
 * (verified against live data — 11 of 11 events on the account tested).
 * An exact-string comparison between the two therefore failed on 100% of
 * real events. The brackets are DELIMITER syntax, not part of the
 * semantic identifier, so stripping them before comparing normalises two
 * spellings of one value rather than loosening the match.
 *
 * Anchored, so only a leading `<` and a trailing `>` go — an angle
 * bracket inside the identifier (legal in a quoted local part) survives.
 * The client has the same function under the same name
 * (client/src/components/openEvents.ts `bareMessageId`); they cannot
 * share a module across two separately deployed services, so they share a
 * name and this note instead.
 */
export function bareMessageId(id: string): string {
  return id.replace(/^</, '').replace(/>$/, '');
}

/** What the opens data says about ONE message. */
export interface OpenTally {
  readonly openCount: number;
  readonly distinctRecipientOpens: number;
  readonly lastOpenAtMs: number;
}

/**
 * Confirmed opens, grouped by the message they belong to.
 *
 * TWO FILTERS, BOTH LOAD-BEARING:
 *
 *  1. `classification === 'open'` only. An `mpp` event is Apple's privacy
 *     proxy prefetching every image on delivery, `prefetch` is Gmail's
 *     own proxy, `scanner` is a gateway; none of them is a person
 *     reading. Anything unrecognised takes the same branch rather than an
 *     allowlist's default-true — a future classifier value must degrade
 *     to "not confirmed", never to a false green. This is the same rule
 *     push/dispatch.ts's `shouldNotifyOpen` applies before buzzing a
 *     phone.
 *  2. OWN-PIXEL OPENS ARE NOT COUNTED. Gmail files a copy of every SMTP
 *     send into the sender's own Sent folder, byte-identical to the
 *     recipient's — same live token. Commit d056622 strips that pixel
 *     before Valen Mail renders any body (spec §5.6), so it no longer fires
 *     from inside this product. But every open row recorded BEFORE that
 *     fix is still in the tracking database, attributed to a recipient
 *     who did nothing, and re-reading the same Sent copy in Gmail's own
 *     client still produces one today. Counting those would put messages
 *     in the follow-up queue on the strength of the user reading their
 *     own outbox — the exact overclaim this product exists to refuse.
 *
 * Returns a fresh Map; `opens` is only read.
 */
export function tallyOpens(
  opens: readonly OpenEvent[],
  ownAddresses: readonly string[],
): ReadonlyMap<string, OpenTally> {
  const building = new Map<string, { count: number; recipients: Set<string>; last: number }>();

  for (const event of opens) {
    if (event.classification !== 'open') continue;
    if (isOwnAddress(event.recipientEmail, ownAddresses)) continue;

    const key = bareMessageId(event.messageId);
    const existing = building.get(key);
    if (existing) {
      existing.count += 1;
      existing.recipients.add(event.recipientEmail.trim().toLowerCase());
      existing.last = Math.max(existing.last, event.occurredAt);
      continue;
    }
    building.set(key, {
      count: 1,
      recipients: new Set([event.recipientEmail.trim().toLowerCase()]),
      last: event.occurredAt,
    });
  }

  const tallies = new Map<string, OpenTally>();
  for (const [key, value] of building) {
    tallies.set(key, {
      openCount: value.count,
      distinctRecipientOpens: value.recipients.size,
      lastOpenAtMs: value.last,
    });
  }
  return tallies;
}

/**
 * How far back the opens we were handed can actually speak.
 *
 * The tracking service answers with its newest N events and nothing
 * older. A SHORT page means we saw everything it has, so silence about a
 * message is real silence. A FULL page means the window is truncated: the
 * oldest event in it is a horizon, and an open below that horizon exists
 * but is invisible to us. Reporting "never opened" for a message sent
 * before the horizon would be a confident answer built on data we
 * demonstrably could not see — §7A.2's exact prohibition.
 */
export function opensEvidenceFrom(result: OpensResult, requestedLimit: number): OpensEvidence {
  if (!result.ok) return { available: false, visibleSinceMs: null };
  if (result.opens.length < requestedLimit) return { available: true, visibleSinceMs: null };

  let oldest = Infinity;
  for (const event of result.opens) oldest = Math.min(oldest, event.occurredAt);
  return {
    available: true,
    visibleSinceMs: Number.isFinite(oldest) ? oldest : null,
  };
}

/** `text[]` columns arrive as an array or null; anything else is a caller
 *  bug rather than data, and an empty list is the safe reading either way. */
function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/** `timestamptz` arrives as a Date from the pg driver. The string branch
 *  exists because a driver configured otherwise must degrade to a number,
 *  not to `NaN` silently rendered as "Invalid Date" in a queue. */
function epochMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(String(value)).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

const EMPTY_TALLY: OpenTally = { openCount: 0, distinctRecipientOpens: 0, lastOpenAtMs: 0 };

function toWireRow(
  raw: Record<string, unknown>,
  options: FollowupQueryOptions,
  tallies: ReadonlyMap<string, OpenTally>,
  evidence: OpensEvidence,
): FollowupRow {
  const messageId = typeof raw.message_id === 'string' ? bareMessageId(raw.message_id) : null;
  const tally = (messageId === null ? undefined : tallies.get(messageId)) ?? EMPTY_TALLY;

  // THE REPLY RULE. A later message in this thread from someone who is
  // NOT me. A later message from MYSELF is a follow-up nudge, not an
  // answer, and must not clear the queue — without this exclusion, every
  // thread the user chased twice would silently resolve itself.
  const hasReply = stringArray(raw.later_senders).some(
    (sender) => !isOwnAddress(sender, options.ownAddresses),
  );

  const sentAtMs = epochMs(raw.date);
  const state = classifyWithEvidence(
    {
      openCount: tally.openCount,
      distinctRecipientOpens: tally.distinctRecipientOpens,
      hasReply,
      sentAtMs,
      nowMs: options.nowMs,
    },
    evidence,
  );

  return {
    accountId: String(raw.account_id),
    // `pg` renders bigint as a STRING through the driver (it renders the
    // same column as a JSON number through json_build_object — one
    // column, two encodings). Without this the wire carries "7" where
    // every consumer's type says 7.
    uid: Number(raw.uid),
    folder: String(raw.folder),
    subject: typeof raw.subject === 'string' ? raw.subject : null,
    fromName: typeof raw.from_name === 'string' ? raw.from_name : null,
    fromEmail: typeof raw.from_email === 'string' ? raw.from_email : null,
    recipients: [...stringArray(raw.to_emails), ...stringArray(raw.cc_emails)],
    sentAtMs,
    openCount: tally.openCount,
    distinctRecipientOpens: tally.distinctRecipientOpens,
    lastOpenAtMs: tally.openCount > 0 ? tally.lastOpenAtMs : null,
    hasReply,
    state,
  };
}

/**
 * One page of outbound mail with an engagement state on every row.
 *
 * PAGINATION IS NOT OPTIONAL. An unbounded select over every message ever
 * sent is the performance bug this table eventually grows into, and the
 * cursor is the inbox's own — `buildInboxFilter`'s clause and
 * `INBOX_ORDER`, both imported rather than restated, so the two views
 * cannot drift into disagreeing about what "the next page" means.
 *
 * ORDERING IS BY DATE HERE AND BY ENGAGEMENT IN THE CLIENT, and the split
 * is deliberate. A page has to be addressable by a stable key to be
 * paginated at all, and an engagement state is not stable — it changes
 * the moment someone opens the mail, which would shuffle rows between
 * pages and drop some entirely. So Postgres returns the most recent sends
 * and the view ranks what it was given. The window is recency-bounded
 * either way, because the opens evidence behind the ranking is.
 *
 * EVERY caller-supplied value is a bound parameter. Nothing from a query
 * string is ever concatenated into the statement text.
 */
export async function queryFollowup(
  db: Db,
  options: FollowupQueryOptions,
): Promise<FollowupPage> {
  const filter = buildInboxFilter({
    cursor: options.cursor,
    folder: options.folder,
    accountId: options.accountId,
  });

  const values = [...filter.values];
  const limitIdx = values.push(options.limit);
  const where = filter.where === '' ? `where ${DATED_ONLY}` : `${filter.where} and ${DATED_ONLY}`;
  const text = `${FOLLOWUP_SELECT}\n  ${where}\n  ${INBOX_ORDER}\n  limit $${limitIdx}`;

  const raw = (await db.query(text, values)) as Record<string, unknown>[];

  const evidence = opensEvidenceFrom(options.opens, options.opensLimit);
  const tallies = tallyOpens(options.opens.ok ? options.opens.opens : [], options.ownAddresses);

  return {
    rows: raw.map((row) => toWireRow(row, options, tallies, evidence)),
    nextCursor: nextCursorFrom(raw, options.limit),
    opensAvailable: evidence.available,
  };
}
