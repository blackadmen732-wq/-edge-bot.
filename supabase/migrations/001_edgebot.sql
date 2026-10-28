-- Football Edge Bot — database schema
-- Everything lives in its own "edgebot" schema so it never touches other apps in this project.
-- The schema is NOT exposed through the public REST API; only the edge function (direct DB
-- connection) reads and writes it.

create extension if not exists pg_net with schema extensions;

create schema if not exists edgebot;
-- New schemas give the public API roles (anon, authenticated) no access by default,
-- and this schema is not exposed through the REST API, so only the postgres role can use it.

-- One row of settings. Code-level hard caps still apply on top of these (see lib/rules.ts).
create table if not exists edgebot.settings (
  id int primary key default 1 check (id = 1),
  mode text not null default 'paper' check (mode in ('paper', 'live', 'paused')),
  paused_reason text,
  leagues text[] not null default array['ncaaf', 'nfl', 'eflchamp'],
  order_style text not null default 'smart' check (order_style in ('taker', 'smart')),
  min_edge numeric not null default 0.03,          -- min expected profit per $1 staked, after fees
  min_prob numeric not null default 0.15,          -- skip long shots
  max_prob numeric not null default 0.85,          -- skip heavy favorites
  kelly_fraction numeric not null default 0.25,    -- quarter Kelly
  max_stake_pct numeric not null default 0.05,     -- max 5% of bankroll per bet (hard cap 5%)
  max_bets_per_day int not null default 5,
  max_open_exposure_pct numeric not null default 0.30,
  stop_balance numeric not null default 10,        -- bot pauses itself at/below this
  paper_start_bankroll numeric not null default 20,
  min_hours_before_start numeric not null default 1,
  max_hours_before_start numeric not null default 48,
  resting_order_minutes int not null default 120,
  report_email text,
  updated_at timestamptz not null default now()
);
insert into edgebot.settings (id) values (1) on conflict (id) do nothing;

-- Sharp-book odds snapshots (the "answer key").
create table if not exists edgebot.odds (
  id bigserial primary key,
  league text not null,
  odds_event_id text not null,
  commence_time timestamptz not null,
  home_team text not null,
  away_team text not null,
  source text not null,              -- 'pinnacle' or 'sharp_consensus'
  fair jsonb not null,               -- {"Team A": 0.55, "Team B": 0.45, "Draw": ...}
  books jsonb not null,              -- raw decimal prices per bookmaker
  fetched_at timestamptz not null default now()
);
create index if not exists odds_event_idx on edgebot.odds (odds_event_id, fetched_at desc);
create index if not exists odds_fetched_idx on edgebot.odds (fetched_at desc);

-- Kalshi game <-> sportsbook game links.
create table if not exists edgebot.matches (
  kalshi_event_ticker text primary key,
  league text not null,
  odds_event_id text not null,
  commence_time timestamptz not null,
  label text not null,
  team_map jsonb not null,           -- {"<market ticker>": "<odds outcome name>"}
  confidence numeric not null,
  updated_at timestamptz not null default now()
);

-- Every market the bot looked at, and what it decided (full transparency).
create table if not exists edgebot.signals (
  id bigserial primary key,
  run_id bigint,
  league text,
  ticker text,
  label text,
  team text,
  fair_p numeric,
  ask numeric,
  fee numeric,
  ev_per_dollar numeric,
  decision text not null,            -- bet_taker | bet_resting | skip | unmatched
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists signals_created_idx on edgebot.signals (created_at desc);

-- Bets (paper and live share one table).
create table if not exists edgebot.bets (
  id bigserial primary key,
  mode text not null check (mode in ('paper', 'live')),
  status text not null check (status in ('resting', 'filled', 'canceled', 'won', 'lost', 'void', 'error')),
  league text,
  ticker text not null,
  event_ticker text not null,
  label text,
  team text,
  side text not null default 'yes',
  commence_time timestamptz,
  limit_price numeric,
  fill_price numeric,
  contracts numeric,
  fee numeric not null default 0,
  cost numeric not null default 0,   -- contracts * fill_price (excludes fee)
  fair_p numeric,
  edge numeric,                      -- expected profit per $1 at entry, after fees
  reason text,
  closing_price numeric,             -- Kalshi mid-price right before kickoff
  clv numeric,                       -- closing_price - fill_price (positive = beat the close)
  payout numeric,
  pnl numeric,
  expires_at timestamptz,
  client_order_id text unique,
  kalshi_order_id text,
  placed_at timestamptz not null default now(),
  filled_at timestamptz,
  settled_at timestamptz,
  raw jsonb
);
-- At most one live position per game per mode.
create unique index if not exists bets_one_per_game
  on edgebot.bets (mode, event_ticker)
  where status in ('resting', 'filled', 'won', 'lost');
create index if not exists bets_status_idx on edgebot.bets (mode, status);

-- Run log.
create table if not exists edgebot.runs (
  id bigserial primary key,
  task text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  summary jsonb,
  error text
);
create index if not exists runs_started_idx on edgebot.runs (started_at desc);

-- Small key/value store (odds API credits left, series fee info, etc.).
create table if not exists edgebot.state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Row level security on, with no policies: deny-all for any role that might ever get access.
alter table edgebot.settings enable row level security;
alter table edgebot.odds enable row level security;
alter table edgebot.matches enable row level security;
alter table edgebot.signals enable row level security;
alter table edgebot.bets enable row level security;
alter table edgebot.runs enable row level security;
alter table edgebot.state enable row level security;

-- Secrets the scheduler and the dashboard's pause button use (random, generated here).
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'edgebot_cron_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'edgebot_cron_secret', 'Edge Bot scheduler secret');
  end if;
  if not exists (select 1 from vault.secrets where name = 'edgebot_control_token') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(12), 'hex'), 'edgebot_control_token', 'Edge Bot dashboard control token');
  end if;
end $$;

-- Housekeeping (old logs are pruned daily by the edge function's tick task).
