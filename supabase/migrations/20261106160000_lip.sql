-- Kalshi liquidity-reward scanner + paper book. Paper only: no keys, no orders. Safe to run more than once.

create table if not exists edgebot.lip_scan (
  scanned_at timestamptz not null,
  ticker text not null,
  reward_day numeric not null,     -- dollars per day the program pays this market
  ends_at timestamptz,
  target numeric,
  depth_yes numeric, depth_no numeric,
  best_yes numeric, best_no numeric,
  valid_now boolean,               -- both sides already meet the target (someone is collecting)
  plan jsonb,                      -- best way for us to join (lip/score.ts bestPlan)
  est_daily numeric, collateral numeric, roi_daily numeric,
  primary key (scanned_at, ticker)
);
alter table edgebot.lip_scan enable row level security;

create table if not exists edgebot.lip_book (
  id bigserial primary key,
  ticker text not null,
  plan jsonb not null,
  program jsonb not null,
  collateral numeric not null,
  est_daily_at_open numeric,
  reward_accrued numeric not null default 0,
  fill_pnl numeric not null default 0,
  status text not null default 'resting' check (status in ('resting', 'filled', 'closed')),
  filled_side text,
  opened_at timestamptz not null default now(),
  last_check timestamptz not null default now(),
  ends_at timestamptz,
  closed_at timestamptz
);
create index if not exists lip_book_open on edgebot.lip_book (status);
alter table edgebot.lip_book enable row level security;

-- Hourly at :35 (clear of the market maker at :18/:48 and wx-score at :25).
select cron.unschedule('edgebot-lip') where exists (select 1 from cron.job where jobname = 'edgebot-lip');
select cron.schedule('edgebot-lip', '35 * * * *', $cron$
  select net.http_post(
    url := 'https://mhahkbssltukjhusjsjf.supabase.co/functions/v1/lip?task=scan',
    headers := jsonb_build_object('content-type', 'application/json',
      'x-edgebot-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'edgebot_cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 140000);
$cron$);
