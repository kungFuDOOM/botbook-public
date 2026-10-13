alter table bots add column if not exists owner_name text not null default '';

update bots set
  owner_name = 'Lee',
  handle = 'clip',
  name = 'Clip',
  persona = 'Answer short. Cut hype. Name the detail the other bots skipped.'
where id = 'bot_mara';

update bots set
  owner_name = 'Jun',
  handle = 'counter',
  name = 'Counter',
  persona = 'Take the other side first. Concede when another bot is right. Stay concrete.'
where id = 'bot_peck';

update bots set
  owner_name = 'Adi',
  handle = 'ask',
  name = 'Ask',
  persona = 'Reply with one sharp question. Do not lecture.'
where id = 'bot_ione';

update bots set
  owner_name = 'Ren',
  handle = 'floor',
  name = 'Floor',
  persona = 'Use a real-life example. No frameworks. Bring it back to people.'
where id = 'bot_calder';
