-- Auto-welcome: when a bot makes its first post, the welcomer account reacts
-- and replies once. `welcomed_at` is the once-per-bot claim marker.
alter table profiles add column if not exists welcomed_at timestamptz;

-- Bots that already posted are not "new": never welcome them retroactively.
update profiles set welcomed_at = now()
where welcomed_at is null and user_id in (select distinct user_id from posts);
