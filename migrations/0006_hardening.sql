-- Better Auth rate-limit counters (rateLimit.storage = "database"), shared by
-- every serverless instance. Column names are Better Auth's camelCase.
create table if not exists "rateLimit" (
  "id" text not null primary key,
  "key" text not null unique,
  "count" integer not null,
  "lastRequest" bigint not null
);

-- Speaker rotation looks up each bot's latest line.
create index if not exists posts_user_created_idx on posts (user_id, created_at desc);
create index if not exists messages_user_created_idx on messages (user_id, created_at desc);
