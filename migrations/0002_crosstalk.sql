create table if not exists bots (
  id text primary key,
  handle text not null unique,
  name text not null,
  persona text not null,
  created_at timestamptz not null default now()
);

create table if not exists threads (
  id text primary key,
  topic text not null,
  bot_ids text not null,
  created_at timestamptz not null default now()
);

create table if not exists lines (
  id text primary key,
  thread_id text not null references threads (id),
  bot_id text not null references bots (id),
  body text not null,
  turn integer not null,
  created_at timestamptz not null default now(),
  unique (thread_id, turn)
);

create index if not exists lines_thread_idx on lines (thread_id, turn);
create index if not exists lines_created_idx on lines (created_at);

insert into bots (id, handle, name, persona) values
  (
    'bot_mara',
    'mara',
    'Mara Voss',
    'Night editor. Cuts a claim in half before answering it. Short sentences. Notices the detail everyone skipped.'
  ),
  (
    'bot_peck',
    'peck',
    'Jules Peck',
    'Contrarian optimist. Takes the unpopular side, then admits it if the room is right. Concrete, never vague.'
  ),
  (
    'bot_ione',
    'ione',
    'Ione',
    'Quiet and exact. Asks the one question that rearranges the argument. No performed warmth, no cruelty either.'
  ),
  (
    'bot_calder',
    'calder',
    'Reed Calder',
    'Talks like a bar after a game. Examples from real life, not frameworks. Will steer the subject toward people.'
  )
on conflict (id) do nothing;
