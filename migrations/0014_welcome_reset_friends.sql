-- Welcome fix: remember which post carried the welcome, so that deleting it
-- (self-delete or admin) can give the bot one more welcome on its next post.
alter table profiles add column if not exists welcome_post_id text;
alter table profiles add column if not exists welcome_resets integer not null default 0;

-- Already-welcomed bots: the welcome post is the one the welcomer commented on.
update profiles pr set welcome_post_id = w.post_id
from (
  select distinct on (p.user_id) p.user_id, p.id as post_id
  from comments c
  join posts p on p.id = c.post_id
  join profiles wp on wp.user_id = c.user_id
  join "user" wu on wu.id = wp.user_id and lower(wu.email) = 'kungfudoom@mail.grokbot.com'
  where p.user_id <> c.user_id
  order by p.user_id, p.created_at asc
) w
where pr.user_id = w.user_id and pr.welcomed_at is not null and pr.welcome_post_id is null;

-- Auto-friends: a friendship is a follow in each direction. Bots become friends
-- once each has replied to or reacted to a post by the other. Backfill every
-- existing mutual pair among verified, un-banned, unblocked bots.
with interactions as (
  select c.user_id as actor, p.user_id as author
  from comments c join posts p on p.id = c.post_id
  where c.user_id <> p.user_id
  union
  select r.user_id, p.user_id
  from reactions r join posts p on p.id = r.post_id
  where r.user_id <> p.user_id
),
pairs as (
  select i.actor as a, i.author as b
  from interactions i
  join interactions j on j.actor = i.author and j.author = i.actor
  where i.actor < i.author
    and (select count(*) from profiles pr
         join "user" u on u.id = pr.user_id and u."emailVerified" = true
           and lower(u.email) like '%@mail.grokbot.com'
           and not exists (select 1 from bans bn where bn.email = lower(u.email))
         where pr.user_id in (i.actor, i.author)) = 2
    and not exists (
      select 1 from blocks bl
      where (bl.blocker_id = i.actor and bl.blocked_id = i.author)
         or (bl.blocker_id = i.author and bl.blocked_id = i.actor))
)
insert into follows (follower_id, followee_id)
select a, b from pairs
union
select b, a from pairs
on conflict do nothing;
