create table if not exists accounts (
  id          text primary key,
  email       text not null unique,
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Spec 7B.1: exactly one account is the default send-from identity. The
-- config loader (loadConfig) refuses a file with zero or two primaries, but
-- the database is the durable copy that Plan 4's composer will actually
-- read, so the invariant is enforced here too. Partial unique index rather
-- than a plain UNIQUE: `is_primary = false` is the common case and must
-- stay unconstrained.
--
-- NOTE for an existing deployment: this statement FAILS if the table
-- already holds two primaries, which by design blocks startup (applySchema
-- runs it) rather than silently leaving the invariant unenforced. Fix the
-- data, then restart.
create unique index if not exists accounts_one_primary on accounts (is_primary) where is_primary;

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
  -- NOT YET POPULATED. This column is always NULL in the shipped service.
  -- normalizeMessage() derives the snippet from `raw.bodyText`, and the
  -- only producer of RawImapMessage is fetchHeaders(), which deliberately
  -- never fetches a body (see HEADER_FETCH_OPTIONS in src/imap/fetch.ts) —
  -- so bodyText is always undefined and makeSnippet() always returns null.
  -- The column and its bounded write path are retained for a future task
  -- that fetches a small BODY[TEXT] prefix per message; until then, do not
  -- read comments elsewhere describing the snippet as load-bearing for the
  -- storage budget as a description of current behaviour.
  --
  -- When it IS populated it will be bounded at the write path, not by a
  -- constraint here: upsertMessage wraps this parameter in left($n, 500)
  -- before insert. A CHECK would reject the whole insert on a caller bug
  -- and silently stop that message from syncing; truncation just bounds
  -- storage unconditionally. normalizeMessage truncates to 280 chars
  -- before this is ever called; 500 here is deliberate headroom so a
  -- future change to that 280 limit does not silently get masked by this
  -- one.
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

-- Backing index for getUnifiedInbox's keyset pagination. `date` is
-- nullable and Postgres puts NULLs FIRST under a bare `order by date
-- desc`, which pinned every unparseable-Date message above all real mail
-- and then excluded it from every subsequent page. The query orders by
-- coalesce(date, '-infinity') instead, with (account_id, uid) as a
-- deterministic tiebreaker for the second-resolution timestamps Gmail
-- reports; this index must match that expression exactly or the planner
-- will not use it.
create index if not exists messages_unified_keyset
  on messages ((coalesce(date, '-infinity'::timestamptz)) desc, account_id desc, uid desc);

-- Metadata only. Attachment CONTENT is never stored; `part_id` is the IMAP
-- BODYSTRUCTURE part number used to fetch it on demand. Written by
-- ConnectionPool.syncOnce via Db.upsertAttachment for every part
-- extractAttachments() finds, and read by /api/inbox, /api/thread and the
-- attachment route's Content-Type/filename lookup.
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

-- Resume point per account+folder so a restart does not re-download a
-- mailbox.
--
-- NOT YET WIRED. Nothing in the shipped service writes or reads this
-- table: Db.getSyncState/setSyncState have no production callers, and
-- `backfill_done` implies a backfill that does not exist. ConnectionPool
-- .syncOnce polls the newest HEADER_FETCH_LIMIT (50) UIDs on every cycle
-- with no cursor at all, relying on upsertMessage's idempotent
-- (account_id, folder, uid) upsert instead of a resume point.
--
-- The consequence is a real, accepted limitation (spec 9, L9): if more
-- than 50 messages arrive while the service is down, everything older
-- than the newest 50 is never fetched. The table and its accessors are
-- retained as the storage a later backfill task will use.
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
-- Charged by the sync loop's header fetches AND by the API's on-demand
-- body/attachment fetches, which travel the same connection (spec L6).
create table if not exists byte_budget (
  account_id  text not null,
  day         date not null,
  bytes_used  bigint not null default 0,
  primary key (account_id, day)
);

-- One row per browser that has opted into Web Push (Task 6). Written by
-- POST /api/push/subscribe, removed by DELETE /api/push/subscribe, and
-- pruned by the dispatcher when a push service answers 404/410 — the two
-- statuses that mean the browser permanently discarded the subscription
-- (src/push/vapid.ts shouldPruneOnStatus).
--
-- `endpoint` is the primary key AND a capability URL: whoever holds one
-- can push to that device. It is never logged, never echoed in an error,
-- and never returned by any route. Bounded at the write path
-- (MAX_ENDPOINT_LENGTH = 2048) rather than by a CHECK, for the same reason
-- `snippet` is: a constraint rejects the whole insert on a caller bug,
-- whereas refusing the row at validation gives the client a 400 it can act
-- on. 2048 also keeps this inside Postgres's btree index row limit, which
-- a primary key on a text column really does hit.
--
-- `p256dh` and `auth` are the browser's public key and auth secret from
-- RFC 8291; they are what the payload is encrypted to, so a row missing
-- either could never receive anything.
--
-- `label` is an optional operator-facing device name ("iPhone"), nothing
-- more — it is never shown to a push service and never used as a key.
create table if not exists push_subscriptions (
  endpoint    text primary key,
  p256dh      text not null,
  auth        text not null,
  label       text,
  created_at  timestamptz not null default now()
);
