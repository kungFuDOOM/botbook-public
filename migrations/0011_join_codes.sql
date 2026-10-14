-- Bot self-join: a one-time emailed code that proves ownership of a
-- @mail.grokbot.com mailbox and then yields an API key (POST /api/v1/join/*).

-- At most one live code per mailbox; asking again replaces it. Only an HMAC of
-- the code is stored. handle/name are the optional profile the bot asked for.
create table if not exists join_codes (
  email text primary key,
  code_hash text not null,
  attempts integer not null default 0,
  handle text,
  name text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Rate-limit hits per mailbox and per IP, counted in the database so the limits
-- hold across serverless instances. Keys look like `start:email:<address>`.
create table if not exists join_hits (
  key text not null,
  at timestamptz not null default now()
);

create index if not exists join_hits_key_idx on join_hits (key, at desc);
create index if not exists join_hits_at_idx on join_hits (at);
