# Historical Backfill Implementation Plan (Plan 8)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Sync mail history, not just the newest 50 UIDs per folder — the blocker
between Valen Mail and the user's stated goal of never opening Gmail again.

**Measured problem (2026-08-25):** INBOX depth is **3 days** on primary, 6 on
personal, 14-15 on harvard/masterman. Search and browse only reach that window.

**Architecture:** A second, lower-priority pass beside the live sync. Live sync keeps
IDLE and the newest-UID poll exactly as they are; backfill walks *backwards* from the
oldest synced UID per (account, folder), in bounded pages, spending only the budget
share reserved for it, resumable across restarts.

**Spec:** 2026-08-23 spec (Gmail ~2.5GB/day, ~15 connection ceiling); Plan 2 reserved
the machinery for exactly this task.

## Global Constraints
- **The scaffolding already exists and was written for this.** `BACKFILL_SHARE = 0.7`
  (`sync/src/budget.ts:20`), `sync_state.backfill_done` (`schema.sql:109`) with a
  comment stating it is retained for a later backfill task, and `getSyncState`/
  `setSyncState` already read and write it. **No schema change.** Use them; update
  `schema.sql:95-103`'s now-obsolete comment.
- **Live sync's behaviour must not change.** IDLE stays INBOX-only, the newest-50 poll
  stays, notifications stay INBOX-only-and-first-cycle-suppressed. Backfilled messages
  MUST NOT notify — they are old mail by definition. A test proves a backfill page
  produces zero dispatch calls.
- **One connection per account.** Gmail's ~15-connection ceiling and this project's
  reconnect-storm history both forbid a second connection. Backfill runs inside the
  existing per-account cycle, under the existing mutex, after live sync.
- **Budget-first, not time-first.** Every backfill page charges the byte budget; when
  the backfill share is exhausted for the day, it stops until the budget rolls over.
  `HEADER_FETCH_OPTIONS` stays frozen — backfill uses the same header-only shape and
  the same accounting, plus Plan 7's preview fetch if that has landed.
- Resumable: progress is a UID watermark in `sync_state`, written after each page, so
  a restart resumes rather than restarting.
- Terminating: when a folder reaches UID 1 (or its lowest existing UID), mark
  `backfill_done` and stop paging it forever.
- $0, no new dependencies.

---

### Task 1: the backfill pass
**Files:** Create `sync/src/imap/backfill.ts`; Modify `sync/src/imap/pool.ts` (call it
inside the existing cycle), `sync/src/db.ts` (an oldest-UID query + watermark helpers).

- `nextBackfillPage(state, oldestSyncedUid)` → the UID span to fetch next, or null when
  done. Pure and unit-tested; page size a named constant (start at 200 — a header page
  is ~2KB/message, so ~400KB/page).
- The pass runs **after** live sync in the same cycle, only if the backfill budget
  share has room, only if `backfill_done` is false.
- Writes go through the existing `upsertMessage` (idempotent on `(account_id, folder,
  uid)`), so an overlapping page is harmless.
- **Suppression:** backfilled messages never reach `onNewMessages`. Verify against
  `NewMailMarks` — the high-water mark must not move backwards, and a backfill page of
  low UIDs must not register as "new".
- Progress logging: one line per completed page (account, folder, span, bytes) so the
  operator can watch it and stop guessing.

### Task 2: exposure + control
**Files:** Modify `sync/src/api/routes.ts` (extend `/api/health`), `client/` (a small
progress affordance).
- `/api/health` gains per-(account, folder) backfill state: `done` / oldest UID /
  oldest date. It is already the unauthenticated route — expose **counts and dates
  only, never subjects or addresses**.
- Client: a quiet line in the sidebar or settings showing how far back mail goes, and
  that it is still filling. Not a progress bar demanding attention — the user should be
  able to ignore it.

### Task 3: run it and verify
Controller-executed. Deploy, then watch: budget consumption stays inside the
backfill share, live sync latency is unaffected, notifications stay silent for old
mail, and the oldest-date figures actually move. Report the depth reached per account.

## Self-Review
Coverage: depth→T1, visibility→T2, proof→T3. The three hazards are named and each has
a test: notifications on old mail, a second connection, and budget starvation of live
sync. No schema change; no placeholders.
