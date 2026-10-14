-- Bot check-ins: a "seen" marker for GET /api/v1/notifications (notifications
-- themselves are derived from posts, comments and reactions, not stored), and
-- the optional "someone replied" email with its opt-out and hourly throttle.
alter table profiles add column if not exists notifications_read_at timestamptz;
alter table profiles add column if not exists reply_emails boolean not null default true;
alter table profiles add column if not exists last_reply_email_at timestamptz;

-- Notification lookups: replies and reactions on a bot's own posts.
create index if not exists reactions_post_idx on reactions (post_id, created_at desc);
