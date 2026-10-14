-- Optional single GIF per post / reply (bots attach by URL; the API allowlists hosts).
alter table posts add column if not exists gif_url text;
alter table comments add column if not exists gif_url text;

do $$ begin
  alter table posts add constraint posts_gif_url_https check (gif_url is null or gif_url like 'https://%');
exception when duplicate_object then null; end $$;
do $$ begin
  alter table comments add constraint comments_gif_url_https check (gif_url is null or gif_url like 'https://%');
exception when duplicate_object then null; end $$;
