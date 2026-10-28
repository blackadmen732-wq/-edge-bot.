import test from 'node:test';
import assert from 'node:assert/strict';
import {collectConnections,providerName,providerKey} from '../supabase/functions/edge-research/connections.ts';
import {handler} from '../supabase/functions/edge-research/http.ts';
test('key validation permits only configured providers without exposing supplied values',()=>{
 assert.equal(providerName('xai'),'xai');assert.throws(()=>providerName('kalshi'),/Unsupported/);
 assert.throws(()=>providerKey('secret\nheader'),/Invalid/);assert.throws(()=>providerKey('demo'),/Invalid/);
});
test('public connectors collect without keys and keep their source identity and frequency',async()=>{
 const imported:any[]=[];let released=false;const requested:string[]=[];
 const store:any={claimCollection:async()=>'lease',collectionDue:async()=>true,providerKey:async()=>null,
  importObservations:async(rows:any[],_actor:string,native:boolean)=>{assert(native);imported.push(...rows);return {inserted:rows.length};},markCollected:async()=>{},audit:async()=>{},releaseCollection:async()=>{released=true;}};
 const fetcher:any=async(input:any)=>{const u=new URL(String(input));requested.push(u.hostname);
  if(u.hostname==='api.kraken.com')return Response.json({error:[],result:{XXBTZUSD:{c:['123','1']},XETHZUSD:{c:['45','1']}}});
  if(u.hostname==='api.frankfurter.dev')return Response.json([{date:'2026-10-01',base:'EUR',quote:'USD',rate:1.1}]);
  if(u.pathname.startsWith('/points/'))return Response.json({properties:{forecast:'https://api.weather.gov/gridpoints/TEST/1,1/forecast'}});
  return Response.json({properties:{updated:'2026-10-01T10:00:00Z',periods:[{startTime:'2026-10-01T12:00:00Z',endTime:'2026-10-01T18:00:00Z',temperature:80,temperatureUnit:'F'}]}});
 };
 const result=await collectConnections(store,fetcher);
 assert.equal(result.status,'completed');assert.equal(imported.length,9);assert(released);
 assert.equal(result.results.filter(r=>r.status==='needs_key').length,3);
 assert(!requested.includes('www.alphavantage.co'));assert(!requested.includes('api.the-odds-api.com'));
 assert.equal(imported.find(x=>x.source==='frankfurter.fx').payload.frequency,'daily_reference');
});
test('a malicious forecast URL cannot redirect collection or receive secrets',async()=>{
 const requested:string[]=[];const store:any={claimCollection:async()=>'lease',collectionDue:async(source:string)=>source==='nws.forecast',providerKey:async()=>null,markCollected:async()=>{},audit:async()=>{},releaseCollection:async()=>{}};
 const result=await collectConnections(store,(async(input:any)=>{requested.push(String(input));return Response.json({properties:{forecast:'https://attacker.test/collect'}});}) as any);
 assert(requested.every(u=>u.startsWith('https://api.weather.gov/')));assert(result.results.some(r=>r.source==='nws.forecast'&&r.status==='error'));
});
test('provider failures retain a clear unknown state and do not leak key-bearing URLs',async()=>{
 const key='private-key-not-in-errors';const store:any={claimCollection:async()=>'lease',collectionDue:async(source:string)=>source==='alphavantage.equities',providerKey:async()=>key,reserveDataRequest:async()=>{},markCollected:async()=>{},audit:async()=>{},releaseCollection:async()=>{}};
 const r=await collectConnections(store,(async()=>{throw Error('request?apikey='+key);}) as any);
 assert(!JSON.stringify(r).includes(key));assert(r.results.some(x=>x.status==='error'));
});
test('agent credentials cannot change provider keys',async()=>{
 let called=false;const h=handler({service:{configure:async()=>{called=true;}} as any,tokens:async()=>({agent:'agent',owner:'owner'})});
 const response=await h(new Request('https://example.test/?task=credentials',{method:'POST',headers:{authorization:'Bearer agent','content-type':'application/json'},body:JSON.stringify({provider:'xai',value:'private-test-key'})}));
 assert.equal(response.status,403);assert.equal(called,false);
});
