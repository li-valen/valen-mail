# Attachments on Send Implementation Plan (Plan 11)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user attach files to a message — the last thing compose cannot do —
without silently eating their Gmail quota.

**Architecture:** The browser sends files as base64 parts inside the existing JSON send
request; `nodemailer` (already a dependency) turns them into MIME. The interesting work
is not the plumbing, it is spec §5.3.1's **binding** mitigation: per-recipient tracked
sends multiply every attachment by the recipient count, so above a budget the send
degrades to one shared token — and the UI has to say so.

**Tech Stack:** TypeScript, `nodemailer`, React 19 + Tailwind v4. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-08-23-postbox-spec.md` — §5.3 (per-recipient
bodies), **§5.3.1 (attachment multiplication, BINDING)**, §5.1 (pixel markup), §7A.2
(honest states are a design requirement).

## Global Constraints

- **No new dependencies.** `nodemailer` handles MIME; a multipart parser is not needed
  because files arrive as base64 in the JSON body the send route already accepts.
- **§5.3.1 is BINDING and is the point of this plan.** Gmail copies every SMTP send into
  Sent and the client cannot suppress it, so N tokenized sends write N copies of every
  attachment into a 15 GB quota. A 10 MB file to 5 recipients costs 50 MB.
  1. **Degrade before sending.** If `attachmentBytes × recipientCount` exceeds
     `TRACKED_SEND_BYTE_BUDGET` (default **25 MB**), fall back to a **single shared
     token** for that message.
  2. **The UI MUST say so on that message**, rather than implying per-person data it
     does not have. Attribution degrades to "someone opened" — never a name.
- **§5.3.1 item 2 (reconcile after sending) is NOT in scope.** It requires deleting
  redundant Sent copies over IMAP, which needs the expunge path `sync/src/imap/flags.ts`
  forbids. The spec itself prefers degrading, because reconciliation is racy and a failed
  sweep silently costs quota. Record this as deliberately not done.
- Pixel markup EXACT (§5.1): `<img alt="" src="{PIXEL_BASE}/o/{token}.png">`.
- `MAX_SEND_REQUEST_BODY_BYTES` is currently **1536 KiB** and was raised once already
  (a reply carries the original body). Attachments will exceed it; raise it deliberately
  with arithmetic in a comment, and keep the self-recomputing cap test passing.
- Timestamps on the wire are **epoch-ms numbers**, never ISO strings.
- Client tests never render components — extract pure helpers and test those.
- Test floors at time of writing: sync **1079/64**, client **1144**. Do not reduce.

---

## File Structure

| File | Responsibility |
|---|---|
| `sync/src/send/attachments.ts` (create) | Validate + decode parts; the §5.3.1 budget decision |
| `sync/src/send/build.ts` (modify) | Hand attachments to nodemailer |
| `sync/src/api/send.ts` (modify) | Accept `attachments[]`, enforce caps |
| `client/src/attachmentPicker.ts` (create) | Pure: size accounting, the degrade predicate, copy |
| `client/src/components/Compose.tsx` (modify) | File input, chips, the degradation notice |

---

## Task 1: The §5.3.1 budget decision (pure, no I/O)

Build this first. It is the whole spec requirement reduced to one function, and it must
be settled before any MIME code exists to bias it.

**Files:**
- Create: `sync/src/send/attachments.ts`
- Test: `sync/tests/attachments.test.ts`

**Interfaces:**
```ts
export const TRACKED_SEND_BYTE_BUDGET = 25 * 1024 * 1024;

export type TokenStrategy = 'per-recipient' | 'shared';

export function chooseTokenStrategy(
  attachmentBytes: number, recipientCount: number,
): TokenStrategy;
```

**The judgement, stated so nobody has to guess:** the comparison is
`attachmentBytes * recipientCount > TRACKED_SEND_BYTE_BUDGET`. Zero attachments must
always yield `'per-recipient'` — a plain text message has nothing to multiply, and
degrading it would throw away attribution for no benefit whatsoever.

- [ ] **Step 1: Write the failing tests**

```ts
const MB = 1024 * 1024;

it('keeps per-recipient tracking when there is nothing to multiply', () => {
  expect(chooseTokenStrategy(0, 25)).toBe('per-recipient');
});

it('keeps per-recipient tracking under the budget', () => {
  // 2 MB x 5 = 10 MB, well under 25 MB.
  expect(chooseTokenStrategy(2 * MB, 5)).toBe('per-recipient');
});

it('degrades once the MULTIPLIED size exceeds the budget, not the raw size', () => {
  // 10 MB alone is fine; 10 MB x 5 recipients is 50 MB of quota. This is the
  // case the whole rule exists for, and the one a naive size check misses.
  expect(chooseTokenStrategy(10 * MB, 1)).toBe('per-recipient');
  expect(chooseTokenStrategy(10 * MB, 5)).toBe('shared');
});

it('is exclusive at the boundary — exactly the budget is still allowed', () => {
  expect(chooseTokenStrategy(5 * MB, 5)).toBe('per-recipient');   // == 25 MB
  expect(chooseTokenStrategy(5 * MB + 1, 5)).toBe('shared');
});
```

- [ ] **Step 2: Run, confirm they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run, confirm pass**
- [ ] **Step 5: Mutation check (required)** — change the comparison to use
      `attachmentBytes` alone, without the recipient multiplier. The third test must
      fail. That mutation is exactly the bug the spec was written to prevent, so if it
      does not fail the test is worthless.
- [ ] **Step 6: Commit**

```bash
git add sync/src/send/attachments.ts sync/tests/attachments.test.ts
git commit -m "feat: degrade to a shared token when attachments would multiply past budget"
```

---

## Task 2: Accept, validate and send attachments

**Files:**
- Modify: `sync/src/api/send.ts`, `sync/src/send/build.ts`, `sync/src/send/send.ts`
- Test: `sync/tests/send-route.test.ts`, `sync/tests/send-build.test.ts`

**Wire shape:**
```ts
readonly attachments?: readonly {
  readonly filename: string;
  readonly contentType: string;
  readonly contentBase64: string;
}[];
```

**Validation, because every field here is attacker-reachable:**
- `filename` must not contain CR, LF, `/`, `\`, or NUL. A newline is header injection
  in `Content-Disposition`; a path separator is a path-traversal attempt against any
  future code that writes the file down.
- `contentType` must match a conservative `type/subtype` pattern — never echoed raw.
- `contentBase64` must decode; a decode failure is a 400, never a partial send.
- Cap the count and the total decoded bytes, both as named constants.

- [ ] **Step 1: Write the failing tests**

```ts
it('rejects a filename containing CRLF (Content-Disposition injection)', async () => {
  const res = await handleSend(reqWith({ attachments: [
    { filename: 'a.txt\r\nX-Injected: 1', contentType: 'text/plain', contentBase64: 'aGk=' },
  ]}), deps);
  expect(res.status).toBe(400);
});

it('rejects a filename containing a path separator', async () => {
  const res = await handleSend(reqWith({ attachments: [
    { filename: '../../etc/passwd', contentType: 'text/plain', contentBase64: 'aGk=' },
  ]}), deps);
  expect(res.status).toBe(400);
});

it('rejects undecodable base64 rather than sending a truncated file', async () => {
  const res = await handleSend(reqWith({ attachments: [
    { filename: 'a.txt', contentType: 'text/plain', contentBase64: 'not!base64' },
  ]}), deps);
  expect(res.status).toBe(400);
});

it('a send with no attachments is byte-identical to before this change', () => {
  // The regression that matters most: every existing send path must be untouched.
  expect(buildMessage(plainRequest)).toEqual(buildMessagePreAttachments(plainRequest));
});

it('uses ONE shared token when the budget forces degradation', async () => {
  const res = await handleSend(reqWith({
    to: ['a@x.com','b@x.com','c@x.com','d@x.com','e@x.com'],
    attachments: [bigAttachment(10 * 1024 * 1024)],
  }), deps);
  const tokens = new Set(deps.sent.map((s) => s.token));
  expect(tokens.size).toBe(1);
});
```

- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3: Implement.** Raise `MAX_SEND_REQUEST_BODY_BYTES` with the arithmetic
      shown in a comment; base64 inflates by 4/3, so the cap must account for it.
- [ ] **Step 4: Run, confirm pass. Full sync suite ≥ 1079.**
- [ ] **Step 5: Mutation check (required)** — remove the filename CR/LF guard; the
      injection test must fail.
- [ ] **Step 6: Commit**

---

## Task 3: The composer, and telling the truth about degradation

**Files:**
- Create: `client/src/attachmentPicker.ts`
- Modify: `client/src/components/Compose.tsx`
- Test: `client/tests/attachment-picker.test.ts`

**Interfaces:**
```ts
export function totalBytes(files: readonly { size: number }[]): number;
export function willDegradeTracking(files: readonly { size: number }[], recipientCount: number): boolean;
export function degradationNotice(): string;
```

**§7A.2 applies here, and this is the part that is easy to get wrong.** When tracking
degrades, the message genuinely cannot tell you *who* opened it — only that *someone*
did. The UI must say that **before** the send, while the user can still decide, and must
not later render a per-recipient claim for that message. Say it in one short sentence.
Do not explain tokens, tracking pixels, or Gmail's quota behaviour to the reader — the
user's standing direction is *"i dont need any liek side notes"*.

- [ ] **Step 1: Write failing tests**, including one asserting the notice fires on the
      multiplied size rather than the raw size, and one asserting the copy contains no
      jargon (`token`, `pixel`, `SMTP`, `quota`).
- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3: Implement** — file input, per-file chips with sizes and a remove control,
      running total, and the notice.
- [ ] **Step 4: Run, confirm pass. Client suite ≥ 1144.**
- [ ] **Step 5: Live browser verification** — attach a real file, send it to one of the
      user's own accounts, and confirm in Gmail that the attachment arrives intact and
      opens. Both themes, mobile and desktop widths.
- [ ] **Step 6: Commit**

---

## Self-review

**Spec coverage.** §5.3.1 item 1 (degrade before sending) — Task 1, with the multiplied
comparison as the mutation-checked core. §5.3.1's UI requirement — Task 3. §5.3
per-recipient bodies — unchanged for the non-degraded path. §5.1 markup — untouched.
§7A.2 honest states — Task 3's notice.

**Not covered, deliberately:** §5.3.1 item 2 (reconciling redundant Sent copies) needs
the expunge path `flags.ts` forbids, and the spec itself argues degrading is the better
trade because a failed sweep silently costs quota. Inline images (`cid:`) are also out —
the reader renders them, but composing them is a separate editor problem.

**Type consistency.** `attachmentBytes` is decoded bytes at every hop, never base64
length — the two differ by 4/3 and conflating them makes the budget wrong by 33%.
