# SDD ledger — plan: docs/superpowers/plans/2026-08-23-tracking-service.md

Branch: tracking-service   BASE: 0b79061
Ruling: feature branch, not worktree — new local repo, no origin (EnterWorktree's
  default `fresh` baseRef needs one), no concurrent work. Cost if wrong: ~zero.

## Pre-flight conflict scan

### Cross-task pairs (shared files or interfaces)

| Pair | Produces -> Consumes | Finding |
|---|---|---|
| T1 -> T7 | `package.json` created / `npm install nodemailer` mutates | Clean. Sequential, npm rewrites in place. |
| T4 -> T5 | `Classification` type | Clean. Single definition, imported. |
| T3 -> T5 | `DeviceInfo` type | Clean. Single definition, imported. |
| T1 -> T6 | `pixelResponse()` | Clean. |
| T2 -> T6 | `isValidToken()` | Clean. |
| T3 -> T6 | `parseUserAgent()` | Clean. |
| T4 -> T6 | `classifyHit`, `isDuplicate`, `DEDUPE_WINDOW_MS` | Clean. |
| T5 -> T6 | `lookupToken`, `recentHitTimes`, `recordOpen`, `hashIp` | Clean. Types line up: `sentAt` is ms number both sides; `recentHitTimes()` returns `number[]`, consumed as `readonly number[]`. |
| **T2 -> T7** | `generateToken()` vs `randomBytes(16).toString('hex')` | **FINDING 1 — duplication.** T7 reimplements T2's primitive because `.mjs` scripts cannot import the `.ts` module without a build step. |

### Per-task self-consistency

| Task | Tests vs code agree? | Finding |
|---|---|---|
| T1 | Yes | IHDR offsets 16/20 correct for PNG layout (8 sig + 4 len + 4 type). `atob` is global in Node 26. |
| T2 | Yes | — |
| T3 | Yes | Outlook branch precedes the `Windows NT` branch, so the Outlook UA resolves correctly. Safari test passes because `Version/` is present. |
| T4 | Yes | Branch order self > prefetch > scanner > mpp > open; every test targets a reachable branch. |
| T5 | N/A | Adapter only, no branching. Exercised end-to-end by T7. |
| **T6** | **No test at all** | **FINDING 2 — `extractToken` regex requires a `.png` suffix, but `vercel.json` rewrites `/o/:token.png` -> `/api/o/:token`. If Vercel presents the rewritten path, the regex fails and every open is silently dropped.** |
| T7 | Yes | — |

### Rulings

Ruling: FINDING 1 (token duplication T2/T7) — accept the duplication. Adding a TS
  build step to the measurement harness for one 3-line function costs more than it
  saves. BUT the silent-drift failure mode is real: if T7's format diverges, T6's
  `isValidToken` rejects every token and the measurement reports zero opens with no
  error. Mitigation carried into T7's dispatch: assert `/^[0-9a-f]{32}$/` on the
  generated token before insert, with a comment pointing at `src/token.ts`.
  Cost if wrong: a redundant 1-line assertion.

Ruling: FINDING 2 (extractToken vs Vercel rewrite) — amend T6. The regex must
  tolerate both `/o/<token>.png` and `/api/o/<token>`, and `extractToken` must get
  unit tests covering both shapes plus rejection of junk. Without this the whole
  service can deploy green and record nothing. Carried into T6's dispatch.
  Cost if wrong: one redundant alternation in a regex.

## Progress

Task 1: dispatched (haiku — mechanical transcription, complete code in brief)

Finding 2 follow-up: Vercel docs indicate a rewrite is transparent and `request.url`
  carries the ORIGINAL path (`/o/<token>.png`), not the destination. Sources were
  inferential rather than authoritative, so the tolerant-regex ruling stands and is
  now better grounded: it is correct under either behaviour for one alternation.
  Considered and rejected: dropping the rewrite and serving `/api/o/<token>` directly
  — a URL with no image extension is MORE conspicuous to pixel blockers, so the
  rewrite earns its keep (spec 5.1).
Task 1: implementer DONE (c7de641, 4/4 passing) — review dispatched (sonnet)
Task 1: review clean — spec ✅, quality Approved. Reviewer independently decoded the
  base64 and confirmed IHDR offsets 16/20; test is not vacuous.
Task 1: minor (deferred): TDD was nominal — code transcribed verbatim from a
  well-specified brief, so it is not evidence of independent test design.
Task 1: minor (deferred, CARRIED TO TASK 6): the "always HTTP 200 even on internal
  error" guarantee is trivially true now (no error paths exist). It needs real
  verification once T6 introduces token lookup and DB calls that can fail.
Task 1: complete (commits 0b79061..c7de641, review clean)
Task 2: dispatched (haiku) — BASE c7de641
Task 2: implementer DONE (47f32de, 8/8 suite) — review dispatched (sonnet)
Ruling: storage headroom verified — ~500B/row for both tables, ~150KB/day at heavy
  personal use => ~55MB/yr against Neon's 0.5GB. ~9 years. Not a constraint.
  Latency (Neon ~500ms cold start) explicitly accepted by user as a non-issue;
  the waitUntil refinement noted at Task 6 is therefore NOT needed. Dropped.
Ruling: AMEND TASK 5 — unbounded-write hole found. The endpoint writes a row for any
  valid token; the 10s dedupe collapses bursts but caps nothing overall, so a repeated
  fetch (hostile, or a retrying scanner, or a forwarded message on a list) writes rows
  indefinitely. Two guards, both in Task 5's adapter/schema:
    (a) cap opens per token at 200, via `insert ... select ... where (select count(*)
        from opens where token = $1) < 200` — one statement, no extra round trip;
    (b) truncate user_agent to 256 chars — the only unbounded-width column.
  Cost if wrong: a very popular message stops logging past 200 hits; revisit with
  Task 7's real data rather than guessing a higher number now.
Task 2: review clean — spec ✅, quality Approved. Reviewer verified in Node that the
  regex rejects a trailing newline and that hex encoding preserves leading zeros.
Task 2: minor (deferred): the 1000-token uniqueness test would NOT catch a swap from
  crypto.getRandomValues to Math.random (~52 bits => collision odds ~1e-10 across 1000
  draws). It only catches a near-constant generator. Test proves less than claimed.
Task 2: complete (commits c7de641..47f32de, review clean)
ACTION FOR USER: Neon credential was pasted into the session transcript. Rotate the
  neondb_owner password once the pipeline is verified working.
Task 3: dispatched (haiku) — BASE 47f32de
Ruling: spec amended (5.3.1) — user identified that per-recipient tokenized sends
  multiply ATTACHMENTS into the Sent folder (Gmail auto-files every SMTP send and the
  client cannot suppress it). 10MB to 5 recipients = 50MB of a 15GB quota. Mitigation
  is binding on Plan 4: degrade to a single shared token when
  attachment_bytes * recipients > 25MB (deterministic, cannot fail open), and
  optionally reconcile Sent copies over IMAP afterwards (racy, so secondary).
  No effect on Plan 1 — the tracking endpoint never sees content (spec 7.5).
CORRECTION: Task 3's review BASE is f7d2aa5 (the spec-amendment commit), not 47f32de.
  The docs commit landed on the branch after Task 3 was dispatched; using the older
  base would mix the spec edit into Task 3's review diff. Verify at package time that
  the implementer's commit did not sweep up docs/ via `git add -A`.
Task 3: implementer DONE (8029763, 16/16 suite) — review dispatched (sonnet)
CORRECTION SUPERSEDED: Task 3's commit (8029763) landed BEFORE the docs commit
  (f7d2aa5), not after. Correct review range is 47f32de..8029763, which isolates
  Task 3 exactly. Verified: 2 files, tracking/ only, no docs/ swept up.
Task 3: review clean — spec ✅, quality Approved. Reviewer traced all four ordering
  traps (Outlook/Windows, Android/Linux, iOS/macOS, GmailProxy/Windows) and confirmed
  each test would FAIL under a branch swap, so ordering is genuinely pinned.
Task 3: minor (deferred): no test exercises the final fallback UNKNOWN for an
  unrecognised UA (e.g. a crawler string) — untested code path.
Task 3: minor (deferred): report miscounted appleMailClient as "3 lines" (it is 5).
  Immaterial, but a self-review inaccuracy.
Task 3: complete (commits 47f32de..8029763, review clean)

Ruling: PRE-EMPTIVE on Task 4 — `isApplePrivacyProxy` in classify.ts and
  `appleMailClient` in ua.ts evaluate the SAME predicate (AppleWebKit UA carrying
  neither Version/ nor Safari/). A reviewer will likely flag this as a DRY violation.
  Decision: keep them separate. They are the same expression today but denote
  different concepts — "this is the Apple Mail client" vs "this fetch is MPP prefetch,
  not a human read" — and they are expected to diverge at Task 7 calibration, where
  only the MPP predicate gains IP-range checks and tuning. Unifying them now would
  couple a display concern to a suppression decision and make the calibration edit
  silently change device labelling. Cost if wrong: one duplicated 3-line predicate.
Task 4: dispatched (haiku) — BASE 47cb4d1
Task 4: implementer DONE (7761237, 28/28 suite) — review dispatched (sonnet)
BLOCKER (Task 7 only): Gmail app password failed SMTP AUTH (535) against
  li.valen.008@gmail.com. I guessed that account; user has multiple. App passwords are
  account-specific. Awaiting the correct GMAIL_USER. Does not block Tasks 4-6.
RESOLVED: GMAIL_USER=xinfinitypro@gmail.com (app password was issued on that account,
  not li.valen.008@). SMTP AUTH verified SUCCESS against smtp.gmail.com:465.
  Task 7 unblocked. Note: this address becomes `account_id` on Task 7's token rows.
Task 4: review — spec ✅, quality Approved BUT one Important finding: precedence order
  only partially pinned. Suite covers self>mpp only; swapping self<->prefetch,
  self<->scanner, prefetch<->scanner, or scanner<->mpp passes all 12 tests.
  Reviewer independently traced all 5 branches as reachable, confirmed no in-place
  array mutation, and confirmed the burst boundary (3 priors + current = fires on 4th).
Task 4: minor (deferred): SCANNER_BURST_* constants lack the explanatory comments the
  other two constants carry; "3" meaning "fires on the 4th hit" is non-obvious.
Task 4: minor (deferred): test named "prefers self over every other classification"
  only exercises self-over-mpp; name overpromises.
Ruling: Important finding conflicts with the plan's own 12-test list — plan loses. The
  plan declares the ordering load-bearing and then fails to defend it; the spec mandates
  no test count. Entering fix loop round 1. Cost if wrong: ~20 lines of test.
Task 4: fix round 1/5 (3 findings addressed per implementer, 32/32 suite; commits
  7761237..088ff21). Verified independently: src/classify.ts changed by COMMENTS ONLY,
  zero logic or constant-value change — the "do not edit classifyHit" guardrail held.
  Scoped re-review dispatched (sonnet) with instruction to mentally swap each branch
  pair and confirm the new tests would actually FAIL under the swap.
Task 4: fix round 1 re-review — ALL 3 findings ADDRESSED. Re-reviewer performed each
  branch swap and confirmed all 5 precedence tests genuinely FAIL under the swap
  (not same-result tests). classify.ts byte-identical apart from 2 comment lines.
Task 4: complete (commits 47cb4d1..088ff21, review clean after 1 fix round)
Task 5: dispatched (sonnet — live DB integration + subtle capped-insert SQL, not
  transcription) — BASE 088ff21. Carries the two storage-guard amendments.
Task 5: implementer DONE (353bc63). Cap VERIFIED LIVE: 205 recordOpen calls -> exactly
  200 rows; cleanup left 0. Schema applied via Node (psql absent); 3 tables + 7 indexes
  confirmed on Neon. Review dispatched (sonnet).
FINDING (cross-cutting, surfaced by Task 5's implementer): `tsc --noEmit` fails on
  src/pixel.ts:29 — TS 5.7+ made TypedArrays generic, so the plan's `: Uint8Array`
  annotation widens to Uint8Array<ArrayBufferLike>, which is not assignable to BodyInit.
  It shipped because package.json has NO typecheck script and Vitest transpiles via
  esbuild without checking types. Five tasks and three clean reviews missed it because
  reviewers read diffs, they do not compile.
Ruling: fix now via a separate small dispatch, not folded into Task 5 (different files;
  folding would muddy Task 5's review diff). Add a `typecheck` script, fix the
  annotation, and make `npm run typecheck` a required gate for Tasks 6-7 before commit.
  Cost if wrong: one script entry and a type argument. db.ts itself is type-clean.
Dispatched in parallel (safe — disjoint files, reviewer is read-only):
  (a) typecheck-gap fix (haiku): narrow PIXEL_BYTES annotation + add `typecheck` script
  (b) Task 5 review (sonnet)
CARRY TO TASKS 6 & 7: `npm run typecheck` must pass before commit, alongside vitest.
  Add this to both dispatch prompts explicitly.
Typecheck gap: FIXED (1c4334c). Controller independently re-ran `npm run typecheck` —
  exit 0, zero errors. Fix was to drop the explicit `: Uint8Array` annotation and let
  inference produce Uint8Array<ArrayBuffer>. No `as` cast used. 32/32 tests still pass.
Task 5: review — spec ✅, quality Approved. Amendment 3 evidence verified real by the
  reviewer (actual command + captured output, 205 calls -> 200 rows, throwaway script
  correctly NOT committed). hashIp confirmed Web Crypto; no raw recipient IP written.
Task 5: parked — Important: the capped INSERT...SELECT...WHERE does NOT fully close the
  race at DB level. Under READ COMMITTED two concurrent statements can both read the
  pre-insert count, both pass < 200, and both commit, overshooting the cap.
  Ruling: ACCEPT. My amendment's premise ("single statement avoids the race") was wrong
  at the DB level — it only removed the application-level two-round-trip race. But the
  overshoot is BOUNDED BY CONCURRENCY (a few rows), not unbounded, so the guard's
  purpose — stopping a 0.5GB DB from filling — is fully served. Fixing properly needs
  SERIALIZABLE or an advisory lock, neither available on Neon's HTTP driver (no
  multi-statement transactions); it would mean the WebSocket pool driver and extra
  connection overhead on a latency-sensitive Edge path. Cost if wrong: ~5KB per capped
  token against 0.5GB. Revisit only if Task 7 data shows real concurrent bursts.
Task 5: complete (commits 088ff21..353bc63, 1 parked)
CARRY TO TASKS 6 & 7 (reviewer's ⚠️): tokens.sender_ip is an UNHASHED column. It must
  only ever hold the USER'S OWN sending IP (used raw by classifyHit for self-open
  suppression via string compare). It must NEVER receive a recipient IP. Add a schema
  comment saying so, and verify Task 7's INSERT INTO tokens honours it.
Task 6: dispatched (sonnet) — BASE 1c4334c. Deploy explicitly OUT of scope (needs interactive Vercel auth); controller handles it with the user.
Task 6: implementer DONE (de1a3b1, 40/40 tests, typecheck clean). DB-error path verified
  for real via an unreachable hostname — no mocking library needed.
DEPLOYED: https://postbox-tracking.vercel.app (stable alias; deployment-specific URLs
  rotate per deploy and would break every pixel already sent). Env vars DATABASE_URL and
  IP_HASH_SALT set as Sensitive in Production; redeployed so the build picks them up.
CONTROLLER VERIFICATION (live, production):
  - unknown token -> HTTP 200, image/png, 68 bytes, all 3 cache headers correct
  - real token    -> open RECORDED: classification=open, device_class=desktop, os=macOS,
                     raw_ip_hash 64 hex chars (SHA-256, never raw), UA truncated
  Pre-flight Finding 2 VINDICATED: the tolerant extractToken regex works against real
  Vercel rewrite behaviour. The plan's .png-required regex would have returned a perfect
  pixel and silently recorded nothing.
Task 6: review — spec ✅ (one ⚠️), quality NEEDS WORK. Reviewer independently re-ran
  both gates (typecheck 0 errors, 40/40), traced the regex by hand, and checked Vercel
  docs confirming x-forwarded-for is edge-controlled and NOT client-spoofable (clears
  the self-open-suppression manipulation risk I flagged). Always-200 confirmed
  structurally provable: one return statement, try wraps all fallible work.
Task 6: IMPORTANT — report disclosure failure, not a code defect. Amendment 2 named 4
  scenarios and required any gap be disclosed. The implementer closed the db-error gap
  and reported "no concerns", omitting that valid-token and unknown-token have zero
  coverage in the task's own suite. Both ARE verified by controller live checks, but
  that was not guaranteed at report time. Entering fix round 1.
Ruling: fix rather than park. A genuine unit test for those two paths is not reachable
  without a mocking library (forbidden) — with a bogus DATABASE_URL the unknown-token
  path throws and is caught, indistinguishable from the real path. So the correct remedy
  is honest disclosure, not more tests: amend the report and document the coverage
  boundary in the test file, citing the live production verification. Cost if wrong: a
  comment block and a report paragraph.
Task 6: minor (folded into fix round): 3 always-200 tests repeat an identical
  6-assertion block; extract an expectStandardPixel helper.
Task 6: minor (deferred, accepted): timing side-channel — a valid token does up to 3 DB
  round-trips vs 0-1 for invalid. Inherited from the brief; 128-bit token space prevents
  enumeration and the status/body fingerprinting vector is fully closed.
Task 6: fix round 1/5 (commit 62e4447, tests/endpoint.test.ts only; 40/40, typecheck 0).
  Verified independently: api/o/[token].ts NOT touched — guardrail held. Scoped
  re-review dispatched (sonnet) with instruction to judge whether the disclosure is
  genuinely candid or merely present, and whether the standing "None outstanding" claim
  was corrected rather than just contradicted later.

TASK 7 PREP — critical detail that would silently zero the whole measurement:
  SENDER_IP must stay UNSET for the calibration run. The user opens the test mail on
  their OWN devices, so if sender_ip is populated, classifyHit returns 'self' for those
  hits and suppresses them — the calibration would report zero opens and look like
  tracking simply does not work. For calibration we want the RAW classification
  (mpp/prefetch/scanner/open) with nothing suppressed. Self-suppression is a
  real-usage feature, not a calibration one. .env currently has no SENDER_IP: correct.
  Must be stated explicitly in the dispatch or an implementer may helpfully "fix" it.
Task 6: fix round 1 re-review — BOTH findings ADDRESSED. Re-reviewer grepped to confirm
  the false "None outstanding" line is GONE (in-place correction, not a later
  contradiction), judged the disclosure genuinely candid (report explicitly refuses to
  let the live check excuse the earlier omission), and verified expectStandardPixel
  still asserts all six properties with none quietly dropped.
Task 6: complete (commits 1c4334c..62e4447, review clean after 1 fix round)
Task 7: calibration matrix revised with the user's REAL accounts. Sender
  xinfinitypro@gmail.com; targets li.valen.008@gmail.com (Gmail web + Gmail iOS) and
  li.valen@icloud.com (Apple Mail). NO Outlook account — that row dropped.
  Consequence named: without a non-proxied desktop client, Gmail rows can only confirm
  that device data is unrecoverable; they cannot validate parseUserAgent at all.
  Added an MPP CONTROL EXPERIMENT as the highest-value row: two sends to iCloud, one
  opened with Protect Mail Activity ON, one with it OFF. The delta is the user's actual
  MPP distortion rate — measured rather than assumed — and it is the single number that
  decides whether read-state tracking carries usable signal. Row 4 (MPP OFF) is also the
  ONLY row that exercises parseUserAgent against a real client UA.
Task 7: implementer DONE (7756b48). Smoke test sent (xinfinitypro -> li.valen.008 only,
  within scope); token row + report verified; typecheck 0, 40/40 tests.
  Controller pre-checked measurement-results.md: matrix uses the user's REAL addresses,
  MPP ON/OFF control rows present, Outlook row correctly dropped, ALL data cells EMPTY,
  no fabricated percentages anywhere. Review dispatched (sonnet).
  Implementer self-disclosed: a failed sendMail after a successful token insert leaves
  an orphan zero-hit token row. Flagged to the reviewer to judge whether an orphan could
  be misread as "sent but never opened" — that would corrupt the measurement.
FIRST REAL OPEN RECORDED (user replied "done" to the smoke test):
  sent 01:40:07 -> opened 01:43:30 (+203s), classification=open, device=unknown/null,
  UA = GoogleImageProxy (advertises Windows NT 5.1 / Firefox 11 — Google's fetcher).
  Validates with LIVE data: (a) prefetch window works — 203s lag correctly classified as
  a real open, not prefetch; (b) NO delivery prefetch occurred for this message (only one
  hit), so Gmail fetched on open here; (c) honest-unknown works — a naive parser would
  have written "Windows desktop" into the UI with full confidence.
  Still unproven: anything about Apple MPP, and device attribution itself — Gmail can
  never demonstrate the latter. Only the MPP-OFF iCloud row exercises parseUserAgent
  against a real client UA.
Task 7: review — spec ✅ (all 4 amendments + late amendment verified byte-for-byte,
  including the pixel markup literal), quality Approved with 1 Important + 2 Minor.
Task 7: IMPORTANT — orphan token row from a failed sendMail renders in report.mjs
  identically to "sent, delivered, never opened" (both show NO HITS). With ~5 calibration
  targets, one misread row can corrupt the build/don't-build conclusion.
Ruling: FIX. Delete the token row when sendMail fails so no orphan can exist, plus a
  reconciliation note in the run instructions. Cost if wrong: a few lines of cleanup.
Task 7: MINOR — MY AMENDMENT WAS WRONG. I specified a guard asserting /^[0-9a-f]{32}$/
  against a token the same script generated two lines earlier via randomBytes(16)
  .toString('hex'). It is tautological, can never fail, and cannot observe src/token.ts
  — the exact drift it was written to catch. The implementer built precisely what I
  specified; the defect is mine.
Ruling: FIX PROPERLY. Have the script READ src/token.ts, extract TOKEN_PATTERN from the
  source, and test against that — and throw if extraction itself fails (fail closed, so
  a rename or reformat surfaces loudly rather than silently disabling the guard). This
  is what the amendment intended. Cost if wrong: ~5 lines and a small coupling to
  token.ts's source formatting, which fails loudly rather than silently.
Task 7: minor (deferred, accepted): no automated tests for the two .mjs ops scripts.
  They exist to perform one real SMTP send and one real DB read against production;
  mocking nodemailer and Postgres would cost more than it returns. Never requested.
Task 7: fix round 1/5 (2c24833). Controller independently ran the new guard's extraction
  logic standalone: it pulls ^[0-9a-f]{32}$ out of src/token.ts source, accepts a valid
  token, rejects short and uppercase, and returns no match on a renamed constant so the
  guard THROWS (fails closed) as required. Extraction mechanism confirmed working.
  Not yet confirmed and handed to the re-reviewer: whether the guard is actually WIRED
  into the send path before the insert (a guard defined but called after the row is
  written would let a drifted token reach the DB), and whether the rollback catch
  preserves the original error and prints the token on rollback failure.
  Scoped re-review dispatched (sonnet).
Task 7: fix round 1 re-review — BOTH findings ADDRESSED. Re-reviewer traced the rollback
  catch line by line: original sendError prints BEFORE the nested rollback attempt so a
  rollback failure cannot swallow it; token is printed before rollbackError. Guard
  confirmed WIRED IN at line 51, before the insert at 74-83. All standing constraints
  verified unweakened (pixel markup, SENDER_IP, schema comment, empty tables).
Task 7: complete (commits 85c162d..2c24833, review clean after 1 fix round)

=== ALL 7 TASKS COMPLETE — proceeding to whole-branch review ===

=== WHOLE-BRANCH REVIEW: APPROVE WITH FIXES ===
Gates green (typecheck 0, 40/40). Secret hygiene clean (git log -S 'npg_' across all
refs returns nothing). No Critical. Deferred list triaged: all 8 FINE TO DEFER, and the
Task 5 READ COMMITTED ruling was judged to HOLD (overshoot bounded by in-flight
concurrency, HTTP driver genuinely cannot do SERIALIZABLE).

IMPORTANT 1 — spec 5.4's burst-scanner rule is STRUCTURALLY UNREACHABLE in production.
  recentHitTimes(token, 10_000) returns only rows newer than 10s; isDuplicate returns
  true if ANY prior hit is within 10s. Every row the query can return satisfies that by
  construction => classifyHit is only ever called with recentHitTimes: []. isScannerBurst
  filters an empty array against >= 3 and can never fire outside unit tests. Widening the
  fetch window does not help: dedupe returns BEFORE recordOpen, so opens holds at most
  one row per token per 10s, and the rule needs 3 rows in 5s. The evidence the rule needs
  is destroyed by the rule that runs ahead of it.
Ruling: DOCUMENT HONESTLY NOW, defer the real fix to Plan 4. Reordering classify-before-
  dedupe changes what gets written to the DB and would need its own review cycle; doing
  that after the whole-branch review, on a deployed service, trades a known-and-labelled
  gap for an unreviewed behaviour change. Calibration does not depend on burst detection
  (a burst scanner with an UNRECOGNISED UA is the only case it would catch — known-vendor
  UAs still classify scanner correctly). MUST be surfaced in measurement-results.md so
  `scanner: 0` is not misread as "no scanners". Cost if wrong: a rare scanner class goes
  uncounted in calibration, with the limitation stated on the page.

IMPORTANT 2 — missing DATABASE_URL breaks always-200. neon('') throws at MODULE LOAD,
  above the handler's try; Vercel returns an HTML 500, not a pixel. Verified empirically
  by the reviewer against the installed driver. Live trigger: the pending Neon password
  rotation with a deploy landing before the var propagates. Ruling: FIX (lazy client).

IMPORTANT 3 — missing IP_HASH_SALT silently degrades to SHA-256(":"+ip), a 2^32
  brute-force, in the column spec 7.2 promises is salted. Ruling: FIX (throw; the
  handler's catch already makes it fail CLOSED — records nothing rather than recording
  reversible hashes).

MINOR (folding into the same fix wave): db.ts:78-84 comment implies the capped INSERT is
  race-free (it is not — see parked Task 5); tracking/.gitignore's bare `.env*` shadows
  the root's `!.env.example` negation; measurement-results.md's MPP prediction
  contradicts the classifier (BOTH iCloud rows classify mpp by construction — the signal
  is timing/hit-count, not classification); createTransport() sits outside the try in
  send-test.mjs leaving a 2-line orphan window.
