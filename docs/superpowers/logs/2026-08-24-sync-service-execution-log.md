# SDD ledger — plan: docs/superpowers/plans/2026-08-24-sync-service.md

Branch: sync-service   BASE: 82ccd6d
Ruling: feature branch, not worktree — same reasoning as Plan 1 (no origin, no
  concurrent work, nothing on main a branch does not equally protect).
Ruling: local test Postgres via a DISPOSABLE DOCKER CONTAINER, not Homebrew.
  postgres:16 on localhost:5433, matching the production target version exactly.
  Homebrew would install a permanent launch agent on the user's machine; the
  container reverses completely with `docker rm -f postbox-pg`. Task 2's adapter
  tests self-skip without a database, and shipping an unverified DB adapter means
  discovering at Task 9 that nothing works. Cost if wrong: one `docker rm`.
  TEST_DATABASE_URL=postgresql://postbox:devonly@localhost:5433/postbox_sync_test

## Pre-flight conflict scan

### Cross-task pairs (shared files or interfaces)

| Pair | Produces -> Consumes | Finding |
|---|---|---|
| T1 -> T5,T7,T8 | `AccountConfig`, `SyncConfig`, `MAX_ACCOUNTS` | Clean. Single definition in config.ts. |
| T2 -> T3,T4,T6,T7,T8 | `MessageInput`, `Db` | Clean. Single definition in db.ts; normalize/fetch import the type only. |
| T3 -> T6 | `normalizeMessage`, `extractAttachments`, `AttachmentMeta` | Clean. |
| T4 -> T7 | `ByteBudget`, `checkBudget`, `BACKFILL_SHARE` | Clean. |
| T5 -> T6,T7 | `ImapConnection`, `MailboxInfo` | **FINDING 1** — T6 requires `connection.rawClient()`, which T5's interface block does NOT declare. T6's step 3 patches it into T5's file after the fact. A T5 reviewer would never see it, and T6's implementer must edit a file T5 owns. |
| T6 -> T7,T8 | `fetchHeaders`, `fetchBodyPart`, `FetchResult` | Clean. |
| T7 -> T8 | `ConnectionPool`, `AccountStatus`, `status` map | Clean. |
| **T8 internal** | `createRouter(db, pool)` vs `createRouter(db, pool, apiToken)` | **FINDING 2** — the Interfaces block declares a 2-arg signature; the test and the implementation both use 3 args. The Interfaces block is wrong. |

### Per-task self-consistency

| Task | Finding |
|---|---|
| T1 | Clean. Tests match implementation; error messages never echo the password. |
| T2 | Clean, but tests require a live Postgres — provisioned above. |
| T3 | Clean. `normalizeMessage` sets `hasAttach:false` and the caller overrides it; T6 does exactly that. |
| T4 | Clean. |
| T5 | See FINDING 1. |
| **T6** | **FINDING 3** — `bytesDownloaded` is a hardcoded 2048/message estimate, but T6's own test asserts `bytesDownloaded < totalMessageBytes`. With 20 messages that is 40960 bytes vs real message sizes; the assertion holds only if average message size exceeds ~2KB. Usually true, but the test could flake on a mailbox of tiny messages. |
| T7 | Clean. `syncOnce` reserves `2048*50` to match T6's per-message estimate. |
| T8 | See FINDING 2. |
| T9 | Clean. Human-gated on VM prerequisites. |

### Rulings

Ruling: FINDING 1 (rawClient not in T5's interface) — AMEND T5, not T6. `rawClient()`
  must be part of Task 5's deliverable and its Interfaces block, so its reviewer can
  judge it. Having T6 retro-patch a file T5 owns splits one class across two reviews
  and guarantees the T5 reviewer approves an incomplete interface.
  Cost if wrong: one extra method reviewed a task earlier than planned.

Ruling: FINDING 2 (createRouter arity) — the Interfaces block is wrong, the code is
  right. `createRouter(db, pool, apiToken)` is correct; auth cannot be optional on a
  service fronting ten mailboxes. Carry the corrected signature into T8's dispatch.
  Cost if wrong: none — the tests already encode the correct arity.

Ruling: FINDING 3 (byte estimate vs test assertion) — carry into T6's dispatch as a
  known fragility. Do NOT weaken the assertion; it is the guard that catches anyone
  fetching BODY[]. Instead require the test to skip when the sampled mailbox averages
  under 4KB/message, so it fails loudly on a real regression and skips honestly on an
  unrepresentative mailbox. Cost if wrong: the guard is skipped on tiny mailboxes.

## Progress

Task 1: implementer DONE (aa2631c, 8/8) — review dispatched (sonnet)
Task 1: review — spec ✅, quality NEEDS WORK. Reviewer traced all 9 throw sites and
  confirmed NO credential leakage in the implementation, and confirmed no mutation of
  `raw`. Findings are about validation gaps and test quality.
Task 1: IMPORTANT — the credential-leak test can pass VACUOUSLY. No assertion that
  loadConfig throws; if the length check were removed the catch never runs, the expect
  never runs, and the test reports pass while protecting nothing. This is the guard on
  ten app passwords.
Task 1: IMPORTANT — validation gaps on hand-edited fields: `isPrimary` silently coerces
  any non-boolean to false; email is not trimmed (a pasted " a@gmail.com" becomes an
  IMAP username with a leading space — the exact failure mode the brief guards against
  for passwords); duplicate EMAILS under different ids pass, opening two connections to
  one mailbox.
Task 1: minor — PORT: `??` does not catch empty string, so `PORT=` yields 0 and
  `PORT=abc` yields NaN, both silently.
Task 1: minor — the MAX_ACCOUNTS test derives its expectation from the export itself,
  so it never pins the spec's required value of 10.
Ruling: FIX ALL FOUR. They conflict with the plan's own test list; the plan loses, same
  as Plan 1 Task 4. This is the loader for ten credentials in a hand-typed file, and a
  vacuous leak test is worse than no test because it stops anyone from looking.
  Cost if wrong: ~40 lines of validation and test.
Task 1: fix round 1/5 (a16ca0a, 19/19 up from 8/8). Controller ran a MUTATION TEST:
  disabled the app-password length guard in src/config.ts and confirmed the suite FAILS
  (2 tests, including "never includes an app password in an error message" by name).
  The previously-vacuous leak test now genuinely protects. Source restored, 19/19 green,
  working tree clean. Scoped re-review dispatched.
Task 1: fix round 1 re-review — ALL 4 findings ADDRESSED. Vacuity audit run over every
  new test; 10 of 11 genuinely fail if their rule is removed. The one exception
  ("rejects empty email after trimming") uses whitespace-only input, which already fails
  the pre-existing @ check, so it cannot detect trim removal — covered transitively by
  its sibling test. Not a functional gap. No credential in any error, no mutation of
  raw, no new dependencies.
Task 1: parked — nothing validates the COUNT of isPrimary accounts. All ten could be
  primary, or none. Ruling: park. Harmless while nothing reads the field, but isPrimary
  is the presumed default send-from account, so this MUST be resolved before Plan 4's
  composer consumes it. Cost if wrong: a misconfigured default sender, caught at first use.
Task 1: parked — Gmail dot-insensitivity (a.b@gmail.com == ab@gmail.com) is not handled
  by the duplicate-email check. Ruling: park. Only bites if two of the ten accounts are
  dotted variants of one another, which would be unusual. Cost if wrong: two IMAP
  connections to one mailbox, visible in the health endpoint.
Task 1: complete (commits 82ccd6d..a16ca0a, review clean after 1 fix round, 2 parked)
Task 2: dispatched (sonnet — live Postgres integration) — BASE a16ca0a
Task 2: FIRST ATTEMPT DIED (machine slept mid-response, no files written, no commit, tree clean). Re-dispatching fresh.
Task 2: implementer DONE (90ab37e, 23/23 incl. 4 db tests verified RUN via unset-env control) — review dispatched
Task 2: review — spec ✅, quality Approved with 1 Important + 2 Minor + 1 plan gap.
  Reviewer verified idempotency by reading all 8 DDL statements (all carry if-not-exists),
  confirmed the upsert conflict list correctly updates flags/labels while leaving
  identity fields immutable, and JUDGED THE query() ESCAPE HATCH JUSTIFIED — pushing back
  on the implementer's own over-caution, since removing it would scatter raw SQL across
  Tasks 4, 7 and 8 rather than eliminate it.
Task 2: IMPORTANT — uidValidity round-trip and null-preservation are UNTESTED. The test
  sets uidValidity: 99n but asserts only on lastSeenUid. Correct by inspection, but a
  future edit (?? -> ||) would break it silently. uidValidity gates whether a resync
  treats a mailbox as fresh; getting it wrong re-downloads whole mailboxes into Gmail's
  2.5GB/day ceiling and a 24h lockout across all ten accounts. Ruling: FIX.
Task 2: PLAN GAP (mine, not the implementer's) — messages.snippet is unbounded `text`.
  The whole ~1GB storage budget depends on Task 3 truncating to 280 chars; nothing at the
  DB level enforces it, so a Task 3 bug grows the store toward 10GB SILENTLY.
  Ruling: FIX via defensive truncation in upsertMessage's SQL (left($12, 500)), NOT a
  CHECK constraint. A CHECK rejects the insert, so a caller bug would silently stop mail
  syncing — trading silent bloat for silent data loss. Truncation bounds storage
  unconditionally with no failure mode. 500 leaves headroom over Task 3's 280.
  Cost if wrong: snippets capped at 500 chars, which is already 1.8x the design value.
Task 2: minor (CARRY TO TASK 8) — pg returns bigint/int8 columns as STRINGS, so `uid`
  and `size_bytes` come back as strings from getUnifiedInbox/getThread/query, while
  going in as numbers. No break today (Task 8 only JSON-serialises them), but Task 8
  must not do arithmetic on uid without converting.
Task 2: fix round 1 re-review — BOTH findings ADDRESSED. Re-reviewer independently
  audited every new assertion for vacuity (all 4 load-bearing), confirmed toBe(99n) is
  Object.is-strict so a number/string would fail, confirmed toBeNull() distinguishes
  null from 0n and "null", and confirmed left($12,500) keeps the VALUE bound — only the
  constant 500 is inlined. Bonus finding: because Postgres evaluates `excluded` after
  the target list, the truncation also applies on the upsert-UPDATE path, so the bound
  is unconditional rather than first-insert-only.
Task 2: parked — left() truncates CHARACTERS not bytes; 500 4-byte codepoints is ~2KB
  vs the ~280B design assumption. Ruling: acceptable margin against a ~1GB target for
  realistic mixed-content mail; a real risk only for predominantly CJK/emoji mailboxes.
  Revisit if the storage budget is ever measured against real data. Cost if wrong: the
  ~1GB estimate is optimistic by up to ~4x for one pathological account.
Task 2: parked — the backfillDone=true test depends on running after its false sibling
  against the same row. Safe under Vitest's sequential-within-describe default; fragile
  if reordered or parallelised. Cost if wrong: one confusing failure after a reorder.
Task 2: complete (commits a16ca0a..a6d014a, review clean after 1 fix round, 2 parked)
Task 3: dispatched (haiku — pure functions, complete code in brief) — BASE a6d014a
Task 3: implementer DONE (563b096, 39 tests) — review dispatched
Task 3: review — spec ✅, quality NEEDS WORK. 1 Critical + 1 Important + 3 Minor.
Task 3: CRITICAL — extractAttachments THROWS on deeply-nested or cyclic BODYSTRUCTURE.
  Reviewer verified by EXECUTION: ~5000 levels deep -> RangeError: Maximum call stack
  size exceeded; self-referential childNodes -> same. MIME nesting costs only a boundary
  header per level so 5000 levels is <1MB and trivially craftable. Directly violates the
  never-throw invariant; a hostile email would crash the sync process. The brief's two
  malformed tests only exercise the top-level guard, giving false confidence.
  Ruling: FIX. Depth cap or iterative worklist, plus a defensive try/catch backstop.
Task 3: IMPORTANT — forwarded-email attachments are silently skipped. Reviewer read
  imapflow's own source (lib/tools.js) and confirmed message/rfc822 parts carry BOTH
  childNodes AND their own disposition='attachment' + filename. The walker returns early
  on childNodes so it never checks that node's own disposition. Gmail's "forward as
  attachment" is exactly this shape — those attachments never get listed, silently.
  Ruling: FIX. Check the node's own disposition independent of recursing into children.
Task 3: PLAN DEFECT (mine, 4th found by review) — my reference implementation used a
  plain [...value].sort() for labels, which FAILS my own test: 'Work' (W=0x57) sorts
  before '\Inbox' (\=0x5C), but the test expects ['\Inbox','Work']. The implementer
  correctly diverged with a system-labels-first comparator. Ruling: keep the divergence,
  require a comment so it is not "corrected" back to the broken version later.
Task 3: minor — `part` typed string but never runtime-validated; part:2 (number) is
  stored verbatim as partId, violating the documented contract. Ruling: FIX (cheap).
Task 3: minor — no test for both threadId AND messageId absent. Reviewer verified by
  execution that it correctly yields null, not undefined. Ruling: FIX (add the test).
Task 3: fix round 1/5 (263626d, 44 tests). Controller ran the ADVERSARIAL INPUTS
  directly against the fixed parser: 5000-level nesting -> no throw; cyclic childNodes
  -> no throw; null child elements -> no throw; string dispositionParameters -> no throw
  and still lists the attachment; imapflow message/rfc822 forwarded .eml -> DETECTED with
  filename; numeric `part` -> rejected. All six shapes behave. Scoped re-review dispatched.
Task 3: fix round 1 re-review — Finding 1 NOT ADDRESSED; findings 2-5 addressed.
  CONTROLLER VERIFIED BOTH RESIDUAL CLAIMS EMPIRICALLY:
  (a) BRANCHING CYCLE HANGS. childNodes:[self,self] -> 2^depth visits, never exceeds the
      depth cap, DFS unwinds so no stack overflow, never terminates. Killed after 15s.
      This is WORSE than the crash it replaced: a crash restarts the worker, a hang
      silently stops processing mail for that account indefinitely.
  (b) THE DEEP-NESTING TEST IS VACUOUS. Mutation test: deleted the `if (depth >
      MAX_DEPTH)` guard entirely and ALL 10 tests still passed. 150 levels is nowhere
      near V8's ~10k limit, so the test neither throws nor exercises the guard. A hollow
      test guarding the Critical finding.
  Also: the cap path logs nothing, which the finding explicitly required.
Ruling: a depth cap is the WRONG structural bound — it bounds depth but not fan-out.
  Round 2 requires an iterative worklist with a visited set (object identity), which
  bounds both. Plus a node-count budget, plus logging on every bound trip, plus tests
  that assert the guard FIRES rather than merely that nothing throws.
  Cost if wrong: a slightly more complex walk function.
Task 3: fix round 2/5 (cedbf56 — iterative worklist + visited set + node budget).
  CONTROLLER VERIFIED BEHAVIOUR: branching cycle [self,self] 0ms; 3-way cycle 0ms;
  linear self-cycle 0ms; 10k-level nesting 1ms (budget trips, LOGGED); 50k siblings 5ms
  (budget trips at 999, LOGGED); normal 3-part message -> 2 attachments. Hang is gone,
  guards log, normal mail unaffected.
  CONTROLLER MUTATION TESTS (syntax-preserving):
    visited.has(node) -> false      => 10/10 STILL PASS  (visited set is UNPINNED)
    MAX_NODES 1000 -> MAX_SAFE_INT  => 1 test FAILS      (budget IS pinned)
  Reading: the NODE BUDGET is the mechanism that actually prevents the hang, and it is
  tested. The visited set is redundant defence-in-depth that the budget masks — every
  cycle hits the budget before the visited set could matter.
Ruling: COMPLETE the Critical. The safety property holds and the mechanism delivering it
  is pinned by a failing-on-removal test. Park the unpinned visited set as a Minor rather
  than spending a third round on redundant belt-and-braces. Flag it for the whole-branch
  review to triage. Cost if wrong: a redundant guard could be deleted later without a
  test objecting — but the budget would still prevent the hang.
Task 3: RULING REVERSED. I ruled the visited set "redundant defence-in-depth, park as
  Minor". That was WRONG and the re-reviewer disproved it with a case I never built: a
  SELF-REFERENCING ATTACHMENT node (all existing cycle tests use bare multipart
  containers with no disposition, which emit no attachments, so duplication was
  structurally invisible in everything I tested).
  CONTROLLER VERIFIED against the real shipped module:
    visited active   -> 1 attachment  (correct)
    visited disabled -> 1000 DUPLICATES of evil.pdf, budget trips at 1000
  The node budget stops the HANG but does nothing about CORRUPT OUTPUT. The visited set
  has an independent, load-bearing job — duplicate suppression — pinned by zero tests.
  Severity is HIGH, not Minor. My error was generalising from a non-representative case,
  which is the exact trap I had briefed the reviewer to watch for.
Task 3: ALSO CONFIRMED — cedbf56 committed two stray files, sync/src/attachments.ts.bak2
  and sync/src/attachments.ts.tmp, byte-identical to attachments.ts. 198 of that commit's
  268 inserted lines are these duplicates. Both are tracked in git.
Task 3: ALSO — cycle-bound trips are never logged, partial non-compliance with round 2's
  explicit "log every bound trip" requirement. A hostile cyclic message that stays under
  MAX_NODES produces zero log signal.
Ruling: ROUND 3. Fix all three. Cost if wrong: one test, one log line, two deletions.
Task 3: fix round 3/5 (62e07b5, 45 tests). CONTROLLER VERIFIED ALL THREE:
  A) MUTATION TEST: visited.has(node) -> false now FAILS the new test
     "suppresses duplicate attachments from cyclic self-referencing nodes"
     (1 failed | 10 passed). The visited set is finally PINNED.
  B) Stray .bak2/.tmp removed from git AND disk; git ls-files shows only real sources.
  C) Cycle detection logs: "[sync/attachments] cycle detected in BODYSTRUCTURE,
     skipping duplicate node after collecting 1 attachments" — once per walk.
  Scoped re-review dispatched.
Task 3: fix round 3 re-review — ALL THREE ADDRESSED. Reviewer confirmed cycleLogged is
  FUNCTION-LOCAL both by source position and empirically (two independent log lines with
  different counts in one process — impossible with module-level state). New assertion is
  toHaveLength(1), strict. Deletions were pure; attachments.ts was NOT reverted to a .bak2
  copy (visited set, MAX_NODES, rfc822 handling, part typeof check all still present).
Task 3: complete (commits a6d014a..62e07b5, review clean after 3 fix rounds)
  Journey: crashed on crafted input -> hung on crafted input -> silently duplicated DB
  records -> every guard now fails a test when removed. None visible in a green run.
Task 4: dispatched (haiku — complete code in brief) — BASE 62e07b5
Task 4: implementer DONE (62aedb9, 52 tests). Both dispatch traps avoided by inspection:
  record() ACCUMULATES (bytes_used = byte_budget.bytes_used + $3), day key is UTC.
CONTROLLER FOUND A PRODUCTION-BREAKING DEFECT (mine, 6th plan-authored):
  budget.ts:38 uses a TypeScript PARAMETER PROPERTY — constructor(private readonly db: Db).
  The plan's `dev` script AND Task 9's systemd ExecStart both run node
  --experimental-strip-types, which does NOT support parameter properties. Confirmed:
  importing budget.ts under that flag throws ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
  THE SERVICE CANNOT START. And 52/52 tests pass with typecheck clean, because Vitest
  transpiles via esbuild which DOES support them — the test runner and the production
  runtime disagree about the language. Identical shape to Plan 1's typecheck gap: a gate
  that never exercises the thing that matters.
Ruling: FIX in three parts — (1) replace the parameter property with an explicit field
  assignment; (2) audit all of src/ for others; (3) add an npm `check:runtime` gate that
  actually imports the modules under --experimental-strip-types, and require it for the
  remaining tasks. Cost if wrong: one extra script and a two-line constructor change.
Task 4: fix (e06fb5b) — parameter property replaced, `check:runtime` gate added, src/
  audited clean (no enums, namespaces, decorators).
  CONTROLLER MUTATION-TESTED THE GATE: reintroduced the parameter property and
    check:runtime -> FAILS (gate is real, not decorative)
    vitest        -> 52/52 STILL PASSES (blind to it)
  That contrast is the entire justification for the third gate.
CARRY TO TASKS 5-9: `npm run check:runtime` is now a required gate alongside typecheck
  and vitest. Node's --experimental-strip-types implements a NARROWER TypeScript subset
  than esbuild, so Vitest green says nothing about whether Node can load the code.
Task 4: review — spec ✅, quality Approved. Reviewer mutation-tested 3 MORE boundaries
  beyond the controller's (clamp removal, <= to <, ignoring the limit override) — each
  broke its own test. Confirmed used() returns 0 not NaN for a fresh account by reading
  db.ts's query path. Confirmed the pure/stateful split holds.
Task 4: PLAN DEFECT (mine, 7th) — my brief's pseudocode for `remaining` (limit - used)
  contradicted my own Step-1 test (limit - used - requested). The implementer followed
  the TEST, which is the contract. Correct call.
Task 4: parked (CARRY TO TASK 7) — reserve()/record() is check-then-act with no
  transaction. Two concurrent fetches can both reserve against a stale snapshot. record()
  is atomic so nothing is lost, but overspend is real. Bounded by Gmail's ~15-connection
  cap; worst case a few hundred MB, inside the 500MB margin between our 2GB target and
  Gmail's 2.5GB ceiling — but it EATS that margin. Ruling: Task 7 must serialise
  reserve->fetch->record per account. Cost if wrong: margin erosion, not lockout.
Task 4: minor (FOLDED INTO TASK 5) — check:runtime is a hardcoded import list. Task 5
  adds src/imap/connection.ts; a gate that silently stops covering new files is exactly
  the regression it exists to prevent. Task 5 must make it glob-based.
Task 4: minor (parked) — BudgetDecision.remaining is post-grant, not pre-grant headroom;
  undocumented. Cost if wrong: a caller misreads it in a log line.
Task 4: minor (parked) — used() uses Number() where db.ts converts bigint columns with
  BigInt(). No precision loss below 2^53 (bytes), just a convention inconsistency.
Task 4: complete (commits 62e07b5..e06fb5b, review clean, 3 parked)
Task 5: review — spec ✅, quality Approved, no Critical. Reviewer read IMAPFLOW'S OWN
  SOURCE to verify the credential path: auth-failure .message comes from server-supplied
  text via enhanceCommandError, never client-sent data; logger:false fully suppresses
  imapflow's logger rather than lowering its level. Both catch blocks pass only
  describeError(error) through redactSecret, never the raw error object.
Task 5: IMPORTANT — disconnect() during an in-flight connect() silently no-ops
  (this.client is still null), and the in-flight connect() then assigns the client
  anyway, leaving a LIVE UNTRACKED connection surviving shutdown. Task 7 performs
  exactly this: ten-way concurrent shutdown.
  Ruling: FIX NOW in Task 5's file, not later in Task 7. Letting Task 7 patch a race into
  a class Task 5 owns is the same anti-pattern the pre-flight scan caught with
  rawClient(). Cost if wrong: one small state field.
Task 5: minor (CARRY TO TASK 7) — isConnected mirrors imapflow's `usable`, set false on
  socket close/end/error. Cannot detect a HALF-OPEN TCP failure (no FIN/RST) until the
  next read/write. Task 7's IDLE loop must not treat isConnected===true as proof of
  liveness without its own keepalive/timeout.
Task 5: minor (parked) — rawClient() hands out the live client, so a caller driving it
  directly can desync the wrapper's bookkeeping. Inherent to Amendment 1; documented.
Task 5: minor (FOLDED INTO FIX) — the uidValidity/uidNext test checks each > 0n
  independently, so a bug SWAPPING the two fields would pass. Inherited from my brief.
Task 5: fix round 1 re-review — BOTH findings ADDRESSED. Reviewer traced both the success
  and failure interleavings concretely and confirmed the race is CLOSED, not narrowed.
  Key answers: (a) .finally() clears connectPromise on REJECTION too, so a failed connect
  does NOT cache a rejected promise and does NOT brick the reconnect loop — the highest-
  consequence failure mode of this design is absent; (b) this.client=null before logout()
  is net-SAFER — concurrent commands during teardown now fail fast instead of racing a
  socket mid-close.
Task 5: MY FINDING'S FRAMING WAS WRONG — I wrote that concurrent double-disconnect
  "worked before". Tracing the pre-fix code shows it did not: both concurrent calls saw
  this.client still set and both called logout(). The fix closed a latent bug I had
  mischaracterised as already-working.
Task 5: minor (parked) — lifecycle test 2 (disconnect awaits a failing connect) verifies
  a real property but does NOT pin Finding 1's guard, since a failed connect never
  assigns this.client either way. Cost if wrong: one less regression catcher.
Task 5: minor (parked) — the new uidNext STATUS cross-check can flake if mail arrives in
  the ~350ms window between openMailbox() and status(). uidValidity is stable. Low
  probability; a genuine swap detector otherwise. Cost if wrong: rare live-test flake.
Task 5: complete (commits e06fb5b..505bc65, review clean after 1 fix round, 2 parked)
Task 6: dispatched (sonnet — live IMAP fetch) — BASE 505bc65
Task 6: implementer DONE_WITH_CONCERNS (de7123b, 66/66, 5 new fetch tests ran live).
  CONTROLLER VERIFIED: tsconfig strictness INTACT (strict + noUncheckedIndexedAccess both
  still true; the added noEmit + allowImportingTsExtensions are REQUIRED for .ts-extension
  imports under strip-types, not a weakening). Fetch options are correct — uid, envelope,
  flags, size, bodyStructure, labels, threadId; no body, no source. `download` appears
  only in fetchBodyPart, the on-demand path.
Task 6: IMPLEMENTER-SURFACED, AND CORRECT — the BODY[] guard test is CAUSALLY INERT.
  bytesDownloaded is a fixed 2048/message estimate, so adding `source: true` to the fetch
  options would not change it and the assertion would still pass. My Amendment 1
  preserved a guard that cannot guard. 8th plan-level defect, and the first one an
  IMPLEMENTER caught rather than a reviewer.
Ruling: FIX — extract the fetch options to an exported constant and assert on the
  constant itself (exactly the allowed keys, none of source/bodyParts/BODY[]). That is
  causal: adding a body key fails the test. Keep the byte-magnitude check but rename and
  comment it honestly as a sanity check on the ESTIMATE, not a BODY[] guard.
  Cost if wrong: one exported constant and a pure unit test.
Task 6: concern — hasAttach:true was NOT observed live (no attachment in the sampled 50
  messages). Honest reporting, exactly as asked. Ruling: add a PURE unit test of the
  override logic ({...normalized, hasAttach: parts.length > 0}) — it needs no network.
Task 6: concern (CARRY TO TASK 7) — FetchRange.sinceUid is an inclusive bound and `limit`
  is uncapped when sinceUid is set. Task 7 must confirm that is the semantics it wants.
Task 6: fix round 1 (76e6996, 72/72; 6 new PURE unit tests in fetch-unit.test.ts).
  CONTROLLER MUTATION TEST: injected `source: true` into HEADER_FETCH_OPTIONS ->
  2 tests FAIL; removed it -> 6/6 pass. The BODY[] guard is now CAUSAL, replacing the
  byte-estimate assertion that would have stayed green while the service bulk-downloaded
  ten mailboxes. Scoped re-review dispatched.
Task 6: review — spec ✅, quality Approved. Reviewer confirmed HEADER_FETCH_OPTIONS is
  passed DIRECTLY to client.fetch with no spread (the guard is not theatre), lock release
  is in a finally in both functions with nothing between acquire and try, empty/inverted
  UID ranges return EMPTY_RESULT before any range string is built, and fetchBodyPart has
  ZERO call sites outside its own definition. Reviewer ran the suite WITHOUT credentials
  to avoid opening IMAP connections — 56 passed / 16 skipped.
Task 6: IMPORTANT — sinceUid silently ignores limit. Once sinceUid is set, every message
  up to the mailbox top is fetched in ONE uncapped call, and budget.record() only charges
  AFTER the fetch already hit Gmail, so the budget cannot preempt it. Inert today (Task
  7's brief never passes sinceUid) BUT the docstring invites the pattern for incremental
  sync — a landmine the documentation points at.
  Ruling: FIX NOW (round 2). A ~3-line cap makes the parameter safe by construction.
  Cost if wrong: sinceUid callers get at most `limit` messages per call and must loop.
Task 6: minor (FOLDED INTO ROUND 2) — the key-set unit test checks Object.keys only, so
  flipping bodyStructure:true -> false while keeping the key would slip past. Different
  failure class (breaks attachment detection, not a BODY[] download) but cheap to close.
Task 6: minor (parked, pre-existing) — live tests assert toBeGreaterThan(0) on INBOX
  contents; if that mailbox were emptied they would fail rather than skip. Inherited from
  the brief's reference test.
Task 6: fix round 2 (26225c7, 80/80; range math extracted to resolveUidSpan with 8 pure
  unit tests). CONTROLLER VERIFIED THE CAP against the real function:
    sinceUid=1, limit=50, top=10000  -> 1:50       span 50  (previously ALL 10000)
    sinceUid=500 above top=100       -> null
    sinceUid=1, limit=5, top=1000    -> 1:5        span 5
    no sinceUid, limit=50, top=10000 -> 9951:10000 span 50
    empty mailbox / limit=0          -> null
  Every case bounded by limit. The documented landmine is defused.
  Note: my first probe guessed the wrong signature and returned span 0 for every case —
  I read the actual function rather than trusting the guess. Worth remembering that a
  probe returning uniform zeros usually means the probe is wrong, not the code.
  Scoped re-review dispatched.
Task 6: fix round 2 re-review — BOTH findings ADDRESSED. Reviewer confirmed
  resolveUidSpan IS wired into fetchHeaders (no inline arithmetic remains), the null path
  sits inside the try so `finally { lock.release() }` still runs (no wedge), limit=1
  gives span exactly 1, and the full-shape toEqual would catch a flipped bodyStructure.
  Corrected my check 4: the bigint boundary does not apply — fetchHeaders reads
  imapflow's raw mailbox.uidNext, typed `number`; the bigint MailboxInfo.uidNext belongs
  to Task 5's wrapper, which this path never calls.
Task 6: SHARP CATCH ABOUT MY OWN VERIFICATION — two of the eight new tests do NOT
  discriminate the fix from the bug, because their inputs make the MAILBOX TOP the
  binding constraint rather than `limit`. One of them (sinceUid=500 above top=100 ->
  null) is a case I RAN AND REPORTED AS VERIFICATION. It returns null under both old and
  new code. Two of my six spot-checks proved nothing. Two tests DO discriminate
  (sinceUid=1/limit=50/top=10000 and sinceUid=10/limit=3), so the fix is genuinely pinned.
  Lesson: a passing check and a DISCRIMINATING check are different things.
Task 6: parked — the two non-discriminating tests are valid boundary coverage, just
  weaker than their names suggest. Cost if wrong: less regression protection than assumed.
Task 6: complete (commits 505bc65..26225c7, review clean after 2 fix rounds, 1 parked)
CARRY TO TASK 7 (accumulated):
  (a) isConnected mirrors imapflow's `usable`, set false on socket close/end/error. It
      CANNOT detect a half-open TCP failure until the next read/write. The IDLE loop must
      not treat isConnected===true as proof of liveness — needs its own keepalive/timeout.
  (b) reserve()/record() is check-then-act with no transaction. Task 7 must SERIALISE
      reserve -> fetch -> record per account so concurrent fetches cannot both reserve
      against a stale snapshot.
  (c) resolveUidSpan does NOT validate sinceUid: 0 or negative would build a malformed
      IMAP range ("0:49", "-5:44"). Unreachable today (no callers). If Task 7 passes
      sinceUid, it must validate it.
  (d) Task 7's reference syncOnce() never passes sinceUid — it polls {limit: 50} and
      relies on idempotent upserts. Confirm that is intended before changing it.
Task 7: dispatched (sonnet — concurrency + live IDLE) — BASE 26225c7
USER DECISIONS:
  VM = GCP always-free e2-micro. CONSEQUENCE for Task 9: 1GB RAM running BOTH Postgres
  and Node with 10 live IMAP connections. Postgres defaults assume far more. Task 9 must
  tune shared_buffers / work_mem / max_connections DOWN and add a swap file (GCP images
  ship without one). An OOM kill on a sync service is a silent stop, not a crash loop.
  Disk 30GB vs ~1GB of headers+snippets for 10 mailboxes = comfortable — precisely
  because attachments are never cached and BODY[] is never fetched.
  Accounts-vs-aliases: STILL UNRESOLVED. User replied "#2 is correct" but #2 was the
  question. Asked again rather than guessing; it changes connection count and send limits.
RESOLVED — accounts vs aliases: TEN SEPARATE ACCOUNTS, each sending via its OWN SMTP.
  Gmail "Send as" aliases are NOT used and need no configuration. Recorded as spec 7B.
  Rationale: per-recipient tokenised tracking (5.3) sends one message per recipient, so
  a 5-person email costs 5 sends. Ten independent ~500/day limits give ~5000/day; a
  shared alias limit would give ~500 TOTAL across all ten identities.
UNPARKED — Task 1's `isPrimary` finding is now LOAD-BEARING (spec 7B.1). It was parked as
  harmless because nothing read the field; it is now the default send-from account.
  Exactly one account must be primary and the config loader MUST enforce it before Plan 4
  consumes it. Add to the whole-branch review's triage list.
FOUR ACCOUNTS CONFIGURED AND LIVE-VERIFIED (accounts.json, gitignored, confirmed):
  sender@example.com        30,832 msgs   (primary, provisional)
  recipient@example.com        11,060 msgs
  valenli@college.harvard.edu      525 msgs   <- Google WORKSPACE; app passwords and
                                                 IMAP are NOT disabled by Harvard's admin
                                                 policy. This was the one genuinely at
                                                 risk of failing at Task 9.
  third@example.com      18,043 msgs
REAL DATA REPLACES MY ESTIMATE:
  planned ~50,000 msgs/mailbox -> 500,000 for ten
  actual average 15,115        -> ~151,000 for ten
  sync store: ~0.31 GB, not ~1 GB. GCP 30GB disk is very comfortable.
  Largest backfill (30,832 msgs @ 2KB est) = 63 MB = 3.2% of ONE account's daily budget.
  => the entire first sync of all accounts fits inside a single day. The backfill
  lockout risk I designed the byte budget around is far smaller than modelled — the
  budget stays as a guard, but it is not the binding constraint I assumed.
  Retroactively validates Task 6's no-BODY[] fight: at 151k msgs, headers+snippet is
  0.31GB; bodies would be ~3GB and attachments >15GB. On 1GB RAM that is the difference
  between running and thrashing.
OPEN: isPrimary is provisionally set to xinfinitypro. Per spec 7B.1 exactly one account
  must be primary and it is the DEFAULT SEND-FROM. Needs user confirmation.
PARALLELISATION ASSESSED (user asked): NOT possible for the remaining chain.
  T8 imports ConnectionPool directly (its /api/health reads pool.status), so it cannot be
  written before T7 exists. T9's systemd ExecStart names src/api/server.ts which T8
  creates, and its guide must state the real port/env/entry point — writing it earlier
  means guessing, the same "plan against an imagined API" failure already flagged.
  T9 is additionally blocked on the GCP VM. Mechanically, two implementers committing to
  one branch also contend on .git/index.lock; disjoint files do not help since the index
  is shared. The parallelism that DID pay off earlier was reviewer-plus-fixer (one writer,
  one reader), not two writers.
WATCH: Task 7 is modifying sync/src/imap/fetch.ts — Task 6's already-reviewed file. It
  should be CONSUMING fetchHeaders, not editing it. May be legitimate (an extra export),
  but a task editing a neighbour's reviewed file is the exact pattern the pre-flight scan
  caught twice. Inspect that hunk specifically at review time.
Task 7: implementer DONE (32076b7, 103/103, ZERO live connections from pool.test.ts).
  WATCH ITEM RESOLVED — the fetch.ts edit is legitimate and good: it exports
  ESTIMATED_BYTES_PER_HEADER_FETCH so the pool sizes its budget reservation from the SAME
  constant the fetch module charges, instead of duplicating the literal 2048 and letting
  the two drift. Visibility change with a stated rationale, not an edit to Task 6's logic.
  JITTER DEVIATION VERIFIED by the controller: equal jitter draws from [ceiling/2,
  ceiling] rather than [0, ceiling]. Sampled 200 draws per attempt: 165-200 distinct
  values, ranges grow correctly, ceiling (300000ms) respected at attempt 20 (max 299811).
  Still prevents lockstep reconnects, and guarantees a MINIMUM delay where full jitter can
  produce near-zero backoff and hammer Gmail on a fast-failing account. Sound deviation.
  Implementer also self-found and fixed a connection-LEAK race (registered connections in
  the tracking map before connect() rather than after) with a regression test.
Task 7: review — spec ✅ (all 4 amendments verified), quality NEEDS WORK.
  Reviewer READ IMAPFLOW'S SOURCE: idle() is run('IDLE', maxIdleTime) and maxIdleTime
  defaults to FALSE, so client.idle() genuinely hangs indefinitely without the pool's own
  timeout — Amendment 1 was necessary, not defensive. Also confirmed run() calls
  preCheck() which breaks an active IDLE, so no overlapping idle() calls accumulate.
  KeyedMutex confirmed GENUINELY PER-ACCOUNT (traced by hand; the different-keys test
  would fail under a global lock). Accounts sync concurrently.
  VACUITY AUDIT CLEAN ON ALL 23 TESTS — first time in this project.
  Self-disclosed leak fix verified real: registering in this.connections BEFORE connect()
  is what lets disconnect()'s in-flight-connectPromise logic find a racing connection.
Task 7: IMPORTANT — dangling timer in sleepInterruptible. Promise.race between the
  backoff sleep and stopRequested; when stop wins, the setTimeout is never cleared and
  keeps Node's event loop alive up to MAX_BACKOFF_MS (5 min). Reviewer REPRODUCED with
  `time node`: race resolves ~103ms, process exits ~5030ms. SIGTERM during backoff =>
  systemd waits out its grace period then SIGKILLs. Tests miss it because attempt-1
  backoff is <=1000ms and vitest does not measure process-exit timing.
  Ruling: FIX. Capture the handle and clearTimeout after the race. Note the pool's other
  two timers (withTimeout, waitForIdleWake) already do this correctly — isolated gap.
Task 7: minor — createConnection(account) sits OUTSIDE the try/catch, so a synchronously
  throwing factory would reject start()'s Promise.all and take down all other accounts —
  the exact guarantee the brief makes. Unreachable with the default factory. Ruling: FIX
  (one-line move) since it is the stated guarantee.
PROCESS NOTE: my review-package range 26225c7..32076b7 swept in my own spec-7B commit
  (1a26ea9). The reviewer correctly identified and excluded it, but I should scope
  packages to the implementer's commits when I have interleaved my own.
Task 7: fix round 1 (b782653, 105/105, both regression tests mutation-verified).
  CONTROLLER VERIFIED the timer fix: process exits in ~1s where it would previously have
  held the event loop up to MAX_BACKOFF_MS (5 min).
RATE LIMIT CONFIRMED — the shared test account is being throttled:
    sender@example.com        4680ms   <-- hammered all session
    recipient@example.com        1587ms
    valenli@college.harvard.edu    775ms
    third@example.com       557ms
  Still authenticating, not blocked, but the trend is clear. MITIGATION, binding on the
  remaining tasks: Task 8 gets a HARD zero-live-connections rule (its endpoints are
  testable with a fake Db and a fake pool — nothing about the HTTP layer needs IMAP).
  If any later task genuinely requires a live connection, use third@example.com
  (barely touched) rather than xinfinitypro.
Task 7: fix round 1 re-review — BOTH findings ADDRESSED. Timer test uses
  vi.getTimerCount() (observes pending-timer STATE, not elapsed time) so it genuinely
  discriminates; factory test would fail pre-fix because status would be undefined.
  Reviewer confirmed neither promise in the race can reject, so the bare clearTimeout is
  safe — noted as latent fragility (if an executor ever rejects, the leak silently
  returns, and no test forces that path).
  Reviewer's position on infinite retry of a throwing factory: CORRECT as-is. A
  permanently-bad credential already retries forever by design, so treating a factory
  throw identically keeps the failure model uniform. A "permanently failed" status would
  be real scope expansion beyond the finding.
Task 7: complete (commits 26225c7..b782653, review clean after 1 fix round)
Task 8: dispatched (sonnet) — BASE b782653. HARD zero-live-connections rule.
Task 8: implementer DONE (cbc6c08, 124 passed / 9 skipped, ZERO live IMAP connections).
  Controller verified auth: timingSafeEqual with a length check first, API_TOKEN throws
  below MIN_TOKEN_LENGTH, /api/health sits before the auth gate so it is the only
  unauthenticated route. check:runtime now covers 10 modules (was 8).
  Two disclosed changes to neighbours' reviewed files, both additive and documented:
    fetch.ts   — partId made OPTIONAL so the full-body route downloads the whole raw
                 message while the attachment route requests one part. One function,
                 two callers. NOTE: this creates an easier path to a full-message
                 download; the no-BODY[] guard covers fetchHeaders, not this.
    pool.ts    — getConnection(accountId) accessor, zero prior callers, needed by the
                 body/attachment routes. Hands out a live connection (same desync class
                 as rawClient), documented.
  Also disclosed: "unknown account" and "account not yet registered" both map to 404.
Task 8: review — spec ✅, quality Approved. 1 Important + 3 Minor.
  AUTH BYPASS HUNT CLEAN AND STRUCTURAL: `path` computed once and used identically for
  the health check, auth check and route matching; decodeURIComponent only ever applied
  to ALREADY-MATCHED capture groups, never to the matching path, so decode-confusion
  bypasses are impossible by construction. Traced /API/INBOX, trailing slashes, and
  /api/inbox/../health (URL normalises it before anything runs). Safe by construction.
  404 CONFLATION DOES NOT EXIST — reviewer traced further than the report: runAccount
  calls connections.set() SYNCHRONOUSLY before the first await, and map() invokes each
  runAccount in turn, so every configured account has an entry by the time start() yields.
  A 404 can only mean "not in accounts.json"; a connecting account correctly gets 503.
  VACUITY AUDIT CLEAN ON ALL 28 TESTS — third clean audit in a row. The wrong-token test
  uses a SAME-LENGTH token so it genuinely exercises timingSafeEqual rather than the
  length short-circuit.
Task 8: PLAN DEFECT (mine, 10th) — my brief's reference server.ts used response.text()
  when writing the Node response, which CORRUPTS BINARY ATTACHMENTS. The implementer used
  arrayBuffer() instead and disclosed it. Second defect an implementer caught in my plan.
Task 8: IMPORTANT — unguarded decodeURIComponent on route captures throws URIError on
  malformed percent-encoding (GET /api/thread/% with a valid token). Violates
  createRouter's declared always-resolves contract. Masked in production by server.ts's
  try/catch (degrades to 500) so not a bypass or DoS, but wrong status for client input
  error, untested, and a future caller of createRouter without that wrapper gets an
  unhandled rejection. Ruling: FIX — guard the decodes, return 400 on URIError.
Task 8: minor (FOLDED INTO FIX) — /api/health is matched before the method check so it
  answers POST/DELETE too, unlike every other route.
Task 8: parked — reviewer disagrees with making partId optional: it converts a
  COMPILE-TIME guardrail into a runtime-only one for the project's load-bearing invariant
  (a future caller omitting the 4th arg silently downloads a whole message). Suggests two
  named functions sharing a private helper. Ruling: PARK for whole-branch triage — real
  improvement, but it is a design refactor of a twice-reviewed file at the last task, and
  both current callers are correct. Cost if wrong: a future footgun on the byte budget.
Task 8: parked — ConnectionPool.getConnection() has no direct test against the real class.
Task 8: fix round 1 (edf67b8, 131 passed / 9 skipped, zero live IMAP connections).
  CONTROLLER VERIFIED against the real router:
    /api/thread/%                  -> 400 (was: threw URIError)
    /api/message/%/INBOX/1/body    -> 400
    /api/thread/t1                 -> 200 (unaffected)
    GET  /api/health               -> 200
    POST /api/health               -> 401
  My probe labelled the 401 "still answers" — that reading was WRONG. 401 means health no
  longer matches on a non-GET method, falls through to the auth gate, and is rejected.
  Arguably better than 405: an unauthenticated POST now looks identical to any other
  unauthenticated route and does not reveal that /api/health exists.
  Implementer's mutation evidence: reverting the guard makes all 6 new tests fail with an
  uncaught URIError rather than a clean assertion mismatch — i.e. genuinely causal.
Task 8: fix round 1 re-review — BOTH findings ADDRESSED. Reviewer GREPPED ALL OF
  sync/src/ and confirmed exactly ONE decodeURIComponent call site exists, inside
  decodeSegment's try/catch — so the guard is exhaustive, not just applied to the routes
  the controller probed. Confirmed no conflation of decode-failure with empty segment
  (decodeURIComponent never returns null on success, and every capture group is [^/]+ so
  an empty raw segment cannot reach it). Confirmed %2F and + still decode as before.
  Added a test for POST /api/health WITH a valid token -> 404, covering the
  authenticated-wrong-method path my own probe missed.
Task 8: complete (commits b782653..edf67b8, review clean after 1 fix round, 2 parked)

=== TASKS 1-8 COMPLETE. Task 9 (GCP deploy) blocked on the VM. ===
Running the whole-branch review across Tasks 1-8 now rather than idling.
USER DECISION: FOUR accounts, not ten. accounts.json already holds exactly these four and
  all are live-verified. Nothing to change — MAX_ACCOUNTS=10 remains a cap, not a target.
  Revised reality at 4 accounts (60,460 messages total):
    sync store        ~0.12 GB  (vs 0.31 GB projected for ten, vs ~1 GB originally planned)
    IMAP connections  4         (Gmail allows ~15 per account; we use 1 each)
    send capacity     ~2000/day aggregate (4 x ~500), still ample for per-recipient
                      tokenised tracking which costs one send per recipient
    GCP e2-micro      30 GB disk vs 0.12 GB store — the disk is a non-issue entirely;
                      1 GB RAM remains the binding constraint, and 4 connections instead
                      of 10 makes that materially easier too
  No further app passwords needed.

=== WHOLE-BRANCH REVIEW (Tasks 1-8): APPROVE WITH FIXES ===
Gates green (typecheck, check:runtime 10 modules, 124 passed / 16 skipped). Secret
hygiene CLEAN — the nested-.gitignore shadowing hazard was specifically checked and does
not bite; accounts.json untracked and ignored; logger:false not defeated anywhere except
F6. Boot ordering on an empty DB verified CORRECT (applySchema -> registerAccounts ->
pool.start), which matters because messages.account_id has an FK to accounts.

MUST FIX BEFORE MERGE:
F1 CRITICAL — backoff resets on CONNECT success, not CYCLE success (pool.ts:330). Any
  post-handshake failure resets attempt to 0, so backoff never grows past ~500ms.
  MEASURED by the reviewer against the real pool with a failing Db: 8 connect attempts in
  6s for ONE account (~1.3 handshakes/sec). Self-amplifying: an already-IMAP-suspended
  account (auth OK, SELECT INBOX fails) hammers Gmail forever — the very lockout this
  subsystem exists to prevent. Existing tests miss it: they assert only that A reconnect
  happens. FIX: reset attempt after a completed CYCLE, not after connect.
F2 IMPORTANT — isPrimary count still unvalidated, and config.test.ts ships a GREEN test
  asserting a zero-primary config is VALID, contradicting spec 7B.1 which I added in this
  branch. server.ts persists is_primary into a column with no uniqueness constraint.
  I unparked this and never actioned it. FIX: enforce exactly one, rewrite the test, add
  a partial unique index.
F3 IMPORTANT — on-demand body fetch is unbounded in memory AND invisible to the byte
  budget. fetchBodyPart Buffer.concats the whole part; handleBody passes NO partId so it
  downloads the entire raw message; writeWebResponse buffers it again. ~3x peak: a 25MB
  message is ~75MB, Gmail's 50MB limit is ~150MB, on a 1GB box with Postgres. Also
  violates spec L6: these bytes travel the same connection and count toward Gmail's
  2.5GB/day, but budget.reserve/record never see them.
F4 IMPORTANT — NOTHING WIRES SHUTDOWN TO A SIGNAL. No SIGTERM/SIGINT handler anywhere;
  close() is never called. Task 5's connect/disconnect race coordination, Task 7's
  sleepInterruptible timer fix (a full fix round, reproduced with `time node`), and
  pool.stop() are ALL DEAD CODE in production. Also: logout() has no timeout (hangs
  forever on a half-open socket, and stop() awaits Promise.all over all connections), and
  close() ordering is pool->db->server when it should be server->pool->db.
F5 IMPORTANT — syncOnce DROPS result.attachments. The attachments table is permanently
  empty, lookupAttachmentMeta is a guaranteed miss, and a client has no way to discover a
  partId at all. Task 3's three fix rounds protect a walk whose output is discarded.
F6 IMPORTANT — JSON.parse on accounts.json can echo ~20 chars of source into a V8 error,
  including an app password fragment, and startServer's entry guard console.errors it
  into the systemd journal. VERIFIED on this machine. Realistic trigger is exactly the
  paste mistake config.ts already anticipates.
F7 IMPORTANT — unified inbox ordering/pagination lossy: NULL dates sort FIRST in Postgres
  so an unparseable Date: header pins that message above all real mail forever AND is
  excluded from every later page; strict `<` drops ties at page boundaries on
  second-resolution Gmail timestamps.
F8 IMPORTANT (medium confidence) — the liveness probe can tear down a healthy connection
  mid-download. An API download breaks IDLE, the probe's NOOP queues behind it, a >15s
  download times out the probe, and runAccount disconnects a working connection.
NOTABLE MINOR — `snippet` is ALWAYS NULL. normalizeMessage derives it from raw.bodyText
  which fetchHeaders never supplies (correctly — it must not fetch bodies). Three files
  document it as load-bearing for the storage budget. Clearest six-month hazard.
NOTABLE MINOR — no backfill, no UID cursor: only the newest 50 UIDs are ever synced. More
  than 50 messages during an outage are PERMANENTLY MISSED.
FINAL FIX WAVE COMPLETE (02c9e71) — 201 passed / 9 skipped, up from 131/9. All of F1-F8
  plus the doc corrections and cheap items. Mutation evidence per finding; notably F1's
  mutation confirmed the PRE-EXISTING "reconnects with backoff" test passes under the
  bug, proving the review's claim it was never protection.
CONTROLLER VERIFIED:
  F2: loadConfig now rejects zero primaries AND two primaries, accepts exactly one.
  F1: 4 connect attempts in 6s vs 8 pre-fix — and the 4 are the backoff RAMPING
      (~750ms, 1.5s, 3s, 6s) whereas 8-per-6s was the pre-fix SUSTAINED rate. Steady
      state now climbs to the 5-min ceiling: ~2 orders of magnitude reduction.
  MY FIRST F1 PROBE WAS INVALID — I passed the factory as {createConnection: fn} when
  the constructor takes a bare function, so the pool never connected and my script
  reported "0 attempts, storm fixed". Third time this session a probe of mine returned
  a confident wrong answer. Read the signature; do not infer it.
Implementer's honest partials: F3 buffering remains (2x capped at 32MB = ~64MB peak, down
  from 3x uncapped ~150MB); F1 residual thrash window if idleLoop fails immediately every
  pass after a successful cycle; registerAccounts' clearing UPDATE not transactional
  (sub-ms no-primary window); it used accounts*.json* rather than my accounts*.json
  because the latter does NOT match accounts.json.bak — my brief was wrong.
FINAL FIX WAVE RE-REVIEW: F1-F7 ADDRESSED. F8 PARTIAL. Merge verdict APPROVE WITH FIXES.
  Reviewer independently ran the gates (182 passed / 28 skipped without a DB, arithmetically
  consistent with 201/9 with one), traced every await chain in the shutdown path and found
  no hang, verified the RFC 6266 header is ASCII-only for 発表資料.pdf through the REAL
  router, and proved F7's paging with a real 5-row loop across a tied timestamp and a NULL
  date. Confirmed accounts*.json* ignores .bak/.orig while accounts.example.json stays
  tracked — my brief's pattern was wrong and the implementer's correction was right.
RESIDUAL 1 — F8 incomplete: idleLoop calls probeLiveness(client) BARE, not through
  mutex.run. The named failure mode (probe tears down a healthy connection mid-download)
  is narrowed but NOT closed. Worse, the doc-comment asserts "the probe and the download
  can never interleave" — a guarantee the code does not deliver.
RESIDUAL 2 — F1's "resets once a cycle completes" test is VACUOUS: attempt starts at 0 in
  runAccount regardless, so the test passes even if the post-syncOnce reset were deleted.
  The primary bounded-reconnect test IS sound, so the fix is still pinned.
Ruling: ONE final tightly-scoped fix (three one-line changes), not a second wave. The
  false comment is the deciding factor — a narrow race is a known gap, a narrow race
  DOCUMENTED AS IMPOSSIBLE is a trap, and this project has been bitten by misleading
  comments repeatedly. The mutex wrap that makes the comment true costs one line.
  Cost if wrong: one extra round trip on an otherwise-finished branch.

=== TASK 9 COMPLETE — DEPLOYED AND LIVE ===
  https://postbox-valen.duckdns.org  — Let's Encrypt cert (Aug 24 -> Nov 22, auto-renew)
  GCP postbox-sync-11903 / postbox / us-central1-a / e2-micro / 30GB pd-standard
  All three always-free constraints met. Budget alert at $1 with 50%/100% thresholds.
  Service: active, bound 127.0.0.1:8080 ONLY (Caddy is the sole public path).
  Swap 2GB active (was 0), Postgres tuned for 955MB, 4 accounts connected, 200 msgs.
CONTROLLER VERIFIED END TO END: /api/health from the public internet returns all four
  accounts connected; /api/inbox returns real interleaved mail; per-account row counts
  confirm 50 each on the SERVER's own Postgres, not the Mac's.
CUTOVER: the Mac instance stopped CLEANLY on SIGTERM (exit 0) — F4's signal handler,
  which was dead code until the whole-branch review found it, working in production.
Caddy note: file logging fails under the packaged unit's sandbox even with a
  caddy-owned /var/log/caddy. Switched to journald (its default). journalctl -u caddy.
Task 9 concern (disclosed): the implementer modified src/api/server.ts to add
  BIND_HOST='127.0.0.1' — outside its declared file list, but amendment A4 was
  unachievable without it since the app had no host-binding config. Isolated fix: commit.
Task 9: review — spec ✅ (all 5 amendments), quality Approved, 3 Minor only.
  KEY ANSWER: BIND_HOST is a HARDCODED CONSTANT, not an env var — there is no absent-or-
  malformed case, so the fail-open pattern that bit this project twice (missing
  DATABASE_URL, missing IP_HASH_SALT) cannot recur here. Reviewer independently grepped
  the diff for gmail.com, account names and secret-shaped tokens: none.
Task 9: minor (parked) — no automated test asserts the loopback bind; verified live only.
Task 9: minor (parked) — README §4 omits the literal scp command other sections show.
Task 9: minor (parked) — the A3 rationale comment says systemd's CWD is / , but the unit
  sets WorkingDirectory explicitly. Absolute path is still correct; the reason is imprecise.
Task 9: complete (commits e6b1045..84009b6, review clean, 3 parked)

=== PLAN 2 COMPLETE: 9/9 TASKS, DEPLOYED AND LIVE ===
