# Classifier recalibration — execution log

**Date:** 2026-08-24
**Trigger:** first production calibration run invalidated the MPP heuristic
in `tracking/src/classify.ts` (see `tracking/docs/measurement-results.md`).
**Type:** targeted repair against real-world measurement data, not a
planning task.

## Summary

The calibration run proved `isApplePrivacyProxy` never fired against real
traffic: Apple's MPP relay sends a bare 11-character `"Mozilla/5.0"`, which
carries no `AppleWebKit` token, so the old `isWebKit && !isBrowser` check
was always false against it. Both `apple-mail-mpp-on` and
`apple-mail-mpp-off` calibration sends were recorded as `open` — a genuine
machine prefetch counted as a confirmed human read, the exact failure this
classifier exists to prevent. Separately, the data showed
`PREFETCH_WINDOW_MS` (10s) was too narrow: two Gmail proxy hits at +14s and
+26s, very likely machine re-fetches, fell outside the window and were also
recorded as `open`.

Both are fixed in `tracking/src/classify.ts`. Device attribution's
empirical 0% rate is recorded in the spec as a limitation. The calibration
results and three required analysis questions are filled into
`tracking/docs/measurement-results.md` with the real measured data.

## Changes made

### 1. `isApplePrivacyProxy` → `isContentlessProxy` (`tracking/src/classify.ts`)

**Old heuristic:** `ua.includes('AppleWebKit') && !ua.includes('Version/') && !ua.includes('Safari/')`.

**New heuristic:** `!ua.includes('(')` (plus the unchanged Apple-netblock IP
check as an independent trigger).

**Why:** the measured MPP proxy UA (`"Mozilla/5.0"`, 11 characters) has no
platform parenthetical at all. Every genuine mail client identifies its
platform in a parenthetical segment — `"(Macintosh; Intel Mac OS X
10_15_7)"`, `"(Windows NT 10.0)"`, `"(iPhone; CPU iPhone OS 17_5 like Mac OS
X)"`, etc. — so the complete absence of `(` is a clean, evidence-backed
signature for a relay/proxy fetch. It also naturally and correctly covers
an empty user-agent string, as the task required.

**Renamed, not just retuned.** The dominant trigger is no longer
Apple-specific — it fires on any contentless UA, from any source, which is
exactly what the task asked it to do ("implement it so a bare `Mozilla/5.0`
... classifies as `mpp`"). `isContentlessProxy` describes what the function
actually checks; `isApplePrivacyProxy` implied an Apple-specific signature
that the primary trigger no longer is. The Apple-netblock IP check
(`ip.startsWith('17.')`) remains as the function's one genuinely
Apple-specific trigger, kept because it costs nothing and remains valid
regardless of UA shape.

**All references updated:** the function definition and its call site in
`classifyHit` (`tracking/src/classify.ts`), and the historical prose in
`tracking/docs/measurement-results.md` that names the function — those
references are left as `isApplePrivacyProxy()` where they describe what the
code was named/did *at measurement time* (the erratum block and the
Results-table notes), since that's an accurate historical record, not a
live reference that needs to track the current name. Nothing outside
`classify.ts` imports the function (checked: `tracking/src/db.ts` only
imports the `Classification` type; `tracking/api/o/[token].ts` calls
`classifyHit`, never the proxy-detection function directly), so no
production call site needed updating.

### 2. The AppleWebKit-without-Version/Safari condition: dropped, not kept

The task required a deliberate, justified decision here rather than a
reflexive keep-or-drop. **Decision: dropped.**

**Reasoning.** That UA shape — `AppleWebKit` present, neither `Version/`
nor `Safari/` present — never appeared as an MPP signature in this
calibration; the real proxy signature is the *absence* of any parenthetical
at all, a strictly different and stronger condition (a full AppleWebKit
platform string still contains a `(`). Crucially, `tracking/src/ua.ts`
already uses this exact same check (`appleMailClient`) for a different,
opposite purpose: to *positively identify* "Apple Mail" as the real client,
for device attribution. That function's own comment states it plainly:
"Apple Mail presents an AppleWebKit UA carrying neither a Version/ nor a
Safari/ token; real Safari always carries both." In other words, this shape
is documented elsewhere in the same codebase as the signature of a **real,
direct-loading Apple Mail client** — not of Apple's privacy proxy.

Keeping the old condition in `classify.ts`'s MPP check would have meant: a
genuine human open, from Apple Mail, with images loaded directly (no MPP
proxy involved — MPP fully off, or a client that bypasses it) would be
labelled `mpp` and suppressed as "not a confirmed open." That is the
mirror-image of the exact bug this recalibration exists to fix — trading
one false-positive-suppression direction (proxy fetches counted as opens)
for a false-negative-suppression direction (real opens hidden as
unverifiable). Given Apple Mail is called out in the spec itself as
"roughly half of all email opens" (spec L1), silently mislabeling a real
subset of those as unverifiable is a real cost, and one this run's own
device-attribution logic contradicts.

**Trade accepted:** a differently-shaped Apple proxy fetch not observed in
this run (e.g. a future MPP relay version that emits a platform
parenthetical, or a different privacy-proxying mail client) would fall
through to `open` instead of `mpp` under the new heuristic. This is
mitigated, not eliminated, by the unchanged Apple-netblock IP check, which
triggers independently of UA shape. I judged this residual risk smaller
than the immediate, evidenced cost of keeping a condition that (a) never
matched real MPP traffic in this run, and (b) is documented elsewhere in
this codebase as the signature of a genuine client, not a proxy.

### 3. `PREFETCH_WINDOW_MS`: 10,000 → 60,000

**Evidence used (GoogleImageProxy lag from send, all four Gmail-related
hits carry the identical measured UA):**

| Lag | Old classification | Likely reality |
|---|---|---|
| +9s | `prefetch` (correct) | machine prefetch |
| +14s | `open` (wrong) | very likely machine |
| +26s | `open` (wrong) | possibly machine, possibly the real open |
| +203s | `open` (correct) | **confirmed genuine human open** (recipient replied "done") |

**Reasoning for 60,000ms specifically:** the window needs to clear the
14s/26s suspects with margin for jitter (a slightly slower or faster
network/proxy round trip shouldn't flip the classification), while staying
well clear of the one confirmed genuine open at 203s, so a fast human
reader isn't silently suppressed. 60s is roughly 2.3x the highest suspect
lag (26s) and leaves ~140s of headroom below the confirmed genuine open —
closer to the machine-lag cluster than to the human lag, on the
(explicitly untested) theory that a delayed Gmail proxy re-fetch is more
likely than a human opening mail within a minute of send. I did not pick a
tighter value (e.g. 30s, which barely clears 26s with no jitter margin) or
a much wider one (e.g. 120s, which starts eating into the gap before the
one confirmed human data point) — six data points from one run don't
support fitting a precise boundary, so I chose a round, defensible number
with margin on both sides rather than optimizing against this specific
sample. The code comment states this is provisional and names the ambiguous
zone (roughly 30s-200s) that needs more data before the window can be
tightened with confidence.

**Trade acknowledged in the comment:** widening the window also widens the
zone in which a genuine fast human open gets suppressed as prefetch. This
is an explicit, accepted trade, not an oversight — recorded in the code
comment on `PREFETCH_WINDOW_MS`.

`DEDUPE_WINDOW_MS` (10,000ms) was left untouched — spec 5.4 binds it
explicitly ("Repeat hits on the same token within a 10-second window MUST
be collapsed into one event"), and Finding 2 was scoped to the prefetch
window only.

### 4. Spec section 9: added L8 (`docs/superpowers/specs/2026-08-23-postbox-spec.md`)

Added a new limitation entry recording that device attribution
(`parseUserAgent`, spec 5.7) was empirically 0% across every real account
tested in this calibration — Gmail proxies (expected, per existing L2) and
Apple's MPP relay both yield `device_class: unknown`, for different
underlying reasons that produce the same observable outcome. It notes
`parseUserAgent` is correct code, retained for accounts where a real UA
does arrive, and states explicitly that the future UI must not be designed
around device breakdowns as a primary surface for Gmail/iCloud-heavy
recipient sets. `parseUserAgent` and `tracking/src/ua.ts` were not modified
— the task was explicit that this code is correct and should not be
deleted; only the limitation needed recording.

### 5. `tracking/docs/measurement-results.md`: real data recorded

Filled in the `Results` table (per-target: hit arrival, classification(s),
device attribution, hit count, notes) and the `Classification breakdown`
table using the measured data from the task brief — these are the actual
production observations, not fabricated or estimated numbers. Also:

- Added an **erratum block** after the pre-run prediction that both
  MPP-on/off rows "are expected to classify as `mpp`" — that prediction was
  reasoned correctly from the code as it existed, but the code's premise
  about what MPP traffic looks like was wrong, so the prediction was wrong
  in a way that is itself the finding. Left the original prediction text
  intact (accurate historical record of what was believed pre-run) rather
  than rewriting it, and added the erratum as a clearly-marked correction
  pointing at this log.
- Updated the **smoke-test section**: it originally recorded "No (0 hits)"
  as of write time; the +203s hit has since landed, is classified `open`,
  and is the run's one independently-confirmed genuine human open (reply
  "done"). Noted that this single hit directly grounds the
  `PREFETCH_WINDOW_MS` choice above.
- Updated the doc's status banner from "template, awaiting real data" to
  reflect the completed run.
- Answered all **three required analysis questions** using only the
  measured data:
  1. **Did any true open go unrecorded?** No — every send (rows 1-4 plus
     the smoke test) produced at least one hit. Noted this is a narrow
     result (5-6 hits) that cannot bound a general loss rate.
  2. **Was any true open misclassified?** Yes, inverted from the question's
     original framing — machine prefetches (Apple MPP at +25s/+7s, and
     likely the Gmail +14s hit) were misclassified as genuine `open`
     events, not the other way around. The one confirmed genuine open (the
     smoke test) was *not* misclassified. Named the fixes applied in
     response.
  3. **Is the signal worth building a client around?** Answered with
     nuance rather than a flat yes/no: pixel delivery held up in every case
     tested; human-vs-machine discrimination was badly broken and is now
     provisionally, evidence-backed better — but unvalidated against any
     real human Apple Mail open, because none occurred in this data; device
     attribution is architecturally unavailable for the accounts actually
     in use. Concluded the build is defensible on this evidence but the UI
     must treat classification and device data as provisional, per spec
     7A.2's existing honest-states requirement.

## Tests changed (`tracking/tests/classify.test.ts`)

Went from 40 to 47 total tests in the suite (23 in `classify.test.ts`, up
from 16).

**Corrected, not deleted, because behavior legitimately changed:**

- `'labels Apple MPP prefetch rather than counting it as an open'` (old
  AppleWebKit UA, expected `mpp`) → renamed
  `'classifies a direct (non-proxied) Apple Mail fetch as a real open, not
  mpp'`, same UA, now expects `open`. This is the direct consequence of the
  decision in change #2 above: this UA shape no longer triggers `mpp`, and
  under the recalibrated heuristic `open` is the correct classification,
  not a regression.
- `'prefers self over mpp when both conditions hold'` — the old test used
  the AppleWebKit UA, which no longer satisfies the "mpp condition," making
  the test's stated premise inaccurate even though the assertion (`self`)
  still passed (the `self` check runs first regardless). Updated the UA to
  the real contentless proxy string (`"Mozilla/5.0"`) so both conditions
  genuinely hold, preserving the test's actual intent.
- `'prefers scanner over mpp when both conditions hold'` — same issue and
  same fix: swapped the UA to the real contentless string so the "mpp
  condition" the test name refers to is actually true.

**Added, using real observed user-agent strings verbatim per the task
requirement:**

- `'labels the real Apple MPP proxy user agent as mpp'` — literal
  `"Mozilla/5.0"`.
- `'labels an empty user agent as mpp, since no genuine client sends one'`
  — covers the "including an empty one" requirement explicitly.
- `'suppresses the real Gmail proxy UA at the measured 9s/14s/26s lag'`
  (three tests) and `'counts the real Gmail proxy UA as open at the
  measured 203s confirmed-human lag'` — using the literal 89-character
  Gmail proxy UA string from the calibration data, at the exact measured
  lags. The 14s/26s tests directly demonstrate the Finding 2 fix (they were
  `open` under the old 10s window; they are `prefetch` under the new 60s
  window).
- `'counts a Gmail proxy fetch as open exactly at the PREFETCH_WINDOW_MS
  boundary'` — boundary test using the exported constant rather than a
  hardcoded number, so it stays correct if the window is retuned again.

**Incidental fixture fix:** the shared `hit()` test helper's default
`occurredAt` was `SENT_AT + 60_000` — which became numerically identical to
the new `PREFETCH_WINDOW_MS` value by coincidence. Changed it to
`SENT_AT + PREFETCH_WINDOW_MS + 60_000` so the default fixture stays
unambiguously outside the prefetch window regardless of future retuning,
rather than relying on the two constants happening to differ.

No test was deleted. `isScannerBurst` and its test (`'flags a rapid burst
on one token as a scanner'`) were not touched, per the constraint not to
touch that path.

## Gate output

**`npm run typecheck`** (from `tracking/`):

```
> typecheck
> tsc --noEmit
```

Clean, no output, exit 0.

**`npx vitest run`** (from `tracking/`):

```
 RUN  v2.1.9 /Users/li-valen/Developer/postbox/tracking

 ✓ tests/ua.test.ts (8 tests)
 ✓ tests/pixel.test.ts (4 tests)
 ✓ tests/classify.test.ts (23 tests)
 ✓ tests/token.test.ts (4 tests)
 ✓ tests/endpoint.test.ts (8 tests)

 Test Files  5 passed (5)
      Tests  47 passed (47)
```

47/47 passing, up from the pre-change 40/40 (7 new `classify.test.ts`
cases; no other suite touched).

## Diff scope check (self-review)

Files touched: `tracking/src/classify.ts`, `tracking/tests/classify.test.ts`,
`tracking/docs/measurement-results.md`,
`docs/superpowers/specs/2026-08-23-postbox-spec.md`. Confirmed via `git
status`/`git diff --stat` that nothing else changed.

- `tracking/api/o/[token].ts` (endpoint order of operations): untouched —
  calls `classifyHit(...)` the same way, with the same argument shape.
- Pixel markup (`tracking/src/pixel.ts`): untouched.
- Schema / SQL (`tracking/src/schema.sql`, `tracking/src/db.ts`): untouched.
  `db.ts` only imports the `Classification` type, which did not change.
- `isScannerBurst` and its documentation: untouched, per constraint.
- `parseUserAgent` / `tracking/src/ua.ts`: untouched, per constraint (kept,
  not deleted; its device-attribution heuristic is unrelated to the
  MPP-classification heuristic that changed).
- No new dependencies added; no Node-specific APIs introduced (the fix is a
  single string method, `String.prototype.includes`, already used
  throughout the file).
- No email sent, no database write, no deploy performed.

## What I could not verify

- **The new `isContentlessProxy` heuristic against any Apple proxy shape
  other than the one observed.** This calibration run has exactly two MPP
  hits, both with byte-identical UAs. Whether Apple's relay is consistent
  across regions, OS versions, or over time cannot be established from two
  data points from one account. This is called out explicitly in the code
  comment and in measurement-results.md's Q3 answer.
- **Whether 60,000ms is the right prefetch window in general.** It is
  defensible from the six data points available, but the code comment and
  measurement-results.md both flag it as provisional. In particular,
  nothing in this data set says what happens between roughly 30s and 200s
  after send — that whole range is unobserved.
- **Whether a genuine human Apple Mail open would now classify correctly.**
  No such event occurred in this calibration run (both Apple hits were MPP
  proxy prefetches). The decision to drop the old AppleWebKit condition is
  reasoned from the codebase's own `ua.ts` documentation and from the logic
  of what MPP does and doesn't proxy, not from a directly observed genuine
  Apple Mail open in this data.
- **Row 5 (`real-contact`)** of the calibration matrix was not run, so
  there is no second independent human-open data point beyond the smoke
  test.
