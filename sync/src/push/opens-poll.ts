import type { Db, SyncStateInput } from '../db';
import type { TrackingConfig } from '../config';
import type { VapidConfig } from './vapid';
import type { OpenEvent } from '../api/opens';
import { fetchOpens } from '../api/opens.ts';
import { MAX_LIMIT } from '../api/limits.ts';
import { notifyOpens } from './dispatch.ts';
import type { SendImpl } from './send';

/**
 * Cadence for checking the tracking service for new opens. A minute is
 * ample for a personal tool and costs the tracking service almost nothing
 * (task-7-brief.md).
 */
export const OPENS_POLL_INTERVAL_MS = 60_000;

/** How many of the newest events to ask for on each poll. MAX_LIMIT
 *  (200) rather than the smaller DEFAULT_LIMIT: this poll runs every
 *  60s specifically so it never needs to page, and asking for the
 *  largest single page the tracking service allows maximises the chance
 *  that a burst of opens between two ticks is caught in full. If more
 *  than 200 confirmed opens land inside one 60s window — implausible for
 *  a personal mailbox — the oldest of that burst would be missed; that is
 *  an accepted limitation of a single-page poll, not pagination this
 *  module implements. */
const OPENS_POLL_PAGE_SIZE = MAX_LIMIT;

/**
 * sync_state's real primary key is (account_id, folder) and its real job
 * is an IMAP resume point for a future backfill (Plan 2, not yet wired —
 * see schema.sql's own comment on the table). The opens poll is not IMAP
 * sync and has no account or folder of its own, but the brief is explicit:
 * reuse the EXISTING table's pattern rather than add a new one for this.
 * These two sentinel values are not a real account or folder — they are
 * this poll's one single row in that table, using the `last_seen_uid`
 * column (already a monotonic high-water-mark column) to hold the newest
 * `occurredAt` (epoch ms) already notified. `uid_validity` and
 * `backfill_done` are meaningless for this row and always written as
 * null/false. `sync_state` has no foreign key to `accounts`, so an
 * arbitrary sentinel string is a valid row, and one deliberately
 * unlike any real account id (all real ids come from accounts.json).
 */
const SYNC_STATE_ACCOUNT_ID = '__opens_poll__';
const SYNC_STATE_FOLDER = '__opens_poll__';

async function readLastSeenOccurredAt(db: Db): Promise<number | null> {
  const state = await db.getSyncState(SYNC_STATE_ACCOUNT_ID, SYNC_STATE_FOLDER);
  // Epoch milliseconds today (2026) is ~1.8e12, nowhere near
  // Number.MAX_SAFE_INTEGER (2^53 ~= 9e15) — safe for centuries.
  return state ? Number(state.lastSeenUid) : null;
}

async function writeLastSeenOccurredAt(db: Db, occurredAt: number): Promise<void> {
  const state: SyncStateInput = {
    uidValidity: null,
    lastSeenUid: BigInt(Math.trunc(occurredAt)),
    backfillDone: false,
  };
  await db.setSyncState(SYNC_STATE_ACCOUNT_ID, SYNC_STATE_FOLDER, state);
}

function newestOccurredAt(events: readonly OpenEvent[]): number | null {
  if (events.length === 0) return null;
  return events.reduce((max, event) => Math.max(max, event.occurredAt), -Infinity);
}

export interface OpensPoll {
  /** Starts polling on OPENS_POLL_INTERVAL_MS cadence, firing an
   *  immediate first check rather than waiting out the first interval.
   *  Calling this a second time on an already-started poll is a no-op —
   *  it does not create a second overlapping timer. */
  start(): void;
  /** Stops the interval. Safe to call whether or not start() was ever
   *  called. Does not wait for an in-flight tick to finish — the tick
   *  itself never throws (see tick()'s own doc comment), so there is
   *  nothing for a caller to await here beyond clearing the timer. */
  stop(): Promise<void>;
  /** Runs one poll cycle immediately, outside the timer. This is the unit
   *  under test for every behavioural property (down-state transitions,
   *  first-run baseline, persistence, notify filtering) — only the
   *  cadence itself needs start()/stop() and a timer. */
  tick(): Promise<void>;
}

export interface OpensPollDeps {
  /** Threaded straight through to `fetchOpens`'s own `fetchImpl` seam
   *  (../api/opens.ts). Production never passes this. */
  readonly fetchImpl?: typeof fetch;
  /** Threaded straight through to `notifyOpens`'s `sendImpl` seam
   *  (./dispatch.ts), which is itself `sendPush`'s own seam
   *  (./send.ts). Production never passes this. */
  readonly sendImpl?: SendImpl;
}

/**
 * Polls the tracking service for open events and dispatches confirmed-open
 * push notifications.
 *
 * Down-state logging: `fetchOpens` already logs the SPECIFIC reason
 * ('unreachable' / 'upstream_error') on every single failed call (see
 * ../api/opens.ts) — that is correct for a request made on behalf of a
 * live HTTP client, where every failure is its own incident. Logging
 * again here on every failed tick would mean a log line once a minute for
 * as long as the tracking service is down, which is exactly the "must not
 * spam logs at 1/min" the brief warns against. This module instead logs
 * its OWN line only on a state TRANSITION (up -> down, down -> up), which
 * tells an operator when an outage started and when it ended without
 * drowning that signal in identical lines in between.
 */
export function createOpensPoll(
  db: Db,
  vapid: VapidConfig,
  tracking: TrackingConfig,
  deps: OpensPollDeps = {},
): OpensPoll {
  let timer: ReturnType<typeof setInterval> | null = null;
  // Optimistic default: if the very first tick ever run succeeds, nothing
  // was ever observed to be down, so there is nothing to report "back up"
  // from.
  let wasUp = true;

  async function tick(): Promise<void> {
    const result = await fetchOpens(OPENS_POLL_PAGE_SIZE, {
      baseUrl: tracking.baseUrl,
      token: tracking.readToken,
      fetchImpl: deps.fetchImpl,
    });

    if (!result.ok) {
      if (wasUp) {
        console.error(
          `push: opens poll — tracking service is down (${result.reason}); will keep retrying ` +
            `quietly every ${OPENS_POLL_INTERVAL_MS / 1000}s`,
        );
        wasUp = false;
      }
      return;
    }

    if (!wasUp) {
      console.error('push: opens poll — tracking service is back up');
      wasUp = true;
    }

    const lastSeen = await readLastSeenOccurredAt(db);

    if (lastSeen === null) {
      // First-ever run for this deployment (no persisted row at all):
      // establish the baseline at the newest existing event rather than
      // notifying the whole backlog — the same principle as Amendment 3's
      // mail backfill guard, applied to a durably-persisted watermark
      // instead of an in-memory one, because unlike the IMAP pool this
      // poll DOES have somewhere safe to persist a real resume point.
      //
      // Written EVEN WHEN there are zero events yet (newestOccurredAt ??
      // 0): a real occurredAt is always a large positive epoch-ms number,
      // so 0 is a safe "nothing has ever been seen" floor that any
      // genuine future event compares greater than. Without this, a poll
      // that starts against a currently-empty opens table would never
      // persist a baseline at all, and the FIRST tick to actually see an
      // event — even one that arrives minutes later, a genuinely new open
      // — would be wrongly treated as "first-ever run" all over again and
      // silently swallowed instead of notified.
      await writeLastSeenOccurredAt(db, newestOccurredAt(result.opens) ?? 0);
      return;
    }

    const freshEvents = result.opens.filter((event) => event.occurredAt > lastSeen);
    if (freshEvents.length === 0) return;

    await notifyOpens(db, vapid, freshEvents, deps.sendImpl);

    const newest = newestOccurredAt(freshEvents);
    if (newest !== null) await writeLastSeenOccurredAt(db, newest);
  }

  /** Never lets a tick's own failure escape to whatever scheduled it —
   *  every await inside tick() is already wrapped by fetchOpens's and
   *  notifyOpens's own never-throw contracts, but this is the backstop:
   *  a poll cycle failing must not take down the setInterval callback
   *  (an uncaught rejection there is merely logged by Node, not fatal,
   *  but silently logging via Node's own default handler is worse than
   *  this module choosing its own message) or reject a caller's direct
   *  `await poll.tick()` in a test. */
  async function safeTick(): Promise<void> {
    try {
      await tick();
    } catch (error) {
      console.error('push: opens poll cycle failed', error);
    }
  }

  return {
    start() {
      if (timer) return; // already running — not a second overlapping timer.
      timer = setInterval(() => {
        void safeTick();
      }, OPENS_POLL_INTERVAL_MS);
      void safeTick();
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    tick: safeTick,
  };
}
