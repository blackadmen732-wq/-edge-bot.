import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from './e2e/db/node_modules/@electric-sql/pglite/dist/index.js';
import {Store,type Sql} from '../supabase/functions/edge-research/store.ts';
import {SERIES,numericPoints,listArchiveSeries,analyzeArchive,savedNumericResults,numericResult,addNumericUniverse} from '../supabase/functions/edge-research/numeric-archive.ts';
const t=Date.parse('2026-01-01T00:00:00Z');
const rows=Array.from({length:40},(_,i)=>({id:String(i+1),source:'kraken.spot',payload:{pair:'XXBTZUSD',price:100+i},event_at:new Date(t+i*3600000).toISOString(),available_at:new Date(t+i*3600000).toISOString()}));
const end=rows.at(-1)!.available_at;
function adapter(db:any):Sql{const sql:any=async(parts:TemplateStringsArray,...args:any[])=>{const q=parts.reduce((s,p,i)=>s+p+(i<args.length?'$'+(i+1):''),'');return (await db.query(q,args)).rows;};sql.json=JSON.stringify;sql.begin=(fn:any)=>db.transaction((tx:any)=>fn(adapter(tx)));return sql;}
test('archive parser separates assets, excludes unknown/future data, sorts and resolves timestamp revisions',()=>{
 const extra=[{...rows[0],id:'90',payload:{pair:'XETHZUSD',price:9000}},{...rows[1],id:'91',available_at:'2099-01-01T00:00:00Z'},{...rows[2],id:'92',payload:{pair:'XXBTZUSD',price:-1}},{...rows[0],id:'93',payload:{pair:'XXBTZUSD',price:101},available_at:rows[1].available_at}];
 const points=numericPoints([...rows].reverse().concat(extra),SERIES[0],end);
 assert.equal(points.length,40);assert.equal(points[0].value,101);assert.equal(points[0].observationId,'93');assert(!points.some(p=>p.value===9000));
 assert.equal(numericPoints(rows,SERIES[0],rows[19].available_at).length,20);
 assert.throws(()=>numericPoints(rows,SERIES[0],'2099-01-01T00:00:00Z'),/future/);
});
test('real Postgres saves reproducible results, reuses unchanged snapshots and keeps previous versions',async()=>{
 const db=new PGlite();const sql=adapter(db),store=new Store(sql);
 try{
 await db.exec('create schema edgebot_research; create table edgebot_research.observations(id bigserial primary key,source text,payload jsonb,event_at timestamptz,available_at timestamptz); create table edgebot_research.events(id bigserial primary key,actor text,action text,details jsonb,created_at timestamptz default now());');
 for(const r of rows)await sql`insert into edgebot_research.observations(source,payload,event_at,available_at) values(${r.source},${sql.json(r.payload)},${r.event_at},${r.available_at})`;
 const series=await listArchiveSeries(store);assert.equal(series.find(s=>s.id==='kraken:BTC-USD')!.ready,true);assert.equal(series.find(s=>s.id==='kraken:ETH-USD')!.samples,0);
 const first=await analyzeArchive(store,{seriesId:'kraken:BTC-USD'},'test');assert(first.persisted);assert(!first.cached);assert.equal(first.snapshot.points.length,40);assert.equal(first.report.status,'descriptive_only');assert.equal(first.report.canExecuteTrades,false);
 const again=await analyzeArchive(store,{seriesId:'kraken:BTC-USD'},'test');assert.equal(again.id,first.id);assert(again.cached);
 const later=new Date(t+40*3600000).toISOString();await sql`insert into edgebot_research.observations(source,payload,event_at,available_at) values('kraken.spot',${sql.json({pair:'XXBTZUSD',price:140})},${later},${later})`;
 const second=await analyzeArchive(store,{seriesId:'kraken:BTC-USD'},'test');assert.notEqual(first.id,second.id);assert.notEqual(first.fingerprint,second.fingerprint);
 const saved=await numericResult(store,first.id);assert.equal(saved.details.snapshot.points.length,40);assert.equal((await savedNumericResults(store)).length,2);
 await assert.rejects(()=>analyzeArchive(store,{seriesId:'kraken:BTC-USD',asOf:rows[19].available_at},'test'),/Need 30/);
 await assert.rejects(()=>analyzeArchive(store,{seriesId:'unknown'},'test'),/Unsupported/);
 await assert.rejects(()=>numericResult(store,'1;drop table x'),/Invalid/);
 const graph=addNumericUniverse({records:[{id:'source:kraken.spot'}],counts:{}},await savedNumericResults(store));assert.equal(graph.counts.numericAnalyses,2);assert.equal(graph.records.length,5);
 assert(graph.records.find((r:any)=>r.id==='numeric-snapshot:'+first.id).relatedIds.includes('source:kraken.spot'));
 }finally{await db.close();}
});
