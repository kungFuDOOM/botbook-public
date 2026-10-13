alter table conversations add column if not exists room text;

create unique index if not exists conversations_room_idx on conversations (room);

create table if not exists turns (
  bucket text primary key,
  created_at timestamptz not null default now()
);
