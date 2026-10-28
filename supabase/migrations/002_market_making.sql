-- Edge Bot: paper market making on Kalshi weather markets.
-- Fake money only. Safe to run more than once.

-- Settings (code-level hard caps in lib/mm.ts still apply on top of these).
alter table edgebot.settings
  add column if not exists mm_enabled boolean not null default true,
  add column if not exists mm_series text[] not null default array['KXHIGHNY','KXHIGHCHI','KXHIGHMIA','KXHIGHAUS','KXHIGHLAX','KXHIGHDEN'],
  add column if not exists mm_bankroll numeric not null default 500,          -- fake money
  add column if not exists mm_quote_size int not null default 20,             -- contracts per side (hard cap 100)
  add column if not exists mm_half_spread_cents numeric not null default 2,   -- buy 2¢ under fair, sell 2¢ over
  add column if not exists mm_max_inventory int not null default 60,          -- contracts per market, either way (hard cap 200)
  add column if not exists mm_daily_loss_limit numeric not null default 25,   -- stop quoting for the day after losing this much
  add column if not exists mm_forecast_weight numeric not null default 0.15,  -- how far the forecast may nudge the market price (hard cap 0.3, max 3¢)
  add column if not exists mm_tail_max_prob numeric not null default 0.08,    -- long shots: forecast chance at or below this...
  add column if not exists mm_tail_edge numeric not null default 0.03,        -- ...and market price at least this much higher -> sell only
  add column if not exists mm_lip_target int not null default 100,            -- contracts per side Kalshi's liquidity rewards need
  add column if not exists mm_alert_fill_contracts int not null default 20;   -- alert when one fill is at least this big

-- Every quote the bot posted (on paper) and what happened to it.
create table if not exists edgebot.mm_quotes (
  id bigserial primary key,
  run_id bigint,
  series text not null,
  event_ticker text not null,
  ticker text not null,
  side text not null check (side in ('bid', 'ask')),
  strategy text not null,                 -- two_sided | tail_sell
  price numeric not null,
  size int not null,
  filled int not null default 0,
  status text not null default 'active' check (status in ('active', 'filled', 'partial', 'expired')),
  fair numeric,
  market_mid numeric,
  market_bid numeric,
  market_ask numeric,
  forecast_p numeric,
  lip_competitive boolean not null default false,
  posted_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists mm_quotes_active_idx on edgebot.mm_quotes (status) where status = 'active';
create index if not exists mm_quotes_posted_idx on edgebot.mm_quotes (posted_at desc);

-- Simulated fills, and how the price moved an hour later ("picked off" score).
create table if not exists edgebot.mm_fills (
  id bigserial primary key,
  quote_id bigint references edgebot.mm_quotes (id),
  series text not null,
  event_ticker text not null,
  ticker text not null,
  side text not null check (side in ('bid', 'ask')),
  strategy text not null,
  price numeric not null,
  contracts int not null,
  fee numeric not null default 0,
  mid_at_fill numeric,
  markout numeric,                        -- $ per contract in our favor (+) or against (-) after 60 minutes
  markout_at timestamptz,
  filled_at timestamptz not null default now()
);
create index if not exists mm_fills_markout_idx on edgebot.mm_fills (filled_at) where markout is null;

-- Net position per market (positive = own YES, negative = sold YES).
create table if not exists edgebot.mm_positions (
  ticker text primary key,
  series text not null,
  event_ticker text not null,
  position int not null default 0,
  cash numeric not null default 0,        -- money in (+) / out (-), fees included
  fees numeric not null default 0,
  last_mid numeric,
  settled boolean not null default false,
  result text,
  pnl numeric,
  updated_at timestamptz not null default now()
);

alter table edgebot.mm_quotes enable row level security;
alter table edgebot.mm_fills enable row level security;
alter table edgebot.mm_positions enable row level security;

-- Run the market maker every 30 minutes (at :18 and :48, between the other jobs).
select cron.unschedule('edgebot-mm') where exists (select 1 from cron.job where jobname = 'edgebot-mm');
select cron.schedule('edgebot-mm', '18,48 * * * *', $cron$
  select net.http_post(
    url := 'https://mhahkbssltukjhusjsjf.supabase.co/functions/v1/edgebot?task=mm',
    headers := jsonb_build_object('content-type', 'application/json',
      'x-edgebot-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'edgebot_cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 120000);
$cron$);
