# Compose + Tracked Send Implementation Plan (Plan 4)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Send mail from any of the four accounts with per-recipient open tracking.

**Architecture:** Tracking mints opaque tokens via a new authed Edge route; sync sends
per-recipient tokenized bodies over SMTP (app passwords, nodemailer) and exposes
identities + a send route; the client gets a Plunk-idiom composer. Gmail auto-saves
SMTP sends to Sent, so no IMAP APPEND is needed.

**Spec:** docs/superpowers/specs/2026-08-23-postbox-spec.md — §5.1 (pixel markup,
BINDING), §5.2 (insertion), §5.3 (per-recipient bodies), §7B/§7B.1 (identities,
primary), §7.2 (never store raw IP — unchanged), C1 ($0), C5 (app passwords).

## Global Constraints
- Pixel markup EXACT (spec §5.1): `<img alt="" src="{PIXEL_BASE}/o/{token}.png">`
  — MUST NOT set width/height/style/class or descriptive alt.
- Tokens: `generateToken()` from tracking/src/token.ts (32 hex). Never in URLs/logs.
- $0; the ONE new dependency is `nodemailer` in sync/ (proven with these exact
  accounts in tracking/scripts/send-test.mjs).
- Compose v1 sends NEW plain-text mail (HTML = escaped text + pixel). No attachments,
  no reply-quoting (§5.2's .gmail_quote case deferred with them). State in UI copy? No
  — absence is self-evident; no caveat copy.
- Per-recipient: N recipients → N SMTP sends, each with its own token; To:/Cc:
  headers carry the FULL group on every copy (envelope ≠ headers).
- Auth: cookie or bearer, same gate as every /api route. Send route: PRIVATE_NO_STORE,
  size caps (subject 500, body 100KB, recipients ≤25), and the session limiter
  pattern is NOT reused — sends are authed; add a modest global cap (30 sends/hour)
  purely as a runaway-script brake, in-memory, failures-don't-count-style irrelevant
  (count all).
- Never log subject/body/recipients; log counts and account ids only.
- All existing suite floors hold (tracking 67, sync 448/28, client ≥198 + V-tasks').

---

### Task 1: tracking mints tokens — POST /api/tokens
**Files:** Create tracking/api/tokens.ts; Modify tracking/src/db.ts (insertTokens),
tracking/.env.example (note: READ_API_TOKEN now guards both read+mint; name kept).
**Interfaces:** Produces POST /api/tokens {sends:[{recipientEmail,subject}]} →
{tokens:[{token,recipientEmail}]} (order-preserving). Bearer = READ_API_TOKEN,
timing-safe (reuse api/opens.ts's Edge-safe compare — extract to src/compare.ts,
both routes import it; moving code, tests must not weaken).
Steps: failing tests (auth 401/503-fail-closed like opens; ≤25 sends cap; token
shape from TOKEN_PATTERN; db insert parameterized, one statement for N rows) →
implement (insertTokens uses sql_ pattern; tokens table exists from Plan 1) →
gates (`npm run typecheck`, `npx vitest run`) → deploy is Task 5's; commit.

### Task 2: sync identities + SMTP transports
**Files:** Create sync/src/send/transports.ts, sync/src/api/identities.ts;
Modify sync/src/api/routes.ts (thin branch), sync/package.json (nodemailer).
**Interfaces:** GET /api/identities → {identities:[{id,email,isPrimary}]} (from
loadConfig's accounts; primary first). `getTransport(accountId)` — lazy per-account
nodemailer transport (smtp.gmail.com:465, secure, app password from accounts config),
cached in a Map, `closeAll()` wired into createShutdown BEFORE db.close.
Steps: failing tests (identities shape+order; transport caching returns same
instance; closeAll closes each; NO live SMTP in tests — inject createTransport) →
implement → all three sync gates → commit.

### Task 3: sync POST /api/send — per-recipient tokenized sends
**Files:** Create sync/src/send/build.ts, sync/src/send/send.ts, sync/src/api/send.ts;
Modify routes.ts (branch), config.ts (PIXEL_BASE=TRACKING_BASE_URL reuse), .env.example.
**Interfaces:** `buildTrackedMessage({from,to,cc,subject,textBody,token,pixelBase})`
→ {text, html} — PURE. html = escapeHtml(textBody) in <div dir="auto"> with \n→<br>,
then EXACTLY `<img alt="" src="${pixelBase}/o/${token}.png">` appended (spec §5.1
verbatim — a test asserts the literal serialized tag, and a mutation check proves
adding width/style fails it). POST /api/send: validate (≤25 rcpts, caps, identity
exists) → mint N tokens via tracking POST /api/tokens (fetchImpl-injected; tracking
DOWN → 502 {error:'tracking unavailable'}, NO untracked fallback silently — the
user's product is tracking; failing closed here is honest) → N sends via
transport.sendMail({from, to: ALL, cc, subject, text, html, envelope:{to:[one]}})
— envelope-to is the ONE recipient, headers show the group (spec §5.3) → per-recipient
results [{recipientEmail, ok}] → 200 even on partial failure (results carry truth).
Steps: RED (build.ts literal-tag test + escape test + envelope test with injected
transport) → implement → gates → commit. NO live SMTP/tracking in tests.

### Task 4: composer UI
**Files:** Create client/src/components/Compose.tsx (+ small ui/ ports if needed:
Dialog or a route-view — follow the Plunk idiom already ported; Textarea/Select
atoms may be ported per provenance rules); Modify App/AppShell (a "Compose" primary
button in the sidebar, Plunk's button idiom), client/src/api.ts (sendMail,
getIdentities with per-item validation like the rest).
Behaviour: identity select (primary default), To/Cc (comma-split chips, trim,
basic email regex, dedupe), subject, body textarea; sending state; per-recipient
result surface (all-ok → close + toast-ish inline confirm; partial → keep open,
mark failures). Honest copy: "Tracked — each recipient gets its own pixel." XSS:
everything text. A11y: labels, focus trap if Dialog, Esc closes, reduced-motion.
Tests: pure helpers (parseRecipients, canSubmit) — floor holds.
Steps: RED → implement → 3 client gates → commit.

### Task 5: deploy + E2E verify
**Files:** Modify sync/deploy/README.md §16 (send env: nothing new on VM — PIXEL_BASE
reuses TRACKING_BASE_URL; nodemailer arrives via npm ci).
Controller-executed: vercel deploy tracking (Task 1) → rollout sync+client → battery:
identities 200; send route 401 unauth; THEN one real send: primary → user's own
address with a token, verify tracking pixel row exists (GET /api/opens shows the
token after a self-open… classification will be `self`/`open` — either proves the
loop) and the mail lands in Sent + Inbox via sync. Never in tests/CI — one manual
controller action, logged in the ledger.

## Self-Review
Spec coverage: §5.1→T3 build.ts literal test; §5.2 quote-insertion deferred WITH
reply feature (no quotes exist in v1 mail); §5.3→T3 envelope test; §5.3.1 moot (no
attachments v1, stated); §7B→T2 identities (4 accounts today; loader's one-primary
invariant already enforced since Plan 2); §7.2 untouched. Types: OpenEvent unchanged;
tokens flow tracking→sync as opaque strings. No placeholders; exact values inline.
