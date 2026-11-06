-- Weather history backfill: every settled Kalshi high-temp market since late August, with the market's
-- price the day before (noon local), the GFS/ECMWF forecast made the day before, and the actual high.
-- Lets the scoreboard answer in days instead of weeks. Records only; places no orders. Safe to run twice.

alter table edgebot.wx_scores add column if not exists fc_src text;        -- 'ens' (live ensemble) | 'hist_det' (archived day-1 GFS+ECMWF)
alter table edgebot.wx_scores add column if not exists fc_mean numeric;    -- forecast high, °F
alter table edgebot.wx_scores add column if not exists actual_high numeric;
alter table edgebot.wx_scores add column if not exists bmin int;           -- bracket, whole °F (null = open end)
alter table edgebot.wx_scores add column if not exists bmax int;

create table if not exists edgebot.wx_hist (
  ticker text primary key,
  series text not null,
  event_ticker text not null,
  event_date date not null,
  bmin int,
  bmax int,
  outcome smallint not null check (outcome in (0, 1)),
  actual_high numeric,
  done boolean not null default false,
  note text
);
create index if not exists wx_hist_todo on edgebot.wx_hist (event_date) where not done;
alter table edgebot.wx_hist enable row level security;

create table if not exists edgebot.wx_hist_fc (
  series text not null,
  date date not null,
  gfs numeric,
  ecmwf numeric,
  primary key (series, date)
);
alter table edgebot.wx_hist_fc enable row level security;

-- Every 5 minutes until the backfill finishes; the function unschedules this job itself when done.
select cron.unschedule('edgebot-wx-backfill') where exists (select 1 from cron.job where jobname = 'edgebot-wx-backfill');
select cron.schedule('edgebot-wx-backfill', '*/5 * * * *', $cron$
  select net.http_post(
    url := 'https://mhahkbssltukjhusjsjf.supabase.co/functions/v1/wx-score?task=backfill',
    headers := jsonb_build_object('content-type', 'application/json',
      'x-edgebot-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'edgebot_cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 140000);
$cron$);
