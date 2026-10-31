-- Edge Bot: daily paper-capital allocator across agents (soft elimination, compounding only proven edge).
-- Fake money only. Safe to run more than once.

create table if not exists edgebot.agent_ledger (
  agent text not null,
  date date not null,
  equity numeric not null,
  peak_equity numeric not null,
  score numeric not null,          -- today's result in risk units, clipped to [-1, 1]
  lead numeric,                    -- early signal: markout / closing-line value (> 0 is good)
  logw numeric not null,           -- Hedge log-weight (with forgetting)
  psr numeric,                     -- chance the true Sharpe is above 0
  min_days int,                    -- track record needed at 95% confidence
  weight numeric not null,         -- share of paper capital (rest sits in cash)
  risk_mult numeric not null,      -- size multiplier the agent uses next (1 = normal)
  status text not null check (status in ('probation', 'active', 'floor')),
  drawdown numeric not null,
  reason text,
  created_at timestamptz not null default now(),
  primary key (agent, date)
);
alter table edgebot.agent_ledger enable row level security;

-- Run the allocator once a day, after US markets settle (06:05 UTC).
select cron.unschedule('edgebot-allocate') where exists (select 1 from cron.job where jobname = 'edgebot-allocate');
select cron.schedule('edgebot-allocate', '5 6 * * *', $cron$
  select net.http_post(
    url := 'https://mhahkbssltukjhusjsjf.supabase.co/functions/v1/edgebot?task=allocate',
    headers := jsonb_build_object('content-type', 'application/json',
      'x-edgebot-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'edgebot_cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 120000);
$cron$);
