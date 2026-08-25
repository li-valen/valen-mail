import type { BudgetDecision } from '../budget';
import type { ImapConnection } from './connection';
import type { FetchResult, PreviewTarget } from './fetch';
import { ESTIMATED_BYTES_PER_PREVIEW_FETCH, fetchPreviews } from './fetch.ts';

/**
 * The preview half of a folder's sync cycle (Plan 7 Task 1): decide which
 * of the just-fetched messages still need a preview, reserve and charge
 * exactly those bytes, and fetch them.
 *
 * Its own module rather than two more methods on ConnectionPool, matching
 * how ./backoff.ts, ./keyed-mutex.ts and ./new-mail-marks.ts were split out
 * of that same file: pool.ts sits at the project's file-size ceiling, and
 * this is a self-contained decision that needs three narrow capabilities
 * (a snippet lookup, a byte budget, a connection) rather than the pool's
 * whole surface. Taking those as an options object — instead of a
 * ConnectionPool — is also what lets it be tested without one.
 */

/** The two byte-budget operations this needs, structurally rather than by
 *  class: ../budget.ts's ByteBudget satisfies it, and so does a fake. */
export interface PreviewBudget {
  reserve(accountId: string, bytes: number): Promise<BudgetDecision>;
  record(accountId: string, bytes: number): Promise<void>;
}

/** The one Db method this needs — see its doc comment in ../db.ts for why
 *  the question goes to Postgres rather than to an in-memory set. */
export interface PreviewStore {
  findUidsWithSnippet(
    accountId: string,
    folder: string,
    uids: readonly number[],
  ): Promise<ReadonlySet<number>>;
}

export interface CollectPreviewsOptions {
  readonly db: PreviewStore;
  readonly budget: PreviewBudget;
  readonly accountId: string;
  readonly connection: ImapConnection;
  readonly folder: string;
  readonly result: FetchResult;
}

/** Shared empty result for every "no previews this cycle" path — the
 *  steady state once a folder's newest UIDs all have one. */
const EMPTY_PREVIEWS: ReadonlyMap<number, string> = new Map();

/**
 * The messages worth fetching a preview for: those with a usable text part
 * (firstTextPart found one in the BODYSTRUCTURE the header fetch already
 * pulled) AND no snippet stored yet.
 *
 * A message with no text part at all — a bare image, a calendar invite
 * with no text alternative — is skipped rather than fetched-and-discarded,
 * which is both cheaper and the honest reason its row shows no preview.
 */
async function resolvePreviewTargets(
  options: CollectPreviewsOptions,
): Promise<readonly PreviewTarget[]> {
  const candidates = options.result.messages
    .map((message) => ({ uid: message.uid, part: options.result.textParts.get(message.uid) }))
    .filter((candidate): candidate is PreviewTarget => candidate.part !== undefined);

  if (candidates.length === 0) return [];

  const alreadyPreviewed = await options.db.findUidsWithSnippet(
    options.accountId,
    options.folder,
    candidates.map((candidate) => candidate.uid),
  );
  return candidates.filter((candidate) => !alreadyPreviewed.has(candidate.uid));
}

/**
 * Three things keep this from being a way to quietly reintroduce
 * body-fetching into sync:
 *
 *  - ONLY messages with no stored snippet are asked about. The sync loop
 *    re-polls the same newest 50 UIDs every cycle; without this filter
 *    that would be 50 preview fetches per folder forever instead of a
 *    one-time cost per message. That is also why the worst case in
 *    ESTIMATED_BYTES_PER_PREVIEW_FETCH's arithmetic is one-time rather
 *    than recurring, and why a settled deployment's steady-state preview
 *    charge is zero.
 *  - The bytes are RESERVED before the fetch and RECORDED after, against
 *    the same per-account daily budget as the header fetch, using
 *    fetch.ts's own per-message estimate. A refused reservation skips
 *    previews for this cycle and logs why — the messages still sync, just
 *    without previews. (The caller must record the HEADER bytes before
 *    calling this, or that reservation is measured against a snapshot
 *    that pretends the header fetch never happened — see syncFolder.)
 *  - A throw from fetchPreviews cannot fail the folder. The mailbox
 *    failing to re-open, say — one part group failing is already handled
 *    inside fetchPreviews itself — is logged and turned into an empty map,
 *    so every message is still upserted, just with `snippet` null.
 *    Scoped deliberately to fetchPreviews: findUidsWithSnippet and
 *    budget.reserve are OUTSIDE the try, and a throw from either does
 *    propagate to syncFolder. That is correct rather than an oversight —
 *    both are Postgres round trips, and a database this sync loop cannot
 *    reach is not a preview problem to swallow; upsertMessage on the very
 *    next line would fail too.
 *
 * Returns an empty map for a folder with nothing to preview, which is the
 * steady state.
 */
export async function collectPreviews(
  options: CollectPreviewsOptions,
): Promise<ReadonlyMap<number, string>> {
  const { accountId, budget, connection, folder } = options;

  const targets = await resolvePreviewTargets(options);
  if (targets.length === 0) return EMPTY_PREVIEWS;

  const requested = targets.length * ESTIMATED_BYTES_PER_PREVIEW_FETCH;
  const decision = await budget.reserve(accountId, requested);
  if (!decision.allowed) {
    console.error(
      `account "${accountId}" folder "${folder}": daily byte budget exhausted, skipping ` +
        `${targets.length} message preview(s) (requested ${requested}, remaining ${decision.remaining})`,
    );
    return EMPTY_PREVIEWS;
  }

  try {
    const previewResult = await fetchPreviews(connection, folder, targets);
    await budget.record(accountId, previewResult.bytesDownloaded);
    return previewResult.previews;
  } catch (error) {
    // Charged anyway: a throw here does not prove nothing crossed the
    // wire, and under-charging the budget is the one direction that risks
    // Gmail's 24-hour IMAP suspension. Account and folder only — never any
    // body content.
    await budget.record(accountId, requested);
    console.error(
      `account "${accountId}" folder "${folder}": preview fetch failed for ${targets.length} ` +
        'message(s); they sync without a preview',
      error,
    );
    return EMPTY_PREVIEWS;
  }
}
