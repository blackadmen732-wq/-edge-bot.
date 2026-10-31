import {InputError,date,digest,object,string} from './core.ts';
import {analyzeNumericSeries} from './patterns.ts';
import type {Store} from './store.ts';
export const NUMERIC_VERSION='archive-patterns-1';
export const SERIES=[
 {id:'kraken:BTC-USD',source:'kraken.spot',name:'BTC / USD',market:'crypto',unit:'USD',field:'price',match:{pair:'XXBTZUSD'}},
 {id:'kraken:ETH-USD',source:'kraken.spot',name:'ETH / USD',market:'crypto',unit:'USD',field:'price',match:{pair:'XETHZUSD'}},
 {id:'coinbase:BTC-USD',source:'coinbase.spot',name:'BTC / USD',market:'crypto',unit:'USD',field:'price',match:{symbol:'BTC'}},
 {id:'coingecko:BTC-USD',source:'coingecko.markets',name:'BTC / USD',market:'crypto',unit:'USD',field:'price',match:{asset:'bitcoin'}},
 {id:'coingecko:ETH-USD',source:'coingecko.markets',name:'ETH / USD',market:'crypto',unit:'USD',field:'price',match:{asset:'ethereum'}},
 {id:'coingecko:SOL-USD',source:'coingecko.markets',name:'SOL / USD',market:'crypto',unit:'USD',field:'price',match:{asset:'solana'}},
 {id:'jupiter:SOL-USD',source:'jupiter.prices',name:'SOL / USD',market:'crypto',unit:'USD',field:'priceUsd',match:{mint:'So11111111111111111111111111111111111111112'}},
 {id:'frankfurter:EUR-USD',source:'frankfurter.fx',name:'EUR / USD daily reference',market:'forex',unit:'USD per EUR',field:'rate',match:{base:'EUR',quote:'USD'}},
 {id:'frankfurter:EUR-GBP',source:'frankfurter.fx',name:'EUR / GBP daily reference',market:'forex',unit:'GBP per EUR',field:'rate',match:{base:'EUR',quote:'GBP'}},
] as const;
type Spec=typeof SERIES[number];
export function numericPoints(rows:any[],spec:Spec,asOf:string) {
 const end=Date.parse(date(asOf,'asOf'));if(end>Date.now()+1000)throw new InputError('asOf cannot be in the future');
 // Resolve revisions at the same event timestamp using only records available at this asOf.
 const times=new Map<string,any>();
 for(const r of rows){
  if(r.source!==spec.source||!r.payload||!Object.entries(spec.match).every(([k,v])=>r.payload[k]===v))continue;
  const event=r.event_at==null?NaN:new Date(r.event_at).valueOf(),available=r.available_at==null?NaN:new Date(r.available_at).valueOf();
  const raw=r.payload[spec.field],value=typeof raw==='number'?raw:typeof raw==='string'&&raw.trim()?Number(raw):NaN;
  if(!Number.isFinite(event)||!Number.isFinite(available)||available<event||available>end||event>end||!Number.isFinite(value)||value<=0)continue;
  const time=new Date(event).toISOString(),known=new Date(available).toISOString(),old=times.get(time);
  const tie=String(r.id);const newer=!old||known>old.availableAt||(known===old.availableAt&&BigInt(tie)>BigInt(old.observationId));
  if(newer)times.set(time,{time,availableAt:known,value,observationId:tie});
 }
 return [...times.values()].sort((a,b)=>a.time.localeCompare(b.time)).slice(-2000);
}
export async function listArchiveSeries(store:Store) {
 const rows=await store.sql`select id,source,payload,event_at,available_at from edgebot_research.observations
  where source in ('kraken.spot','coinbase.spot','coingecko.markets','jupiter.prices','frankfurter.fx')
  and available_at<=now() and event_at<=now() order by event_at desc,id desc limit 20000`;
 const asOf=new Date().toISOString();
 return SERIES.map(spec=>{const p=numericPoints(rows,spec,asOf);return {id:spec.id,name:spec.name,source:spec.source,unit:spec.unit,market:spec.market,samples:p.length,minimumSamples:30,ready:p.length>=30,firstTime:p[0]?.time??null,lastTime:p.at(-1)?.time??null,frequency:'recorded snapshots; may be irregular'};});
}
export async function savedNumericResults(store:Store) {
 return store.sql`select id,created_at,details->>'seriesId' as series_id,details->>'name' as name,
 details->>'fingerprint' as fingerprint,details->>'source' as source,details->'report' as report
 from edgebot_research.events where action='numeric_analysis' order by id desc limit 30`;
}
export async function numericResult(store:Store,value:unknown) {
 const id=string(value,'id',20);if(!/^\d{1,19}$/.test(id))throw new InputError('Invalid numeric result ID');
 const [r]=await store.sql`select id,created_at,details from edgebot_research.events where id=${id}::bigint and action='numeric_analysis'`;
 if(!r)throw new InputError('Numeric result not found');return r;
}
export async function analyzeArchive(store:Store,input:unknown,actor:string) {
 const a=object(input),id=string(a.seriesId,'seriesId'),spec=SERIES.find(s=>s.id===id);
 if(!spec)throw new InputError('Unsupported archived series');
 const asOf=a.asOf===undefined?new Date().toISOString():date(a.asOf,'asOf');
 if(Date.parse(asOf)>Date.now()+1000)throw new InputError('asOf cannot be in the future');
 const rows=await store.sql`select id,source,payload,event_at,available_at from edgebot_research.observations
 where source=${spec.source} and payload @> ${store.sql.json(spec.match)}::jsonb and available_at<=${asOf}::timestamptz
 and event_at<=${asOf}::timestamptz order by event_at desc,available_at desc,id desc limit 10000`;
 const points=numericPoints(rows,spec,asOf);
 if(points.length<30)throw new InputError('Need 30 distinct usable observations; '+id+' has '+points.length);
 const snapshotAsOf=points.reduce((m,p)=>p.availableAt>m?p.availableAt:m,points[0].availableAt);
 const snapshot={name:spec.name,source:spec.source,market:spec.market,asOf:snapshotAsOf,unit:spec.unit,points};
 const fingerprint=await digest({version:NUMERIC_VERSION,seriesId:id,snapshot});
 const measured=analyzeNumericSeries(snapshot);
 const report={...measured,source:{name:spec.source,verification:'server_archive_records'},limitations:[
  ...measured.limitations.filter(x=>!x.startsWith('Data provenance')),
  'Source and observation IDs come from the server archive; provider accuracy is not independently certified.',
  'This snapshot analysis uses all selected archived observations, not an out-of-sample strategy test.'
 ]};
 return store.sql.begin(async tx=>{
  await tx`select pg_advisory_xact_lock(174523,7)`;
  const [existing]=await tx`select id,created_at,details from edgebot_research.events where action='numeric_analysis' and details->>'fingerprint'=${fingerprint} order by id limit 1`;
  if(existing)return {...existing.details,id:String(existing.id),createdAt:existing.created_at,cached:true,persisted:true};
  const details={seriesId:id,name:spec.name,source:spec.source,fingerprint,version:NUMERIC_VERSION,snapshot,report};
  const [saved]=await tx`insert into edgebot_research.events(actor,action,details) values(${actor},'numeric_analysis',${tx.json(details)}) returning id,created_at`;
  return {...details,id:String(saved.id),createdAt:saved.created_at,cached:false,persisted:true};
 });
}
export async function analyzeReadyArchive(store:Store) {
 const results:any[]=[];
 for(const series of (await listArchiveSeries(store)).filter(s=>s.ready)){
  try{const r=await analyzeArchive(store,{seriesId:series.id},'numeric-collector');results.push({seriesId:series.id,id:r.id,status:r.cached?'cached':'saved',samples:r.snapshot.points.length});}
  catch(e){results.push({seriesId:series.id,status:'error',error:e instanceof InputError?e.message:'Numeric analysis failed'});}
 }
 return results;
}
export function addNumericUniverse(graph:any,rows:any[]) {
 for(const r of rows.slice(0,30)){
  const dataset='numeric-snapshot:'+r.id,experiment='numeric-result:'+r.id,source='source:'+r.source;
  const base={market:'other',updatedAt:new Date(r.created_at).toISOString(),provenance:{source:r.source,version:r.fingerprint}};
  graph.records.push({...base,id:dataset,kind:'dataset',name:r.name+' snapshot',status:'saved',description:'Timestamped numerical observations with archive provenance.',evidence:{resultId:String(r.id),fingerprint:r.fingerprint,samples:r.report.series.observations},relatedIds:[experiment,...(graph.records.some((x:any)=>x.id===source)?[source]:[])]});
  graph.records.push({...base,id:experiment,kind:'experiment',name:r.name+' measurements',status:'descriptive_only',description:'Saved deterministic calculations; no AI request.',evidence:{resultId:String(r.id),statistics:r.report.statistics,patterns:r.report.patterns},relatedIds:[dataset]});
 }
 graph.counts.numericSnapshots=rows.length;graph.counts.numericAnalyses=rows.length;return graph;
}

