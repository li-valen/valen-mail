# Reply, Forward, and Mailbox Actions Implementation Plan (Plan 9)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four gaps that still force the user back to Gmail — reply,
reply-all, forward, and getting mail out of the inbox (archive / trash / spam).

**Architecture:** Threading is read at reply time from the message already on
screen, not from a new column — `ParsedMessage` gains the two headers it omits
(`messageId`, `references`) and the send route learns to emit `In-Reply-To` /
`References`. Quote construction is a pure function so the spec's binding pixel
placement is assertable without a network. Mailbox actions ride IMAP `MOVE` into
the already-discovered special-use folders; no expunge path is opened.

**Tech Stack:** TypeScript, `imapflow`, `mailparser`, `nodemailer` (all already
present — **this plan adds no dependency**), React 19 + Tailwind v4 client.

**Spec:** `docs/superpowers/specs/2026-08-23-postbox-spec.md` — §5.1 (pixel markup,
BINDING), §5.2 (placement before `.gmail_quote`, BINDING), §5.3 (per-recipient
bodies), §5.6 (strip own pixel when preparing a reply/forward draft, BINDING),
§7B/§7B.1 (identities), C1 ($0), C5 (app passwords).

## Global Constraints

- **No new dependencies.** `imapflow`, `mailparser`, `nodemailer` are already in
  `sync/package.json`. Adding a quoting or MIME library is a plan violation.
- **Pixel markup EXACT** (spec §5.1): `<img alt="" src="{PIXEL_BASE}/o/{token}.png">`
  — MUST NOT set width/height/style/class or a descriptive alt.
- **Pixel placement** (spec §5.2, BINDING): immediately **before** the
  `.gmail_quote` element; appended to the body root only when no quote exists.
  Plan 4 only ever exercised the second branch. This plan exercises the first.
- **Draft strip** (spec §5.6, BINDING): a reply/forward draft MUST have any
  existing Postbox pixel stripped **before** the new pixel is injected. This is a
  *different code path* from `api/strip-pixel.ts`'s strip-at-render (commit
  `d056622`) and does not come for free from it — the quote is built from the
  original body, and an unstripped quote re-fires the original recipient's token.
- **No expunge, ever.** `sync/src/imap/flags.ts` documents that `\Deleted` is
  absent and must stay absent. Trash is a `MOVE` into the discovered Trash
  folder, which is what Gmail's own UI does. Nothing in this plan may add
  `messageDelete`, `expunge`, or `\Deleted`.
- **Never hardcode folder names.** `[Gmail]/Trash` does not exist on every
  account and breaks under a non-English locale. Use the existing special-use
  discovery in `sync/src/imap/folder-cache.ts`.
- **One connection per account** (Gmail throttles reconnects). Mailbox actions go
  through the same `KeyedMutex` and `resolveConnection` path the flag writes use.
- **Timestamps are epoch-ms numbers on the wire**, never ISO strings — this
  codebase's convention (`ParsedMessage.date`, `OpenEvent.occurredAt`). Three
  separate defects in this project came from a brief that said "string".
- Test floors before this plan: **tracking 104 / sync 917 / client 696.** No task
  may reduce a floor; a deliberate reduction must be argued in the task report.

---

## File Structure

| File | Responsibility |
|---|---|
| `sync/src/api/message.ts` (modify) | `ParsedMessage` gains `messageId` + `references` |
| `sync/src/send/quote.ts` (create) | Pure quote construction + draft-pixel strip (§5.2/§5.6) |
| `sync/src/send/build.ts` (modify) | Emit `In-Reply-To` / `References`; pixel before quote |
| `sync/src/api/send.ts` (modify) | Accept + validate `inReplyTo`, `references`, `htmlQuote` |
| `sync/src/imap/move.ts` (create) | `moveMessage` — MOVE into a discovered special-use folder |
| `sync/src/api/move.ts` (create) | `POST /api/move` route |
| `client/src/replyDraft.ts` (create) | Pure: subject prefix, recipient derivation, quote header |
| `client/src/components/Compose.tsx` (modify) | Reply / reply-all / forward entry points |
| `client/src/components/MessageView.tsx` (modify) | Reply / Forward / Archive / Trash actions |

---

## Task 1: Expose the threading headers the reader already parses

Today `ParsedMessage` returns `from`/`to`/`cc`/`subject`/`date` but **not**
`messageId` or `references`. Without them a reply from Postbox arrives in the
recipient's Gmail as a brand-new thread — the single most visible way a mail
client looks broken. `mailparser` already parses both; the route simply drops them.

**Files:**
- Modify: `sync/src/api/message.ts` (the `ParsedMessage` interface and `toParsedMessage`)
- Test: `sync/tests/message-route.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```ts
  readonly messageId: string | null;      // WITH angle brackets, as the header carries them
  readonly references: readonly string[]; // oldest → newest; [] when absent
  ```

**Why angle brackets stay on.** `In-Reply-To` and `References` are emitted
verbatim into headers, so the value that leaves here must be header-shaped.
Note the asymmetry already recorded in project memory: tracking's `messageId`
has **no** brackets while the synced `message_id` column **does**. This field
follows the header, and its doc comment must say so — a future matcher that
compares this to a tracking row will otherwise silently never match.

- [ ] **Step 1: Write the failing test**

```ts
test('exposes Message-ID and References so a reply can thread', async () => {
  // Arrange — References with mixed whitespace is the real-world shape:
  // RFC 5322 folds long header values across lines.
  const raw = [
    'From: Ada <ada@example.com>',
    'To: you@example.com',
    'Subject: Re: numbers',
    'Message-ID: <c@example.com>',
    'References: <a@example.com>\r\n <b@example.com>',
    '',
    'body',
  ].join('\r\n');

  // Act
  const parsed = await toParsedMessage(raw, /* …existing fixture args… */);

  // Assert — brackets retained, order oldest→newest
  expect(parsed.messageId).toBe('<c@example.com>');
  expect(parsed.references).toEqual(['<a@example.com>', '<b@example.com>']);
});

test('a message with no References yields [] rather than null', async () => {
  const raw = 'From: a@example.com\r\nMessage-ID: <x@example.com>\r\n\r\nbody';
  const parsed = await toParsedMessage(raw, /* … */);
  expect(parsed.references).toEqual([]);
  expect(parsed.messageId).toBe('<x@example.com>');
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd sync && npx vitest run tests/message-route.test.ts -t 'thread'`
Expected: FAIL — `parsed.messageId` is `undefined` (the property does not exist).

- [ ] **Step 3: Implement**

`mailparser` types `references` as `string | string[] | undefined` — a single
reference comes back as a bare string, not a one-element array. Normalize:

```ts
/** mailparser hands back a STRING when there is exactly one reference and an
 *  ARRAY when there are several — the same shape hazard `flattenAddresses`
 *  already handles for address headers. Absent becomes [], never null: every
 *  caller concatenates this, and [] concatenates correctly while null throws. */
function normalizeReferences(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  const list = typeof value === 'string' ? [value] : value;
  return list.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}
```

and in the returned object: `messageId: textOrNull(parsed.messageId)`,
`references: normalizeReferences(parsed.references)`.

- [ ] **Step 4: Run tests, confirm pass**

Run: `cd sync && npx vitest run tests/message-route.test.ts`
Expected: PASS, and the file's existing test count rises by exactly 2.

- [ ] **Step 5: Mutation check (required)**

Delete the `.filter(...)` and re-run: a folded `References` whose continuation
line yields an empty entry must fail a test. If nothing fails, the test is
vacuous — this repo has shipped three tests that passed regardless of the code.

- [ ] **Step 6: Commit**

```bash
git add sync/src/api/message.ts sync/tests/message-route.test.ts
git commit -m "feat: expose Message-ID and References so replies can thread"
```

---

## Task 2: Quote construction — the spec's binding pixel placement

**Files:**
- Create: `sync/src/send/quote.ts`
- Test: `sync/tests/quote.test.ts`

**Interfaces:**
- Consumes: `escapeHtml` from `sync/src/send/build.ts`; `stripOwnTrackingPixels`
  from `sync/src/api/strip-pixel.ts` (already exported and tested).
- Produces:
  ```ts
  export interface QuoteInput {
    readonly originalHtml: string | null;
    readonly originalText: string | null;
    readonly fromLabel: string;   // "Ada Lovelace <ada@example.com>"
    readonly sentAtMs: number;
    readonly trackingBaseUrl: string | null; // null ⇒ tracking disabled
  }
  export function buildQuotedHtml(input: QuoteInput): string;
  export function attributionLine(fromLabel: string, sentAtMs: number): string;
  ```

**The two binding rules this file exists to satisfy:**

1. **§5.6 — strip before inject.** The quote is built from the *original* body,
   which for a message the user themselves sent carries the *original*
   recipient's pixel. Quoting it unstripped means every reply re-fires that
   token forever. `stripOwnTrackingPixels` runs on `originalHtml` **first**,
   before any pixel is added.
2. **§5.2 — placement.** The new pixel goes immediately **before** the
   `.gmail_quote` div, never inside it. Gmail collapses quoted text behind a
   toggle; a pixel inside the collapsed region never loads, so tracking a reply
   would silently always report "unopened".

- [ ] **Step 1: Write the failing tests**

```ts
const QUOTE = { fromLabel: 'Ada <ada@example.com>', sentAtMs: 1_700_000_000_000 };

test('strips a Postbox pixel out of the quoted original (spec 5.6)', () => {
  // Arrange — this is our own tracking origin, i.e. exactly what our own Sent
  // copy of the message being replied to contains.
  const html = buildQuotedHtml({
    ...QUOTE,
    originalHtml: '<p>hi</p><img alt="" src="https://track.test/o/deadbeef.png">',
    originalText: null,
    trackingBaseUrl: 'https://track.test',
  });

  // Assert
  expect(html).not.toContain('deadbeef');
  expect(html).toContain('hi');
});

test('keeps a third-party image in the quote — the strip is OURS only', () => {
  const html = buildQuotedHtml({
    ...QUOTE,
    originalHtml: '<img src="https://cdn.example.com/logo.png">',
    originalText: null,
    trackingBaseUrl: 'https://track.test',
  });
  expect(html).toContain('cdn.example.com/logo.png');
});

test('quoted plain text is ESCAPED, never injected as markup', () => {
  const html = buildQuotedHtml({
    ...QUOTE,
    originalHtml: null,
    originalText: '<script>alert(1)</script>',
    trackingBaseUrl: null,
  });
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;');
});

test('emits a .gmail_quote container so send/build can place the pixel before it', () => {
  const html = buildQuotedHtml({ ...QUOTE, originalHtml: '<p>x</p>', originalText: null, trackingBaseUrl: null });
  expect(html).toContain('class="gmail_quote"');
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `cd sync && npx vitest run tests/quote.test.ts`
Expected: FAIL — module `../src/send/quote.ts` not found.

- [ ] **Step 3: Implement `sync/src/send/quote.ts`**

```ts
import { escapeHtml } from './build.ts';
import { stripOwnTrackingPixels } from '../api/strip-pixel.ts';

/**
 * "On Mon, Nov 14, 2023 at 10:13 PM Ada <ada@example.com> wrote:" — Gmail's
 * own attribution shape, so a reply from Postbox is indistinguishable from a
 * reply from Gmail in every client that renders one.
 *
 * FIXED to UTC deliberately. This string is written into mail that leaves the
 * machine; rendering it in the server's local zone would make the same reply
 * read differently depending on where the box happens to be deployed.
 */
export function attributionLine(fromLabel: string, sentAtMs: number): string { /* … */ }

export function buildQuotedHtml(input: QuoteInput): string {
  // §5.6 FIRST — before anything is added. See the file header.
  const source = input.originalHtml !== null
    ? stripOwnTrackingPixels(input.originalHtml, input.trackingBaseUrl)
    : `<pre>${escapeHtml(input.originalText ?? '')}</pre>`;

  return [
    `<div>${escapeHtml(attributionLine(input.fromLabel, input.sentAtMs))}</div>`,
    `<blockquote class="gmail_quote">${source}</blockquote>`,
  ].join('');
}
```

- [ ] **Step 4: Run, confirm pass**

- [ ] **Step 5: Mutation check (required)**

Move the `stripOwnTrackingPixels` call to run *after* the quote is assembled
instead of before. The §5.6 test must fail. If it still passes, the test is not
pinning ordering and must be rewritten before this task is reported DONE.

- [ ] **Step 6: Commit**

```bash
git add sync/src/send/quote.ts sync/tests/quote.test.ts
git commit -m "feat: quote construction that strips our own pixel before injecting a new one"
```

---

## Task 3: Emit the threading headers and place the pixel before the quote

**Files:**
- Modify: `sync/src/send/build.ts`, `sync/src/api/send.ts`
- Test: `sync/tests/send-build.test.ts`, `sync/tests/send-route.test.ts`

**Interfaces:**
- Consumes: Task 1's `messageId`/`references`; Task 2's `buildQuotedHtml`.
- Produces: `SendRequest` gains three optional fields:
  ```ts
  readonly inReplyTo?: string;             // one message-id, angle brackets included
  readonly references?: readonly string[]; // oldest → newest
  readonly htmlQuote?: string;             // pre-built by the client from Task 2's shape
  ```
  Absent ⇒ today's behaviour exactly. A plain new compose must be byte-identical
  to what it produces now.

**Validation — these are attacker-reachable strings that become headers.**
A newline inside `inReplyTo` is **header injection**: it terminates the header
and lets the rest of the value forge `Bcc:`. Reject any value containing CR or
LF outright — do not strip and continue, since a silently-mangled thread id is
indistinguishable from a working one until the reply lands unthreaded.

- [ ] **Step 1: Write the failing tests**

```ts
test('rejects a Message-ID containing CRLF (header injection)', async () => {
  const res = await handleSend(reqWith({ inReplyTo: '<a@b>\r\nBcc: attacker@evil.test' }), deps);
  expect(res.status).toBe(400);
});

test('References is capped so a long thread cannot unbound the header', async () => {
  const res = await handleSend(reqWith({ references: Array.from({ length: 200 }, (_, i) => `<${i}@b>`) }), deps);
  expect(res.status).toBe(400);
});

test('places the tracking pixel BEFORE the quote, not inside it (spec 5.2)', () => {
  const html = buildHtmlBody({ text: 'my reply', htmlQuote: '<blockquote class="gmail_quote">old</blockquote>', token: 'abc', trackingBaseUrl: 'https://track.test' });
  // Assert on ORDER, not mere containment — containment passes for both placements.
  expect(html.indexOf('/o/abc.png')).toBeLessThan(html.indexOf('gmail_quote'));
});

test('with no quote the pixel still appends to the body root (unchanged behaviour)', () => {
  const html = buildHtmlBody({ text: 'new mail', htmlQuote: undefined, token: 'abc', trackingBaseUrl: 'https://track.test' });
  expect(html).toContain('/o/abc.png');
});
```

- [ ] **Step 2: Run, confirm all four fail**

- [ ] **Step 3: Implement** — `MAX_REFERENCES = 50` as a named constant beside
      the other `MAX_*` in `api/send.ts`; a `hasHeaderInjection(value)` guard
      used by both new string fields; `buildHtmlBody` splices the pixel before
      `htmlQuote` when one is present.

- [ ] **Step 4: Run, confirm pass. Full suite: `cd sync && npm test` ≥ 917.**

- [ ] **Step 5: Mutation check (required)**

Invert the placement so the pixel lands after the quote — the §5.2 order test
must fail. A `toContain` assertion would survive this; that is why the test
above asserts `indexOf(...) < indexOf(...)`.

- [ ] **Step 6: Commit**

```bash
git add sync/src/send/build.ts sync/src/api/send.ts sync/tests/send-build.test.ts sync/tests/send-route.test.ts
git commit -m "feat: thread replies with In-Reply-To/References and place the pixel before the quote"
```

---

## Task 4: Reply, reply-all and forward in the client

**Files:**
- Create: `client/src/replyDraft.ts`
- Modify: `client/src/components/Compose.tsx`, `client/src/components/MessageView.tsx`
- Test: `client/tests/reply-draft.test.ts`

**Interfaces:**
- Consumes: Task 1's `ParsedMessage`; Task 3's `SendRequest` fields.
- Produces:
  ```ts
  export type ReplyMode = 'reply' | 'replyAll' | 'forward';
  export function buildReplyDraft(
    message: ParsedMessage,
    mode: ReplyMode,
    ownAddresses: readonly string[],
  ): { to: string[]; cc: string[]; subject: string };
  ```

**Client tests never render components** (project standing constraint) — this is
why recipient derivation and subject prefixing live in a pure module. Live
browser verification is still mandatory and has caught 100%-failure bugs that
unit tests passed.

- [ ] **Step 1: Write the failing tests**

```ts
const OWN = ['me@example.com'];

test('reply goes to the sender only, never to the other recipients', () => {
  const d = buildReplyDraft(msg({ from: 'ada@x.com', to: ['me@example.com', 'bob@x.com'] }), 'reply', OWN);
  expect(d.to).toEqual(['ada@x.com']);
  expect(d.cc).toEqual([]);
});

test('reply-all keeps everyone EXCEPT me — otherwise every reply mails myself', () => {
  const d = buildReplyDraft(msg({ from: 'ada@x.com', to: ['me@example.com', 'bob@x.com'], cc: ['carol@x.com'] }), 'replyAll', OWN);
  expect(d.to).toEqual(['ada@x.com', 'bob@x.com']);
  expect(d.cc).toEqual(['carol@x.com']);
  expect([...d.to, ...d.cc]).not.toContain('me@example.com');
});

test('own-address matching is case-insensitive — Gmail echoes mixed case', () => {
  const d = buildReplyDraft(msg({ from: 'ada@x.com', to: ['ME@Example.com'] }), 'replyAll', OWN);
  expect(d.to).toEqual(['ada@x.com']);
});

test('does not double-prefix an already-Re: subject', () => {
  expect(buildReplyDraft(msg({ subject: 'Re: numbers' }), 'reply', OWN).subject).toBe('Re: numbers');
  expect(buildReplyDraft(msg({ subject: 'numbers' }), 'reply', OWN).subject).toBe('Re: numbers');
});

test('forward prefixes Fwd: and pre-fills NO recipient', () => {
  const d = buildReplyDraft(msg({ subject: 'numbers', from: 'ada@x.com' }), 'forward', OWN);
  expect(d.subject).toBe('Fwd: numbers');
  expect(d.to).toEqual([]);   // sending a forward to the original sender is the classic misfire
});
```

- [ ] **Step 2: Run, confirm fail.** `cd client && npx vitest run tests/reply-draft.test.ts`

- [ ] **Step 3: Implement.** Dedupe addresses case-insensitively while preserving
      first-seen display order. `Re:`/`Fwd:` detection is anchored and
      case-insensitive (`/^re:\s*/i`) — an unanchored match would treat
      "Agenda: Re-org" as already prefixed.

- [ ] **Step 4: Run, confirm pass. Full client suite ≥ 696.**

- [ ] **Step 5: Wire the UI** — Reply / Reply all / Forward in `MessageView`,
      opening `Compose` pre-filled, with the quote from Task 2's shape and
      `inReplyTo` / `references` from Task 1 threaded through.

- [ ] **Step 6: Live verification (NOT optional)** — send a real reply to a real
      address, then confirm **in Gmail's own web UI** that it lands *in the
      existing thread* rather than as a new one. This is the only check that
      proves Task 1 and Task 3 actually work end to end; every unit test here
      would pass with the headers dropped on the floor.

- [ ] **Step 7: Commit**

```bash
git add client/src/replyDraft.ts client/src/components client/tests/reply-draft.test.ts
git commit -m "feat: reply, reply-all and forward"
```

---

## Task 5: Archive, trash and spam — getting mail out of the inbox

**Files:**
- Create: `sync/src/imap/move.ts`, `sync/src/api/move.ts`
- Modify: `client/src/components/MessageView.tsx`, `client/src/components/InboxList.tsx`
- Test: `sync/tests/move.test.ts`

**Interfaces:**
- Consumes: `getDiscoveredFolders` (`sync/src/imap/folder-cache.ts`), the
  `KeyedMutex` and `resolveConnection` path used by `api/flags.ts`.
- Produces:
  ```ts
  export type MoveDestination = 'archive' | 'trash' | 'spam';
  export function moveMessage(
    deps: MoveDeps, accountId: string, folder: string, uid: number, to: MoveDestination,
  ): Promise<boolean>;   // false ⇒ the message was already gone; never throws for that case
  ```

**Archive is not a move.** In Gmail/IMAP, "archive" means *remove the INBOX
label* — i.e. a MOVE out of `INBOX` into All Mail, which `imapflow` expresses as
`messageMove`. Trash and Spam are moves into the discovered `\Trash` / `\Junk`
folders. Discovery is mandatory: `[Gmail]/Trash` is wrong on a non-English
account and this repo already has a folder-cache for exactly this reason.

**No expunge.** `flags.ts` records that `\Deleted` is absent and must stay
absent; a MOVE achieves the user-visible result with no destructive path.

- [ ] **Step 1: Write the failing tests**

```ts
test('trash resolves the destination from DISCOVERY, never a hardcoded name', async () => {
  const conn = fakeConnection();
  await moveMessage(depsWithFolders({ trash: '[Gmail]/Papelera' }), 'a', 'INBOX', 42, 'trash');
  expect(conn.moves).toEqual([{ from: 'INBOX', uid: 42, to: '[Gmail]/Papelera' }]);
});

test('refuses when the account exposes no such special-use folder', async () => {
  await expect(moveMessage(depsWithFolders({ /* no junk */ }), 'a', 'INBOX', 42, 'spam'))
    .rejects.toThrow(/spam/i);
});

test('never sets \\Deleted or expunges', async () => {
  const conn = fakeConnection();
  await moveMessage(depsWith(conn), 'a', 'INBOX', 42, 'trash');
  expect(conn.flagsAdded).toEqual([]);
  expect(conn.expunged).toBe(false);
});

test('a uid that no longer exists returns false rather than throwing', async () => {
  await expect(moveMessage(depsWithMissingUid(), 'a', 'INBOX', 999, 'archive')).resolves.toBe(false);
});
```

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement** both files. The route validates `accountId`, `folder`,
      `uid` and a `to` that must be one of the three literals — an unconstrained
      destination string would be an arbitrary-folder-move primitive.

- [ ] **Step 4: Run, confirm pass. Full sync suite ≥ 917.**

- [ ] **Step 5: Mutation check (required)** — replace the discovered destination
      with the literal `'[Gmail]/Trash'`. The discovery test must fail.

- [ ] **Step 6: Wire the UI** — the row and the reader both get Archive and
      Trash. Removal from the list must be optimistic with rollback on failure:
      a message that visibly returns after a failed archive is honest; one that
      silently stays gone in the UI while still in the inbox is not.

- [ ] **Step 7: Live verification** — archive a real message, confirm in Gmail's
      web UI that it left the inbox and is still in All Mail (**not** deleted).

- [ ] **Step 8: Commit**

```bash
git add sync/src/imap/move.ts sync/src/api/move.ts sync/tests/move.test.ts client/src/components
git commit -m "feat: archive, trash and spam without ever opening an expunge path"
```

---

## Self-review

**Spec coverage.** §5.1 markup — unchanged, still asserted by Plan 4's tests.
§5.2 placement — Task 3, and this plan is the *first* to exercise its
before-the-quote branch. §5.3 per-recipient bodies — unchanged; a reply with N
recipients still fans out, and the known N-Sent-copies artifact is unchanged and
still out of scope (it needs the forbidden expunge path). §5.6 draft strip —
Task 2, previously unimplemented. §7B identities — unchanged; a reply sends from
the account that received the message, which the existing identity picker
already expresses.

**Not covered, deliberately:** attachments on send (spec §5.3.1's multiplication
mitigation is its own problem — N recipients × a 10 MB attachment is 10 separate
SMTP transactions and will hit Gmail's limits), and the third-party pixel
blocklist from §5.6's last bullet (the user explicitly overruled image blocking:
*"i dont care if people can track me with the pixels"* — recorded in memory).

**Type consistency.** `messageId` carries angle brackets in Tasks 1→3→4;
`references` is `readonly string[]` at every hop; `sentAtMs` is epoch-ms
everywhere, matching `ParsedMessage.date`.
