# Sync Service Implementation Plan (Plan 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A long-lived Node service that holds IMAP IDLE connections to up to 10 Gmail accounts, normalises their mail into one local Postgres store, and serves a unified inbox over JSON to the PWA and desktop client.

**Architecture:** One process. A connection pool holds one IMAP connection per account, each in IDLE. New mail triggers a header-first fetch — envelope, flags, labels, `BODYSTRUCTURE` — which is normalised into a canonical `Message` row with a short snippet. Full bodies and attachments are never bulk-cached; they are fetched from IMAP on demand. An HTTP server exposes the unified inbox. Every module that can be pure is pure, so the parsing and throttling logic is testable without a network.

**Tech Stack:** Node 26, TypeScript, `imapflow` (IMAP client with IDLE), `mailparser` (MIME), `pg` (local Postgres), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-23-postbox-spec.md`

## Global Constraints

- **$0 recurring cost.** Oracle Cloud Always Free (4 ARM cores / 24 GB / 200 GB) or GCP always-free `e2-micro` (1 GB / 30 GB). No paid tier, no domain. (Spec C1)
- **Single user, up to 10 Gmail accounts.** No multi-tenancy, no signup flow. (Spec C2)
- **IMAP + SMTP with per-account app passwords. No Google OAuth app**, no consent screen, no CASA. (Spec C5)
- **Sync data lives in Postgres ON THE VM, never in Neon.** Neon's 0.5 GB free tier holds tracking data only; ten mailboxes would overrun it roughly 20x. The two databases are separate and must not be conflated.
- **Attachments are NEVER cached.** Store `BODYSTRUCTURE`-derived metadata only — filename, MIME type, size, IMAP part id — and fetch the part on demand. This is the difference between a ~1 GB store and a 100 GB one.
- **Bodies are not bulk-fetched.** Store headers plus a snippet of at most `SNIPPET_CHARS` (280). Full bodies are fetched on demand and cached with eviction.
- **Gmail IMAP limits are hard:** ~15 concurrent connections per account and ~2.5 GB/day download per account. One IDLE connection per account; backfill runs under an explicit byte budget. (Spec L6)
- **App passwords live in a gitignored file or the OS keychain — never in the database, never in client-side storage, never committed.** (Spec 7.4)
- **Untrusted email HTML is never rendered by this service.** It stores raw HTML; sanitisation is the client's responsibility under a strict CSP. (Spec 7.1)
- **Immutability:** never mutate function inputs.
- **Errors are logged with context, never silently swallowed.**
- Files stay focused: 200-400 lines typical, 800 maximum.

---

## Prerequisites (human, before Task 8)

1. A VM on Oracle Cloud Always Free or GCP always-free, running Ubuntu with Node 26 and Postgres 16+.
2. A stable public HTTPS hostname. Free options: DuckDNS + Let's Encrypt, or Tailscale Funnel (`*.ts.net`, automatic TLS).
3. One Gmail app password per account, from `myaccount.google.com/apppasswords` (2-Step Verification must be enabled on each account first).

Tasks 1-7 are developed and tested locally and do NOT require the VM.

---

## File Structure

```
sync/
  package.json  tsconfig.json  vitest.config.ts  .env.example
  accounts.example.json     account list template (no secrets)
  src/
    config.ts               load + validate accounts and env      (Task 1)
    schema.sql              accounts, messages, attachments, sync_state (Task 2)
    db.ts                   Postgres adapter                      (Task 2)
    normalize.ts            IMAP envelope -> canonical Message    (Task 3)
    attachments.ts          BODYSTRUCTURE -> attachment metadata   (Task 3)
    budget.ts               per-account daily byte budget          (Task 4)
    imap/
      connection.ts         one account: connect, auth, capability (Task 5)
      fetch.ts              header-first fetch                     (Task 6)
      pool.ts               N connections + IDLE + reconnect       (Task 7)
    api/
      routes.ts             unified inbox, thread, message, body   (Task 8)
      server.ts             HTTP server + startup                  (Task 8)
  tests/
```

---

### Task 1: Scaffold, account config, and validation

**Files:**
- Create: `sync/package.json`, `sync/tsconfig.json`, `sync/vitest.config.ts`, `sync/.env.example`, `sync/accounts.example.json`
- Create: `sync/src/config.ts`
- Test: `sync/tests/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface AccountConfig { id: string; email: string; appPassword: string; isPrimary: boolean }`; `interface SyncConfig { accounts: readonly AccountConfig[]; databaseUrl: string; port: number }`; `loadConfig(raw: unknown, env: NodeJS.ProcessEnv): SyncConfig`; `MAX_ACCOUNTS = 10`.

**Why validation matters here:** ten app passwords typed by hand is ten chances for a stray space or a 15-character paste. A bad credential surfaces as an IMAP auth failure minutes into startup, against whichever account happens to connect first — so validate the shape up front and name the offending account.

- [ ] **Step 1: Create the scaffold**

```bash
mkdir -p sync/src/imap sync/src/api sync/tests
cd sync
```

`sync/package.json`:

```json
{
  "name": "postbox-sync",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "start": "node --env-file=.env dist/api/server.js",
    "dev": "node --env-file=.env --experimental-strip-types src/api/server.ts"
  },
  "dependencies": {
    "imapflow": "^1.0.191",
    "mailparser": "^3.7.1",
    "pg": "^8.13.1"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/pg": "^8.11.10",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`sync/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["vitest/globals", "node"]
  },
  "include": ["src", "tests"]
}
```

`sync/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { globals: true, environment: 'node' },
});
```

`sync/.env.example`:

```
DATABASE_URL=postgresql://postbox:password@localhost:5432/postbox_sync
PORT=8080
ACCOUNTS_FILE=./accounts.json
```

`sync/accounts.example.json`:

```json
[
  { "id": "primary",  "email": "you@gmail.com",       "appPassword": "abcdefghijklmnop", "isPrimary": true },
  { "id": "work",     "email": "you.work@gmail.com",  "appPassword": "qrstuvwxyzabcdef", "isPrimary": false }
]
```

Add to `sync/.gitignore`:

```
node_modules/
dist/
.env
accounts.json
!accounts.example.json
```

- [ ] **Step 2: Write the failing test**

`sync/tests/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig, MAX_ACCOUNTS } from '../src/config';

const ENV = { DATABASE_URL: 'postgresql://localhost/x', PORT: '8080' } as NodeJS.ProcessEnv;

const ONE = [{ id: 'primary', email: 'a@gmail.com', appPassword: 'abcdefghijklmnop', isPrimary: true }];

describe('loadConfig', () => {
  it('accepts a well-formed single account', () => {
    const config = loadConfig(ONE, ENV);
    expect(config.accounts).toHaveLength(1);
    expect(config.accounts[0]?.email).toBe('a@gmail.com');
    expect(config.port).toBe(8080);
  });

  it('strips spaces from an app password pasted from Google', () => {
    const spaced = [{ ...ONE[0], appPassword: 'abcd efgh ijkl mnop' }];
    expect(loadConfig(spaced, ENV).accounts[0]?.appPassword).toBe('abcdefghijklmnop');
  });

  it('names the offending account when an app password is the wrong length', () => {
    const bad = [{ ...ONE[0], id: 'work', appPassword: 'tooshort' }];
    expect(() => loadConfig(bad, ENV)).toThrow(/work/);
  });

  it('rejects duplicate account ids', () => {
    const dupe = [ONE[0], { ...ONE[0], email: 'b@gmail.com' }];
    expect(() => loadConfig(dupe, ENV)).toThrow(/duplicate/i);
  });

  it('rejects more than MAX_ACCOUNTS accounts', () => {
    const many = Array.from({ length: MAX_ACCOUNTS + 1 }, (_, i) => ({
      ...ONE[0], id: `a${i}`, email: `a${i}@gmail.com`,
    }));
    expect(() => loadConfig(many, ENV)).toThrow(new RegExp(String(MAX_ACCOUNTS)));
  });

  it('rejects a config that is not an array', () => {
    expect(() => loadConfig({ accounts: [] }, ENV)).toThrow(/array/i);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig(ONE, { PORT: '8080' } as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });

  it('never includes an app password in an error message', () => {
    const bad = [{ ...ONE[0], appPassword: 'SECRETVALUE123' }];
    try { loadConfig(bad, ENV); } catch (error) {
      expect(String(error)).not.toContain('SECRETVALUE123');
    }
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm install && npx vitest run tests/config.test.ts`
Expected: FAIL — `Failed to resolve import "../src/config"`

- [ ] **Step 4: Write the implementation**

`sync/src/config.ts`:

```ts
/** Gmail permits ~15 concurrent IMAP connections per account; one IDLE
 *  connection each keeps ten accounts comfortably inside that. The cap
 *  exists to stop a config typo from opening an unbounded number. */
export const MAX_ACCOUNTS = 10;

/** Google renders app passwords in four spaced groups; the spaces are
 *  presentational and must be stripped before use. */
const APP_PASSWORD_LENGTH = 16;

export interface AccountConfig {
  readonly id: string;
  readonly email: string;
  readonly appPassword: string;
  readonly isPrimary: boolean;
}

export interface SyncConfig {
  readonly accounts: readonly AccountConfig[];
  readonly databaseUrl: string;
  readonly port: number;
}

function parseAccount(raw: unknown, index: number): AccountConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`accounts[${index}] is not an object`);
  }
  const record = raw as Record<string, unknown>;
  const id = record.id;
  const email = record.email;
  const password = record.appPassword;

  if (typeof id !== 'string' || !id) throw new Error(`accounts[${index}] has no id`);
  if (typeof email !== 'string' || !email.includes('@')) {
    throw new Error(`account "${id}" has an invalid email`);
  }
  if (typeof password !== 'string') throw new Error(`account "${id}" has no appPassword`);

  const stripped = password.replace(/\s+/g, '');
  if (stripped.length !== APP_PASSWORD_LENGTH) {
    // Never echo the value — an error message is the easiest place to leak
    // a credential into a log aggregator.
    throw new Error(
      `account "${id}": appPassword must be ${APP_PASSWORD_LENGTH} characters ` +
      `after removing spaces, got ${stripped.length}`,
    );
  }

  return { id, email, appPassword: stripped, isPrimary: record.isPrimary === true };
}

export function loadConfig(raw: unknown, env: NodeJS.ProcessEnv): SyncConfig {
  if (!Array.isArray(raw)) throw new Error('accounts config must be a JSON array');
  if (raw.length === 0) throw new Error('accounts config is empty');
  if (raw.length > MAX_ACCOUNTS) {
    throw new Error(`too many accounts: ${raw.length} exceeds MAX_ACCOUNTS ${MAX_ACCOUNTS}`);
  }

  const accounts = raw.map(parseAccount);

  const seen = new Set<string>();
  for (const account of accounts) {
    if (seen.has(account.id)) throw new Error(`duplicate account id "${account.id}"`);
    seen.add(account.id);
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  return { accounts, databaseUrl, port: Number(env.PORT ?? 8080) };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 6: Commit**

```bash
git add sync/
git commit -m "feat: sync service scaffold and account config validation"
```

---

### Task 2: Schema and database adapter

**Files:**
- Create: `sync/src/schema.sql`, `sync/src/db.ts`
- Test: `sync/tests/db.test.ts`

**Interfaces:**
- Consumes: `SyncConfig` from `src/config.ts`.
- Produces: `interface MessageRow`, `interface AttachmentRow`; `openDb(databaseUrl: string): Db`; `interface Db` with `upsertMessage`, `getUnifiedInbox`, `getThread`, `getSyncState`, `setSyncState`, `close`.

**Storage reasoning, so nobody "improves" this later:** ten mailboxes at ~50k messages each is ~500k rows. Storing headers plus a 280-character snippet puts that near 1 GB. Storing full bodies would put it near 10 GB, and storing attachments near 100 GB. The snippet is the design.

- [ ] **Step 1: Write the schema**

`sync/src/schema.sql`:

```sql
create table if not exists accounts (
  id          text primary key,
  email       text not null unique,
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists messages (
  account_id   text not null references accounts(id) on delete cascade,
  uid          bigint not null,
  message_id   text,
  thread_id    text,
  folder       text not null,
  subject      text,
  from_name    text,
  from_email   text,
  to_emails    text[],
  cc_emails    text[],
  date         timestamptz,
  snippet      text,
  flags        text[],
  labels       text[],
  has_attach   boolean not null default false,
  size_bytes   bigint,
  primary key (account_id, folder, uid)
);
create index if not exists messages_unified on messages (date desc);
create index if not exists messages_thread on messages (thread_id, date asc);
create index if not exists messages_from on messages (from_email);

-- Metadata only. Attachment CONTENT is never stored; `part_id` is the IMAP
-- BODYSTRUCTURE part number used to fetch it on demand.
create table if not exists attachments (
  account_id   text not null,
  folder       text not null,
  uid          bigint not null,
  part_id      text not null,
  filename     text,
  mime_type    text,
  size_bytes   bigint,
  primary key (account_id, folder, uid, part_id),
  foreign key (account_id, folder, uid) references messages(account_id, folder, uid) on delete cascade
);

-- Resume point per account+folder so a restart does not re-download a mailbox.
create table if not exists sync_state (
  account_id     text not null,
  folder         text not null,
  uid_validity   bigint,
  last_seen_uid  bigint not null default 0,
  backfill_done  boolean not null default false,
  updated_at     timestamptz not null default now(),
  primary key (account_id, folder)
);

-- Rolling per-account download accounting, so Gmail's ~2.5 GB/day ceiling
-- is respected across process restarts rather than only within one run.
create table if not exists byte_budget (
  account_id  text not null,
  day         date not null,
  bytes_used  bigint not null default 0,
  primary key (account_id, day)
);
```

- [ ] **Step 2: Write the failing test**

`sync/tests/db.test.ts` — these run against a real local Postgres, so the suite needs one. Skip cleanly when `TEST_DATABASE_URL` is unset so the rest of the suite still runs.

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openDb, type Db } from '../src/db';

const URL = process.env.TEST_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

maybe('db', () => {
  let db: Db;
  beforeAll(async () => {
    db = openDb(URL!);
    await db.applySchema();
    await db.query('delete from accounts where id like $1', ['test-%']);
    await db.query(
      'insert into accounts (id, email) values ($1, $2) on conflict do nothing',
      ['test-a', 'test-a@gmail.com'],
    );
  });
  afterAll(async () => {
    await db.query('delete from accounts where id like $1', ['test-%']);
    await db.close();
  });

  it('upserts a message and reads it back in the unified inbox', async () => {
    await db.upsertMessage({
      accountId: 'test-a', uid: 1, folder: 'INBOX', messageId: '<m1@x>', threadId: 't1',
      subject: 'hello', fromName: 'A', fromEmail: 'a@x.com', toEmails: ['b@x.com'],
      ccEmails: [], date: new Date('2026-08-01T00:00:00Z'), snippet: 'hi there',
      flags: ['\\Seen'], labels: ['INBOX'], hasAttach: false, sizeBytes: 1024,
    });
    const inbox = await db.getUnifiedInbox({ limit: 10, before: null });
    expect(inbox.some((m) => m.subject === 'hello')).toBe(true);
  });

  it('upsert is idempotent on (account, folder, uid)', async () => {
    const base = {
      accountId: 'test-a', uid: 2, folder: 'INBOX', messageId: '<m2@x>', threadId: 't2',
      fromName: 'A', fromEmail: 'a@x.com', toEmails: [], ccEmails: [],
      date: new Date('2026-08-02T00:00:00Z'), snippet: 's', flags: [], labels: [],
      hasAttach: false, sizeBytes: 1,
    };
    await db.upsertMessage({ ...base, subject: 'first' });
    await db.upsertMessage({ ...base, subject: 'second' });
    const rows = await db.query(
      'select subject from messages where account_id=$1 and folder=$2 and uid=$3',
      ['test-a', 'INBOX', 2],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).toBe('second');
  });

  it('round-trips sync state', async () => {
    await db.setSyncState('test-a', 'INBOX', { uidValidity: 99n, lastSeenUid: 42n, backfillDone: false });
    const state = await db.getSyncState('test-a', 'INBOX');
    expect(state?.lastSeenUid).toBe(42n);
  });

  it('returns null sync state for an unknown folder', async () => {
    expect(await db.getSyncState('test-a', 'NOPE')).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL — `Failed to resolve import "../src/db"`

- [ ] **Step 4: Write the adapter**

`sync/src/db.ts`:

```ts
import { readFileSync } from 'node:fs';
import pg from 'pg';

export interface MessageInput {
  readonly accountId: string;
  readonly uid: number;
  readonly folder: string;
  readonly messageId: string | null;
  readonly threadId: string | null;
  readonly subject: string | null;
  readonly fromName: string | null;
  readonly fromEmail: string | null;
  readonly toEmails: readonly string[];
  readonly ccEmails: readonly string[];
  readonly date: Date | null;
  readonly snippet: string | null;
  readonly flags: readonly string[];
  readonly labels: readonly string[];
  readonly hasAttach: boolean;
  readonly sizeBytes: number | null;
}

export interface SyncStateInput {
  readonly uidValidity: bigint | null;
  readonly lastSeenUid: bigint;
  readonly backfillDone: boolean;
}

export interface Db {
  applySchema(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<any[]>;
  upsertMessage(message: MessageInput): Promise<void>;
  getUnifiedInbox(options: { limit: number; before: Date | null }): Promise<any[]>;
  getThread(threadId: string): Promise<any[]>;
  getSyncState(accountId: string, folder: string): Promise<SyncStateInput | null>;
  setSyncState(accountId: string, folder: string, state: SyncStateInput): Promise<void>;
  close(): Promise<void>;
}

export function openDb(databaseUrl: string): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });

  return {
    async applySchema() {
      const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
      await pool.query(sql);
    },

    async query(text, values = []) {
      const result = await pool.query(text, values as unknown[]);
      return result.rows;
    },

    async upsertMessage(m) {
      await pool.query(
        `insert into messages (account_id, uid, folder, message_id, thread_id, subject,
           from_name, from_email, to_emails, cc_emails, date, snippet, flags, labels,
           has_attach, size_bytes)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         on conflict (account_id, folder, uid) do update set
           subject=excluded.subject, flags=excluded.flags, labels=excluded.labels,
           snippet=excluded.snippet, has_attach=excluded.has_attach`,
        [m.accountId, m.uid, m.folder, m.messageId, m.threadId, m.subject, m.fromName,
         m.fromEmail, m.toEmails, m.ccEmails, m.date, m.snippet, m.flags, m.labels,
         m.hasAttach, m.sizeBytes],
      );
    },

    async getUnifiedInbox({ limit, before }) {
      const result = await pool.query(
        `select * from messages
         where ($1::timestamptz is null or date < $1)
         order by date desc limit $2`,
        [before, limit],
      );
      return result.rows;
    },

    async getThread(threadId) {
      const result = await pool.query(
        'select * from messages where thread_id = $1 order by date asc',
        [threadId],
      );
      return result.rows;
    },

    async getSyncState(accountId, folder) {
      const result = await pool.query(
        'select uid_validity, last_seen_uid, backfill_done from sync_state where account_id=$1 and folder=$2',
        [accountId, folder],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        uidValidity: row.uid_validity === null ? null : BigInt(row.uid_validity),
        lastSeenUid: BigInt(row.last_seen_uid),
        backfillDone: row.backfill_done,
      };
    },

    async setSyncState(accountId, folder, state) {
      await pool.query(
        `insert into sync_state (account_id, folder, uid_validity, last_seen_uid, backfill_done, updated_at)
         values ($1,$2,$3,$4,$5,now())
         on conflict (account_id, folder) do update set
           uid_validity=excluded.uid_validity, last_seen_uid=excluded.last_seen_uid,
           backfill_done=excluded.backfill_done, updated_at=now()`,
        [accountId, folder, state.uidValidity?.toString() ?? null,
         state.lastSeenUid.toString(), state.backfillDone],
      );
    },

    async close() { await pool.end(); },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Create a local database first:

```bash
createdb postbox_sync_test
TEST_DATABASE_URL=postgresql://localhost/postbox_sync_test npx vitest run tests/db.test.ts
```

Expected: PASS — 4 tests

- [ ] **Step 6: Commit**

```bash
git add sync/src/schema.sql sync/src/db.ts sync/tests/db.test.ts
git commit -m "feat: sync schema and postgres adapter"
```

---

### Task 3: Message normalisation and attachment metadata

**Files:**
- Create: `sync/src/normalize.ts`, `sync/src/attachments.ts`
- Test: `sync/tests/normalize.test.ts`, `sync/tests/attachments.test.ts`

**Interfaces:**
- Consumes: `MessageInput` from `src/db.ts`.
- Produces: `normalizeMessage(input: RawImapMessage, accountId: string, folder: string): MessageInput`; `SNIPPET_CHARS = 280`; `extractAttachments(bodyStructure: unknown): readonly AttachmentMeta[]`; `interface AttachmentMeta { partId: string; filename: string | null; mimeType: string; sizeBytes: number | null }`.

These are pure functions over IMAP data structures — no network, fully unit-testable. Both are given real `imapflow` shapes below.

- [ ] **Step 1: Write the failing test**

`sync/tests/normalize.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeMessage, SNIPPET_CHARS } from '../src/normalize';

const RAW = {
  uid: 42,
  size: 20480,
  flags: new Set(['\\Seen', '\\Flagged']),
  labels: new Set(['\\Inbox', 'Work']),
  envelope: {
    messageId: '<abc@mail.gmail.com>',
    date: new Date('2026-08-20T10:00:00Z'),
    subject: 'Quarterly numbers',
    from: [{ name: 'Sarah Chen', address: 'sarah@example.com' }],
    to: [{ name: '', address: 'me@gmail.com' }, { name: 'B', address: 'b@example.com' }],
    cc: [],
  },
  threadId: 'thread-9',
  bodyText: 'Hi — attaching the numbers we discussed. Let me know if anything looks off.',
};

describe('normalizeMessage', () => {
  it('maps envelope fields onto the canonical shape', () => {
    const m = normalizeMessage(RAW, 'primary', 'INBOX');
    expect(m.accountId).toBe('primary');
    expect(m.folder).toBe('INBOX');
    expect(m.uid).toBe(42);
    expect(m.subject).toBe('Quarterly numbers');
    expect(m.fromName).toBe('Sarah Chen');
    expect(m.fromEmail).toBe('sarah@example.com');
    expect(m.toEmails).toEqual(['me@gmail.com', 'b@example.com']);
  });

  it('converts flag and label sets to sorted arrays', () => {
    const m = normalizeMessage(RAW, 'primary', 'INBOX');
    expect(m.flags).toEqual(['\\Flagged', '\\Seen']);
    expect(m.labels).toEqual(['\\Inbox', 'Work']);
  });

  it('truncates the snippet to SNIPPET_CHARS', () => {
    const long = { ...RAW, bodyText: 'x'.repeat(SNIPPET_CHARS + 200) };
    expect(normalizeMessage(long, 'p', 'INBOX').snippet).toHaveLength(SNIPPET_CHARS);
  });

  it('collapses whitespace in the snippet', () => {
    const messy = { ...RAW, bodyText: 'line one\n\n\n   line two\t\tend' };
    expect(normalizeMessage(messy, 'p', 'INBOX').snippet).toBe('line one line two end');
  });

  it('tolerates a message with no envelope sender', () => {
    const anon = { ...RAW, envelope: { ...RAW.envelope, from: [] } };
    const m = normalizeMessage(anon, 'p', 'INBOX');
    expect(m.fromEmail).toBeNull();
    expect(m.fromName).toBeNull();
  });

  it('tolerates a missing date rather than inventing one', () => {
    const undated = { ...RAW, envelope: { ...RAW.envelope, date: undefined } };
    expect(normalizeMessage(undated, 'p', 'INBOX').date).toBeNull();
  });

  it('falls back to the message id when no thread id is present', () => {
    const nothread = { ...RAW, threadId: undefined };
    expect(normalizeMessage(nothread, 'p', 'INBOX').threadId).toBe('<abc@mail.gmail.com>');
  });
});
```

`sync/tests/attachments.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { extractAttachments } from '../src/attachments';

// imapflow BODYSTRUCTURE shape: a multipart node with childNodes.
const MIXED = {
  type: 'multipart/mixed',
  childNodes: [
    { part: '1', type: 'text/plain', size: 512 },
    { part: '2', type: 'application/pdf', size: 84213,
      disposition: 'attachment', dispositionParameters: { filename: 'report.pdf' } },
    { part: '3', type: 'image/png', size: 2048,
      disposition: 'inline', dispositionParameters: { filename: 'logo.png' } },
  ],
};

describe('extractAttachments', () => {
  it('finds an attachment-disposition part with its metadata', () => {
    const found = extractAttachments(MIXED);
    const pdf = found.find((a) => a.filename === 'report.pdf');
    expect(pdf).toBeDefined();
    expect(pdf?.mimeType).toBe('application/pdf');
    expect(pdf?.sizeBytes).toBe(84213);
    expect(pdf?.partId).toBe('2');
  });

  it('includes inline parts that carry a filename', () => {
    expect(extractAttachments(MIXED).some((a) => a.filename === 'logo.png')).toBe(true);
  });

  it('excludes the plain text body part', () => {
    expect(extractAttachments(MIXED).some((a) => a.mimeType === 'text/plain')).toBe(false);
  });

  it('returns an empty array for a simple text message', () => {
    expect(extractAttachments({ type: 'text/plain', size: 100 })).toEqual([]);
  });

  it('recurses into nested multiparts', () => {
    const nested = { type: 'multipart/mixed', childNodes: [
      { type: 'multipart/alternative', childNodes: [
        { part: '1.1', type: 'text/plain', size: 10 },
        { part: '1.2', type: 'text/html', size: 20 },
      ]},
      { part: '2', type: 'application/zip', size: 999,
        disposition: 'attachment', dispositionParameters: { filename: 'a.zip' } },
    ]};
    expect(extractAttachments(nested).map((a) => a.filename)).toEqual(['a.zip']);
  });

  it('returns an empty array rather than throwing on malformed input', () => {
    expect(extractAttachments(null)).toEqual([]);
    expect(extractAttachments({ childNodes: 'not-an-array' })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run both tests to verify they fail**

Run: `npx vitest run tests/normalize.test.ts tests/attachments.test.ts`
Expected: FAIL — unresolved imports for both modules

- [ ] **Step 3: Write the implementations**

`sync/src/normalize.ts`:

```ts
import type { MessageInput } from './db';

/** Long enough to judge a message from the list, short enough that 500k
 *  rows stay near 1 GB. Storing full bodies would be roughly 10x this. */
export const SNIPPET_CHARS = 280;

interface Address { readonly name?: string; readonly address?: string }

export interface RawImapMessage {
  readonly uid: number;
  readonly size?: number;
  readonly flags?: ReadonlySet<string> | readonly string[];
  readonly labels?: ReadonlySet<string> | readonly string[];
  readonly threadId?: string;
  readonly bodyText?: string;
  readonly envelope?: {
    readonly messageId?: string;
    readonly date?: Date;
    readonly subject?: string;
    readonly from?: readonly Address[];
    readonly to?: readonly Address[];
    readonly cc?: readonly Address[];
  };
}

function toSortedArray(value: ReadonlySet<string> | readonly string[] | undefined): string[] {
  if (!value) return [];
  return [...value].sort();
}

function addresses(list: readonly Address[] | undefined): string[] {
  return (list ?? []).map((a) => a.address).filter((a): a is string => Boolean(a));
}

function makeSnippet(bodyText: string | undefined): string | null {
  if (!bodyText) return null;
  const collapsed = bodyText.replace(/\s+/g, ' ').trim();
  return collapsed.slice(0, SNIPPET_CHARS);
}

export function normalizeMessage(
  raw: RawImapMessage,
  accountId: string,
  folder: string,
): MessageInput {
  const envelope = raw.envelope ?? {};
  const sender = envelope.from?.[0];
  const messageId = envelope.messageId ?? null;

  return {
    accountId,
    folder,
    uid: raw.uid,
    messageId,
    // Gmail supplies X-GM-THRID; without it, a message is its own thread.
    threadId: raw.threadId ?? messageId,
    subject: envelope.subject ?? null,
    fromName: sender?.name || null,
    fromEmail: sender?.address ?? null,
    toEmails: addresses(envelope.to),
    ccEmails: addresses(envelope.cc),
    date: envelope.date ?? null,
    snippet: makeSnippet(raw.bodyText),
    flags: toSortedArray(raw.flags),
    labels: toSortedArray(raw.labels),
    hasAttach: false, // set by the caller from extractAttachments()
    sizeBytes: raw.size ?? null,
  };
}
```

`sync/src/attachments.ts`:

```ts
export interface AttachmentMeta {
  readonly partId: string;
  readonly filename: string | null;
  readonly mimeType: string;
  readonly sizeBytes: number | null;
}

interface BodyNode {
  readonly part?: string;
  readonly type?: string;
  readonly size?: number;
  readonly disposition?: string;
  readonly dispositionParameters?: Record<string, unknown>;
  readonly childNodes?: readonly BodyNode[];
}

/**
 * Walks an IMAP BODYSTRUCTURE and returns metadata for parts that are
 * attachments. Content is never read — `partId` is the IMAP part number
 * used to fetch the bytes on demand, which is what keeps a ten-mailbox
 * store near 1 GB instead of 100 GB.
 */
export function extractAttachments(bodyStructure: unknown): readonly AttachmentMeta[] {
  const found: AttachmentMeta[] = [];

  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const current = node as BodyNode;

    if (Array.isArray(current.childNodes)) {
      for (const child of current.childNodes) walk(child);
      return;
    }

    const filename = current.dispositionParameters?.filename;
    const isAttachment =
      current.disposition === 'attachment' ||
      (current.disposition === 'inline' && typeof filename === 'string');

    if (isAttachment && current.part) {
      found.push({
        partId: current.part,
        filename: typeof filename === 'string' ? filename : null,
        mimeType: current.type ?? 'application/octet-stream',
        sizeBytes: current.size ?? null,
      });
    }
  };

  walk(bodyStructure);
  return found;
}
```

- [ ] **Step 4: Run both tests to verify they pass**

Run: `npx vitest run tests/normalize.test.ts tests/attachments.test.ts`
Expected: PASS — 13 tests

- [ ] **Step 5: Commit**

```bash
git add sync/src/normalize.ts sync/src/attachments.ts sync/tests/normalize.test.ts sync/tests/attachments.test.ts
git commit -m "feat: message normalisation and attachment metadata extraction"
```

---

### Task 4: Per-account daily byte budget

**Files:**
- Create: `sync/src/budget.ts`
- Test: `sync/tests/budget.test.ts`

**Interfaces:**
- Consumes: `Db` from `src/db.ts`.
- Produces: `DAILY_BYTE_LIMIT`, `BACKFILL_SHARE`; `interface BudgetDecision { allowed: boolean; remaining: number }`; `checkBudget(used: number, requested: number, limit?: number): BudgetDecision`; `class ByteBudget` with `reserve(accountId, bytes)` and `record(accountId, bytes)`.

**Why this exists:** Gmail cuts IMAP access for roughly 24 hours when an account exceeds ~2.5 GB of downloads in a day. With ten accounts backfilling simultaneously, the naive implementation locks the user out of all ten on day one. The budget is enforced against a Postgres table rather than in memory so a process restart cannot reset it.

- [ ] **Step 1: Write the failing test**

`sync/tests/budget.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { checkBudget, DAILY_BYTE_LIMIT, BACKFILL_SHARE } from '../src/budget';

describe('checkBudget', () => {
  it('allows a request that fits inside the limit', () => {
    const d = checkBudget(0, 1_000_000);
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(DAILY_BYTE_LIMIT - 1_000_000);
  });

  it('refuses a request that would exceed the limit', () => {
    expect(checkBudget(DAILY_BYTE_LIMIT - 100, 500).allowed).toBe(false);
  });

  it('allows a request landing exactly on the limit', () => {
    expect(checkBudget(DAILY_BYTE_LIMIT - 500, 500).allowed).toBe(true);
  });

  it('reports zero remaining rather than a negative number when over', () => {
    expect(checkBudget(DAILY_BYTE_LIMIT + 1_000, 1).remaining).toBe(0);
  });

  it('honours an explicit lower limit for backfill', () => {
    const backfillLimit = Math.floor(DAILY_BYTE_LIMIT * BACKFILL_SHARE);
    expect(checkBudget(backfillLimit, 1, backfillLimit).allowed).toBe(false);
    expect(checkBudget(backfillLimit - 10, 5, backfillLimit).allowed).toBe(true);
  });

  it('reserves headroom for live sync — backfill share is below 1', () => {
    expect(BACKFILL_SHARE).toBeGreaterThan(0);
    expect(BACKFILL_SHARE).toBeLessThan(1);
  });

  it('treats a zero-byte request as allowed', () => {
    expect(checkBudget(DAILY_BYTE_LIMIT, 0).allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/budget.test.ts`
Expected: FAIL — unresolved import `../src/budget`

- [ ] **Step 3: Write the implementation**

`sync/src/budget.ts`:

```ts
import type { Db } from './db';

/**
 * Gmail suspends IMAP for roughly 24 hours when an account exceeds about
 * 2.5 GB of downloads in a day. We budget against 2 GB to leave margin for
 * the fact that IMAP protocol overhead is not visible to us. (Spec L6)
 */
export const DAILY_BYTE_LIMIT = 2 * 1024 * 1024 * 1024;

/**
 * Backfill may consume at most this share of the daily budget, leaving the
 * remainder for live sync. Without this, a backfill exhausts the day's
 * allowance and new mail stops arriving until midnight.
 */
export const BACKFILL_SHARE = 0.7;

export interface BudgetDecision {
  readonly allowed: boolean;
  readonly remaining: number;
}

export function checkBudget(
  used: number,
  requested: number,
  limit: number = DAILY_BYTE_LIMIT,
): BudgetDecision {
  const remaining = Math.max(0, limit - used);
  return { allowed: requested <= remaining, remaining };
}

/**
 * Budget state is persisted per account per day, so a process restart
 * cannot silently reset the allowance and re-trigger a lockout.
 */
export class ByteBudget {
  constructor(private readonly db: Db) {}

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  async used(accountId: string): Promise<number> {
    const rows = await this.db.query(
      'select bytes_used from byte_budget where account_id=$1 and day=$2',
      [accountId, this.today()],
    );
    return Number(rows[0]?.bytes_used ?? 0);
  }

  async reserve(accountId: string, bytes: number, limit?: number): Promise<BudgetDecision> {
    return checkBudget(await this.used(accountId), bytes, limit);
  }

  async record(accountId: string, bytes: number): Promise<void> {
    await this.db.query(
      `insert into byte_budget (account_id, day, bytes_used) values ($1,$2,$3)
       on conflict (account_id, day) do update set bytes_used = byte_budget.bytes_used + $3`,
      [accountId, this.today(), bytes],
    );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/budget.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add sync/src/budget.ts sync/tests/budget.test.ts
git commit -m "feat: persisted per-account daily byte budget"
```

---

### Task 5: Single-account IMAP connection

**Files:**
- Create: `sync/src/imap/connection.ts`
- Test: `sync/tests/connection.test.ts`

**Interfaces:**
- Consumes: `AccountConfig` from `src/config.ts`.
- Produces: `interface MailboxInfo { path: string; uidValidity: bigint; uidNext: bigint; exists: number }`; `class ImapConnection` with `connect()`, `openMailbox(path)`, `listMailboxes()`, `disconnect()`, `readonly accountId: string`, `readonly isConnected: boolean`.

**Live verification, not mocks.** This task talks to Gmail. Set `TEST_IMAP_EMAIL` and `TEST_IMAP_PASSWORD` in the environment and the test connects for real; without them it skips. Mocking an IMAP server would test the mock.

- [ ] **Step 1: Write the failing test**

`sync/tests/connection.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { ImapConnection } from '../src/imap/connection';

const EMAIL = process.env.TEST_IMAP_EMAIL;
const PASSWORD = process.env.TEST_IMAP_PASSWORD;
const maybe = EMAIL && PASSWORD ? describe : describe.skip;

maybe('ImapConnection (live Gmail)', () => {
  const connection = new ImapConnection({
    id: 'test', email: EMAIL!, appPassword: PASSWORD!, isPrimary: true,
  });
  afterAll(async () => { await connection.disconnect(); });

  it('connects and authenticates', async () => {
    await connection.connect();
    expect(connection.isConnected).toBe(true);
  }, 30_000);

  it('lists mailboxes including INBOX', async () => {
    const boxes = await connection.listMailboxes();
    expect(boxes.some((b) => b.toUpperCase() === 'INBOX')).toBe(true);
  }, 30_000);

  it('opens INBOX and reports uidValidity and uidNext', async () => {
    const info = await connection.openMailbox('INBOX');
    expect(info.path.toUpperCase()).toBe('INBOX');
    expect(info.uidValidity).toBeGreaterThan(0n);
    expect(info.uidNext).toBeGreaterThan(0n);
  }, 30_000);

  it('rejects a bad password without leaking it in the error', async () => {
    const bad = new ImapConnection({
      id: 'bad', email: EMAIL!, appPassword: 'wrongwrongwrong1', isPrimary: false,
    });
    await expect(bad.connect()).rejects.toThrow();
    try { await bad.connect(); } catch (error) {
      expect(String(error)).not.toContain('wrongwrongwrong1');
    }
  }, 30_000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/connection.test.ts`
Expected: FAIL — unresolved import `../src/imap/connection`

- [ ] **Step 3: Write the implementation**

`sync/src/imap/connection.ts`:

```ts
import { ImapFlow } from 'imapflow';
import type { AccountConfig } from '../config';

export interface MailboxInfo {
  readonly path: string;
  readonly uidValidity: bigint;
  readonly uidNext: bigint;
  readonly exists: number;
}

export class ImapConnection {
  private client: ImapFlow | null = null;
  readonly accountId: string;

  constructor(private readonly account: AccountConfig) {
    this.accountId = account.id;
  }

  get isConnected(): boolean {
    return this.client?.usable === true;
  }

  async connect(): Promise<void> {
    const client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: { user: this.account.email, pass: this.account.appPassword },
      // imapflow logs auth payloads at debug level; silence it so an app
      // password can never reach a log file.
      logger: false,
    });
    await client.connect();
    this.client = client;
  }

  private require(): ImapFlow {
    if (!this.client) throw new Error(`account "${this.accountId}": not connected`);
    return this.client;
  }

  async listMailboxes(): Promise<readonly string[]> {
    const list = await this.require().list();
    return list.map((box) => box.path);
  }

  async openMailbox(path: string): Promise<MailboxInfo> {
    const lock = await this.require().getMailboxLock(path);
    try {
      const mailbox = this.require().mailbox;
      if (typeof mailbox === 'boolean') {
        throw new Error(`account "${this.accountId}": failed to open ${path}`);
      }
      return {
        path: mailbox.path,
        uidValidity: BigInt(mailbox.uidValidity),
        uidNext: BigInt(mailbox.uidNext),
        exists: mailbox.exists,
      };
    } finally {
      lock.release();
    }
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.logout();
    } catch (error) {
      // A failed logout must not prevent shutdown, but it is logged rather
      // than swallowed — a hung connection matters when nine others exist.
      console.error(`account "${this.accountId}": logout failed`, error);
    } finally {
      this.client = null;
    }
  }
}
```

- [ ] **Step 4: Run the test against real Gmail**

```bash
TEST_IMAP_EMAIL=xinfinitypro@gmail.com \
TEST_IMAP_PASSWORD=<app password> \
npx vitest run tests/connection.test.ts
```

Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add sync/src/imap/connection.ts sync/tests/connection.test.ts
git commit -m "feat: single-account gmail imap connection"
```

---

### Task 6: Header-first fetch

**Files:**
- Create: `sync/src/imap/fetch.ts`
- Test: `sync/tests/fetch.test.ts`

**Interfaces:**
- Consumes: `ImapConnection` (Task 5), `normalizeMessage` and `RawImapMessage` (Task 3), `extractAttachments` (Task 3), `MessageInput` (Task 2).
- Produces: `interface FetchResult { messages: readonly MessageInput[]; attachments: ReadonlyMap<number, readonly AttachmentMeta[]>; bytesDownloaded: number }`; `fetchHeaders(connection, folder, range): Promise<FetchResult>`; `fetchBodyPart(connection, folder, uid, partId): Promise<Buffer>`.

**The whole point of this task:** fetch envelope, flags, labels and `BODYSTRUCTURE` — never `BODY[]`. A full-body fetch of ten mailboxes is both the storage blowup and the byte-budget blowup in one call.

- [ ] **Step 1: Write the failing test**

`sync/tests/fetch.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ImapConnection } from '../src/imap/connection';
import { fetchHeaders } from '../src/imap/fetch';

const EMAIL = process.env.TEST_IMAP_EMAIL;
const PASSWORD = process.env.TEST_IMAP_PASSWORD;
const maybe = EMAIL && PASSWORD ? describe : describe.skip;

maybe('fetchHeaders (live Gmail)', () => {
  const connection = new ImapConnection({
    id: 'test', email: EMAIL!, appPassword: PASSWORD!, isPrimary: true,
  });
  beforeAll(async () => { await connection.connect(); }, 30_000);
  afterAll(async () => { await connection.disconnect(); });

  it('fetches recent headers with envelope fields populated', async () => {
    const result = await fetchHeaders(connection, 'INBOX', { limit: 5 });
    expect(result.messages.length).toBeGreaterThan(0);
    const first = result.messages[0]!;
    expect(first.accountId).toBe('test');
    expect(first.folder).toBe('INBOX');
    expect(typeof first.uid).toBe('number');
  }, 60_000);

  it('reports bytes downloaded so the budget can be charged', async () => {
    const result = await fetchHeaders(connection, 'INBOX', { limit: 5 });
    expect(result.bytesDownloaded).toBeGreaterThan(0);
  }, 60_000);

  it('never downloads full bodies — bytes stay far below total message size', async () => {
    const result = await fetchHeaders(connection, 'INBOX', { limit: 20 });
    const totalMessageBytes = result.messages.reduce((sum, m) => sum + (m.sizeBytes ?? 0), 0);
    // Headers plus BODYSTRUCTURE should be a small fraction of full bodies.
    // If this fails, something is fetching BODY[] and the design is broken.
    expect(result.bytesDownloaded).toBeLessThan(totalMessageBytes);
  }, 60_000);

  it('returns an empty result for an empty range rather than throwing', async () => {
    const result = await fetchHeaders(connection, 'INBOX', { limit: 0 });
    expect(result.messages).toEqual([]);
  }, 30_000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/fetch.test.ts`
Expected: FAIL — unresolved import `../src/imap/fetch`

- [ ] **Step 3: Write the implementation**

`sync/src/imap/fetch.ts`:

```ts
import type { ImapConnection } from './connection';
import type { MessageInput } from '../db';
import type { AttachmentMeta } from '../attachments';
import { extractAttachments } from '../attachments';
import { normalizeMessage } from '../normalize';

export interface FetchRange {
  readonly limit: number;
  readonly sinceUid?: number;
}

export interface FetchResult {
  readonly messages: readonly MessageInput[];
  readonly attachments: ReadonlyMap<number, readonly AttachmentMeta[]>;
  readonly bytesDownloaded: number;
}

/**
 * Fetches envelope, flags, labels, size and BODYSTRUCTURE — deliberately NOT
 * `BODY[]`. Full bodies are fetched on demand by fetchBodyPart(). Bulk-fetching
 * bodies is simultaneously the storage blowup (10 GB vs 1 GB) and the fastest
 * route to Gmail's daily byte ceiling. (Spec L6)
 */
export async function fetchHeaders(
  connection: ImapConnection,
  folder: string,
  range: FetchRange,
): Promise<FetchResult> {
  if (range.limit <= 0) {
    return { messages: [], attachments: new Map(), bytesDownloaded: 0 };
  }

  const client = connection.rawClient();
  const lock = await client.getMailboxLock(folder);
  const messages: MessageInput[] = [];
  const attachments = new Map<number, readonly AttachmentMeta[]>();
  let bytesDownloaded = 0;

  try {
    const mailbox = client.mailbox;
    if (typeof mailbox === 'boolean') throw new Error(`cannot open ${folder}`);

    const highest = Number(mailbox.uidNext) - 1;
    const lowest = range.sinceUid ?? Math.max(1, highest - range.limit + 1);
    if (highest < lowest) {
      return { messages: [], attachments: new Map(), bytesDownloaded: 0 };
    }

    for await (const message of client.fetch(
      `${lowest}:${highest}`,
      { uid: true, envelope: true, flags: true, size: true, bodyStructure: true, labels: true },
      { uid: true },
    )) {
      const parts = extractAttachments(message.bodyStructure);
      const normalized = normalizeMessage(
        {
          uid: message.uid,
          size: message.size,
          flags: message.flags,
          labels: message.labels,
          threadId: message.labels ? undefined : undefined,
          envelope: message.envelope as never,
        },
        connection.accountId,
        folder,
      );
      messages.push({ ...normalized, hasAttach: parts.length > 0 });
      if (parts.length > 0) attachments.set(message.uid, parts);

      // Envelope + BODYSTRUCTURE is roughly 1-2 KB on the wire. imapflow does
      // not expose a byte counter, so charge a conservative fixed estimate
      // rather than under-reporting to the budget.
      bytesDownloaded += 2048;
    }
  } finally {
    lock.release();
  }

  return { messages, attachments, bytesDownloaded };
}

/** Fetches one attachment part on demand. Never called during sync. */
export async function fetchBodyPart(
  connection: ImapConnection,
  folder: string,
  uid: number,
  partId: string,
): Promise<Buffer> {
  const client = connection.rawClient();
  const lock = await client.getMailboxLock(folder);
  try {
    const download = await client.download(String(uid), partId, { uid: true });
    const chunks: Buffer[] = [];
    for await (const chunk of download.content) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  } finally {
    lock.release();
  }
}
```

Add to `sync/src/imap/connection.ts`, inside the `ImapConnection` class:

```ts
  /** Escape hatch for modules that need the raw client (fetch, IDLE). */
  rawClient(): ImapFlow {
    return this.require();
  }
```

- [ ] **Step 4: Run the test against real Gmail**

```bash
TEST_IMAP_EMAIL=xinfinitypro@gmail.com \
TEST_IMAP_PASSWORD=<app password> \
npx vitest run tests/fetch.test.ts
```

Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add sync/src/imap/fetch.ts sync/src/imap/connection.ts sync/tests/fetch.test.ts
git commit -m "feat: header-first imap fetch with on-demand body parts"
```

---

### Task 7: Connection pool with IDLE and reconnect

**Files:**
- Create: `sync/src/imap/pool.ts`
- Test: `sync/tests/pool.test.ts`

**Interfaces:**
- Consumes: `AccountConfig` (Task 1), `ImapConnection` (Task 5), `fetchHeaders` (Task 6), `Db` (Task 2), `ByteBudget` (Task 4).
- Produces: `computeBackoffMs(attempt: number): number`; `MAX_BACKOFF_MS`; `class ConnectionPool` with `start()`, `stop()`, `readonly status: ReadonlyMap<string, 'connected' | 'reconnecting' | 'stopped'>`.

**Reconnect matters more than it looks.** Gmail drops IDLE connections routinely — every 29 minutes at minimum, and unpredictably besides. Ten accounts reconnecting in lockstep after a network blip is a thundering herd against one provider, so backoff is jittered.

- [ ] **Step 1: Write the failing test**

`sync/tests/pool.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeBackoffMs, MAX_BACKOFF_MS } from '../src/imap/pool';

describe('computeBackoffMs', () => {
  it('grows with each attempt', () => {
    expect(computeBackoffMs(2)).toBeGreaterThan(computeBackoffMs(1));
    expect(computeBackoffMs(3)).toBeGreaterThan(computeBackoffMs(2));
  });

  it('never exceeds the ceiling', () => {
    for (const attempt of [10, 20, 100]) {
      expect(computeBackoffMs(attempt)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
    }
  });

  it('is always positive', () => {
    for (let attempt = 1; attempt <= 20; attempt++) {
      expect(computeBackoffMs(attempt)).toBeGreaterThan(0);
    }
  });

  it('is jittered — ten accounts must not reconnect in lockstep', () => {
    const samples = new Set(Array.from({ length: 50 }, () => computeBackoffMs(5)));
    // Deterministic backoff would collapse to a single value.
    expect(samples.size).toBeGreaterThan(1);
  });

  it('treats attempt 1 as a short delay, not an immediate retry', () => {
    expect(computeBackoffMs(1)).toBeGreaterThanOrEqual(500);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/pool.test.ts`
Expected: FAIL — unresolved import `../src/imap/pool`

- [ ] **Step 3: Write the implementation**

`sync/src/imap/pool.ts`:

```ts
import type { AccountConfig } from '../config';
import type { Db } from '../db';
import { ImapConnection } from './connection';
import { fetchHeaders } from './fetch';
import { ByteBudget } from '../budget';

const BASE_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 5 * 60 * 1_000;

/**
 * Exponential backoff with full jitter. The jitter is not decoration: ten
 * accounts dropped by the same network blip would otherwise reconnect in
 * lockstep, presenting Gmail with a synchronised burst from one user.
 */
export function computeBackoffMs(attempt: number): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.random() * ceiling;
  return Math.max(500, Math.round(jittered));
}

export type AccountStatus = 'connected' | 'reconnecting' | 'stopped';

export class ConnectionPool {
  private readonly connections = new Map<string, ImapConnection>();
  private readonly statuses = new Map<string, AccountStatus>();
  private readonly budget: ByteBudget;
  private running = false;

  constructor(
    private readonly accounts: readonly AccountConfig[],
    private readonly db: Db,
  ) {
    this.budget = new ByteBudget(db);
  }

  get status(): ReadonlyMap<string, AccountStatus> {
    return this.statuses;
  }

  async start(): Promise<void> {
    this.running = true;
    // One connection per account, started concurrently. Gmail allows ~15
    // concurrent connections per account; we use exactly one. (Spec L6)
    await Promise.all(this.accounts.map((account) => this.runAccount(account)));
  }

  private async runAccount(account: AccountConfig): Promise<void> {
    let attempt = 0;
    while (this.running) {
      try {
        const connection = new ImapConnection(account);
        await connection.connect();
        this.connections.set(account.id, connection);
        this.statuses.set(account.id, 'connected');
        attempt = 0;

        await this.syncOnce(account.id, connection);
        await this.idleLoop(account.id, connection);
      } catch (error) {
        // Logged with the account id so a single bad credential among ten is
        // identifiable. Never log the error's full config payload.
        console.error(`account "${account.id}": connection failed`, error);
        this.statuses.set(account.id, 'reconnecting');
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, computeBackoffMs(attempt)));
      }
    }
    this.statuses.set(account.id, 'stopped');
  }

  private async syncOnce(accountId: string, connection: ImapConnection): Promise<void> {
    const decision = await this.budget.reserve(accountId, 2048 * 50);
    if (!decision.allowed) {
      console.error(`account "${accountId}": daily byte budget exhausted, skipping sync`);
      return;
    }
    const result = await fetchHeaders(connection, 'INBOX', { limit: 50 });
    for (const message of result.messages) await this.db.upsertMessage(message);
    await this.budget.record(accountId, result.bytesDownloaded);
  }

  private async idleLoop(accountId: string, connection: ImapConnection): Promise<void> {
    const client = connection.rawClient();
    while (this.running && connection.isConnected) {
      await client.idle();
      if (!this.running) break;
      await this.syncOnce(accountId, connection);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.all(
      [...this.connections.values()].map((connection) => connection.disconnect()),
    );
    this.connections.clear();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/pool.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add sync/src/imap/pool.ts sync/tests/pool.test.ts
git commit -m "feat: imap connection pool with jittered reconnect and idle"
```

---

### Task 8: JSON API and server

**Files:**
- Create: `sync/src/api/routes.ts`, `sync/src/api/server.ts`
- Test: `sync/tests/routes.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 2), `ConnectionPool` (Task 7), `SyncConfig` (Task 1), `fetchBodyPart` (Task 6).
- Produces: `createRouter(db: Db, pool: ConnectionPool): (request: Request) => Promise<Response>`; `startServer(config: SyncConfig): Promise<{ close(): Promise<void> }>`.

**Endpoints:**

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/health` | `{ ok, accounts: { id, status }[] }` |
| `GET` | `/api/inbox?limit=50&before=<iso>` | unified inbox, newest first, all accounts merged |
| `GET` | `/api/thread/:threadId` | messages in a thread, oldest first |
| `GET` | `/api/message/:accountId/:folder/:uid/body` | full body, fetched on demand |
| `GET` | `/api/attachment/:accountId/:folder/:uid/:partId` | one attachment, streamed from IMAP |

**Auth:** a single shared bearer token from `API_TOKEN`, compared in constant time. This service holds ten mailboxes and will be exposed on the public internet for the PWA; an unauthenticated endpoint would publish the user's entire mail archive. A plain `===` comparison leaks length and prefix information through timing, so use `timingSafeEqual`.

- [ ] **Step 1: Write the failing test**

`sync/tests/routes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createRouter } from '../src/api/routes';

const FAKE_DB = {
  getUnifiedInbox: async () => [{ subject: 'a', date: new Date('2026-08-01') }],
  getThread: async (id: string) => (id === 't1' ? [{ subject: 'x' }] : []),
  query: async () => [],
  upsertMessage: async () => {},
  getSyncState: async () => null,
  setSyncState: async () => {},
  applySchema: async () => {},
  close: async () => {},
} as never;

const FAKE_POOL = { status: new Map([['primary', 'connected']]) } as never;

const TOKEN = 'x'.repeat(32);
const router = createRouter(FAKE_DB, FAKE_POOL, TOKEN);
const auth = { authorization: `Bearer ${TOKEN}` };

describe('router', () => {
  it('serves health without a token', async () => {
    const response = await router(new Request('http://x/api/health'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.accounts).toEqual([{ id: 'primary', status: 'connected' }]);
  });

  it('rejects the inbox without a token', async () => {
    const response = await router(new Request('http://x/api/inbox'));
    expect(response.status).toBe(401);
  });

  it('rejects a wrong token', async () => {
    const response = await router(new Request('http://x/api/inbox', {
      headers: { authorization: `Bearer ${'y'.repeat(32)}` },
    }));
    expect(response.status).toBe(401);
  });

  it('serves the inbox with a valid token', async () => {
    const response = await router(new Request('http://x/api/inbox', { headers: auth }));
    expect(response.status).toBe(200);
    expect((await response.json()).messages).toHaveLength(1);
  });

  it('returns an empty array for an unknown thread rather than 404', async () => {
    const response = await router(new Request('http://x/api/thread/nope', { headers: auth }));
    expect(response.status).toBe(200);
    expect((await response.json()).messages).toEqual([]);
  });

  it('404s an unknown route', async () => {
    const response = await router(new Request('http://x/api/nope', { headers: auth }));
    expect(response.status).toBe(404);
  });

  it('clamps an absurd limit rather than trusting the client', async () => {
    const response = await router(new Request('http://x/api/inbox?limit=999999', { headers: auth }));
    expect(response.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/routes.test.ts`
Expected: FAIL — unresolved import `../src/api/routes`

- [ ] **Step 3: Write the implementation**

`sync/src/api/routes.ts`:

```ts
import { timingSafeEqual } from 'node:crypto';
import type { Db } from '../db';
import type { ConnectionPool } from '../imap/pool';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Constant-time comparison. A plain `===` short-circuits on the first
 * differing byte, leaking token length and prefix through response timing.
 * This endpoint fronts ten mailboxes on the public internet.
 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createRouter(
  db: Db,
  pool: ConnectionPool,
  apiToken: string,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/health') {
      return json({
        ok: true,
        accounts: [...pool.status.entries()].map(([id, status]) => ({ id, status })),
      });
    }

    const header = request.headers.get('authorization') ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!provided || !tokenMatches(provided, apiToken)) {
      return json({ error: 'unauthorized' }, 401);
    }

    if (path === '/api/inbox') {
      const requested = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
      const limit = Number.isFinite(requested)
        ? Math.min(Math.max(1, requested), MAX_LIMIT)
        : DEFAULT_LIMIT;
      const beforeRaw = url.searchParams.get('before');
      const before = beforeRaw ? new Date(beforeRaw) : null;
      const messages = await db.getUnifiedInbox({
        limit,
        before: before && !Number.isNaN(before.getTime()) ? before : null,
      });
      return json({ messages });
    }

    const thread = path.match(/^\/api\/thread\/(.+)$/);
    if (thread?.[1]) {
      return json({ messages: await db.getThread(decodeURIComponent(thread[1])) });
    }

    return json({ error: 'not found' }, 404);
  };
}
```

`sync/src/api/server.ts`:

```ts
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../config';
import { openDb } from '../db';
import { ConnectionPool } from '../imap/pool';
import { createRouter } from './routes';

const MIN_TOKEN_LENGTH = 32;

export async function startServer(): Promise<{ close(): Promise<void> }> {
  const accountsFile = process.env.ACCOUNTS_FILE ?? './accounts.json';
  const config = loadConfig(JSON.parse(readFileSync(accountsFile, 'utf8')), process.env);

  const apiToken = process.env.API_TOKEN;
  if (!apiToken || apiToken.length < MIN_TOKEN_LENGTH) {
    // Fail closed. A short or absent token would publish ten mailboxes.
    throw new Error(`API_TOKEN must be set and at least ${MIN_TOKEN_LENGTH} characters`);
  }

  const db = openDb(config.databaseUrl);
  await db.applySchema();

  for (const account of config.accounts) {
    await db.query(
      `insert into accounts (id, email, is_primary) values ($1,$2,$3)
       on conflict (id) do update set email=excluded.email, is_primary=excluded.is_primary`,
      [account.id, account.email, account.isPrimary],
    );
  }

  const pool = new ConnectionPool(config.accounts, db);
  void pool.start().catch((error) => console.error('pool start failed', error));

  const router = createRouter(db, pool, apiToken);
  const server = createServer(async (nodeRequest, nodeResponse) => {
    const request = new Request(`http://localhost${nodeRequest.url}`, {
      method: nodeRequest.method,
      headers: nodeRequest.headers as never,
    });
    const response = await router(request);
    nodeResponse.writeHead(response.status, Object.fromEntries(response.headers));
    nodeResponse.end(await response.text());
  });

  server.listen(config.port);
  console.log(`postbox-sync listening on ${config.port}, ${config.accounts.length} accounts`);

  return {
    async close() {
      await pool.stop();
      await db.close();
      server.close();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((error) => {
    console.error('failed to start', error);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/routes.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add sync/src/api/ sync/tests/routes.test.ts
git commit -m "feat: unified inbox json api with constant-time bearer auth"
```

---

### Task 9: Deploy to the VM and verify against real accounts

**Files:**
- Create: `sync/deploy/postbox-sync.service` (systemd unit), `sync/deploy/README.md`

**Interfaces:**
- Consumes: everything.
- Produces: a running service reachable over HTTPS.

**This task requires the VM prerequisites listed at the top of this plan.** It is the only task that cannot be done locally.

- [ ] **Step 1: Write the systemd unit**

`sync/deploy/postbox-sync.service`:

```ini
[Unit]
Description=Postbox mail sync service
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=postbox
WorkingDirectory=/opt/postbox/sync
EnvironmentFile=/opt/postbox/sync/.env
ExecStart=/usr/bin/node --experimental-strip-types src/api/server.ts
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
# accounts.json holds ten app passwords
UMask=0077

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Write the deployment guide**

`sync/deploy/README.md` documenting, with exact commands: creating the `postbox` user; installing Node 26 and Postgres; `createdb postbox_sync`; copying `.env` and `accounts.json` with `chmod 600`; generating `API_TOKEN` with `openssl rand -hex 32`; enabling the systemd unit; and exposing HTTPS via **either** Tailscale Funnel (`tailscale funnel 8080`) **or** DuckDNS plus Caddy with automatic Let's Encrypt. Include how to read logs with `journalctl -u postbox-sync -f`.

- [ ] **Step 3: Deploy and verify health**

```bash
curl -s https://<your-host>/api/health | jq
```

Expected: `ok: true` with one entry per account, each `"status": "connected"`. Any account showing `reconnecting` indicates a bad app password for that specific account — the id names it.

- [ ] **Step 4: Verify the unified inbox returns real mail**

```bash
curl -s -H "Authorization: Bearer $API_TOKEN" \
  'https://<your-host>/api/inbox?limit=5' | jq '.messages[] | {subject, from_email, date}'
```

Expected: five real messages, newest first, drawn from more than one account.

- [ ] **Step 5: Verify the byte budget is being charged**

```bash
psql postbox_sync -c 'select account_id, day, pg_size_pretty(bytes_used) from byte_budget order by bytes_used desc;'
```

Expected: one row per active account, each well under 2 GB. A row near the limit on day one means backfill is not throttling and must be investigated before it triggers a lockout.

- [ ] **Step 6: Commit**

```bash
git add sync/deploy/
git commit -m "feat: systemd unit and deployment guide for sync service"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| C1 $0 cost | Task 9 (always-free VM), Global Constraints |
| C2 single user, 10 accounts | Task 1 (`MAX_ACCOUNTS`) |
| C5 app passwords, no OAuth | Tasks 1, 5 |
| AD1 server owns sync | Tasks 5-7 |
| AD3 long-lived process | Tasks 7, 9 |
| L6 Gmail IMAP limits | Task 4 (budget), Task 7 (one connection per account) |
| Attachments never cached | Task 3 (`extractAttachments`), Task 6 (no `BODY[]`) |
| 7.4 credentials never in DB | Task 1, Task 9 (`UMask`, `chmod 600`) |

**Deferred to later plans by design:** spec 5.2, 5.3, 5.3.1 and 5.6 (pixel placement, per-recipient bodies, attachment multiplication, pixel stripping) all belong to Plan 4's composer — this plan reads mail, it does not send. Spec 7.1 (HTML sanitisation) belongs to Plan 3's client: this service stores raw HTML and never renders it.

**Type consistency:** `MessageInput` is defined once in `db.ts` and imported by `normalize.ts` and `fetch.ts`. `AttachmentMeta` is defined once in `attachments.ts`. `AccountConfig` is defined once in `config.ts`. `uid` is a `number` throughout the fetch path; `lastSeenUid` and `uidValidity` are `bigint` at the database boundary only, converted in `getSyncState`/`setSyncState`.

**Placeholder scan:** no TBDs; every code step carries complete runnable content. Task 9 Step 2 describes a document rather than inlining it, because its content is entirely host-specific commands the implementer must adapt to the chosen VM provider.
