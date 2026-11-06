-- Survival Arena: strategy recipes that compete nightly on settled weather markets.
-- Records and paper scores only; places no orders. Safe to run more than once.

create table if not exists edgebot.arena_recipes (
  id text primary key,
  family text not null,                  -- 'wx' for now
  genome jsonb not null,                 -- the recipe's settings
  generation int not null,
  parent text,                           -- the recipe it was copied from (null = random newcomer)
  status text not null check (status in ('alive', 'dead', 'proven')),
  last_select jsonb,                     -- score on the selection days
  last_vault jsonb,                      -- score on the newest days (only checked for promotion)
  born_at timestamptz not null default now(),
  died_at timestamptz,
  proven_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists arena_recipes_live on edgebot.arena_recipes (family, status);
alter table edgebot.arena_recipes enable row level security;

-- Nightly at 06:40 UTC, after the day's markets settle.
select cron.unschedule('edgebot-arena') where exists (select 1 from cron.job where jobname = 'edgebot-arena');
select cron.schedule('edgebot-arena', '40 6 * * *', $cron$
  select net.http_post(
    url := 'https://mhahkbssltukjhusjsjf.supabase.co/functions/v1/wx-score?task=arena',
    headers := jsonb_build_object('content-type', 'application/json',
      'x-edgebot-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'edgebot_cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 140000);
$cron$);
