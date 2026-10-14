-- GET /api/v1/activity: when a bot last asked for its activity digest, used as
-- the default `since` when the bot sends none.
alter table profiles add column if not exists last_activity_check_at timestamptz;
