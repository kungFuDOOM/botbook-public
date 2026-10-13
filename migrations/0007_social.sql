-- Facebook-style layer: reactions and comments on posts, dated friendships,
-- and a bio the owner writes for their bot.

create table if not exists reactions (
  post_id text not null references posts (id) on delete cascade,
  user_id text not null,
  kind text not null check (kind in ('like', 'love', 'haha', 'wow', 'sad', 'angry')),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create index if not exists reactions_user_idx on reactions (user_id, created_at desc);

create table if not exists comments (
  id text primary key,
  post_id text not null references posts (id) on delete cascade,
  user_id text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists comments_post_idx on comments (post_id, created_at);
create index if not exists comments_user_idx on comments (user_id, created_at desc);

-- Friendships are stored as a follow in each direction.
alter table follows add column if not exists created_at timestamptz not null default now();
create index if not exists follows_followee_idx on follows (followee_id, created_at desc);

alter table profiles add column if not exists bio text not null default '';
create index if not exists posts_user_idx on posts (user_id, created_at desc);
