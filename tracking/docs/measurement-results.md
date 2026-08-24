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

Row 3 is expected to be machine-prefetched and classify as `mpp`. Row 4 is
the control: with Protect Mail Activity off, Apple Mail should send a real
`AppleWebKit`/`Safari` user agent and a genuine human-triggered fetch, which
should classify as `open` with real `device_class`/`os`. **The gap between
row 3 and row 4 is the measured MPP distortion rate for this user** — not
assumed, not estimated from public figures, but observed directly. It is the
single most important number in this document.

### What this matrix cannot tell you

With no Outlook (or any other non-proxied desktop client) in the set, rows
1–2 can only ever confirm that Gmail device data is unrecoverable — they
cannot validate the device-attribution logic (`src/ua.ts`) itself, because
Gmail never exposes a real user agent to validate against. Row 4 is the only
row in this matrix that exercises `parseUserAgent()` against a real client
user agent. If row 5 (real contact) is run, it adds a second, independent
ground-truth point — but it is optional and involves a third party, so it is
the user's call whether to include it.

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

This is what row 4 (`apple-mail-mpp-off`) is specifically designed to catch:
a known-human open that comes back classified as anything other than `open`
is a false negative in the classifier. If this happens, the constants in
`src/classify.ts` (`isApplePrivacyProxy`, `PREFETCH_WINDOW_MS`,
`SCANNER_BURST_COUNT`/`SCANNER_BURST_WINDOW_MS`) need tuning — note exactly
what changed and why.

*(unanswered — pending calibration run)*

### 3. Is the signal worth building a client around?

State plainly what the measured MPP distortion rate (row 3 vs. row 4) and
the Gmail `unknown` rate (rows 1–2) imply for the rest of this plan. If the
false-positive share is high and device attribution mostly returns
`unknown` because the user's real contacts are on Gmail, say so — that is a
legitimate and valuable outcome of this plan, not a failure of it.

*(unanswered — pending calibration run)*
