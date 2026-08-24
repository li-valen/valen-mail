# Live measurement results — tracking pixel calibration

**Status: template, awaiting real data.** Every data cell below is empty. This
document is the deliverable that Success Criterion 7 and Plan gate require —
it exists to be filled in by actually running the calibration matrix, not by
guessing what the numbers will look like. Do not fill in a cell unless you
have run `scripts/report.mjs` and read the number off its output.

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
| 1 | `gmail-web` | `li.valen.008@gmail.com` | Gmail web (desktop browser) | `node --env-file=.env scripts/send-test.mjs li.valen.008@gmail.com "gmail-web"` |
| 2 | `gmail-ios-app` | `li.valen.008@gmail.com` | Gmail iOS app | `node --env-file=.env scripts/send-test.mjs li.valen.008@gmail.com "gmail-ios-app"` |
| 3 | `apple-mail-mpp-on` (send A) | `li.valen@icloud.com` | Apple Mail, **Protect Mail Activity ON** (default) | `node --env-file=.env scripts/send-test.mjs li.valen@icloud.com "apple-mail-mpp-on"` |
| 4 | `apple-mail-mpp-off` (send B) | `li.valen@icloud.com` | Apple Mail, **Protect Mail Activity OFF** | `node --env-file=.env scripts/send-test.mjs li.valen@icloud.com "apple-mail-mpp-off"` |
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

*(Fill in after running `scripts/report.mjs`. Leave any cell blank if it was
not directly observed — do not estimate.)*

| # | Label | Any hit arrived? | Classification(s) observed | Device attribution (`device_class` / `os`) | Spurious hit count | Notes |
|---|---|---|---|---|---|---|
| 1 | `gmail-web` | | | | | |
| 2 | `gmail-ios-app` | | | | | |
| 3 | `apple-mail-mpp-on` | | | | | |
| 4 | `apple-mail-mpp-off` | | | | | |
| 5 | `real-contact` (optional) | | | | | |

"Any hit arrived?" is itself a result: a target with zero hits means the
image was blocked or never fetched by that client — that is a meaningful
finding (spec L3), not missing data.

## Classification breakdown (all hits, all targets)

*(Copy directly from the `scripts/report.mjs` output. All five categories
are shown, including any at zero — a category that never fired is a result,
not an omission.)*

| Classification | Count |
|---|---|
| `open` | |
| `mpp` | |
| `prefetch` | |
| `scanner` | |
| `self` | |

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
report path work end-to-end, from `xinfinitypro@gmail.com` to
`li.valen.008@gmail.com`. It is recorded here for traceability only. It is
**not** part of the calibration matrix above (it wasn't necessarily opened
under a controlled condition, and no open was required or waited for), so it
is not a substitute for rows 1–5.

| Field | Value |
|---|---|
| Sent | 2026-08-24T01:40:07.578Z, to `li.valen.008@gmail.com` |
| Token | `313b3c5e24e403ddd84bb52244594a43` |
| Any hit arrived by the time this doc was written? | No (0 hits) — expected, since no one had opened it yet at write time |

## Analysis — three required questions

Answer each explicitly, using only what the results tables above show. If
the matrix hasn't been run yet, leave these unanswered rather than
speculating.

### 1. Did any true open go unrecorded?

If a row where you know you personally opened the message shows "NO HITS" in
`scripts/report.mjs`, images were blocked for that client and tracking
cannot see it at all (spec L3). Record which row(s), if any, and what that
implies about coverage for that client.

*(unanswered — pending calibration run)*

### 2. Was any true open misclassified as `mpp`, `prefetch`, or `scanner`?

Row 4 (`apple-mail-mpp-off`) does **not** test this by its classification —
per the matrix section above, `isApplePrivacyProxy()` classifies by
user-agent shape, and Apple Mail presents that same shape whether Protect
Mail Activity is on or off, so row 4 is expected to classify `mpp` even on a
genuine human open. Use row 4's raw hit timing (`occurred_at` vs. `sent_at`)
to judge whether the open was real, not its classification column.

The real check for this question is any row where you know with certainty a
fetch was a genuine human open — most usefully row 5 (`real-contact`), if
run — coming back classified as anything other than `open`. That is a
false negative in the classifier. If it happens, the constants in
`src/classify.ts` (`isApplePrivacyProxy`, `PREFETCH_WINDOW_MS`,
`SCANNER_BURST_COUNT`/`SCANNER_BURST_WINDOW_MS`) need tuning — note exactly
what changed and why.

*(unanswered — pending calibration run)*

### 3. Is the signal worth building a client around?

State plainly what the Gmail `unknown` rate (rows 1–2) implies for the rest
of this plan. Rows 3 and 4 do not yield a classification-based MPP
distortion rate — both are expected to classify `mpp` regardless of the
Protect Mail Activity toggle (see the matrix section above), so that
comparison is not available from this matrix. If you compared row 4's raw
hit timing against its send time (per question 2) to judge whether Protect
Mail Activity was actually off, factor that reading in here instead. If the
Gmail `unknown` rate is high because the user's real contacts are on Gmail,
say so — that is a legitimate and valuable outcome of this plan, not a
failure of it.

*(unanswered — pending calibration run)*
