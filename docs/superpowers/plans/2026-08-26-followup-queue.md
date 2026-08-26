# Sent & Waiting / Opened-No-Reply Implementation Plan (Plan 10)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the two views the spec names as the reason this client exists, and
which no mainstream mail client offers — outbound mail ranked by *engagement state*
rather than by date, and the follow-up queue of mail that was read and never answered.

**Architecture:** One new server route does the whole join in Postgres — sent messages
LEFT JOIN their open events, LEFT JOIN any later inbound message sharing the
`thread_id`. The client renders it as a new view beside Inbox. No new storage: every
input already exists (`messages.folder` = the discovered Sent path, `messages.thread_id`,
and the opens the poller already ingests).

**Tech Stack:** TypeScript, `pg`, React 19 + Tailwind v4. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-08-23-postbox-spec.md` §7A (the three views;
"Recent Opens" is already shipped as `OpensFeed`/`OpensRail` — this plan builds the
other two), §7A.2 (honest states are a design requirement, not an edge case),
§5.6 (own-pixel suppression), §7.2 (never store raw IP).

## Global Constraints

- **No new dependencies.**
- **Honest states are first-class** (§7A.2, binding). "Never opened" and "opened,
  cannot verify" are DIFFERENT facts and must render differently. Roughly half of
  opens are unverifiable; a UI that renders "not opened" for "we cannot tell" is
  lying, and the spec forbids it.
- **`deviceClass` is the literal string `'unknown'`, never null, and device
  attribution is impossible** (Gmail's proxy strips it). Never render it. The user
  also asked for no MPP/side-note labels — surface the *subject and recipient*, not
  caveats about measurement.
- **Own-pixel opens must not count.** §5.6's strip means our own Sent copies no longer
  fire, but any historical open row from before that fix can still be attributed to
  the sender. Exclude opens whose recipient resolves to one of the user's own
  addresses, and say so in a comment.
- tracking's `messageId` has **no** angle brackets; synced `message_id` **does**.
  Normalise before joining — this has already caused a defect once.
- `pg` returns bigint as strings via the driver but as JSON **numbers** through
  `json_build_object`. Same column, two encodings.
- Timestamps on the wire are **epoch-ms numbers**, never ISO strings.
- Test floors at time of writing: sync **954/57**, client **763**. Do not reduce.
- Client tests never render components — extract pure helpers and test those.
  Live browser verification is mandatory.

---

## File Structure

| File | Responsibility |
|---|---|
| `sync/src/api/followup.ts` (create) | `GET /api/followup` — the join, paginated |
| `sync/src/followup/query.ts` (create) | The SQL + row→wire shaping, testable alone |
| `sync/src/followup/classify.ts` (create) | Pure: (opens, replies, age) → engagement state |
| `client/src/components/FollowupView.tsx` (create) | The view |
| `client/src/components/FollowupRow.tsx` (create) | One row, engagement-state led |
| `client/src/followupCopy.ts` (create) | Pure: state → the words shown |

---

## Task 1: Classify engagement state (pure, no I/O)

The whole product idea reduces to one function. Build and test it before any SQL, so
the states are settled before a query shape locks them in.

**Files:**
- Create: `sync/src/followup/classify.ts`
- Test: `sync/tests/followup-classify.test.ts`

**Interfaces:**
```ts
export type EngagementState =
  | 'opened-no-reply'      // read, silent — THE queue
  | 'opened-replied'       // resolved; shown only in Sent & Waiting, ranked last
  | 'opened-repeatedly'    // >1 distinct open — strongest signal of interest
  | 'never-opened'         // sent, delivered, no open recorded
  | 'unverifiable';        // §7A.2: we genuinely cannot tell. NOT the same as never-opened.

export interface ClassifyInput {
  readonly openCount: number;
  readonly distinctRecipientOpens: number;
  readonly hasReply: boolean;
  readonly sentAtMs: number;
  readonly nowMs: number;
}
export function classify(input: ClassifyInput): EngagementState;
```

**The judgement call, stated so the implementer does not have to guess:** a message
sent 30 seconds ago with no open is NOT "never opened" — it is too early to say.
Pick a grace period, name it as a constant, and treat anything inside it as
`unverifiable`. The spec's §7A.2 is explicit that an honest unknown beats a
confident wrong answer.

- [ ] **Step 1: Write the failing tests**

```ts
const BASE = { openCount: 0, distinctRecipientOpens: 0, hasReply: false, sentAtMs: 0, nowMs: 10 * 60 * 1000 };

test('opened once with no reply is the follow-up queue', () => {
  expect(classify({ ...BASE, openCount: 1, distinctRecipientOpens: 1 })).toBe('opened-no-reply');
});

test('a reply resolves it even when it was opened many times', () => {
  expect(classify({ ...BASE, openCount: 9, distinctRecipientOpens: 3, hasReply: true })).toBe('opened-replied');
});

test('repeat opens outrank a single open', () => {
  expect(classify({ ...BASE, openCount: 5, distinctRecipientOpens: 2 })).toBe('opened-repeatedly');
});

test('just-sent mail is unverifiable, NOT never-opened (spec 7A.2)', () => {
  // Sent 5 seconds ago. Claiming "never opened" here is the lie the spec forbids.
  expect(classify({ ...BASE, sentAtMs: 0, nowMs: 5_000 })).toBe('unverifiable');
});

test('old mail with no open is honestly never-opened', () => {
  expect(classify({ ...BASE, sentAtMs: 0, nowMs: 48 * 60 * 60 * 1000 })).toBe('never-opened');
});
```

- [ ] **Step 2: Run, confirm they fail** (`cd sync && npx vitest run tests/followup-classify.test.ts`)
- [ ] **Step 3: Implement** with the grace period as a named constant.
- [ ] **Step 4: Run, confirm pass.**
- [ ] **Step 5: Mutation check (required)** — delete the grace-period branch; the
      "just-sent" test must fail. If it still passes, the test is vacuous.
- [ ] **Step 6: Commit**

```bash
git add sync/src/followup/classify.ts sync/tests/followup-classify.test.ts
git commit -m "feat: classify outbound mail by engagement state"
```

---

## Task 2: The query

**Files:**
- Create: `sync/src/followup/query.ts`, `sync/src/api/followup.ts`
- Test: `sync/tests/followup-query.test.ts`

**Interfaces:**
```ts
export interface FollowupRow {
  readonly accountId: string;
  readonly uid: number;
  readonly folder: string;
  readonly subject: string | null;
  readonly recipients: readonly string[];
  readonly sentAtMs: number;          // epoch ms, NOT an ISO string
  readonly openCount: number;
  readonly lastOpenAtMs: number | null;
  readonly hasReply: boolean;
}
```

**What "has a reply" means, precisely:** any message in the same `thread_id`, in any
folder, whose `date` is later than this message's and whose `from_email` is NOT one of
the user's own addresses. A later message from *yourself* in the same thread is a
follow-up nudge, not a reply, and must not clear the queue — that is the single
easiest way to get this feature wrong.

- [ ] **Step 1: Write the failing tests** against a real scratch Postgres (this repo
      has precedent for that — `db.updateStoredFlag` was closed exactly this way).

```ts
test('a later message from ME in the thread does NOT count as a reply', async () => {
  await seed({ sent: { threadId: 't1', dateMs: 1000, from: 'me@example.com' },
               also: { threadId: 't1', dateMs: 2000, from: 'me@example.com' } });
  const [row] = await queryFollowup(db, { ownAddresses: ['me@example.com'] });
  expect(row.hasReply).toBe(false);
});

test('a later message from THEM does count', async () => {
  await seed({ sent: { threadId: 't1', dateMs: 1000, from: 'me@example.com' },
               also: { threadId: 't1', dateMs: 2000, from: 'ada@x.com' } });
  const [row] = await queryFollowup(db, { ownAddresses: ['me@example.com'] });
  expect(row.hasReply).toBe(true);
});

test('sentAtMs is an epoch-ms NUMBER on the wire, not a string', async () => {
  const [row] = await queryFollowup(db, { ownAddresses: ['me@example.com'] });
  expect(typeof row.sentAtMs).toBe('number');
});

test('message_id angle brackets are normalised before matching opens', async () => {
  // synced message_id has <>, tracking's does not. Unnormalised, this returns 0 opens.
  await seedOpen({ messageId: 'abc@x.com' });      // tracking shape
  await seedSent({ messageId: '<abc@x.com>' });    // synced shape
  const [row] = await queryFollowup(db, { ownAddresses: [] });
  expect(row.openCount).toBe(1);
});
```

- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Implement.** Parameterised placeholders only — never string-built SQL
      from route input. Paginate; an unbounded query over every sent message is the
      performance bug this table will eventually have.
- [ ] **Step 4: Run, confirm pass. Full sync suite ≥ 954.**
- [ ] **Step 5: Mutation check (required)** — remove the own-address exclusion from the
      reply join; the "later message from ME" test must fail.
- [ ] **Step 6: Commit**

---

## Task 3: The view

**Files:**
- Create: `client/src/components/FollowupView.tsx`, `FollowupRow.tsx`, `client/src/followupCopy.ts`
- Modify: the sidebar to add the entry
- Test: `client/tests/followup-copy.test.ts`

**Design intent — this is the product's thesis, so it gets the strongest treatment.**
The row is led by engagement state, not by date: the eye should land on *"opened 3×,
no reply"* before it lands on a timestamp. Rank `opened-repeatedly` above
`opened-no-reply` above `never-opened`; put `opened-replied` last or behind a toggle,
since a resolved thread is not a queue item.

Copy rules, from the user's own direction: **no MPP labels, no measurement caveats,
no side notes.** Say what is known — subject, who, when, how many opens. An
`unverifiable` row says something honest and short; it does not explain Apple Mail
Privacy Protection to the reader.

- [ ] **Step 1: Write failing tests** for `followupCopy.ts` — one per state, asserting
      the exact words, plus one asserting no string contains "MPP", "Apple", or
      "privacy" (the user asked for those to be gone and a regression would be silent).
- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Implement copy + components.**
- [ ] **Step 4: Run, confirm pass. Client suite ≥ 763.**
- [ ] **Step 5: Live browser verification** — both themes, mobile and desktop widths.
      Mobile stays borderless/fluid with no unread tint (the user was explicit).
- [ ] **Step 6: Commit**

---

## Self-review

**Spec coverage.** §7A "Sent & Waiting" — Tasks 1-3 (the ranking IS the view). §7A
"Opened, no reply" — the default filter of that same view; it is one query with a
predicate, not a second subsystem. §7A "Recent Opens" — already shipped, untouched.
§7A.2 honest states — Task 1's `unverifiable` state and Task 3's copy tests.

**Not covered, deliberately:** snooze/reminders (not specified, and a follow-up queue
that nags is a different product decision the user has not asked for); device
attribution (impossible — Gmail's proxy strips it, already declined once).

**Type consistency.** `sentAtMs`/`lastOpenAtMs` are epoch-ms numbers at every hop,
matching `ParsedMessage.date` and `OpenEvent.occurredAt`. `EngagementState` is a
string-literal union shared by classify, the wire row, and the copy module.
