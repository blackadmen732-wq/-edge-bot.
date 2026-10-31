import {InputError} from './core.ts';
import type {Store} from './store.ts';

export const EXTRA_PROVIDERS = {
 helius:{name:'Helius',keyUrl:'https://dashboard.helius.dev/',purpose:'Read-only Solana RPC observations'},
 jupiter:{name:'Jupiter',keyUrl:'https://portal.jup.ag/',purpose:'Read-only SOL reference price; no swaps'},
} as const;
export const EXTRA_SOURCES = [
 {id:'coinbase.spot',track:'crypto',name:'Coinbase BTC spot reference',seconds:3600},
 {id:'coingecko.markets',track:'crypto',name:'CoinGecko BTC ETH SOL market snapshots',seconds:3600},
 {id:'dexscreener.solana',track:'crypto',name:'DEX Screener wrapped SOL pool snapshots',seconds:3600},
 {id:'solana.network',track:'crypto',name:'Solana public RPC network status',seconds:3600},
 {id:'defillama.tvl',track:'crypto',name:'DefiLlama chain TVL snapshots',seconds:21600},
 {id:'mempool.fees',track:'crypto',name:'Mempool Bitcoin recommended fees',seconds:3600},
 {id:'usgs.earthquakes',track:'geophysics',name:'USGS hourly earthquake observations',seconds:3600},
 {id:'worldbank.gdp',track:'macro',name:'World Bank US GDP annual history',seconds:86400},
 {id:'helius.network',track:'crypto',name:'Helius Solana network observations',seconds:3600,key:'helius'},
 {id:'jupiter.prices',track:'crypto',name:'Jupiter SOL reference price',seconds:3600,key:'jupiter'},
] as const;
const SOL='So11111111111111111111111111111111111111112';
const HOSTS=new Set(['api.coinbase.com','api.coingecko.com','api.dexscreener.com','api.mainnet-beta.solana.com','api.llama.fi','mempool.space','earthquake.usgs.gov','api.worldbank.org','mainnet.helius-rpc.com','api.jup.ag']);
type Row={source:string;externalId:string;eventAt:string;availableAt:string;payload:Record<string,unknown>};
type Spec=typeof EXTRA_SOURCES[number];
function positive(value:unknown,label:string):number {
 const n=typeof value==='number'?value:typeof value==='string'&&value.trim()?Number(value):NaN;
 if(!Number.isFinite(n)||n<=0)throw new InputError(label+': invalid positive number');return n;
}
function nonnegative(value:unknown,label:string):number {
 if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new InputError(label+': invalid number');return value;
}
export async function providerJSON(url:string,fetcher:typeof fetch,options:RequestInit={}) {
 const u=new URL(url);
 if(u.protocol!=='https:'||!HOSTS.has(u.hostname)||u.port||u.username||u.password)throw new InputError('Provider URL is not allowed');
 let response:Response;
 try{response=await fetcher(u,{...options,headers:{Accept:'application/json','User-Agent':'ParallaxResearch/1.0',...options.headers},redirect:'error',signal:AbortSignal.timeout(9000)});}
 catch{throw new InputError(u.hostname+': request failed');}
 if(!response.ok)throw new InputError(u.hostname+': HTTP '+response.status);
 if(Number(response.headers.get('content-length')??0)>1_000_000)throw new InputError('Provider response too large');
 const reader=response.body?.getReader();if(!reader)throw new InputError('Provider response body missing');
 const decoder=new TextDecoder();let text='',size=0;
 try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>1_000_000){await reader.cancel();throw new InputError('Provider response too large');}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}
 finally{reader.releaseLock();}
 try{return JSON.parse(text);}catch{throw new InputError(u.hostname+': invalid JSON');}
}
function row(source:string,id:string,payload:Record<string,unknown>,eventAt?:string):Row {
 const now=new Date().toISOString(),event=eventAt??now;
 if(!Number.isFinite(Date.parse(event))||Date.parse(event)>Date.now()+5000)throw new InputError('Invalid provider event timestamp');
 if(!id||id.length>200)throw new InputError('Invalid external observation id');
 return {source,externalId:id,eventAt:event,availableAt:now,payload:{...payload,researchOnly:true}};
}
export async function collectExtraSource(spec:Spec,store:Store,fetcher:typeof fetch=fetch):Promise<Row[]> {
 const id=spec.id,get=(url:string,options?:RequestInit)=>providerJSON(url,fetcher,options);
 switch(id){
 case 'coinbase.spot':{
  const j=await get('https://api.coinbase.com/v2/prices/BTC-USD/spot');
  if(j.data?.base!=='BTC'||j.data?.currency!=='USD')throw new InputError('Coinbase: unexpected currency');
  return [row(id,'BTC:'+Date.now(),{symbol:'BTC',currency:'USD',price:positive(j.data.amount,'Coinbase price'),attribution:'Coinbase',timestampBasis:'retrieval'})];
 }
 case 'coingecko.markets':{
  const j=await get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana');
  if(!Array.isArray(j)||!j.length)throw new InputError('CoinGecko: markets missing');
  return j.filter(r=>['bitcoin','ethereum','solana'].includes(r.id)).slice(0,3).map(r=>row(id,r.id+':'+r.last_updated,{asset:r.id,currency:'USD',price:positive(r.current_price,'CoinGecko price'),marketCap:nonnegative(r.market_cap,'market cap'),volume24h:nonnegative(r.total_volume,'volume'),attribution:'CoinGecko'},r.last_updated));
 }
 case 'dexscreener.solana':{
  const j=await get('https://api.dexscreener.com/token-pairs/v1/solana/'+SOL);
  if(!Array.isArray(j))throw new InputError('DEX Screener: pools missing');
  return j.filter(r=>r.chainId==='solana'&&r.baseToken?.address===SOL&&Number(r.priceUsd)>0).slice(0,15).map(r=>row(id,r.pairAddress+':'+Date.now(),{pairAddress:r.pairAddress,dex:r.dexId,baseToken:r.baseToken.address,quoteToken:r.quoteToken?.address,priceUsd:positive(r.priceUsd,'pool price'),liquidityUsd:nonnegative(r.liquidity?.usd??0,'liquidity'),volume24h:nonnegative(r.volume?.h24??0,'volume'),attribution:'DEX Screener',timestampBasis:'retrieval'}));
 }
 case 'solana.network':
 case 'helius.network':{
  let url='https://api.mainnet-beta.solana.com';
  if(id==='helius.network'){
   const key=await store.providerKey('helius');if(!key)throw new InputError('Helius key is missing');
   await store.reserveDataRequest('helius',24);url='https://mainnet.helius-rpc.com/?api-key='+encodeURIComponent(key);
  }
  const j=await get(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getLatestBlockhash',params:[{commitment:'finalized'}]})});
  if(j.error||typeof j.result?.value?.blockhash!=='string')throw new InputError('Solana RPC: blockhash unavailable');
  return [row(id,String(j.result.context.slot),{slot:positive(j.result.context.slot,'slot'),blockhash:j.result.value.blockhash,lastValidBlockHeight:positive(j.result.value.lastValidBlockHeight,'block height'),attribution:id==='helius.network'?'Helius':'Solana public mainnet RPC',scope:'Network metadata only'})];
 }
 case 'defillama.tvl':{
  const j=await get('https://api.llama.fi/v2/chains');if(!Array.isArray(j))throw new InputError('DefiLlama: chains missing');
  return j.filter(r=>['Ethereum','Solana','Bitcoin'].includes(r.name)).map(r=>row(id,r.name+':'+Date.now(),{chain:r.name,tvlUsd:nonnegative(r.tvl,'TVL'),attribution:'DefiLlama',timestampBasis:'retrieval'}));
 }
 case 'mempool.fees':{
  const j=await get('https://mempool.space/api/v1/fees/recommended');
  const fees=Object.fromEntries(['fastestFee','halfHourFee','hourFee','economyFee','minimumFee'].map(k=>[k,nonnegative(j[k],k)]));
  return [row(id,'fees:'+Date.now(),{fees,unit:'sat/vB',attribution:'mempool.space',timestampBasis:'retrieval'})];
 }
 case 'usgs.earthquakes':{
  const j=await get('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson');
  if(j.type!=='FeatureCollection'||!Array.isArray(j.features)||typeof j.metadata?.generated!=='number')throw new InputError('USGS: invalid earthquake feed');
  // A valid empty hour is still an observation, with zero events rather than invented activity.
  const events=j.features.slice(0,40).map((r:any)=>({id:r.id,magnitude:r.properties?.mag,place:r.properties?.place,time:r.properties?.time,coordinates:r.geometry?.coordinates}));
  return [row(id,'hour:'+j.metadata.generated,{eventCount:j.features.length,events,truncated:j.features.length>40,attribution:'US Geological Survey'},new Date(j.metadata.generated).toISOString())];
 }
 case 'worldbank.gdp':{
  const j=await get('https://api.worldbank.org/v2/country/USA/indicator/NY.GDP.MKTP.CD?format=json&per_page=10');
  if(!Array.isArray(j?.[1]))throw new InputError('World Bank: GDP data missing');
  return j[1].filter((r:any)=>r.value!=null&&/^\d{4}$/.test(r.date)).slice(0,10).map((r:any)=>row(id,'USA:GDP:'+r.date,{country:'USA',indicator:'NY.GDP.MKTP.CD',year:r.date,value:positive(r.value,'GDP'),unit:'current USD',frequency:'annual',attribution:'World Bank',limitation:'Latest available vintage; historical release dates unknown'},r.date+'-12-31T00:00:00Z'));
 }
 case 'jupiter.prices':{
  const key=await store.providerKey('jupiter');if(!key)throw new InputError('Jupiter key is missing');
  await store.reserveDataRequest('jupiter',24);
  const j=await get('https://api.jup.ag/price/v3?ids='+SOL,{headers:{'x-api-key':key}});
  const r=j[SOL];if(!r)throw new InputError('Jupiter: SOL reference price missing');
  return [row(id,'SOL:'+Date.now(),{mint:SOL,priceUsd:positive(r.usdPrice,'SOL price'),blockId:r.blockId??null,attribution:'Jupiter Price API',timestampBasis:'retrieval',scope:'Reference data only'})];
 }
 }
}
export async function collectExtras(store:Store,fetcher:typeof fetch=fetch){
 const results:any[]=[];
 // Small batches bound outbound concurrency. The caller holds the existing collection lease.
 for(let offset=0;offset<EXTRA_SOURCES.length;offset+=3){
  await Promise.all(EXTRA_SOURCES.slice(offset,offset+3).map(async spec=>{
   try{
    if(!await store.collectionDue(spec.id,spec.seconds)){results.push({source:spec.id,status:'cached'});return;}
    const rows=await collectExtraSource(spec,store,fetcher);
    if(!rows.length)throw new InputError('No usable observations returned');
    const imported=await store.importObservations(rows,'collector',true);
    await store.markCollected(spec.id);results.push({source:spec.id,status:'received',...imported});
   }catch(e){results.push({source:spec.id,status:e instanceof InputError&&e.message.includes('key is missing')?'needs_key':'error',error:e instanceof InputError?e.message:'Collection failed'});}
  }));
 }
 return results;
}

