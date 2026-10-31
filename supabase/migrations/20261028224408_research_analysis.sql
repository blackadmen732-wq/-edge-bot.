-- A private, append-only research archive and experiment queue. No execution settings change.
create schema if not exists edgebot_research;
revoke all on schema edgebot_research from public, anon, authenticated;

create table edgebot_research.sources (
 id text primary key, track text not null, name text not null,
 expected_seconds int not null default 21600 check (expected_seconds > 0),
 enabled boolean not null default true
);
insert into edgebot_research.sources (id,track,name,expected_seconds) values
 ('edgebot.odds','sports','Sports reference observations',21600),
 ('edgebot.signals','sports','Sports decisions',21600),
 ('edgebot.bets','sports','Recorded outcomes',21600),
 ('edgebot.mm_quotes','weather','Weather simulation quotes',1800),
 ('edgebot.mm_fills','weather','Weather simulation outcomes',1800),
 ('edgebot.mm_positions','weather','Weather simulation accounting',1800),
 ('equities.import','equities','Stocks and ETFs: authenticated import',86400),
 ('crypto.import','crypto','Crypto: authenticated import',86400),
 ('fx.import','fx','Currencies: authenticated import',86400),
 ('commodities.import','commodities','Commodities: authenticated import',86400);

create table edgebot_research.observations (
 id bigint generated always as identity primary key,
 source text not null references edgebot_research.sources(id), external_id text not null,
 payload jsonb not null, payload_hash text not null,
 event_at timestamptz not null, available_at timestamptz not null,
 recorded_at timestamptz not null default clock_timestamp(),
 unique(source,external_id,payload_hash)
);
create index on edgebot_research.observations(source,recorded_at desc);
create table edgebot_research.examples (
 id text primary key, source text not null references edgebot_research.sources(id),
 value jsonb not null, updated_at timestamptz not null default now()
);
create table edgebot_research.datasets (
 id uuid primary key default gen_random_uuid(), fingerprint text unique not null,
 name text not null, examples jsonb not null check (jsonb_typeof(examples) = 'array' and jsonb_array_length(examples) <= 5000),
 created_at timestamptz not null default now()
);
create table edgebot_research.hypotheses (
 id uuid primary key default gen_random_uuid(), question text not null,
 fingerprint text unique not null,
 evidence jsonb not null default '[]', status text not null default 'proposed',
 created_at timestamptz not null default now()
);
create table edgebot_research.jobs (
 id uuid primary key default gen_random_uuid(),
 kind text not null check (kind in ('diagnose','calibrate','agent')),
 dataset_id uuid not null references edgebot_research.datasets(id),
 idempotency_key text unique not null, request_hash text not null,
 status text not null default 'pending' check (status in ('pending','running','succeeded','failed')),
 attempts int not null default 0, lease_token uuid, lease_until timestamptz,
 result jsonb, error text, created_at timestamptz not null default now(), finished_at timestamptz
);
create index on edgebot_research.jobs(status,created_at);
create index on edgebot_research.jobs(dataset_id);
create table edgebot_research.models (
 id uuid primary key default gen_random_uuid(), job_id uuid unique not null references edgebot_research.jobs(id),
 parameters jsonb not null, state text not null default 'candidate' check(state in ('candidate','active','retired')),
 created_at timestamptz not null default now()
);
create unique index research_one_active_model on edgebot_research.models(state) where state='active';
create table edgebot_research.events (
 id bigint generated always as identity primary key,
 job_id uuid references edgebot_research.jobs(id), actor text not null,
 action text not null, details jsonb not null default '{}', created_at timestamptz not null default now()
);
create index on edgebot_research.events(job_id);
create table edgebot_research.usage (
 id bigint generated always as identity primary key,
 job_id uuid references edgebot_research.jobs(id), model text not null,
 input_tokens bigint, output_tokens bigint, actual_cost_usd numeric,
 status text not null default 'reserved', created_at timestamptz not null default now()
);
create index on edgebot_research.usage(job_id);
create index on edgebot_research.usage(created_at);
create table edgebot_research.configuration (key text primary key, value text not null);

-- Immutable evidence and datasets. Corrections become new observations/datasets.
create function edgebot_research.immutable() returns trigger language plpgsql security invoker set search_path='' as $$
begin raise exception 'Research evidence is append-only'; end $$;
create trigger observations_immutable before update or delete on edgebot_research.observations for each row execute function edgebot_research.immutable();
create trigger datasets_immutable before update or delete on edgebot_research.datasets for each row execute function edgebot_research.immutable();

create function edgebot_research.capture() returns trigger language plpgsql security invoker set search_path='' as $$
declare p jsonb := to_jsonb(new)-'raw'; src text := tg_table_schema||'.'||tg_table_name; ext text; ts timestamptz;
begin
 ext := coalesce(p->>'id',p->>'ticker');
 ts := coalesce((p->>'fetched_at')::timestamptz,(p->>'placed_at')::timestamptz,
  (p->>'posted_at')::timestamptz,(p->>'filled_at')::timestamptz,(p->>'updated_at')::timestamptz,clock_timestamp());
 insert into edgebot_research.observations(source,external_id,payload,payload_hash,event_at,available_at)
 values(src,ext,p,md5(p::text),ts,clock_timestamp()) on conflict do nothing;
 -- Only educational paper outcomes are normalized. Raw evidence is preserved separately.
 if tg_table_name='bets' and p->>'mode'='paper' and p->>'status' in ('won','lost')
  and p->>'fair_p' is not null and p->>'placed_at' is not null and p->>'settled_at' is not null then
  insert into edgebot_research.examples(id,source,value) values('paper:'||ext,src,jsonb_build_object(
   'id','paper:'||ext,'predictedAt',p->>'placed_at','availableAt',p->>'placed_at',
   'outcomeAt',p->>'settled_at','probability',(p->>'fair_p')::numeric,'outcome',p->>'status'='won',
   'result',(p->>'pnl')::numeric,'cost',(p->>'fee')::numeric,'group',coalesce(p->>'league','ungrouped'),
   'flags',jsonb_build_array('incomplete_provenance')))
  on conflict(id) do update set value=excluded.value,updated_at=now();
 end if;
 return new;
end $$;

do $$ declare t text; begin
 foreach t in array array['odds','signals','bets','mm_quotes','mm_fills','mm_positions'] loop
  if to_regclass('edgebot.'||t) is not null then
   execute format('create trigger research_archive after insert or update on edgebot.%I for each row execute function edgebot_research.capture()',t);
   execute format('insert into edgebot_research.observations(source,external_id,payload,payload_hash,event_at,available_at) select %L,coalesce(to_jsonb(r)->>''id'',to_jsonb(r)->>''ticker''),to_jsonb(r)-''raw'',md5((to_jsonb(r)-''raw'')::text),clock_timestamp(),clock_timestamp() from edgebot.%I r on conflict do nothing','edgebot.'||t,t);
  end if;
 end loop;
 foreach t in array array['sources','observations','examples','datasets','hypotheses','jobs','models','events','usage','configuration'] loop
  execute format('alter table edgebot_research.%I enable row level security',t);
  execute format('revoke all on edgebot_research.%I from public,anon,authenticated',t);
 end loop;
end $$;
revoke execute on all functions in schema edgebot_research from public,anon,authenticated;
revoke all on all sequences in schema edgebot_research from public,anon,authenticated;

-- Dedicated research credential, separate from execution-control credentials.
do $$ begin
 if not exists(select 1 from vault.secrets where name='edgebot_research_token') then
  perform vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'edgebot_research_token','Research API and MCP only');
 end if;
 if not exists(select 1 from vault.secrets where name='edgebot_research_owner_token') then
  perform vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'edgebot_research_owner_token','Research owner dashboard only');
 end if;
end $$;

-- Dispatcher only enqueues HTTP work; API completion is separately recorded in jobs.
select cron.schedule('edgebot-research-worker','*/5 * * * *',$cron$
 select net.http_post(
  url := (select value from edgebot_research.configuration where key='worker_url'),
  headers := jsonb_build_object('content-type','application/json','Authorization','Bearer '||
    (select decrypted_secret from vault.decrypted_secrets where name='edgebot_research_token')),
  body := '{}'::jsonb, timeout_milliseconds := 120000)
 where exists(select 1 from edgebot_research.configuration where key='worker_url');
$cron$);
