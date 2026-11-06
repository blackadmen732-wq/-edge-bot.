-- Stocks: opening-range breakout day trades through Alpaca. Starts in PAPER mode.
-- Real money needs: control go_live, secret STOCKS_LIVE_ENABLED=true, live Alpaca keys, and a passing paper record.
-- Safe to run more than once.

create table if not exists edgebot.stock_settings (
  id int primary key default 1 check (id = 1),
  mode text not null default 'paper' check (mode in ('paper', 'live', 'paused')),
  paused_reason text,
  watchlist text[] not null default array['SPY','QQQ','AAPL','MSFT','NVDA','TSLA','AMD','META','AMZN','GOOGL'],
  max_loss_per_trade numeric not null default 25,   -- code caps at $50
  max_position_usd numeric not null default 1000,   -- code caps at $2,000
  max_trades_per_day int not null default 2,        -- code caps at 3
  daily_loss_limit numeric not null default 50,     -- code caps at $100
  target_r numeric not null default 1,              -- target = entry + target_r x risk (code caps at 2)
  updated_at timestamptz not null default now()
);
insert into edgebot.stock_settings (id) values (1) on conflict (id) do nothing;
alter table edgebot.stock_settings enable row level security;

create table if not exists edgebot.stock_trades (
  id bigserial primary key,
  mode text not null check (mode in ('paper', 'live')),
  trade_date date not null,
  symbol text not null,
  setup text not null,
  entry numeric not null,
  stop numeric not null,
  target numeric not null,
  qty int not null,
  alpaca_order_id text,
  client_order_id text not null unique,
  status text not null check (status in ('open', 'filled', 'closed', 'unfilled', 'error')),
  fill_price numeric,
  exit_price numeric,
  exit_reason text,
  pnl numeric,
  placed_at timestamptz not null default now(),
  filled_at timestamptz,
  closed_at timestamptz,
  raw jsonb
);
create index if not exists stock_trades_open on edgebot.stock_trades (mode, status);
alter table edgebot.stock_trades enable row level security;

-- Every 5 minutes at :01/:06/... (a minute after each 5-minute bar closes), 13:01-21:56 UTC, Monday-Friday. The function itself checks Alpaca's market clock
-- and New York time (so daylight saving and holidays are handled there, not here).
select cron.unschedule('edgebot-stocks') where exists (select 1 from cron.job where jobname = 'edgebot-stocks');
select cron.schedule('edgebot-stocks', '1-59/5 13-21 * * 1-5', $cron$
  select net.http_post(
    url := 'https://mhahkbssltukjhusjsjf.supabase.co/functions/v1/stocks?task=run',
    headers := jsonb_build_object('content-type', 'application/json',
      'x-edgebot-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'edgebot_cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 60000);
$cron$);
