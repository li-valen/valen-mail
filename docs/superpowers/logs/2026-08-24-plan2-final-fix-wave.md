# Plan 2 — final fix wave (whole-branch review of `sync-service`)

Date: 2026-08-24
Branch: `sync-service`, base `edf67b8`
Scope: `sync/` only. `tracking/` untouched.

Single fix wave: F1–F8, the documentation corrections, and the cheap items.

## Gates

All three pass, run from `sync/`:

| Gate | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run check:runtime` | `runtime import OK (11 modules)` |
| `TEST_DATABASE_URL=… npx vitest run` | **201 passed, 9 skipped (210)**, 12 files passed / 2 skipped |

Baseline at `edf67b8` was 131 passed / 9 skipped (140). The 9 skips are the two
opt-in live-Gmail suites (`tests/fetch.test.ts`, `tests/connection.test.ts`),
unchanged. **No live Gmail connection was opened at any point.**

## Method note on mutation evidence

Every mutation below was applied to the real source, the named suite was run,
and the source was restored from a pristine copy immediately afterwards. The
final gate run above was performed after all restorations; `grep -c MUTATION
src/` returns 0.

---

## F1 (Critical) — reconnect backoff reset on connect success

**Changed.** `sync/src/imap/pool.ts` `runAccount()`, ~line 346.

`attempt = 0` moved from immediately after `connection.connect()` resolves to
immediately after `this.syncOnce(...)` returns. A successful TCP + auth
handshake no longer resets the ladder; only a completed sync cycle (reserve →
fetch → upsert → record) does. The reasoning is recorded inline at the site,
including the measured 8-connects-in-6-seconds figure, so the next person to
read that line sees why it is where it is.

**Tests:** `sync/tests/pool-sync-cycle.test.ts`

- `keeps reconnects bounded when every sync cycle fails after a successful connect (F1)` —
  drives the real pool with a `Db` whose every `query()` throws (a Postgres
  outage as `ByteBudget.reserve` sees it) under `vi.useFakeTimers()`, advances
  60 simulated seconds, and asserts `connect` was called at most 10 times, and
  more than once. Then advances a further 5 simulated minutes and asserts at
  most 8 further attempts — the ladder must keep growing, not plateau.
- `does reset the backoff ladder once a sync cycle actually completes (F1)` —
  the complement, so the fix cannot degrade into "never reset".

**Mutation:** restored `attempt = 0` onto the line after
`statuses.set(id, 'connected')` and removed the post-`syncOnce` reset.
→ `keeps reconnects bounded when every sync cycle fails after a successful connect (F1)` FAILED.
Re-verified after the test-file split; still fails.

As the finding predicted, the pre-existing
`reconnects with backoff when the liveness probe fails after IDLE ends unexpectedly`
passed under the mutation, confirming it was never protection.

**Residual, stated plainly:** the finding's prescription is "reset only after a
completed sync cycle", which is what shipped. One narrower thrash window
remains: a connection that connects, completes one sync cycle, and *then* fails
immediately inside `idleLoop` (e.g. `probeLiveness` rejecting on the first
pass, every pass) still resets `attempt` to 0 each time. Closing that would
need either uptime tracking or an N-completed-cycles rule, neither of which the
finding asked for, and both of which add a clock or a counter to the loop. The
three triggers the finding named — Postgres restart/OOM-kill, mailbox that
fails to open, IMAP-suspended account — all fail *inside* `syncOnce` and are
fully covered.

---

## F2 (Important) — `isPrimary` count unvalidated

**Changed, three places.**

1. `sync/src/config.ts` `loadConfig()`, ~line 100 — counts primaries and throws
   unless exactly one. Placed *after* the duplicate-id/email loop so a config
   with two problems still reports the more specific one first (the existing
   `rejects duplicate account ids` fixture has two primaries and would
   otherwise have started failing with the wrong message).
2. `sync/src/schema.sql`, ~line 20 — `create unique index if not exists
   accounts_one_primary on accounts (is_primary) where is_primary;` exactly as
   specified.
3. `sync/src/api/server.ts` `registerAccounts()` — see "Consequence" below.

**Test rewritten, explicitly:** `allows isPrimary to be absent and defaults to
false` asserted the spec violation and is gone. In its place, in
`sync/tests/config.test.ts`:

- `rejects a config where no account is primary (spec 7B.1)` (asserts the throw
  and `found 0`)
- `rejects a config where more than one account is primary (spec 7B.1)`
  (`found 2`)
- `still defaults an absent isPrimary to false when a different account is primary`
  — this is the behaviour the deleted test was really guarding, kept intact.
- `accepts the shipped accounts.example.json shape (exactly one primary)`

And in `sync/tests/db.test.ts`:
`rejects a second primary account at the database level (spec 7B.1)`.

**Mutations:**
- Neutered the `primaryCount !== 1` check in `loadConfig` → both new config
  tests FAILED.
- Removed the index from `schema.sql` and dropped it from the test database →
  `rejects a second primary account at the database level` FAILED.

**Live config:** `sync/accounts.json` holds 4 accounts with exactly 1 primary
(id `primary`), so the running deployment already satisfies the new rule. (The
brief named `xinfinitypro`; the actual primary id in the file is `primary`. The
count — the thing that matters — is 1.)

**Consequence I had to handle:** with the unique index in place,
`registerAccounts` upserting a *new* primary before the old one has been
demoted is a constraint violation whose likelihood depends purely on the order
of the accounts array. `registerAccounts` now runs
`update accounts set is_primary = false where is_primary` before the upsert
loop. Covered by `moves the primary flag between accounts without violating the
unique index` (deliberately orders the new primary first) and `is a no-op on an
unchanged accounts file`. **Mutation:** removed the clearing update →
`moves the primary flag…` FAILED with `duplicate key value violates unique
constraint`.

**Two caveats worth knowing before deploying:**
- `applySchema` will now *fail startup* on an existing database that already
  holds two primaries. That is deliberate (documented in `schema.sql`): fix the
  data, then restart. The current data has one primary, so this will not fire.
- The clearing update and the upserts are separate statements on a pooled
  connection, not one transaction, so there is a sub-millisecond startup window
  with no primary row. Nothing reads `is_primary` yet (Plan 4 will), and
  wrapping it would mean threading a client through `Db`, which is a larger
  change than this finding warrants.

---

## F3 (Important) — unbounded on-demand fetch, bypassing the byte budget

**(a) Memory — partially fixed, see "buffering remains" below.**

- `sync/src/imap/fetch.ts`: new `MAX_BODY_PART_BYTES = 32 * 1024 * 1024` and
  `BodyPartTooLargeError`. `fetchBodyPart` takes a `maxBytes` parameter
  (defaulting to the constant) and checks the running total *before retaining
  each chunk*, so an oversized part is abandoned partway rather than fully
  accumulated and then rejected. The choice of 32 MB is documented at the
  constant: comfortably under Gmail's 50 MB message ceiling (so the cap is
  actually reachable rather than dead code), covers essentially every
  human-sent attachment, and keeps peak footprint a small fraction of 1 GB.
- `sync/src/api/server.ts` `writeWebResponse`: replaced
  `Buffer.from(await response.arrayBuffer())` with
  `pipeline(Readable.fromWeb(response.body), nodeResponse)`. Both are Node
  built-ins — **no new dependency**. This removes one of the two full copies
  and gets real backpressure instead of one `end(buffer)`.

**(b) Spec L6 — fixed.** `sync/src/api/routes.ts` gains `fetchBudgetedPart`,
the single path by which the API pulls bytes off an IMAP connection. It does
three things that must happen together: holds the account lock (F8), reserves
`MAX_BODY_PART_BYTES` (the worst case — the size is not knowable before the
fetch) and records `bytes.length` (the measured truth) after, and maps
`BodyPartTooLargeError` to **413** while leaving a genuine IMAP failure to the
callers' existing **502**. A refused reservation returns **429** and never
touches IMAP. On a 413 the cap is recorded as a conservative floor, because
those bytes really did cross the wire.

**Tests:**
- `sync/tests/fetch-unit.test.ts` → `fetchBodyPart size cap`: returns the
  concatenation under the cap; throws `BodyPartTooLargeError` over it;
  **stops consuming the stream at the chunk that crosses the cap** (asserts the
  third chunk is never pulled); carries `limitBytes`; releases the mailbox lock
  on the abort path; the default is 32 MB and below Gmail's 50 MB ceiling.
- `sync/tests/routes-fetch.test.ts` → `router / on-demand fetch budgeting and
  bounds (F3, F8, spec L6)`: reserves the worst case and records the measured
  bytes on both routes; 429 with zero IMAP calls when the budget is exhausted;
  413 on both routes with the bytes still charged.
- `sync/tests/server.test.ts` → `writeWebResponse`: passes raw binary through
  byte for byte (including a lone `0xFF` with no UTF-8 interpretation),
  carries status/headers, ends cleanly on a null body.

**Mutations:**
- Removed the `total > maxBytes` check → 4 `fetchBodyPart size cap` tests FAILED.
- Removed `byteBudget.record(...)` from `fetchBudgetedPart` → 2 budget tests FAILED.
- Neutered the `!decision.allowed` branch → the 429 test FAILED.
- Reverted `writeWebResponse` to `await response.text()` → `passes raw binary
  through byte for byte` FAILED (the 0xFF is replaced by U+FFFD).

**Buffering remains — stated clearly, as the finding asked.** The part is still
fully buffered once, inside `fetchBodyPart`, before the `Response` is built.
Peak is therefore roughly **2× the part size, hard-capped at 32 MB → ~64 MB
worst case**, down from ~3× uncapped (~150 MB for a 50 MB Gmail message).
Full IMAP-socket-to-HTTP-socket streaming is genuinely out of scope here: the
per-account `KeyedMutex` and the imapflow mailbox lock must be held for the
whole transfer, and the transfer would finish in `server.ts`'s
`writeWebResponse` — *outside* the router that acquired them. Making that safe
means restructuring the lock lifetime to span the response write, which is a
larger change than this fix, and getting it wrong reintroduces F8.

---

## F4 (Important) — nothing wired shutdown to a signal

**Changed.** `sync/src/api/server.ts`:

- `createShutdown(server, pool, db)` — reordered to `server.close()` →
  `pool.stop()` → `db.close()`, so in-flight requests drain before the
  resources they depend on go away.
- `onceOnly(fn)` — caches the in-flight promise **and does not clear it on
  settle**; shutdown is terminal.
- `registerShutdownHandlers(close, emitter = process, exit = process.exit)` —
  wires SIGTERM and SIGINT, guards against a second signal starting a second
  teardown, exits 0 on success and 1 on failure. `emitter` and `exit` are
  injectable purely so a test can drive a signal without signalling (or
  exiting) the vitest process.
- `startServer()` now calls both, so the handlers actually exist in production.

`sync/src/imap/connection.ts`: `client.logout()` wrapped in `withTimeout(...,
LOGOUT_TIMEOUT_MS = 5_000, 'IMAP LOGOUT')`. `withTimeout` moved out of
`pool.ts` into a new `sync/src/timeout.ts` — importing it from `pool.ts` would
have made `connection.ts` ↔ `pool.ts` circular, which is exactly the class of
thing that has broken this build before.

**Tests:** `sync/tests/server.test.ts` (`createShutdown`, `onceOnly`,
`registerShutdownHandlers` — 10 tests) and
`sync/tests/connection-lifecycle.test.ts` (2 tests). Highlights: a
signal-triggered shutdown completes in `server → pool → db` order and exits 0;
three signals produce exactly one `server.close()`; `disconnect()` **resolves**
(never rejects) when `logout()` never returns, and logs the account id.

**Mutations:**
- Reverted the order to `pool → db → server` → 5 tests FAILED.
- Made `onceOnly` return `fn` unwrapped → 3 tests FAILED.
- Removed the `emitter.on('SIGTERM'/'SIGINT')` registrations → 5 tests FAILED
  (`registers handlers for both signals` fails immediately; the four
  signal-driven ones fail by timeout, which is a slow but unambiguous failure).
- Removed the `withTimeout` around `logout()` → `gives up on a logout() that
  never returns` FAILED by timeout.
- Attached the original error as `cause` (F6, below) → 1 test FAILED.

---

## F5 (Important) — `syncOnce` discarded attachments

**Changed.**

- `sync/src/db.ts`: new `AttachmentInput` and `Db.upsertAttachment`,
  parameterised and idempotent on `(account_id, folder, uid, part_id)`.
- `sync/src/imap/pool.ts`: `syncOnce` now calls `persistAttachments` for each
  message, **after** that message's `upsertMessage` — the `attachments` table
  has an FK onto `messages(account_id, folder, uid)`, so the reverse order
  fails outright on a first-seen message.
- `sync/src/db.ts`: `MESSAGE_SELECT` — a shared `LEFT JOIN LATERAL` +
  `json_agg` that attaches each message's attachment metadata (`partId`,
  `filename`, `mimeType`, `sizeBytes`) to `/api/inbox` and `/api/thread` rows,
  `coalesce`d to `'[]'` so a client sees an empty array rather than null. One
  round trip; the aggregate probes `attachments` on its PK prefix.

**Latent bug also fixed:** `sanitizeFilename` (stripped only `\r\n"`) replaced
by `contentDispositionFor`, emitting RFC 6266
`attachment; filename="<latin-1 fallback>"; filename*=UTF-8''<pct-encoded>`.
The fallback replaces everything outside printable ASCII plus `"` and `\` with
`_`. The `filename*` half additionally percent-encodes `'()!*`, which
`encodeURIComponent` leaves alone but RFC 5987's `attr-char` set excludes.

I verified the original failure mode directly on this machine: a
`content-disposition` containing `発表資料.pdf` makes **both** the `Response`
constructor throw (`Cannot convert argument to a ByteString … value of 30330`)
**and** `ServerResponse.writeHead` throw `ERR_INVALID_CHAR`. In this codebase
the `new Response(...)` is inside `handleAttachment`'s `try`, so the observable
symptom would have been a **502**, not the 500 the finding predicted — same
severity, different status code.

**Behaviour change I am flagging explicitly:** two existing assertions on the
exact `content-disposition` value had to change, because the value legitimately
changed. `attachment; filename="invoice.pdf"` is now
`attachment; filename="invoice.pdf"; filename*=UTF-8''invoice.pdf`, and
`attachment; filename="evil_.pdf"` gains `; filename*=UTF-8''evil%22.pdf`.
Neither assertion was weakened — both still pin the full header value exactly.

**Tests:** `sync/tests/pool-sync-cycle.test.ts` (3: persists the walk's output
with exact field mapping; message row written before its attachment rows; no
rows for an attachment-free message), `sync/tests/db.test.ts` (4: idempotent
upsert on the composite key; metadata present on inbox and thread; `[]` not
null), `sync/tests/routes-fetch.test.ts` (5: the two updated exact-value
assertions, CRLF stripping, a parameterised pair for `発表資料.pdf` and
`résumé.pdf` asserting the whole header is Latin-1-representable, and the RFC
5987 `attr-char` case).

**Mutations:**
- Dropped the `persistAttachments` call → 2 pool tests FAILED.
- Dropped the `attachments` column from `MESSAGE_SELECT` → 3 db tests FAILED.
- Restored the old `sanitizeFilename` one-liner → 5 route tests FAILED,
  including both non-ASCII cases.

---

## F6 (Important) — `JSON.parse` echoing an app-password fragment

**Changed.** `sync/src/api/server.ts`: new exported
`parseAccountsJson(contents, sourceLabel)` throwing
`new Error(\`${sourceLabel} is not valid JSON\`)` with **no `cause`**.
`startServer` calls it instead of bare `JSON.parse`.

Taking the file contents plus a label (rather than doing the `readFileSync`
itself) is what makes it testable without writing a temp file.

I reproduced the leak on this machine before fixing it:
`Unexpected token 'S', ..."assword": SECRETPW12"... is not valid JSON`.

**Test:** `sync/tests/server.test.ts` →
`never echoes the surrounding source, which for the realistic failure is the app password`.
It first asserts that raw `JSON.parse` on the same input *does* leak
`SECRETPW12` — so the test cannot pass because the fixture was harmless — then
asserts the thrown error's `message`, `cause`, `stack` and full own-property
JSON stringification all omit it.

**Mutations:**
- Added `{ cause: error }` → FAILED on the `cause` assertion. (This is why
  `cause` is asserted separately: `console.error` and Node's default
  unhandled-rejection handler both print it, so attaching it reintroduces the
  leak through a different channel.)
- Rethrew the raw `SyntaxError` → 2 tests FAILED.

---

## F7 (Important) — lossy unified-inbox ordering and pagination

**Changed.** `sync/src/db.ts`:

- `INBOX_ORDER` is now
  `order by coalesce(m.date, '-infinity'::timestamptz) desc, m.account_id desc, m.uid desc`.
  The `coalesce` sentinel (rather than `nulls last`) is deliberate: it makes
  every ordering column non-null and same-direction, which is what lets the
  cursor be a single row-value comparison instead of a hand-expanded OR chain
  over the NULL cases — and it lets one expression index match the ordering
  exactly.
- New `InboxCursor { date, accountId, uid }` and `buildInboxFilter`, with three
  branches: full keyset
  (`(coalesce(date,'-inf'), account_id, uid) < (coalesce($1,'-inf'), $2, $3)`),
  date-only (backward tolerance), and none.
- `sync/src/schema.sql`: `messages_unified_keyset` on
  `((coalesce(date, '-infinity'::timestamptz)) desc, account_id desc, uid desc)`.
  Verified this expression index is accepted by the deployment's Postgres
  (16.15) before relying on it.
- `sync/src/api/routes.ts`: `parseInboxCursor` accepts `before` +
  `beforeAccount` + `beforeUid` (lossless), `before` alone (backward-tolerant,
  unchanged semantics for an existing client), or `beforeAccount`/`beforeUid`
  with no `before` (the NULL-date tail, which a bare timestamp can never
  address). `/api/inbox` now also emits `nextCursor`, so lossless paging is the
  default rather than something a client must know to construct.

**Tests:** `sync/tests/db.test.ts` → `unified inbox ordering and pagination`
(5, against real Postgres, with a fixture of three rows sharing one
second-resolution timestamp across two accounts plus one NULL-date row):
NULL-date sorts last; **a full paginating loop at `limit: 2` returns all five
rows in order with no duplicates and no drops**; the cursor reaches the
NULL-date tail; a bare timestamp still works; ties order deterministically.
Plus 7 cursor-parsing and `nextCursor` tests in `sync/tests/routes.test.ts`.

**Mutations:**
- Reverted the ordering to `order by m.date desc, …` → 3 db tests FAILED.
- Reverted the keyset predicate to `where m.date < $1` → 2 db tests FAILED
  (including the full paging loop, which drops `tie-a-101` and `tie-a-100`).

---

## F8 (Important) — liveness probe tearing down a healthy download

**Changed.** `sync/src/imap/pool.ts` gains
`withAccountLock<T>(accountId, fn)` (delegating to the same `KeyedMutex` and
the same key `syncOnce` uses) and a `byteBudget` getter returning the pool's
own `ByteBudget` instance. `sync/src/api/routes.ts`'s `fetchBudgetedPart` does
reserve → fetch → record inside that one critical section, composing with F3
exactly as the finding suggested.

**Tests:**
- `sync/tests/pool-sync-cycle.test.ts` →
  `serialises an on-demand API fetch against the account sync cycle (F8)`:
  launches a real pool, holds `withAccountLock('a')` open, fires the `exists`
  event, and asserts the sync cycle has **not** run; releases, and asserts it
  then does.
- `withAccountLock leaves different accounts fully concurrent (F8)` — the
  serialisation must not cost the ten-account concurrency the keyed mutex
  exists to preserve.
- `exposes the same ByteBudget instance the sync loop charges (F3/L6)` — a
  fresh `ByteBudget` would keep two separate running totals and enforce the
  ceiling against neither.
- `sync/tests/routes-fetch.test.ts` → `holds the account lock for the whole
  fetch (F8)` asserts both routes go through the lock with the right key.

**Mutation:** made `withAccountLock` call `fn()` directly instead of going
through the mutex → `serialises an on-demand API fetch against the account sync
cycle (F8)` FAILED. Re-verified after the test-file split.

---

## Documentation corrections

- **`snippet` is always NULL.** Corrected at all three sites, each now saying
  so up front: `sync/src/schema.sql` (the column comment), `sync/src/db.ts`
  (`SNIPPET_MAX_LENGTH`, plus a note on `MessageInput.snippet`), and
  `sync/src/normalize.ts` (`SNIPPET_CHARS`, plus `makeSnippet` itself). The
  storage arithmetic is reframed as design intent for a future
  fetch-a-body-prefix task, not a description of what is stored today. The code
  is retained, as instructed.
- **No production callers**, noted at each definition:
  `Db.getSyncState`/`setSyncState` (`sync/src/db.ts`), `BACKFILL_SHARE`
  (`sync/src/budget.ts`), `openMailbox`, `listMailboxes` and `MailboxInfo`
  (`sync/src/imap/connection.ts`).
- **No backfill exists.** Documented in `sync/src/schema.sql` (on `sync_state`)
  and at `HEADER_FETCH_LIMIT` in `sync/src/imap/pool.ts`, and added to the spec
  as **section 9 / L9** with the concrete consequence (an outage during which
  more than 50 messages arrive loses everything older than the newest 50,
  permanently and undetectably) and a note that `resolveUidSpan` already
  implements the bounded paging a future backfill needs.

## Cheap items

- `sync/.env.example` gains `API_TOKEN` with the `openssl rand -hex 32`
  instruction and a note that the service refuses to start without it.
- `sync/package.json`: `start` pointed at the same entry `dev` uses
  (`node --env-file=.env --experimental-strip-types src/api/server.ts`). There
  is no build script and no `dist/`, so the old `dist/api/server.js` target was
  permanently broken.
- Bearer scheme matching is now case-insensitive and tolerates extra `SP`
  (`/^\s*bearer\s+(\S+)\s*$/i`). Covered by 6 tests; **mutation:** restoring
  `startsWith('Bearer ')` → 4 FAILED.
- `sync/.gitignore`: `accounts.json` → `accounts*.json*`, negation kept last.
  Note I went one character further than the brief's `accounts*.json`, because
  that pattern does **not** match `accounts.json.bak` (the file the brief
  named) — it requires the name to *end* in `.json`. Verified with
  `git check-ignore -v`: `accounts.json`, `accounts.json.bak`,
  `accounts.json.orig`, `accounts.local.json` and `accounts.example.json.bak`
  are all ignored; `accounts.example.json` is not.

## Refactor performed to satisfy the file-size constraint

Adding tests pushed `tests/pool.test.ts` to 1000 lines and
`tests/routes.test.ts` to 807, over the project's 800-line ceiling. Rather than
delete coverage, the fakes were extracted and the suites split:

- `sync/tests/helpers/pool-fakes.ts` (258) — shared fake imapflow client, fake
  `Db`, and a `createPoolHarness()` that guarantees a launched pool is stopped.
- `sync/tests/pool.test.ts` (490) — backoff, mutex, IDLE wait, probe, pool
  connect/status/stop.
- `sync/tests/pool-sync-cycle.test.ts` (321) — F1, F5, F8.
- `sync/tests/helpers/api-fakes.ts` (121) — shared fake connection, `Db` and
  pool for the router suites.
- `sync/tests/routes.test.ts` (318) — auth, health, thread, inbox
  limit/cursor, malformed segments.
- `sync/tests/routes-fetch.test.ts` (416) — bearer scheme, body and attachment
  routes, budgeting, size cap, Content-Disposition.

Test count is identical across the split (199 → 199 at that point), and the F1,
F5, F8 and F3-budget mutations were re-run afterwards and still caught. Every
source file is under 500 lines; largest are `src/imap/pool.ts` (477) and
`src/api/routes.ts` (471).

## Constraints observed

- No new dependencies. `Readable.fromWeb` and `stream/promises.pipeline` are
  Node built-ins.
- No live Gmail connections; the two opt-in live suites remain skipped.
- No TypeScript parameter properties, enums, namespaces or decorators.
  `BodyPartTooLargeError` uses an explicit field assignment, matching the
  existing convention in `budget.ts` and `connection.ts`.
  `check:runtime` passes on all 11 modules.
- Immutability preserved; new code returns new objects.
- Errors carry the account id and never a credential.
- `tracking/` untouched.

## Things a reviewer should look at

1. **F3 buffering remains** (~2×, capped at 32 MB). Reasoning above; this is
   the one place the fix is partial by design.
2. **F1's residual idle-loop window** — reset-after-first-cycle is what the
   finding asked for, and it leaves a narrower thrash case if `idleLoop` fails
   immediately on every pass after a successful cycle.
3. **`registerAccounts`'s clearing update is not transactional** with the
   upserts — a sub-millisecond startup window with no primary row.
4. **`applySchema` will now fail startup** on a database that already holds two
   primaries. Deliberate; current data has one.
5. **413 vs 429 status choices** were mine, not specified by the finding: 413
   for an oversized part, 429 for an exhausted daily quota.
