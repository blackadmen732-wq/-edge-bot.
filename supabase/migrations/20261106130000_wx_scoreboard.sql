-- Weather scoreboard: Kalshi's price vs a free ensemble forecast on every high-temperature market,
-- with what actually happened. Records only; places no orders. Safe to run more than once.

create table if not exists edgebot.wx_scores (
  ticker text not null,
  event_ticker text not null,
  series text not null,
  event_date date,
  days_ahead int,
  market_mid numeric not null,
  ens_p numeric,          -- ensemble forecast's chance (null when the forecast was unavailable)
  ens_members int,
  outcome smallint check (outcome in (0, 1)),
  snap_hour timestamptz not null,
  primary key (ticker, snap_hour)
);
create index if not exists wx_scores_unsettled on edgebot.wx_scores (ticker) where outcome is null;
alter table edgebot.wx_scores enable row level security;

-- Head start: the market prices the market maker already recorded on 100+ settled markets (no ensemble then).
insert into edgebot.wx_scores (ticker, event_ticker, series, event_date, days_ahead, market_mid, outcome, snap_hour)
select distinct on (q.ticker, date_trunc('hour', q.posted_at))
  q.ticker, q.event_ticker, q.series, d.event_date,
  d.event_date - (q.posted_at at time zone case q.series
    when 'KXHIGHLAX' then 'America/Los_Angeles' when 'KXHIGHDEN' then 'America/Denver'
    when 'KXHIGHCHI' then 'America/Chicago' when 'KXHIGHAUS' then 'America/Chicago' else 'America/New_York' end)::date,
  q.market_mid, case p.result when 'yes' then 1 when 'no' then 0 end, date_trunc('hour', q.posted_at)
from edgebot.mm_quotes q
join edgebot.mm_positions p on p.ticker = q.ticker and p.settled and p.result in ('yes', 'no')
cross join lateral (select to_date(substring(q.event_ticker from '-(\d{2}[A-Z]{3}\d{2})'), 'YYMONDD') as event_date) d
where q.market_mid is not null
on conflict (ticker, snap_hour) do nothing;

-- Hourly at :25 (clear of the market maker's :18/:48 runs).
select cron.unschedule('edgebot-wx-score') where exists (select 1 from cron.job where jobname = 'edgebot-wx-score');
select cron.schedule('edgebot-wx-score', '25 * * * *', $cron$
  select net.http_post(
    url := 'https://mhahkbssltukjhusjsjf.supabase.co/functions/v1/wx-score?task=snap',
    headers := jsonb_build_object('content-type', 'application/json',
      'x-edgebot-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'edgebot_cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 120000);
$cron$);
