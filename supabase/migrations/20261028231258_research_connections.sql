insert into edgebot_research.sources(id,track,name,expected_seconds) values
 ('kraken.spot','crypto','Kraken public spot observations',3600),
 ('frankfurter.fx','fx','Frankfurter daily currency reference rates',86400),
 ('nws.forecast','weather','US NWS forecasts: six cities',3600),
 ('alphavantage.equities','equities','Alpha Vantage daily equity sample',86400),
 ('alphavantage.commodities','commodities','Alpha Vantage daily WTI series',86400),
 ('odds.sports','sports','Read-only sports research feed',21600)
on conflict(id) do nothing;

select cron.schedule('edgebot-research-collect','23 * * * *',$cron$
 select net.http_post(
  url:=replace((select value from edgebot_research.configuration where key='worker_url'),'?task=worker','?task=collect'),
  headers:=jsonb_build_object('content-type','application/json','Authorization','Bearer '||
   (select decrypted_secret from vault.decrypted_secrets where name='edgebot_research_token')),
  body:='{}'::jsonb,timeout_milliseconds:=120000)
 where exists(select 1 from edgebot_research.configuration where key='worker_url');
$cron$);
