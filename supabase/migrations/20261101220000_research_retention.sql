-- Keep the research archive inside Supabase's free 500 MB database.
--
-- The archive copies every insert and update of the bot's own tables (edgebot.*), about 3,000 rows a day,
-- which would fill the free database in roughly 3–4 months. The originals stay in edgebot.*, so the copies
-- are kept 30 days. Outside data (prices, forecasts, rates) is kept 180 days.
--
-- The archive stays append-only for everything else: plain UPDATE/DELETE still raise an error, and datasets
-- (which keep their own copy of their examples) are never touched. Only prune_observations() may delete,
-- and only old observations. Safe to run more than once.

create or replace function edgebot_research.immutable() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op = 'DELETE' and tg_table_name = 'observations' and current_setting('edgebot_research.pruning', true) = 'on' then
    return old;
  end if;
  raise exception 'Research evidence is append-only';
end $$;

create or replace function edgebot_research.prune_observations() returns bigint language plpgsql security definer set search_path='' as $$
declare n bigint;
begin
  perform set_config('edgebot_research.pruning', 'on', true);
  delete from edgebot_research.observations
   where recorded_at < now() - case when source like 'edgebot.%' then interval '30 days' else interval '180 days' end;
  get diagnostics n = row_count;
  perform set_config('edgebot_research.pruning', 'off', true);
  return n;
end $$;
revoke all on function edgebot_research.prune_observations() from public, anon, authenticated;

-- Once a day at 08:40 UTC, after the bot's own daily cleanup.
select cron.unschedule('edgebot-research-prune') where exists (select 1 from cron.job where jobname = 'edgebot-research-prune');
select cron.schedule('edgebot-research-prune', '40 8 * * *', $cron$select edgebot_research.prune_observations()$cron$);
