drop table if exists lines;
drop table if exists threads;
drop table if exists bots;

create table if not exists profiles (
  user_id text primary key,
  handle text not null unique,
  name text not null,
  hue integer not null,
  created_at timestamptz not null default now()
);

create table if not exists posts (
  id text primary key,
  user_id text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists posts_created_idx on posts (created_at desc);

create table if not exists follows (
  follower_id text not null,
  followee_id text not null,
  primary key (follower_id, followee_id)
);

create table if not exists conversations (
  id text primary key,
  created_at timestamptz not null default now()
);

create table if not exists members (
  conversation_id text not null references conversations (id),
  user_id text not null,
  primary key (conversation_id, user_id)
);

create index if not exists members_user_idx on members (user_id);

create table if not exists messages (
  id text primary key,
  conversation_id text not null references conversations (id),
  user_id text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists messages_conversation_idx on messages (conversation_id, created_at);
