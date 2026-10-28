import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from './e2e/db/node_modules/@electric-sql/pglite/dist/index.js';
import {Store,type Sql} from '../supabase/functions/edge-research/store.ts';
import {Service} from '../supabase/functions/edge-research/service.ts';
function adapter(db:any):Sql {
 const sql:any=async(parts:TemplateStringsArray,...args:any[])=>{
  const query=parts.reduce((s,p,i)=>s+p+(i<args.length?'$'+(i+1):''),'');return (await db.query(query,args)).rows;
 };
 sql.json=JSON.stringify;
 sql.begin=(fn:any)=>db.transaction((tx:any)=>fn(adapter(tx)));
 return sql;
}
async function setup(){
 const db=new PGlite();
 await db.exec(`
 create role anon;create role authenticated;
 create schema vault;create schema extensions;create schema edgebot;create schema cron;
 create table vault.secrets(name text unique,decrypted_secret text);
 create view vault.decrypted_secrets as select * from vault.secrets;
 create function extensions.gen_random_bytes(n int) returns bytea language sql as $$select decode(repeat(replace(gen_random_uuid()::text,'-',''),n),'hex')$$;
 create function vault.create_secret(s text,n text,d text) returns uuid language plpgsql as $$begin insert into vault.secrets values(n,s);return gen_random_uuid();end$$;
 create table cron.job(jobname text,schedule text,command text);
 create function cron.schedule(n text,s text,c text) returns int language plpgsql as $$begin insert into cron.job values(n,s,c);return 1;end$$;
 create table edgebot.odds(id bigint primary key,fetched_at timestamptz default now(),fair jsonb);
 create table edgebot.signals(id bigint primary key,created_at timestamptz default now());
 create table edgebot.bets(id bigint primary key,mode text,status text,placed_at timestamptz,settled_at timestamptz,fair_p numeric,pnl numeric,fee numeric,league text,raw jsonb);
 create table edgebot.mm_quotes(id bigint primary key,posted_at timestamptz default now());
 create table edgebot.mm_fills(id bigint primary key,filled_at timestamptz default now());
 create table edgebot.mm_positions(ticker text primary key,updated_at timestamptz default now());
 `);
 const migration=await readFile(new URL('../supabase/migrations/20261028224408_research_analysis.sql',import.meta.url),'utf8');
 await db.exec(migration);return {db,store:new Store(adapter(db))};
}
const rows=Array.from({length:90},(_,i)=>({id:String(i),predictedAt:new Date(Date.UTC(2025,0,1+i)).toISOString(),availableAt:new Date(Date.UTC(2025,0,1+i)).toISOString(),outcomeAt:new Date(Date.UTC(2025,0,1+i,1)).toISOString(),probability:0.2,outcome:i%2===0,result:i%2===0?1:-1,cost:0.1,group:i%2===0?'even':'odd',flags:[]}));
test('migration, archive, immutable datasets, job leases and research models work in Postgres',async()=>{
 const {db,store}=await setup();
 try {
  const tokens=await store.tokens();assert(tokens.agent);assert(tokens.owner);assert.notEqual(tokens.agent,tokens.owner);
  await db.exec(`insert into edgebot.odds(id,fair) values(1,'{"A":0.5}');update edgebot.odds set fair='{"A":0.6}' where id=1;delete from edgebot.odds where id=1;`);
  assert.equal((await db.query('select * from edgebot_research.observations')).rows.length,2);
  await assert.rejects(()=>db.exec('delete from edgebot_research.observations'),/append-only/);
  await db.exec(`insert into edgebot.bets values(1,'paper','won','2025-01-01','2025-01-02',0.4,2,0.1,'test','{"secret":"not archived"}');`);
  assert.equal((await db.query('select * from edgebot_research.examples')).rows.length,1);
  const archived:any=(await db.query("select payload from edgebot_research.observations where source='edgebot.bets'")).rows[0];assert(!('raw' in archived.payload));
  await db.exec(`insert into edgebot.bets values(2,'live','won','2025-01-01','2025-01-02',0.4,2,0.1,'test',null);`);
  assert.equal((await db.query('select * from edgebot_research.examples')).rows.length,1);
  const ds=await store.createDataset({name:'test',examples:rows},'test');
  const repeat=await store.createDataset({name:'again',examples:rows},'test');assert.equal(ds.id,repeat.id);
  await assert.rejects(()=>db.query('update edgebot_research.datasets set name=$1 where id=$2',['changed',ds.id]),/append-only/);
  const j=await store.enqueue({datasetId:ds.id,kind:'diagnose',requestId:'diagnosis-1'},'test');
  assert.equal(j.id,(await store.enqueue({datasetId:ds.id,kind:'diagnose',requestId:'diagnosis-1'},'test')).id);
  await assert.rejects(()=>store.enqueue({datasetId:ds.id,kind:'calibrate',requestId:'diagnosis-1'},'test'),/different/);
  const claimed=await store.claim();assert.equal(claimed.id,j.id);assert.equal(await store.claim(),null);
  assert.equal(await store.finish({...claimed,lease_token:crypto.randomUUID()},{bad:true}),false);
  assert.equal(await store.finish(claimed,{ok:true}),true);
  assert.equal(await store.finish(claimed,{duplicate:true}),false);
  const service=new Service(store);
  const c=await store.enqueue({datasetId:ds.id,kind:'calibrate',requestId:'calibration-1'},'test');
  assert.equal((await service.worker()).processed,1);
  assert.equal((await store.getJob(c.id)).status,'succeeded');
  const [model]=await store.models();assert.equal(model.state,'candidate');
  assert.equal((await store.promote(model.id,'owner')).scope,'research_only');
  await assert.rejects(()=>store.promote(model.id,'owner'),/eligible/);
  const h1=await store.propose({question:'Check missingness',evidence:[]},'test');
  assert.equal(h1.id,(await store.propose({question:'Check missingness',evidence:[]},'test')).id);
  const h:any=await store.health();assert.equal(h.sources.length,10);assert.equal(h.execution,'analysis_only');
  await db.exec('set role anon');await assert.rejects(()=>db.query('select * from edgebot_research.datasets'),/permission denied/);await db.exec('reset role');
 }finally{await db.close();}
});
test('imports are atomic, idempotent, and cannot impersonate native sources',async()=>{
 const {db,store}=await setup();try{
  const observation={source:'equities.import',externalId:'1',eventAt:'2025-01-01',availableAt:'2025-01-01',payload:{value:1}};
  assert.equal((await store.importObservations([observation],'test')).inserted,1);
  assert.equal((await store.importObservations([observation],'test')).inserted,0);
  await assert.rejects(()=>store.importObservations([{...observation,externalId:'2'},{...observation,source:'unknown.import'}],'test'),/Unknown/);
  assert.equal((await db.query('select * from edgebot_research.observations')).rows.length,1);
  await assert.rejects(()=>store.importObservations([{...observation,source:'edgebot.odds'}],'test'),/import source/);
 }finally{await db.close();}
});
test('expired workers cannot overwrite a retry and exhausted jobs terminate',async()=>{
 const {db,store}=await setup();try{
  const ds=await store.createDataset({name:'test',examples:rows},'test');
  const j=await store.enqueue({datasetId:ds.id,kind:'diagnose',requestId:'retry'},'test');
  const first=await store.claim();
  await db.query("update edgebot_research.jobs set lease_until=now()-interval '1 second' where id=$1",[j.id]);
  const second=await store.claim();assert.notEqual(first.lease_token,second.lease_token);
  assert.equal(await store.finish(first,{stale:true}),false);
  await db.query("update edgebot_research.jobs set lease_until=now()-interval '1 second',attempts=3 where id=$1",[j.id]);
  assert.equal(await store.claim(),null);assert.equal((await store.getJob(j.id)).status,'failed');
 }finally{await db.close();}
});
test('AI request budget reserves capacity before provider calls',async()=>{
 const {db,store}=await setup();try{
  const ds=await store.createDataset({name:'test',examples:rows},'test');const job=await store.enqueue({datasetId:ds.id,kind:'agent',requestId:'ai'},'test');
  for(let i=0;i<20;i++)await store.reserveUsage(job.id,'test-model');
  await assert.rejects(()=>store.reserveUsage(job.id,'test-model'),/budget reached/);
  await store.finishUsage(1,{prompt_tokens:12,completion_tokens:4},'succeeded');
  await store.finishUsage(1,null,'failed');
  const measured:any=(await db.query('select input_tokens,output_tokens from edgebot_research.usage where id=1')).rows[0];
  assert.equal(measured.input_tokens,12);assert.equal(measured.output_tokens,4);
  const usage:any=await db.query('select count(*)::int as n,count(actual_cost_usd)::int as measured from edgebot_research.usage');
  assert.equal(usage.rows[0].n,20);assert.equal(usage.rows[0].measured,0);
 }finally{await db.close();}
});
