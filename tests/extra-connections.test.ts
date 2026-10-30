import test from 'node:test';
import assert from 'node:assert/strict';
import {EXTRA_SOURCES,collectExtraSource,collectExtras,providerJSON} from '../supabase/functions/edge-research/extra-connections.ts';
import {providerName} from '../supabase/functions/edge-research/connections.ts';
const spec=(id:string)=>EXTRA_SOURCES.find(s=>s.id===id)!;
const empty:any={providerKey:async()=>null,reserveDataRequest:async()=>{}};
test('every added provider parses timestamped read-only observations',async()=>{
 const now=new Date().toISOString();
 const fixtures:any={
 'coinbase.spot':{data:{base:'BTC',currency:'USD',amount:'100'}},
 'coingecko.markets':[{id:'bitcoin',current_price:100,market_cap:1000,total_volume:200,last_updated:now}],
 'dexscreener.solana':[{chainId:'solana',baseToken:{address:'So11111111111111111111111111111111111111112'},pairAddress:'pool',priceUsd:'10'}],
 'solana.network':{result:{context:{slot:123},value:{blockhash:'hash',lastValidBlockHeight:124}}},
 'defillama.tvl':[{name:'Solana',tvl:100}],
 'mempool.fees':{fastestFee:1,halfHourFee:1,hourFee:1,economyFee:1,minimumFee:1},
 'usgs.earthquakes':{type:'FeatureCollection',metadata:{generated:Date.now()},features:[]},
 'worldbank.gdp':[{},[{date:'2024',value:200}]],
 };
 for(const [id,fixture] of Object.entries(fixtures)){
  const rows=await collectExtraSource(spec(id),empty,async()=>Response.json(fixture));
  assert(rows.length);assert(rows.every(r=>r.source===id&&Date.parse(r.availableAt)<=Date.now()&&r.payload.researchOnly===true));
 }
});
test('RPC permits only the fixed read method; Jupiter sends key in server header',async()=>{
 for(const id of ['helius.network','jupiter.prices']){
  const keys:any={...empty,providerKey:async()=> 'fake-sensitive-key'};
  const rows=await collectExtraSource(spec(id),keys,(async(url:any,init:any)=>{
   if(id==='helius.network'){
    assert.equal(JSON.parse(init.body).method,'getLatestBlockhash');
    assert.equal(init.method,'POST');
    return Response.json({result:{context:{slot:123},value:{blockhash:'hash',lastValidBlockHeight:124}}});
   }
   assert.equal(init.headers['x-api-key'],'fake-sensitive-key');
   assert(!String(url).includes('fake-sensitive-key'));
   return Response.json({So11111111111111111111111111111111111111112:{usdPrice:100}});
  }) as any);
  assert(!JSON.stringify(rows).includes('fake-sensitive-key'));
 }
 assert.equal(providerName('helius'),'helius');assert.equal(providerName('jupiter'),'jupiter');
});
test('missing credentials never make requests and cannot be called connected',async()=>{
 let fetched=0;
 const store:any={...empty,collectionDue:async(id:string)=>['helius.network','jupiter.prices'].includes(id)};
 const results=await collectExtras(store,(async()=>{fetched++;throw Error('unreachable');}) as any);
 assert.equal(fetched,0);assert.equal(results.filter(r=>r.status==='needs_key').length,2);
});
test('provider errors redact secrets and one failed feed does not stop others',async()=>{
 const imported:any[]=[];
 const store:any={...empty,providerKey:async()=> 'fake-sensitive-key',collectionDue:async(id:string)=>['helius.network','coinbase.spot'].includes(id),
 importObservations:async(rows:any[])=>{imported.push(...rows);return {inserted:rows.length};},markCollected:async()=>{}};
 const r=await collectExtras(store,(async(url:any)=>{
  if(String(url).includes('helius'))throw new Error('url?api-key=fake-sensitive-key');
  return Response.json({data:{base:'BTC',currency:'USD',amount:'100'}});
 }) as any);
 assert(!JSON.stringify(r).includes('fake-sensitive-key'));assert.equal(imported.length,1);
 assert(r.some(s=>s.source==='helius.network'&&s.status==='error'));
});
test('reject redirects, unknown hosts and oversized responses',async()=>{
 let calls=0;
 await assert.rejects(()=>providerJSON('https://attacker.test',async()=>{calls++;return Response.json({});}),/not allowed/);
 assert.equal(calls,0);
 await assert.rejects(()=>providerJSON('https://api.coinbase.com',async(_u,init)=>{
  assert.equal(init?.redirect,'error');return new Response('x'.repeat(1000001));
 }),/too large/);
});
test('malformed or empty market responses cannot be recorded as success',async()=>{
 for(const id of ['coinbase.spot','coingecko.markets','solana.network','mempool.fees','worldbank.gdp']){
  await assert.rejects(()=>collectExtraSource(spec(id),empty,async()=>Response.json({})));
 }
 await assert.rejects(()=>collectExtraSource(spec('coinbase.spot'),empty,async()=>Response.json({data:{base:'BTC',currency:'USD',amount:'-1'}})),/invalid/);
});

