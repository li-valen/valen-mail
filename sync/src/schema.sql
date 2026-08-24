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
  -- Bounded at the write path, not by a constraint here: upsertMessage
  -- wraps this parameter in left($n, 500) before insert. A CHECK would
  -- reject the whole insert on a caller bug and silently stop that
  -- message from syncing; truncation just bounds storage unconditionally.
  -- Task 3's normalizeMessage truncates to 280 chars before this is ever
  -- called; 500 here is deliberate headroom so a future change to that
  -- 280 limit does not silently get masked by this one.
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
