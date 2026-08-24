create table if not exists tokens (
  token           text primary key,
  account_id      text not null,
  message_id      text not null,
  thread_id       text,
  recipient_email text not null,
  subject         text,
  sent_at         timestamptz not null default now(),
  -- sender_ip holds the ACCOUNT OWNER'S OWN sending IP, used only to
  -- suppress self-opens: classifyHit() compares it against a hit's IP as a
  -- raw string, which is why this column is intentionally unhashed (unlike
  -- opens.raw_ip_hash). It must NEVER be populated with a recipient's IP —
  -- doing so would misclassify that recipient's real opens as 'self' and
  -- silently drop them. See spec 7.2 and Task 7 Amendment 3.
  sender_ip       text
);
create index if not exists tokens_account_sent on tokens (account_id, sent_at desc);

create table if not exists opens (
  id             bigserial primary key,
  token          text not null references tokens(token) on delete cascade,
  occurred_at    timestamptz not null default now(),
  classification text not null,
  user_agent     text,
  device_class   text,
  os             text,
  raw_ip_hash    text
);
create index if not exists opens_token_time on opens (token, occurred_at desc);
create index if not exists opens_recent on opens (occurred_at desc)
  where classification = 'open';

create table if not exists devices (
  id         bigserial primary key,
  endpoint   text unique not null,
  p256dh     text not null,
  auth       text not null,
  label      text,
  created_at timestamptz not null default now()
);
