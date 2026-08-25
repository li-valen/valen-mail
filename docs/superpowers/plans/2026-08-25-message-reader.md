# Message Reader Implementation Plan (Plan 6)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Open and read an email — the thing an email client must do. Click a row,
read the message (html or text), see the thread, get to attachments.

**Architecture:** sync parses MIME server-side with the ALREADY-PRESENT `mailparser`
dep and returns structured JSON; the client renders it in a sandboxed iframe with
remote images off by default.

**Spec:** user goal 2026-08-25 ("easy UI to open the emails… nicer version of gmail")
+ 2026-08-23 spec §7.2 (privacy posture) — the remote-image default below is that
posture applied to the RECEIVING side.

## Global Constraints (ground truth, curled from production 2026-08-25)
- `GET /api/message/{accountId}/{folder}/{uid}/body` today returns **raw RFC822**
  (`content-type: message/rfc822`, ~4KB for a plain message, PRIVATE_NO_STORE,
  budget-capped via fetchBudgetedPart). Route pattern is `/api/message/.../body`,
  NOT `/api/body/...`.
- `GET /api/thread/{threadId}` returns `{messages:[...]}` — verified, 2 messages on
  the sample thread. Same row shape as /api/inbox.
- `mailparser@^3.7.1` is ALREADY in sync/package.json and imported NOWHERE in src/ —
  so parsing server-side adds **zero** new dependencies. No client MIME parser: it
  would be a forbidden client dep and the wrong layer.
- $0; no new deps in either package.
- sync runs under --experimental-strip-types (no param props/enums/namespaces/
  decorators); check:runtime gates it. mailparser is CJS — verify the import form
  works under strip-types before building on it (`import { simpleParser } from
  'mailparser'`); if types are absent, hand-declare the narrow surface used, as
  types/web-push.d.ts and types/nodemailer.d.ts already do.
- Attacker-authored content everywhere: subjects, sender names, and now full HTML
  bodies. NOTHING is trusted.

---

### Task 1 (sync): parsed message route
**Files:** Create `sync/src/api/message.ts`; Modify `routes.ts` (thin branch — the
push.ts/identities.ts pattern), `types/mailparser.d.ts` if needed.
**Interfaces:** Produces `GET /api/message/{accountId}/{folder}/{uid}` (no `/body`
suffix — the raw route stays untouched and available) →
`{html: string|null, text: string|null, attachments:[{partId, filename, mimeType,
sizeBytes, isInline, contentId}], from, to, cc, subject, date}`.
- Parse with `simpleParser` over the bytes `fetchBudgetedPart` already returns.
- **Do not sanitize HTML server-side.** The client renders in a sandboxed iframe;
  double-sanitizing invites the "it's already safe" mistake at the render layer.
  Return the html as parsed and let the boundary be the sandbox. State this in a
  doc comment so nobody "helpfully" adds a sanitizer later and weakens the sandbox
  rationale.
- Budget/cap semantics inherited unchanged; PRIVATE_NO_STORE; auth gate as usual.
- Steps: RED (parse a fixture .eml with html+text+attachment → asserted shape;
  text-only message → html null; cap exceeded → same response as today) →
  implement → 3 sync gates → commit.

### Task 2 (client): reader view
**Files:** Create `client/src/components/MessageView.tsx`, `client/src/components/
messageBody.ts` (pure helpers); Modify `App.tsx`/`AppShell.tsx` (selection state +
back), `InboxList.tsx`/`MessageRow.tsx` (rows become buttons), `api.ts`
(getMessage, per-item validation like the rest).
- Click row → main column shows the message; back returns to the list with scroll
  position intact. Mobile: same column, full width.
- **Body renders in `<iframe sandbox>` with NO `allow-scripts`** — srcdoc, plus a
  CSP `<meta>` inside the srcdoc blocking remote loads by default.
- **Remote images OFF by default**, with a per-message "Load remote images" button
  that re-renders the srcdoc with images allowed. Copy states why in one short line
  — this product tracks opens via remote images, so the user of all people should
  not load them silently. This is the one place a caveat IS the feature.
- Prefer `html`; fall back to `text` in a `<pre>`-ish wrap when html is null.
- Thread: show the other messages in the thread as collapsed rows beneath.
- Attachments: list name/type/size with a download link to the existing attachment
  route. No preview.
- Pure helpers tested: `srcDocFor(html, {allowRemote})` (asserts the CSP meta flips
  and that no `allow-scripts` ever appears), `formatSize`, `bodyKind(message)`.
- Steps: RED → implement → 3 client gates → commit.

### Task 3: deploy + verify (controller)
Rollout; then: open a real message in the browser at 1280 and 400; confirm images
blocked until clicked; confirm a text-only message renders; confirm attachment link
downloads; confirm back preserves the list.

## Self-Review
Coverage: the reader is Task 2, its data is Task 1, both curled-verified against
production shapes. No placeholders. Types: attachments' partId matches the existing
attachment route's 4th segment (verified in routes.ts's attachmentMatch).
