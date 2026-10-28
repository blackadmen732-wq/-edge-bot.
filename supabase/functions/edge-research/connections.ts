import {InputError,object,string} from './core.ts';
import type {Store} from './store.ts';
export const PROVIDERS={
 xai:{name:'Grok AI',keyUrl:'https://console.x.ai/',purpose:'AI investigation'},
 alphavantage:{name:'Alpha Vantage',keyUrl:'https://www.alphavantage.co/support/api-key/',purpose:'Daily equity and commodity research data'},
 odds:{name:'The Odds API',keyUrl:'https://the-odds-api.com/',purpose:'Read-only sports research observations'},
 resend:{name:'Resend',keyUrl:'https://resend.com/api-keys',purpose:'Optional email credential; sender setup is separate'},
} as const;
export type Provider=keyof typeof PROVIDERS;
export function providerName(value:unknown):Provider {
 const name=string(value,'provider');if(!Object.hasOwn(PROVIDERS,name))throw new InputError('Unsupported provider');return name as Provider;
}
export function providerKey(value:unknown):string {
 const key=string(value,'API key',4096);if(key.length<8||/[^\x21-\x7e]/.test(key))throw new InputError('Invalid API key');return key;
}
const HOSTS=new Set(['api.kraken.com','api.frankfurter.dev','api.weather.gov','www.alphavantage.co','api.the-odds-api.com']);
async function getJSON(url:string,label:string,fetcher:typeof fetch) {
 const u=new URL(url);if(u.protocol!=='https:'||!HOSTS.has(u.hostname)||u.username||u.password)throw new InputError('Provider URL is not allowed');
 let response:Response;try{response=await fetcher(u,{headers:{'User-Agent':'EdgeResearch/1.0','Accept':'application/json'},redirect:'error',signal:AbortSignal.timeout(9000)});}catch{throw new InputError(label+': request failed');}
 if(!response.ok)throw new InputError(label+': HTTP '+response.status);
 try{return await response.json();}catch{throw new InputError(label+': invalid JSON');}
}
const cities=[['NYC',40.7789,-73.9692],['Chicago',41.7868,-87.7522],['Miami',25.7881,-80.3169],['Austin',30.1831,-97.6799],['Los Angeles',33.9382,-118.3866],['Denver',39.8466,-104.6562]] as const;
type Observation={source:string;externalId:string;eventAt:string;availableAt:string;payload:Record<string,unknown>};
export async function collectConnections(store:Store,fetcher:typeof fetch=fetch) {
 const lease=await store.claimCollection();if(!lease)return {status:'busy',results:[]};
 const results:any[]=[];
 const run=async(source:string,seconds:number,fn:()=>Promise<Observation[]>)=>{
  try{
   if(!await store.collectionDue(source,seconds)){results.push({source,status:'cached'});return;}
   const rows=await fn();if(!rows.length)throw new InputError('No usable observations returned');
   const imported=await store.importObservations(rows,'collector',true);
   await store.markCollected(source);results.push({source,status:'received',...imported});
  }catch(e){results.push({source,status:e instanceof InputError&&e.message.includes('key is missing')?'needs_key':'error',error:e instanceof InputError?e.message:'Collection failed'});}
 };
 try{
  await Promise.all([
   run('kraken.spot',900,async()=>{
    const j=await getJSON('https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD','Kraken',fetcher),now=new Date().toISOString();
    if(!Array.isArray(j.error)||j.error.length||!j.result)throw new InputError('Kraken returned an invalid response');
    return Object.entries(j.result).slice(0,2).map(([pair,r]:[string,any])=>{
     const price=Number(r.c?.[0]);if(!Number.isFinite(price)||price<=0)throw new InputError('Kraken price is missing');
     return {source:'kraken.spot',externalId:pair+':'+now,eventAt:now,availableAt:now,payload:{pair,price,currency:'USD',timestampBasis:'retrieval',attribution:'Kraken public market data'}};
    });
   }),
   run('frankfurter.fx',21600,async()=>{
    const j=await getJSON('https://api.frankfurter.dev/v2/rates?base=EUR&quotes=USD,GBP','Frankfurter',fetcher),now=new Date().toISOString();
    if(!Array.isArray(j))throw new InputError('Frankfurter returned an invalid response');
    return j.slice(0,4).map((r:any)=>{if(!r.date||typeof r.rate!=='number'||!(r.rate>0)||r.base!=='EUR'||!['USD','GBP'].includes(r.quote))throw new InputError('Currency reference rate is missing');
     return {source:'frankfurter.fx',externalId:r.base+':'+r.quote+':'+r.date,eventAt:r.date+'T00:00:00Z',availableAt:now,payload:{...r,frequency:'daily_reference',attribution:'Frankfurter blended reference rates'}};
    });
   }),
   run('nws.forecast',3600,async()=>{
    const now=new Date().toISOString();
    const settled=await Promise.allSettled(cities.map(async([city,lat,lon])=>{
     const p=await getJSON(`https://api.weather.gov/points/${lat},${lon}`,'NWS points',fetcher);
     const url=p.properties?.forecast;if(typeof url!=='string')throw new InputError('NWS forecast link is missing');
     const f=await getJSON(url,'NWS forecast',fetcher),periods=f.properties?.periods;
     if(!Array.isArray(periods)||!periods.length)throw new InputError('NWS forecast periods are missing');
     return {source:'nws.forecast',externalId:city+':'+(f.properties.updated??now),eventAt:f.properties.updated??now,availableAt:now,
      payload:{city,lat,lon,updated:f.properties.updated??null,periods:periods.slice(0,14).map((r:any)=>({startTime:r.startTime,endTime:r.endTime,isDaytime:r.isDaytime,temperature:r.temperature,temperatureUnit:r.temperatureUnit,shortForecast:r.shortForecast})),attribution:'US National Weather Service',scope:'forecast research; not an official settlement observation'}};
    }));
    const rows=settled.flatMap(r=>r.status==='fulfilled'?[r.value]:[]);
    if(rows.length!==cities.length)results.push({source:'nws.forecast',status:'partial',receivedCities:rows.length,expectedCities:cities.length});
    return rows;
   }),
   run('alphavantage.equities',86400,async()=>{
    const key=await store.providerKey('alphavantage');if(!key)throw new InputError('Alpha Vantage key is missing');
    await store.reserveDataRequest('alphavantage',20);
    const u=new URL('https://www.alphavantage.co/query');u.search=new URLSearchParams({function:'TIME_SERIES_DAILY',symbol:'SPY',outputsize:'compact',apikey:key}).toString();
    const j=await getJSON(u.toString(),'Alpha Vantage',fetcher),series=j['Time Series (Daily)'],now=new Date().toISOString();
    if(!series)throw new InputError('Alpha Vantage daily data unavailable or rate limited');
    return Object.entries(series).sort(([a],[b])=>b.localeCompare(a)).slice(0,30).map(([day,r]:[string,any])=>({source:'alphavantage.equities',externalId:'SPY:'+day,eventAt:day+'T00:00:00Z',availableAt:now,payload:{symbol:'SPY',day,open:r['1. open'],high:r['2. high'],low:r['3. low'],close:r['4. close'],volume:r['5. volume'],frequency:'daily',adjustment:'raw',attribution:'Alpha Vantage; research sample'}}));
   }),
   run('alphavantage.commodities',86400,async()=>{
    const key=await store.providerKey('alphavantage');if(!key)throw new InputError('Alpha Vantage key is missing');
    await store.reserveDataRequest('alphavantage',20);
    const u=new URL('https://www.alphavantage.co/query');u.search=new URLSearchParams({function:'WTI',interval:'daily',apikey:key}).toString();
    const j=await getJSON(u.toString(),'Alpha Vantage',fetcher),now=new Date().toISOString();if(!Array.isArray(j.data))throw new InputError('Commodity data unavailable or rate limited');
    return j.data.slice(0,30).map((r:any)=>({source:'alphavantage.commodities',externalId:'WTI:'+r.date,eventAt:r.date+'T00:00:00Z',availableAt:now,payload:{series:'WTI',date:r.date,value:r.value==='.'?null:r.value,unit:j.unit,frequency:j.interval,attribution:'Alpha Vantage / US EIA via FRED'}}));
   }),
   run('odds.sports',21600,async()=>{
    const key=await store.providerKey('odds');if(!key)throw new InputError('Sports research data key is missing');
    const rows:Observation[]=[];
    for(const league of ['americanfootball_nfl','americanfootball_ncaaf','soccer_efl_champ']){
     await store.reserveDataRequest('odds',12);
     const u=new URL('https://api.the-odds-api.com/v4/sports/'+league+'/odds');u.search=new URLSearchParams({apiKey:key,regions:'eu',markets:'h2h',oddsFormat:'decimal'}).toString();
     const j=await getJSON(u.toString(),'Sports research data',fetcher),now=new Date().toISOString();if(!Array.isArray(j))throw new InputError('Sports data returned an invalid response');
     for(const game of j.slice(0,60))rows.push({source:'odds.sports',externalId:league+':'+game.id+':'+now,eventAt:game.commence_time,availableAt:now,payload:{...game,researchOnly:true,attribution:'The Odds API'}});
    }return rows;
   }),
  ]);
  await store.audit('collector','collect_connections',{results});return {status:'completed',results};
 }finally{await store.releaseCollection(lease);}
}
