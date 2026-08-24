# Postbox — Specification

**Status:** Draft v1
**Date:** 2026-08-23
**Owner:** Valen Li
**Scope:** Personal use only. Not distributed, not published, not commercial.

---

## 1. Goal

A personal, multi-account Gmail client with Superhuman-style open tracking:
all Gmail accounts unified into one inbox, per-message choice of sending
identity, per-recipient open tracking with device attribution, and push
notifications to both an iPhone and a laptop.

## 2. Hard Constraints

These are binding. Every design decision must satisfy all of them.

- **C1. Total recurring cost: $0.** No domain purchase, no Apple Developer
  Program, no paid hosting tier, no App Store or Play Store account.
- **C2. Single user.** Only Valen's own Gmail accounts. No multi-tenancy,
  no signup flow, no other people's mail ever touches the system.
- **C3. No app-store distribution.** iPhone client must work without the
  $99/yr Apple Developer Program.
- **C4. Not a Chrome extension (initially).** Tracking is done by a native
  client that owns its own composer, the way Superhuman does it. A Gmail
  Chrome extension is an explicit later expansion, not v1.
- **C5. No Google OAuth app.** Use IMAP/SMTP with per-account app passwords.
  This avoids Google verification, CASA assessment, the OAuth consent
  screen, and the 7-day refresh-token expiry of Testing-mode OAuth apps.

## 3. Architecture Decisions

### AD1. The phone is a PWA, therefore the server owns mail sync.

C3 rules out a native iOS app. A PWA cannot open raw TCP sockets, so it
cannot speak IMAP. Therefore IMAP sync moves server-side and the phone is
a thin client over a JSON API.

Rejected alternative: free-Apple-ID sideloading gives a native iOS app at
$0 with on-device IMAP, but code signing expires every 7 days. A recurring
weekly failure mode that strands the user while travelling is worse than a
larger backend, which C-level push requirements demand anyway.

### AD2. One web client, two shells.

Because sync is server-side (AD1), the desktop client does not need native
IMAP either. The UI is a single web application:
- **iPhone:** installed to Home Screen as a PWA (required for Web Push).
- **Laptop:** the same web app, later wrapped in Tauri for native menu bar,
  global hotkeys, dock badge, and launch-at-login.

The Tauri wrapper is polish, not a prerequisite. Web Push works in desktop
browsers, so notifications ship before the wrapper does.

### AD3. Two backend components, split by execution model.

- **Sync service** — a long-lived process holding IMAP IDLE connections.
  Cannot be serverless. Runs on an always-free VM.
- **Tracking endpoint** — stateless, short-lived, latency-sensitive
  (it races the recipient's mail client image fetch). Runs on Vercel Edge.

### AD4. Random opaque tracking tokens with server-side lookup.

Mailspring encodes `{messageId, accountId, recipient}` as plain Base64url in
the pixel URL. This is decodable by anyone who inspects the URL, and a
forwarded message leaks the original recipient's address. Postbox uses a
random 128-bit token resolved against the database instead. Same resistance
to pattern-matching blockers, no information leak.

## 4. Platform Targets

| Component | Platform | Hosting | Cost |
|---|---|---|---|
| Sync service | Node 26, long-lived process | Oracle Cloud Always Free ARM VM (fallback: GCP `e2-micro` always-free) | $0 |
| Public hostname + TLS | — | DuckDNS + Let's Encrypt, or Tailscale Funnel (`*.ts.net`) | $0 |
| Tracking endpoint | Vercel Edge Runtime | `*.vercel.app` | $0 |
| Tracking storage | — | Upstash Redis or Neon Postgres free tier | $0 |
| Web client | React PWA | served by sync service | $0 |
| Desktop shell | Tauri (later) | self-built, unsigned | $0 |
| Push | Web Push + self-generated VAPID keys | none — direct to browser push endpoints | $0 |

## 5. Tracking Semantics

Derived from analysis of Mailspring's `open-tracking` and
`remove-tracking-pixels` packages, and Superhuman's published behaviour.

### 5.1 Pixel markup (binding, exact)

The injected tag MUST be exactly:

```html
<img alt="" src="{PIXEL_BASE}/o/{token}.png">
```

- MUST NOT set `width`, `height`, `style`, `class`, or a descriptive `alt`.
  Zero dimensions, hidden styling, and branded alt text are the primary
  heuristics tracking-pixel blockers match on.
- Invisibility comes from the server returning a 1x1 transparent PNG, not
  from markup.
- URL MUST NOT carry query-string parameters.

### 5.2 Placement (binding)

The pixel MUST be inserted immediately **before** any `.gmail_quote`
element, and appended to the body root only if no quote block exists.
Gmail collapses quoted text behind a toggle; a pixel inside the collapsed
region does not load until the recipient expands it.

### 5.3 Per-recipient bodies (binding)

When tracking is enabled on a message with N recipients, the client MUST
send N separate SMTP transactions, each with a distinct token, each with
`RCPT TO` naming exactly one recipient.

The `To:` header in every copy MUST list the full recipient set. The header
is independent of the SMTP envelope, so recipients see a normal group
thread and reply-all behaves correctly.

Consequences accepted:
- Counts N times against Gmail's ~500 messages/day limit.
- A forwarded message carries its original token, so forwards can read as
  the original recipient re-opening.

**5.3.1 Attachment multiplication (binding mitigation).**

Gmail copies every SMTP send into the Sent folder automatically; the client
cannot suppress this. N tokenized sends therefore write N copies of every
attachment into the user's 15 GB Gmail quota. A 10 MB attachment to 5
recipients consumes 50 MB, not 10 MB.

The client MUST mitigate as follows:

1. **Degrade before sending.** If `attachment_bytes * recipient_count`
   exceeds `TRACKED_SEND_BYTE_BUDGET` (default 25 MB), fall back to a single
   shared token for that message. Attribution degrades to "someone opened"
   rather than naming a recipient. The UI MUST say so on that message
   rather than implying per-person data it does not have.
2. **Reconcile after sending.** Where per-recipient sends did occur, the
   client SHOULD delete the redundant Sent copies over IMAP, retaining one.

Rationale for degrading rather than always reconciling: reconciliation is
racy (it depends on Gmail having filed all N copies before the sweep runs)
and a failed sweep silently costs quota. The budget check is deterministic
and cannot fail open.

### 5.4 Open classification (binding)

Every pixel request MUST be classified before being surfaced as an open:

| Class | Rule | Surfaced? |
|---|---|---|
| `self` | Requesting IP matches a recent sender IP for that account | No |
| `prefetch` | `GoogleImageProxy` in UA **and** age since send < 10s | No |
| `mpp` | Apple Mail Privacy Protection relay ranges / signature UA | Labelled, not counted as a confirmed open |
| `scanner` | Known corporate-gateway UA, or >3 hits within 5s | No |
| `open` | Everything else | Yes |

Repeat hits on the same token within a 10-second window MUST be collapsed
into one event.

### 5.5 Cache headers (binding)

Every pixel response MUST send:

```
Cache-Control: no-store, no-cache, must-revalidate, max-age=0
Pragma: no-cache
Expires: 0
```

Without these, Gmail's image proxy and Vercel's CDN cache the response and
every open after the first is silently lost.

### 5.6 Pixel stripping (binding)

Adopted from Mailspring's `remove-tracking-pixels`, which carries the note
that checking "is from me" alone is insufficient.

- On rendering any message body, Postbox MUST strip its own pixels whose
  token resolves to one of the user's accounts. A reply or bounce can carry
  the original pixel and fire phantom opens indefinitely.
- On preparing a reply or forward draft, Postbox MUST strip any existing
  Postbox pixel before the new pixel is injected.
- On rendering incoming mail, Postbox MUST strip third-party tracking
  pixels matched against a blocklist (seeded from Mailspring's 25-entry
  list: Yesware, Streak, Mailtrack, HubSpot, Salesloft, Mixpanel, Intercom,
  Boomerang, Bananatag, MailChimp, Cirrus Insight, and others).

### 5.7 Device attribution

Device class and OS are derived from the request User-Agent. Coverage is
partial and MUST be surfaced honestly:

- Apple Mail, Outlook desktop, and most mobile clients expose a usable UA.
- **Gmail recipients arrive as `GoogleImageProxy` with no device signal.**
  These MUST display as "device unknown", never as a guess.

## 6. Data Model (tracking)

```
tokens:  token(pk) · account_id · message_id · thread_id · recipient_email
         · subject · sent_at · sender_ip
opens:   id(pk) · token(fk) · occurred_at · classification · user_agent
         · device_class · os · raw_ip_hash
devices: id(pk) · endpoint · p256dh · auth · label · created_at
```

`raw_ip_hash` stores a salted hash, never a raw IP (see 7.2).

## 7. Privacy and Security Requirements

- **7.1** Untrusted email HTML MUST be sanitized before rendering, under a
  strict CSP. Remote content MUST be blocked by default.
- **7.2** Location inference from IP is a **non-goal**. Superhuman shipped
  it, took public backlash in 2019, removed it, and deleted the historical
  data. Postbox never stores a raw recipient IP.
- **7.3** Tracking MUST be per-account opt-in and per-message overridable,
  matching Superhuman's post-2019 opt-in default.
- **7.4** App passwords MUST live in OS keychain or an env file that is
  never committed. Never in the database, never in client-side storage.
- **7.5** The tracking endpoint MUST NOT accept or store message content.
  It sees opaque tokens and request metadata only.

## 7A. Design Intent (binding on Plans 3 and 5)

Stated by the user: "make it different from other email providers, make it look
better and cooler."

**7A.1 The differentiator is the data, not the skin.** Every existing client
organises around one axis: time. Gmail, Outlook, Spark, Superhuman and Hey all
show what arrived, newest first, and differ mainly in density and chrome. A
visually novel client organised the same way is a reskin.

Postbox holds a dimension none of them expose: **who has read what, and when.**
The design should be organised around that, not merely decorated with it.
Concretely, these are the views the tracking data makes possible and that no
mainstream client offers:

- **Sent & Waiting** — outbound mail ranked by engagement state, not by date:
  opened-and-silent, never-opened, opened-repeatedly.
- **Opened, no reply** — the highest-signal follow-up queue in the product, and
  the reason this client exists.
- **Recent Opens** — a live chronological feed of read events (Superhuman ships
  this; it is the one piece worth matching directly).
- **Read state on the thread itself** — per recipient, with device and time, and
  with honest "unknown" and "Apple MPP, cannot verify" states rendered as
  first-class rather than hidden (see 5.7, L1, L2).

**7A.2 Honest states are a design requirement, not an edge case.** Roughly half
of all opens cannot be confirmed (L1) and Gmail recipients yield no device data
(L2). A UI that renders uncertainty as confidence is worse than one with no
tracking at all. Ambiguity must be legible in the interface, not buried.

**7A.3 Direction is chosen by prototype, not by assertion.** Plan 3 MUST open
with the `prototype` skill: three to four genuinely different directions behind a
live picker, the user picks, and only then is a Tier 1 direction skill applied to
the winner. "Make it cooler" is not a direction; it is a request for options.
See `docs/frontend-guide.md` for the routing rules and proposed stack.

## 8. Non-Goals (v1)

- Chrome extension for tracking mail sent from Gmail's web UI — planned
  expansion, explicitly out of v1 scope (C4).
- Native iOS app, TestFlight, App Store, Play Store.
- Multi-user, team features, or Superhuman-style shared conversations.
  The per-person rows in Superhuman's marketing screenshots come from their
  team read-status feature, which is first-party data between Superhuman
  users, not pixel tracking. It is not reproducible for external recipients.
- IP-based location inference (7.2).
- Calendar, contacts, snippets, scheduled send.

## 9. Known Limitations (accepted, must be surfaced in UI)

- **L1. Apple Mail Privacy Protection.** Apple Mail accounts for roughly
  half of all email opens and prefetches images regardless of whether the
  message was read. These are labelled, not counted.
- **L2. Gmail recipients yield no device data** (5.7).
- **L3. No-open is ambiguous.** It may mean unread, or images blocked.
- **L4. Shared-subdomain filtering.** Some corporate mail gateways block
  images from `*.vercel.app`. The pixel base URL MUST be a single config
  value so a custom domain can be swapped in later without a code change.
- **L5. Only mail sent through Postbox is tracked.** Mail sent from Gmail's
  web UI is invisible until the Chrome extension expansion ships.
- **L6. Gmail IMAP limits:** ~15 concurrent connections and ~2.5 GB/day
  download per account. Sync must respect both.

## 10. Success Criteria

1. All Gmail accounts appear in one chronological unified inbox.
2. Sending identity is selectable per message; replies default to the
   account that received the original.
3. A tracked message to N recipients produces N tokens and attributes each
   open to a specific recipient.
4. An open on a non-Gmail recipient shows time and device class.
5. Opens push to both the iPhone Home Screen PWA and the laptop.
6. A Recent Opens feed lists opens chronologically, each linking to its
   conversation.
7. Measured false-positive rate is documented from real test sends before
   any client work begins.
8. Total recurring spend remains $0.
