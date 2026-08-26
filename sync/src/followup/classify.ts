/**
 * Spec §7A's organising principle, reduced to one pure function: given
 * what we know about one outbound message, which engagement state is it
 * in?
 *
 * This is the whole product idea. Every other client sorts outbound mail
 * by date; Postbox sorts it by whether anyone read it and whether anyone
 * answered. That ranking is decided here, before any SQL exists, so the
 * states are settled rather than fitted to whatever a query happened to
 * make convenient.
 *
 * NO I/O, NO CLOCK, NO IMPORTS. `nowMs` is a parameter rather than a call
 * to `Date.now()` precisely so the grace period below is testable at all,
 * and so every row in one response is classified against a single
 * consistent instant instead of drifting across the loop.
 *
 * §7A.2 IS BINDING HERE, NOT DECORATIVE. "Never opened" and "we cannot
 * tell" are different facts about the world, so they are different states
 * with different names. Roughly half of all opens are unconfirmable (L1),
 * and a view that renders "not opened" for "we cannot tell" is lying —
 * the spec forbids it, and this is the file where that refusal is
 * mechanised.
 */

export type EngagementState =
  /** Read, silent — THE follow-up queue. */
  | 'opened-no-reply'
  /** Resolved. Shown in Sent & Waiting, ranked last; never a queue item. */
  | 'opened-replied'
  /** More than one open, or more than one recipient — the strongest
   *  signal of interest this data can carry. */
  | 'opened-repeatedly'
  /** Sent, and no open recorded anywhere in a window that covers its
   *  whole life. */
  | 'never-opened'
  /** §7A.2: we genuinely cannot tell. NOT the same as never-opened. */
  | 'unverifiable';

/**
 * How long after a send the absence of an open proves nothing.
 *
 * THE NUMBER, AND WHY THIS ONE. Two facts bracket it:
 *
 *  - The floor is 60 seconds. The tracking service suppresses every open
 *    inside its own `PREFETCH_WINDOW_MS` as machine prefetch (spec
 *    §7A.4), so for the first minute of a message's life a recorded open
 *    is not merely unlikely — it is impossible by construction. Calling
 *    anything inside that minute "never opened" is guaranteed wrong.
 *  - The ceiling is however long it takes before silence starts to MEAN
 *    something. Mail sent this morning and unopened by lunchtime is a
 *    real signal; mail sent four minutes ago is not.
 *
 * 30 minutes is 30x the floor, which leaves room for a suppressed
 * first fetch AND a later real one to both land inside it, and it is
 * short enough that same-morning mail still resolves into a real state
 * before the day is out. Above all it is long enough that nothing sent
 * during the conversation the user is still having gets labelled
 * unopened — the single fastest way to make a follow-up queue
 * untrustworthy is to have it accuse someone of ignoring mail they have
 * not had time to receive.
 *
 * Exported so tests assert against this value rather than hardcoding a
 * second copy of it.
 */
export const UNVERIFIABLE_GRACE_MS = 30 * 60 * 1000;

export interface ClassifyInput {
  /** Confirmed opens only, own-address opens already excluded — see
   *  ./query.ts's `tallyOpens`, which is the only thing that builds this. */
  readonly openCount: number;
  /** How many DISTINCT recipients contributed those opens. */
  readonly distinctRecipientOpens: number;
  /** A later message in the same thread from someone who is not us. See
   *  ./query.ts for why "later message from myself" is not a reply. */
  readonly hasReply: boolean;
  readonly sentAtMs: number;
  readonly nowMs: number;
}

/**
 * What the opens data we are classifying AGAINST can and cannot speak to.
 *
 * Separate from `ClassifyInput` because it is a property of the whole
 * response, not of one message: every row in one page shares it. Keeping
 * it out of `classify` also keeps that function exactly what it claims to
 * be — a statement about one message — while `classifyWithEvidence` below
 * is where "and how much did we actually get to look at?" is answered.
 */
export interface OpensEvidence {
  /** False when the tracking service was unreachable or answered with
   *  garbage. Nothing about opens can be asserted at all in that case. */
  readonly available: boolean;
  /**
   * The earliest send time this opens window can speak to, or null when
   * it speaks to all of history.
   *
   * The tracking service answers with the newest N events and nothing
   * older. If it returned a FULL page, the oldest event we can see is a
   * HORIZON rather than the beginning of history — an open below it
   * exists and is simply invisible. A message sent before that horizon
   * could have been opened inside the invisible span, so zero visible
   * opens does not mean zero opens. A message sent AFTER it has its
   * entire life inside the window, so zero visible opens really is zero.
   */
  readonly visibleSinceMs: number | null;
}

/** True while the absence of an open is still uninformative. Written as
 *  its own predicate so the ordering below reads as a list of facts. A
 *  clock that ran backwards (negative age) lands here too, which is the
 *  safe direction: an impossible age must never resolve to a confident
 *  "never opened". */
function isTooEarlyToSay(input: ClassifyInput): boolean {
  return input.nowMs - input.sentAtMs < UNVERIFIABLE_GRACE_MS;
}

/**
 * ORDER IS THE WHOLE FUNCTION. Positive evidence first, absence last:
 *
 *  1. A reply resolves the thread no matter what the pixel did — someone
 *     answering the mail is a stronger read signal than an image fetch,
 *     and a resolved thread must never sit in a follow-up queue.
 *  2. More than one open, OR more than one recipient who opened. Both are
 *     "more engagement than a single read", and both are the top of the
 *     queue. (`distinctRecipientOpens` is checked alongside `openCount`
 *     rather than folded into it because the two answer different
 *     questions — one person rereading and three people each reading once
 *     are different facts that happen to share a rank.)
 *  3. Any open at all, and no reply: the queue itself.
 *  4. No open, but too soon for that to mean anything: §7A.2's honest
 *     unknown.
 *  5. No open, and long enough that its absence is a real observation.
 *
 * Steps 1-3 deliberately precede step 4: the grace period gates the
 * ABSENCE of evidence, never evidence itself. An open recorded ten
 * seconds after send is still an open.
 */
export function classify(input: ClassifyInput): EngagementState {
  if (input.hasReply) return 'opened-replied';
  if (input.openCount > 1 || input.distinctRecipientOpens > 1) return 'opened-repeatedly';
  if (input.openCount > 0) return 'opened-no-reply';
  if (isTooEarlyToSay(input)) return 'unverifiable';
  return 'never-opened';
}

/**
 * `classify`, plus the honest admission that our opens data has edges.
 *
 * Two ways the same silence can be uninformative for a reason that has
 * nothing to do with the message itself, both of which §7A.2 requires be
 * rendered as "cannot tell" rather than "not opened":
 *
 *  - The tracking service is down. Every row's open count is zero for a
 *    reason that says nothing about any recipient.
 *  - The message predates the opens window we were able to read. See
 *    `OpensEvidence.visibleSinceMs`.
 *
 * Neither gate applies to positive evidence: a reply, or an open we
 * actually saw, is a fact regardless of what else we failed to see. So
 * both are checked only after `classify` has had its chance to find
 * something real.
 */
export function classifyWithEvidence(
  input: ClassifyInput,
  evidence: OpensEvidence,
): EngagementState {
  const state = classify(input);
  if (state !== 'never-opened') return state;
  if (!evidence.available) return 'unverifiable';
  if (evidence.visibleSinceMs !== null && input.sentAtMs < evidence.visibleSinceMs) {
    return 'unverifiable';
  }
  return state;
}
