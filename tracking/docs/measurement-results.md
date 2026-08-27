# Live measurement results — tracking pixel calibration

**Status: run complete, results recorded 2026-08-24.** Rows 1-4 of the
calibration matrix were sent, opened, and reported per the procedure below;
row 5 (`real-contact`) was not run (optional, user's discretion). The
"How to run this" / "Calibration matrix to run" sections are kept as-written
for traceability of what was planned and predicted going in — see the
erratum below for where a pre-run prediction turned out to be wrong, and
`Results` / `Analysis` for what was actually measured. This document is the
deliverable that Success Criterion 7 and the Plan gate require, and it fed
directly into the classifier recalibration recorded in
`docs/superpowers/logs/2026-08-24-classifier-recalibration.md`.

## How to run this

1. Confirm `tracking/.env` has `DATABASE_URL`, `IP_HASH_SALT`, `PIXEL_BASE`,
   `GMAIL_USER`, `GMAIL_APP_PASSWORD` set, and does **not** have `SENDER_IP`
   set (see the comment in `scripts/send-test.mjs` — populating it would
   suppress every calibration hit as `self`).
2. From `tracking/`, send one message per row in the matrix below:
   ```bash
   node --env-file=.env scripts/send-test.mjs <recipient> "<label>"
   ```
   Confirm each send printed its `sent to ... token ... pixel ...` success
   line before moving on. If a send fails, `send-test.mjs` now rolls back
   the token row it inserted (so no orphan can survive to be misread as a
   real "sent but never opened" target) — but only trust a later `NO HITS`
   row in the report for a target whose send you saw succeed.
3. Open each message once, normally, on the client named in its row. For the
   two Apple Mail rows, set Mail Privacy Protection to the state the row
   specifies **before** opening that message (path below).
4. Wait 24 hours after opening so delayed prefetches and scanner hits land.
5. Run the report:
   ```bash
   node --env-file=.env scripts/report.mjs
   ```
6. Copy the numbers it prints into the tables below. Leave a cell blank
   rather than estimate it.

### Mail Privacy Protection toggle path

- **iOS:** Settings → Apps → Mail → Privacy Protection → Protect Mail Activity
- **macOS:** Mail → Settings → Privacy → Protect Mail Activity

Turn Protect Mail Activity back **on** after send B (row 4) has been opened.
It is a privacy feature; leaving it off just to make this tool's numbers look
better is a poor trade and is not the point of this measurement.

## Calibration matrix to run

Only real, available accounts are used. There is no Outlook account, so
Outlook is dropped from the matrix rather than left as a placeholder row.

| # | Label | Recipient | Client / condition | Command |
|---|---|---|---|---|
| 1 | `gmail-web` | `recipient@example.com` | Gmail web (desktop browser) | `node --env-file=.env scripts/send-test.mjs recipient@example.com "gmail-web"` |
| 2 | `gmail-ios-app` | `recipient@example.com` | Gmail iOS app | `node --env-file=.env scripts/send-test.mjs recipient@example.com "gmail-ios-app"` |
| 3 | `apple-mail-mpp-on` (send A) | `you@icloud.example` | Apple Mail, **Protect Mail Activity ON** (default) | `node --env-file=.env scripts/send-test.mjs you@icloud.example "apple-mail-mpp-on"` |
| 4 | `apple-mail-mpp-off` (send B) | `you@icloud.example` | Apple Mail, **Protect Mail Activity OFF** | `node --env-file=.env scripts/send-test.mjs you@icloud.example "apple-mail-mpp-off"` |
| 5 | `real-contact` *(optional, user's discretion)* | a real contact, chosen by the user | the contact's own client — involves a third party | `node --env-file=.env scripts/send-test.mjs <contact address> "real-contact"` |

Rows 1–2 (Gmail) are expected to yield `device_class: unknown` regardless of
outcome — Gmail proxies every image fetch through `GoogleImageProxy`, so
device data is architecturally unrecoverable there (see `src/ua.ts`). They
cannot tell us anything about whether device attribution *works*; they can
only confirm that it doesn't apply to Gmail.

**Both row 3 and row 4 are expected to classify as `mpp`, regardless of the
Protect Mail Activity toggle.** `isApplePrivacyProxy()` (`src/classify.ts`)
classifies by user-agent *shape* — AppleWebKit present, with neither
`Version/` nor `Safari/` — and that is the same shape Apple Mail presents
whether Protect Mail Activity is on or off; it is also the exact signal
`src/ua.ts` uses to *label* the client "Apple Mail" in the first place. So
the row-3-vs-row-4 classification delta is not a measurement of anything —
it is deterministically zero by construction, whatever actually happened at
send B. Do not read a zero (or nonzero) delta here as evidence about MPP
distortion.

> **Erratum, post-run (2026-08-24):** this prediction was wrong, and the way
> it was wrong is the actual finding. `isApplePrivacyProxy()` never fired at
> all — both row 3 and row 4 classified `open`, not `mpp` (see Results
> below). Real MPP traffic sends a bare 11-character `"Mozilla/5.0"`, which
> does not contain `AppleWebKit`, so the old heuristic's `isWebKit` term was
> always false against real traffic. The prediction above was reasoned
> correctly from the code as written; the code's premise about what MPP
> traffic looks like was simply never checked against a real relay fetch
> until this run. Fixed in
> `docs/superpowers/logs/2026-08-24-classifier-recalibration.md`; the
> classifier now keys off the absence of any platform parenthetical
> (`isContentlessProxy()`), which is what the calibration data actually
> showed.

The real signal for send B is in the **raw hits table — timing and hit
count**, not the classification column: an MPP prefetch arrives at or very
near the delivery timestamp regardless of whether a human ever opens the
message, while a genuine human open arrives whenever the human actually
opened it (which, per the run instructions above, should be well after
delivery). Compare `occurred_at` for row 4's hit(s) against `sent_at` for
that token to judge whether Protect Mail Activity was actually off for that
send — not the classification, which will read `mpp` either way.

### What this matrix cannot tell you

With no Outlook (or any other non-proxied desktop client) in the set, rows
1–2 can only ever confirm that Gmail device data is unrecoverable — they
cannot validate the device-attribution logic (`src/ua.ts`) itself, because
Gmail never exposes a real user agent to validate against. Row 4 keeps its
value despite classifying `mpp` like row 3: it is still the only row in this
matrix that exercises `parseUserAgent()` against a real client user agent,
and `device_class`/`os` are recorded for every hit regardless of
classification — so row 4 remains the matrix's one check on device
attribution, just not on MPP distortion. If row 5 (real contact) is run, it
adds a second, independent ground-truth point — but it is optional and
involves a third party, so it is the user's call whether to include it.

## Results

Run: 2026-08-23/24. Lag is measured from `sent_at` to `occurred_at` for each
hit. Classifications shown are what the **classifier in production at the
time of the run** actually returned (the old `isApplePrivacyProxy()` /
10s `PREFETCH_WINDOW_MS`), not what the recalibrated classifier would now
return — this table records what was measured, not a re-run.

| # | Label | Any hit arrived? | Classification(s) observed | Device attribution (`device_class` / `os`) | Spurious hit count | Notes |
|---|---|---|---|---|---|---|
| 1 | `gmail-web` | Yes | `prefetch` (+9s) | `unknown` / — (Gmail proxied) | 1 | Correctly suppressed even under the old 10s window. |
| 2 | `gmail-ios-app` | Yes | `open` ×2 (+14s, +26s) | `unknown` / — (Gmail proxied) | 2 | Both hits landed outside the old 10s prefetch window and so counted as human opens. +14s is very likely a machine re-fetch; +26s is ambiguous — could be either. No independent confirmation either way for this row. |
| 3 | `apple-mail-mpp-on` | Yes | `open` (+25s) | `unknown` / null (bare `"Mozilla/5.0"`, no platform info) | 1 | **Wrong.** This is Apple's MPP relay prefetching the image, not a human open — `isApplePrivacyProxy()` failed to fire because the real relay UA carries no `AppleWebKit` token (see erratum above). |
| 4 | `apple-mail-mpp-off` | Yes | `open` (+7s) | `unknown` / null (bare `"Mozilla/5.0"`, no platform info) | 1 | **Wrong**, same failure mode as row 3. The +7s lag is itself evidence this is a proxy prefetch, not a human read. Also: row 3 and row 4's user agents are byte-identical, so this run cannot show whether Protect Mail Activity actually changed anything server-side — see note below. |
| 5 | `real-contact` (optional) | Not run | — | — | — | Not exercised this calibration; user's discretion, per matrix note above. |

"Any hit arrived?" is itself a result: a target with zero hits means the
image was blocked or never fetched by that client — that is a meaningful
finding (spec L3), not missing data. Here, every target that was sent
produced at least one hit.

**Row 3 vs. row 4 user-agent identity.** The exact same 11-character
`"Mozilla/5.0"` string was captured for both the MPP-on and MPP-off sends.
Per the calibration brief: do not build any logic that assumes MPP-on and
MPP-off are distinguishable from this data — either the settings change had
not propagated by send time, or iCloud proxies image loads independently of
the Protect Mail Activity toggle for this account. Both are plausible; this
run cannot tell them apart, and neither should the classifier.

## Classification breakdown (calibration-matrix hits only, rows 1-4)

*(The connectivity smoke test below is intentionally excluded from this
breakdown — see its own section — so these counts are the 5 hits produced
by the actual calibration matrix.)*

| Classification | Count |
|---|---|
| `open` | 4 |
| `mpp` | 0 |
| `prefetch` | 1 |
| `scanner` | 0 |
| `self` | 0 |

`mpp: 0` is Finding 1, in numbers: across two real Apple MPP relay hits,
the classifier that was live at measurement time labelled zero of them
`mpp`. Every Apple hit landed in `open` instead — the exact false positive
the classifier exists to prevent (spec 5.4, L1).

**Limitation: `scanner: 0` does not mean no burst scanners occurred.**
`scanner` classification has two independent triggers (spec 5.4): a known
corporate-gateway user agent (Mimecast, Proofpoint, Barracuda, etc.), and a
burst of >3 hits within 5s on one token. Only the first is actually reachable
in production — the burst check runs on `recentHitTimes`, but the endpoint's
dedupe check consumes that same list and returns before `classifyHit()` is
called whenever any prior hit fell within the 10s dedupe window, which fully
contains the burst check's 5s window. So `isScannerBurst` never sees a
non-empty list outside its own unit test (see `src/classify.ts`,
`isScannerBurst`, and spec 9). A `scanner: 0` row here means "no known-vendor
scanner UA was seen," not "no burst scanning happened" — a scanner that
bursts without a recognizable UA is invisible to this build. This matters
because this document is the deliverable that decides whether to build the
client.

## Smoke test (connectivity check only — not a calibration data point)

One send was made during Task 7 implementation to prove the send path and
report path work end-to-end, from `sender@example.com` to
`recipient@example.com`. It is recorded here for traceability only. It is
**not** part of the calibration matrix above (it wasn't necessarily opened
under a controlled condition, and no open was required or waited for), so it
is not a substitute for rows 1–5.

| Field | Value |
|---|---|
| Sent | 2026-08-24T01:40:07.578Z, to `recipient@example.com` |
| Token | `313b3c5e24e403ddd84bb52244594a43` |
| Hit arrived | Yes — one hit, +203s after send |
| Classification | `open` |
| Ground truth | **Genuine human open.** The recipient replied "done" to confirm they had opened it, independent of the tracking data. This is the one hit in the whole run with an external confirmation of what actually happened. |

Retained as a connectivity check per its original framing (not a controlled
calibration row), but its later hit turned out to be the run's single most
valuable data point: it is the only lag with independent ground truth, and
it landed at +203s — far outside any prefetch window under discussion. It
directly grounds the choice of `PREFETCH_WINDOW_MS = 60_000` in
`src/classify.ts`: whatever the window is widened to, it must stay well
clear of 203s.

## Analysis — three required questions

Answer each explicitly, using only what the results tables above show. If
the matrix hasn't been run yet, leave these unanswered rather than
speculating.

### 1. Did any true open go unrecorded?

No. Every target that was sent — rows 1 through 4, plus the smoke test —
produced at least one hit; no row shows "NO HITS" in the report output.
Row 5 (`real-contact`) was not run, so it contributes nothing either way.
This is a real, if narrow, positive result: for the two mail systems tested
(Gmail, iCloud/Apple Mail), the pixel itself was fetched every time an
image-loading client received the message, matching the instruction that
each message be opened normally before the 24-hour wait. Five hits across
five sends is not enough to bound a loss rate with any confidence — it only
says the failure mode of "image silently never fetched" (spec L3) did not
occur in this specific, small run.

### 2. Was any true open misclassified as `mpp`, `prefetch`, or `scanner`?

Yes — but inverted from what this question originally anticipated. The
concern going in was a genuine human open being wrongly suppressed as
`mpp`/`prefetch`/`scanner`. What the data actually shows is the opposite
failure: **machine prefetches were misclassified as genuine opens.** Rows 3
and 4 are Apple's MPP relay prefetching an image at +25s and +7s
respectively — not a human reading the message — and both were recorded as
`open`, the classification meant to mean "surfaced as a confirmed read"
(spec 5.4). That is a false positive, and it is the most consequential
finding in this run: it means the pre-calibration classifier would have
told the user "opened" for messages that were, as far as this data can
tell, never actually read by anyone. Row 2's +14s hit is also suspect for
the same reason (very likely a Gmail proxy re-fetch, not a human), though
without an independent confirmation for that row (unlike the smoke test) it
cannot be stated as certainly as rows 3–4.

In the other direction — a genuine human open wrongly suppressed as
`mpp`/`prefetch`/`scanner` — this run has exactly one point of ground truth
(the smoke test, confirmed by reply), and it was **not** misclassified: it
correctly landed as `open` at +203s. No evidence of that failure direction
in this run, though one confirmed data point cannot rule it out generally.

Fixed in `src/classify.ts`: `isApplePrivacyProxy` (renamed
`isContentlessProxy`) now keys off the absence of any platform
parenthetical rather than the AppleWebKit/Version/Safari shape that never
matched real MPP traffic, and `PREFETCH_WINDOW_MS` widened from 10s to 60s
to cover the +14s/+26s Gmail lags observed in row 2. See
`docs/superpowers/logs/2026-08-24-classifier-recalibration.md` for the full
reasoning.

### 3. Is the signal worth building a client around?

A qualified yes, with the qualification doing real work.

**Pixel delivery is reliable, as far as this data goes.** Every send in
this run produced a hit — no client tested silently dropped the image (see
Q1). That is the load-bearing precondition for everything else in this
plan, and it held.

**Human-vs-machine discrimination was badly broken and is now provisionally
better, not proven.** Before this run, the MPP heuristic had literally
never fired against real traffic (`mpp: 0` across two live Apple MPP hits —
see the classification breakdown above) — the exact failure this
classifier exists to prevent. That is now fixed against the one proxy shape
this run observed (a bare `"Mozilla/5.0"`), and the prefetch window is
widened to cover the two suspect Gmail lags. But this run supplies exactly
one confirmed genuine human open (the smoke test) to validate against, and
zero confirmed genuine Apple Mail opens — every Apple hit in this run was a
machine prefetch. The fix is well-evidenced for what it corrects, but
essentially unvalidated against a real human Apple Mail read, because none
occurred in this data.

**Device attribution is not there for the accounts actually in use.** Rows
1–2 (Gmail) return `device_class: unknown` by architecture — Gmail proxies
every fetch, so there is no UA to parse, full stop (spec 5.7/L2). Rows 3–4
(iCloud) also return `unknown`, for the separate reason that Apple's MPP
relay strips all platform information, not because `parseUserAgent()` is
broken — the code correctly reports "unknown" rather than guessing. Across
every real account tested, device attribution was 0-for-4. It worked
exactly once in this project's history, against a synthetic Outlook UA in a
unit test. See spec L8. If the user's actual contacts are predominantly
Gmail and iCloud (plausible for a personal client), device-class breakdowns
should not be a UI cornerstone; they will read "unknown" almost always.

**Net assessment:** the case for continuing is "pixel delivery works, and a
real, mistaken heuristic just got corrected by real data" — not "the
classifier is validated." The honest-states requirement already written
into spec 7A.2 (uncertainty must be legible, not hidden) is not a
nice-to-have for this product; it is the correct response to what this
calibration actually found. Building the client is defensible on this
evidence. Designing its UI as if `open`/`mpp` were a settled, trustworthy
signal, or as if device class will usually be known, is not.
