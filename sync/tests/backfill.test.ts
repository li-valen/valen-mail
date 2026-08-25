import { describe, it, expect } from 'vitest';
import type { SyncStateInput } from '../src/db';
import {
  BACKFILL_BYTE_LIMIT,
  BACKFILL_PAGE_SIZE,
  ESTIMATED_BYTES_PER_BACKFILLED_MESSAGE,
  backfillFloor,
  isRenumbered,
  nextBackfillPage,
} from '../src/imap/backfill';
import { BACKFILL_SHARE, DAILY_BYTE_LIMIT } from '../src/budget';
import {
  ESTIMATED_BYTES_PER_HEADER_FETCH,
  ESTIMATED_BYTES_PER_PREVIEW_FETCH,
} from '../src/imap/fetch';

/**
 * Plan 8 Task 1 — the paging decision, proved without a database, an IMAP
 * server or a ConnectionPool.
 *
 * This is the whole reason nextBackfillPage is a standalone pure function
 * rather than three lines inside the fetch path: the arithmetic that
 * decides which UIDs a backfill asks for next is the one part of this
 * feature where an off-by-one is silent. A page that starts one UID too
 * high leaves a message permanently unsynced with nothing to detect it; a
 * walk that never reaches UID 1 never terminates.
 */

function stateWith(partial: Partial<SyncStateInput>): SyncStateInput {
  return { uidValidity: 1n, lastSeenUid: 0n, backfillDone: false, ...partial };
}

describe('nextBackfillPage — the paging rule', () => {
  it('starts the first page immediately below the oldest UID live sync reached', () => {
    // No sync_state row yet: this folder has only ever been touched by the
    // newest-50 poll, which left its oldest row at uid 511. The first page
    // is the 200 UIDs directly below it — no gap (510 is adjacent to 511)
    // and no overlap (511 itself is already synced).
    expect(nextBackfillPage(null, 511, 200)).toEqual({ lowestUid: 311, highestUid: 510 });
  });

  it('resumes mid-walk from the persisted watermark, not from the oldest synced row', () => {
    // THE RESUMABILITY PROPERTY. A restart re-reads sync_state and must
    // continue where the previous process stopped. Deriving the floor from
    // `messages` instead would re-page everything already walked — which
    // is idempotent, so it would never fail loudly, just quietly cost the
    // byte budget the same pages over and over.
    const state = stateWith({ lastSeenUid: 311n });
    expect(nextBackfillPage(state, 511, 200)).toEqual({ lowestUid: 111, highestUid: 310 });
  });

  it('caps the final page at UID 1 instead of asking for a range below it', () => {
    // The partial page. `UID -149:49` is not a range an IMAP server can
    // answer; clamping at 1 is what makes the last page legal.
    const state = stateWith({ lastSeenUid: 50n });
    expect(nextBackfillPage(state, 511, 200)).toEqual({ lowestUid: 1, highestUid: 49 });
  });

  it('returns null once the floor has reached UID 1 — the walk is over', () => {
    // Termination. UIDs are strictly positive (RFC 3501), so a floor of 1
    // means there is no history left below it. This null is what the
    // caller turns into backfill_done.
    expect(nextBackfillPage(stateWith({ lastSeenUid: 1n }), 511, 200)).toBeNull();
  });

  it('returns null for a folder already marked backfill_done, whatever else it is told', () => {
    // Terminal means terminal: even a state that still carries a high
    // watermark, and an oldest-synced UID far above 1, must not produce
    // another page.
    const done = stateWith({ lastSeenUid: 900n, backfillDone: true });
    expect(nextBackfillPage(done, 5000, 200)).toBeNull();
  });

  it('returns null for an empty folder — there is nothing to walk backwards from', () => {
    // No sync_state row AND no synced rows: live sync has not landed
    // anything here yet. Declining is the point — picking the mailbox's
    // top as a floor instead would re-download the newest 50 UIDs live
    // sync owns, on every cycle, forever.
    expect(nextBackfillPage(null, null, 200)).toBeNull();
    expect(backfillFloor(null, null)).toBeNull();
  });

  it('treats a zero watermark on an existing row as "no watermark yet"', () => {
    // `last_seen_uid` defaults to 0 in the schema, and 0 is not a legal
    // UID. A row that exists but has never been written by a backfill must
    // fall through to the oldest synced row, not produce a page below 0.
    expect(backfillFloor(stateWith({ lastSeenUid: 0n }), 511)).toBe(511);
    expect(nextBackfillPage(stateWith({ lastSeenUid: 0n }), 511, 200))
      .toEqual({ lowestUid: 311, highestUid: 510 });
  });

  it('yields exactly one UID when the floor is 2', () => {
    expect(nextBackfillPage(stateWith({ lastSeenUid: 2n }), 511, 200))
      .toEqual({ lowestUid: 1, highestUid: 1 });
  });

  it('yields a full page, not a clamped one, at the exact boundary', () => {
    // floor = pageSize + 1 is the last floor that still produces a page of
    // exactly pageSize UIDs. One lower and the clamp engages.
    expect(nextBackfillPage(stateWith({ lastSeenUid: 201n }), 511, 200))
      .toEqual({ lowestUid: 1, highestUid: 200 });
  });

  it('tiles the mailbox with neither a gap nor an overlap across consecutive pages', () => {
    // The property that actually matters, walked end to end: feed each
    // page's own lowestUid back as the next watermark — exactly what
    // runBackfillPage persists — and assert the spans abut perfectly and
    // the walk terminates.
    const covered: boolean[] = new Array(500).fill(false);
    let state: SyncStateInput | null = null;
    let pages = 0;

    for (let page = nextBackfillPage(state, 500, 200); page !== null; ) {
      pages += 1;
      for (let uid = page.lowestUid; uid <= page.highestUid; uid += 1) {
        expect(covered[uid - 1], `uid ${uid} fetched twice`).toBe(false);
        covered[uid - 1] = true;
      }
      state = stateWith({ lastSeenUid: BigInt(page.lowestUid) });
      page = nextBackfillPage(state, 500, 200);
      expect(pages, 'walk did not terminate').toBeLessThan(10);
    }

    // Everything below the oldest synced row (500) is covered exactly
    // once; 500 itself is live sync's, and was never re-fetched.
    for (let uid = 1; uid <= 499; uid += 1) {
      expect(covered[uid - 1], `uid ${uid} was never fetched`).toBe(true);
    }
    expect(covered[499]).toBe(false);
    expect(pages).toBe(3); // 300-499, 100-299, 1-99
  });

  it('refuses to build a range for a non-positive page size', () => {
    expect(nextBackfillPage(null, 511, 0)).toBeNull();
    expect(nextBackfillPage(null, 511, -5)).toBeNull();
  });

  it('defaults to BACKFILL_PAGE_SIZE when no page size is given', () => {
    expect(nextBackfillPage(null, 1000)).toEqual({
      lowestUid: 1000 - BACKFILL_PAGE_SIZE,
      highestUid: 999,
    });
  });
});

describe('isRenumbered — the guard that makes backfill_done revocable', () => {
  // `backfill_done` is terminal and live sync only polls the newest 50, so
  // a renumbering AFTER that flag is set would make the whole renumbered
  // history below that window permanently unreachable. Every folder
  // reaches the flag within about a day, which is what arms it.

  it('is true when the stored numbering differs from the live one', () => {
    expect(isRenumbered(stateWith({ uidValidity: 1n, backfillDone: true }), 2n)).toBe(true);
  });

  it('is false when the numbering is unchanged — the overwhelmingly common path', () => {
    // The inverse matters more than the reset: an implementation that
    // re-walked every folder on every cycle would also pass a test that
    // only proved the reset fires.
    expect(isRenumbered(stateWith({ uidValidity: 7n, backfillDone: true }), 7n)).toBe(false);
  });

  it('is false whenever either side is unknown, so cannot-tell never re-walks', () => {
    // A folder whose live sync threw this cycle reports null. Treating
    // that as a renumbering would re-walk finished folders on every
    // transient per-folder error.
    expect(isRenumbered(stateWith({ uidValidity: 1n }), null)).toBe(false);
    expect(isRenumbered(stateWith({ uidValidity: null }), 2n)).toBe(false);
    expect(isRenumbered(null, 2n)).toBe(false);
    expect(isRenumbered(null, null)).toBe(false);
  });
});

describe('backfill budget arithmetic', () => {
  it('caps a backfill at BACKFILL_SHARE of the daily limit, leaving the rest for live sync', () => {
    // Derived, never a duplicated literal: tuning BACKFILL_SHARE must move
    // this ceiling with it rather than leaving two numbers to drift.
    expect(BACKFILL_BYTE_LIMIT).toBe(Math.floor(DAILY_BYTE_LIMIT * BACKFILL_SHARE));
    expect(BACKFILL_BYTE_LIMIT).toBeLessThan(DAILY_BYTE_LIMIT);
    expect(DAILY_BYTE_LIMIT - BACKFILL_BYTE_LIMIT).toBeGreaterThan(0);
  });

  it('reserves a page\'s previews up front, alongside its headers', () => {
    // A preview reservation refused AFTER the page is fetched leaves those
    // rows with snippet null forever — backfill never revisits a span,
    // unlike live sync's re-poll. Reserving both together means a page is
    // attempted only when both fit, so the watermark cannot move past a
    // span whose previews were refused.
    expect(ESTIMATED_BYTES_PER_BACKFILLED_MESSAGE).toBe(
      ESTIMATED_BYTES_PER_HEADER_FETCH + ESTIMATED_BYTES_PER_PREVIEW_FETCH,
    );
    expect(BACKFILL_PAGE_SIZE * ESTIMATED_BYTES_PER_BACKFILLED_MESSAGE).toBe(614_400);
  });

  it('sizes one page at roughly 400 KB of headers', () => {
    // The arithmetic stated in BACKFILL_PAGE_SIZE's own comment, asserted
    // so the comment cannot quietly stop being true.
    expect(BACKFILL_PAGE_SIZE * ESTIMATED_BYTES_PER_HEADER_FETCH).toBe(409_600);
  });

  it('leaves room for many pages a day inside the share', () => {
    // Sanity on the shape of the whole plan: if one page nearly filled the
    // share, a backfill would take years and this feature would not work
    // at all.
    const pagesPerDay = BACKFILL_BYTE_LIMIT / (BACKFILL_PAGE_SIZE * ESTIMATED_BYTES_PER_BACKFILLED_MESSAGE);
    expect(pagesPerDay).toBeGreaterThan(1000);
  });
});
