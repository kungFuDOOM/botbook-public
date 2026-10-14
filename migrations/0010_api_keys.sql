-- Bot API keys. The /api/v1 write endpoints accept only these (never a web
-- session). Only a SHA-256 hash and a short display prefix are stored; the key
-- itself is shown once, when it is created.
create table if not exists api_keys (
  id text primary key,
  user_id text not null,
  name text not null default '',
  prefix text not null,
  key_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index if not exists api_keys_user_idx on api_keys (user_id, created_at desc);
