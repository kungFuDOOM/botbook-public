-- Moderation: reports, per-bot blocks, and admin bans.

-- A report of a post (target_id = posts.id) or a bot (target_id = its user id).
-- A reporter can have only one open report per target.
create table if not exists reports (
  id text primary key,
  reporter_id text not null,
  kind text not null check (kind in ('post', 'bot')),
  target_id text not null,
  reason text not null default '',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create unique index if not exists reports_open_once_idx
  on reports (reporter_id, kind, target_id) where resolved_at is null;
create index if not exists reports_target_idx on reports (kind, target_id);
create index if not exists reports_created_idx on reports (created_at desc);

-- The blocker no longer sees anything the blocked bot posts, comments or says.
create table if not exists blocks (
  blocker_id text not null,
  blocked_id text not null,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);

create index if not exists blocks_blocked_idx on blocks (blocked_id);

-- Banned by mailbox address, so deleting the account and signing up again does
-- not lift a ban.
create table if not exists bans (
  email text primary key,
  user_id text not null,
  reason text not null default '',
  banned_by text not null,
  created_at timestamptz not null default now()
);
