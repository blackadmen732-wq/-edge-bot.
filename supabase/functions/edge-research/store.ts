import { InputError, object, string, date, examples, digest, type Example } from './core.ts';
import {PROVIDERS,providerName,providerKey,type Provider} from './connections.ts';
export interface Sql {
 (strings: TemplateStringsArray, ...values: any[]): Promise<any[]>;
 json(value: any): any;
 begin<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
}
export class Store {
 sql:Sql;
 constructor(sql:Sql){this.sql=sql;}
 async tokens(): Promise<{agent:string;owner:string}> {
  const rs = await this.sql`select name,decrypted_secret from vault.decrypted_secrets where name in ('edgebot_research_token','edgebot_research_owner_token')`;
  return {agent:rs.find(r=>r.name==='edgebot_research_token')?.decrypted_secret??'',owner:rs.find(r=>r.name==='edgebot_research_owner_token')?.decrypted_secret??''};
 }
 async health() {
  const sources = await this.sql`select s.id,s.track,s.name,s.enabled,s.expected_seconds,
   count(o.id)::int as observations,max(o.recorded_at) as last_received,
   case when count(o.id)=0 then 'no_data' when max(o.recorded_at)<now()-make_interval(secs=>s.expected_seconds*2) then 'stale' else 'receiving' end as status
   from edgebot_research.sources s left join edgebot_research.observations o on o.source=s.id
   group by s.id order by s.track,s.id`;
  const [counts] = await this.sql`select (select count(*)::int from edgebot_research.datasets) as datasets,
   (select count(*)::int from edgebot_research.examples) as examples,
   (select count(*)::int from edgebot_research.jobs where status in ('pending','running')) as queued,
   (select count(*)::int from edgebot_research.jobs where status='failed') as failed,
   (select count(*)::int from edgebot_research.usage where created_at>=date_trunc('day',now())) as ai_requests_today,
   (select coalesce(sum(input_tokens),0) from edgebot_research.usage) as recorded_input_tokens,
   (select coalesce(sum(output_tokens),0) from edgebot_research.usage) as recorded_output_tokens,
   (select sum(actual_cost_usd) from edgebot_research.usage) as measured_ai_cost_usd`;
  return {sources,counts,execution:'analysis_only',schemaVersion:1};
 }
 async datasets() {return this.sql`select id,name,fingerprint,jsonb_array_length(examples) as samples,created_at from edgebot_research.datasets order by created_at desc limit 30`;}
 async jobs() {return this.sql`select id,kind,dataset_id,status,attempts,created_at,finished_at,error from edgebot_research.jobs order by created_at desc limit 30`;}
 async models() {return this.sql`select id,job_id,parameters,state,created_at from edgebot_research.models order by created_at desc limit 30`;}
 async hypotheses() {return this.sql`select id,question,evidence,status,created_at from edgebot_research.hypotheses order by created_at desc limit 30`;}
 async chatHistory(actor:string,role:string) {
  const rows=await this.sql`select details,created_at from edgebot_research.events where actor=${actor} and action='chat_turn' and details->>'role'=${role} order by id desc limit 8`;
  return rows.reverse().map(r=>({...r.details,at:r.created_at}));
 }
 async audit(actor: string, action: string, details: any = {}) {
  await this.sql`insert into edgebot_research.events(actor,action,details) values(${actor},${action},${this.sql.json(details)})`;
 }
 async importObservations(value: any, actor: string, native=false) {
  if (!Array.isArray(value) || value.length<1 || value.length>200) throw new InputError('Import 1 to 200 observations');
  const rows = value.map(v=>{
   const x=object(v), payload=object(x.payload);
   if (JSON.stringify(payload).length>12000) throw new InputError('Observation payload too large');
   const availableAt=date(x.availableAt,'availableAt');
   if(Date.parse(availableAt)>Date.now()+5000) throw new InputError('availableAt cannot be in the future');
   const nativeSources=['kraken.spot','frankfurter.fx','nws.forecast','alphavantage.equities','alphavantage.commodities','odds.sports'];
   if(!String(x.source).endsWith('.import')&&!(native&&nativeSources.includes(x.source)))throw new InputError('Imports must use an import source');
   return {source:string(x.source,'source'),externalId:string(x.externalId,'externalId'),
    eventAt:date(x.eventAt,'eventAt'),availableAt,payload};
  });
  return this.sql.begin(async tx=>{
   let inserted=0;
   for(const r of rows) {
    const [source]=await tx`select id from edgebot_research.sources where id=${r.source} and enabled`;
    if(!source) throw new InputError('Unknown or disabled source');
    const hash=await digest(r.payload);
    const rs=await tx`insert into edgebot_research.observations(source,external_id,payload,payload_hash,event_at,available_at)
     values(${r.source},${r.externalId},${tx.json(r.payload)},${hash},${r.eventAt},${r.availableAt}) on conflict do nothing returning id`;
    inserted+=rs.length;
   }
   await tx`insert into edgebot_research.events(actor,action,details) values(${actor},'import_observations',${tx.json({submitted:rows.length,inserted})})`;
   return {submitted:rows.length,inserted};
  });
 }
 async createDataset(input: any, actor: string) {
  const x=object(input),name=string(x.name,'name');
  const inputRows=x.examples ?? (await this.sql`select value from edgebot_research.examples order by id limit 5001`).map(r=>r.value);
  const rows=examples(inputRows).sort((a,b)=>a.predictedAt.localeCompare(b.predictedAt)||a.id.localeCompare(b.id));
  if(!rows.length) throw new InputError('No examples yet; import a dataset or wait for recorded outcomes');
  const fingerprint=await digest(rows);
  const added=await this.sql`insert into edgebot_research.datasets(name,fingerprint,examples)
   values(${name},${fingerprint},${this.sql.json(rows)}) on conflict(fingerprint) do nothing returning id,name,fingerprint,created_at`;
  const r=added[0]??(await this.sql`select id,name,fingerprint,created_at from edgebot_research.datasets where fingerprint=${fingerprint}`)[0];
  await this.audit(actor,'create_dataset',{datasetId:r.id,samples:rows.length});
  return {...r,samples:rows.length};
 }
 async dataset(id: string): Promise<{id:string;examples:Example[];fingerprint:string}> {
  const [r]=await this.sql`select id,examples,fingerprint from edgebot_research.datasets where id=${id}`;
  if(!r) throw new InputError('Dataset not found');return r;
 }
 async enqueue(input: any, actor: string) {
  const x=object(input),kind=string(x.kind,'kind'), datasetId=string(x.datasetId,'datasetId');
  if(!['diagnose','calibrate','agent'].includes(kind)) throw new InputError('Unknown analysis kind');
  await this.dataset(datasetId);
  const key=string(x.requestId,'requestId',100), hash=await digest({kind,datasetId,version:1});
  return this.sql.begin(async tx=>{
   const [r]=await tx`insert into edgebot_research.jobs(kind,dataset_id,idempotency_key,request_hash)
    values(${kind},${datasetId},${key},${hash}) on conflict(idempotency_key) do update set idempotency_key=excluded.idempotency_key
    returning id,kind,dataset_id,status,request_hash`;
   if(r.request_hash!==hash) throw new InputError('requestId already belongs to a different operation');
   await tx`insert into edgebot_research.events(actor,action,details) values(${actor},'enqueue',${tx.json({jobId:r.id,kind})})`;
   return r;
  });
 }
 async getJob(id: string) {
  const [r]=await this.sql`select id,kind,dataset_id,status,attempts,result,error,created_at,finished_at from edgebot_research.jobs where id=${id}`;
  if(!r)throw new InputError('Job not found');return r;
 }
 async claim() {
  return this.sql.begin(async tx=>{
   await tx`update edgebot_research.jobs set status='failed',error='Retry limit reached',finished_at=now()
    where status='running' and lease_until<now() and attempts>=3`;
   const [j]=await tx`select id from edgebot_research.jobs where attempts<3 and
    (status='pending' or (status='running' and lease_until<now())) order by created_at for update skip locked limit 1`;
   if(!j)return null;
   const [r]=await tx`update edgebot_research.jobs set status='running',attempts=attempts+1,
    lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes' where id=${j.id} returning *`;
   return r;
  });
 }
 async finish(job: any, result: any, error: string | null=null) {
  return this.sql.begin(async tx=>{
   const rs=await tx`update edgebot_research.jobs set status=${error?'failed':'succeeded'},
    result=${tx.json(result)},error=${error},finished_at=now(),lease_until=null
    where id=${job.id} and status='running' and lease_token=${job.lease_token} and lease_until>now() returning id`;
   if(!rs.length)return false;
   if(!error&&job.kind==='calibrate'&&result.status==='evaluated')
    await tx`insert into edgebot_research.models(job_id,parameters) values(${job.id},${tx.json(result.model)}) on conflict(job_id) do nothing`;
   return true;
  });
 }
 async propose(input:any,actor:string) {
  const x=object(input),question=string(x.question,'question',2000);
  const evidence=x.evidence??[];if(!Array.isArray(evidence)||JSON.stringify(evidence).length>5000)throw new InputError('Invalid evidence');
  const fingerprint=await digest({question,evidence});
  const added=await this.sql`insert into edgebot_research.hypotheses(question,evidence,fingerprint) values(${question},${this.sql.json(evidence)},${fingerprint}) on conflict(fingerprint) do nothing returning *`;
  const r=added[0]??(await this.sql`select * from edgebot_research.hypotheses where fingerprint=${fingerprint}`)[0];
  await this.audit(actor,'propose_hypothesis',{id:r.id});return r;
 }
 async promote(id:string,actor:string) {
  return this.sql.begin(async tx=>{
   await tx`select pg_advisory_xact_lock(174523,1)`;
   const [m]=await tx`select m.*,j.result from edgebot_research.models m join edgebot_research.jobs j on j.id=m.job_id where m.id=${id} for update of m`;
   if(!m||m.state!=='candidate'||m.result?.recommendation!=='review_candidate')throw new InputError('Model has no eligible improvement result');
   await tx`update edgebot_research.models set state='retired' where state='active'`;
   await tx`update edgebot_research.models set state='active' where id=${id}`;
   await tx`insert into edgebot_research.events(actor,action,details) values(${actor},'activate_research_model',${tx.json({id})})`;
   return {id,state:'active',scope:'research_only'};
  });
 }
 async reserveUsage(jobId:string|null,model:string) {
  return this.sql.begin(async tx=>{
   await tx`select pg_advisory_xact_lock(174523,2)`;
   const [r]=await tx`select count(*)::int as n from edgebot_research.usage where created_at>=date_trunc('day',now())`;
   if(r.n>=20)throw new InputError('Daily AI request budget reached');
   const [u]=await tx`insert into edgebot_research.usage(job_id,model) values(${jobId},${model}) returning id`;return u.id;
  });
 }
 async finishUsage(id:number,usage:any,status:string) {
  const valid=(x:any)=>typeof x==='number'&&Number.isInteger(x)&&x>=0?x:null;
  await this.sql`update edgebot_research.usage set input_tokens=coalesce(${valid(usage?.prompt_tokens)},input_tokens),output_tokens=coalesce(${valid(usage?.completion_tokens)},output_tokens),status=${status} where id=${id}`;
 }
 async providerKey(provider:Provider):Promise<string|null> {
  providerName(provider);
  const [r]=await this.sql`select decrypted_secret from vault.decrypted_secrets where name=${'edgebot_research_key_'+provider} limit 1`;
  return r?.decrypted_secret??null;
 }
 async connections() {
  const names=await this.sql`select name from vault.secrets where name like 'edgebot_research_key_%'`;
  const last=await this.sql`select details,created_at from edgebot_research.events where action='collect_connections' order by created_at desc limit 1`;
  return {providers:Object.entries(PROVIDERS).map(([id,details])=>({id,...details,keyConfigured:names.some(r=>r.name==='edgebot_research_key_'+id)})),lastCollection:last[0]??null};
 }
 async setProviderKey(input:unknown,actor:string) {
  const x=object(input),provider=providerName(x.provider),value=providerKey(x.value),name='edgebot_research_key_'+provider;
  await this.sql.begin(async tx=>{
   await tx`select pg_advisory_xact_lock(174523,4)`;
   const [existing]=await tx`select id from vault.secrets where name=${name}`;
   if(existing)await tx`select vault.update_secret(${existing.id}::uuid,${value},${name},'Edge Bot research provider credential')`;
   else await tx`select vault.create_secret(${value},${name},'Edge Bot research provider credential')`;
   await tx`insert into edgebot_research.events(actor,action,details) values(${actor},'configure_provider',${tx.json({provider,configured:true})})`;
  });return {provider,keyConfigured:true,validation:'not_tested'};
 }
 async claimCollection():Promise<string|null> {
  return this.sql.begin(async tx=>{
   await tx`select pg_advisory_xact_lock(174523,5)`;
   const [r]=await tx`select value from edgebot_research.configuration where key='collector_lease'`;
   if(r&&JSON.parse(r.value).until>Date.now())return null;
   const id=crypto.randomUUID(),value=JSON.stringify({id,until:Date.now()+120000});
   await tx`insert into edgebot_research.configuration(key,value) values('collector_lease',${value}) on conflict(key) do update set value=excluded.value`;return id;
  });
 }
 async releaseCollection(id:string){await this.sql`delete from edgebot_research.configuration where key='collector_lease' and (value::jsonb->>'id')=${id}`;}
 async collectionDue(source:string,seconds:number){
  const [r]=await this.sql`select value from edgebot_research.configuration where key=${'collection:'+source}`;
  return !r||Date.now()-Date.parse(r.value)>=seconds*1000;
 }
 async markCollected(source:string){
  await this.sql`insert into edgebot_research.configuration(key,value) values(${'collection:'+source},${new Date().toISOString()}) on conflict(key) do update set value=excluded.value`;
 }
 async reserveDataRequest(provider:string,max:number){
  return this.sql.begin(async tx=>{
   await tx`select pg_advisory_xact_lock(174523,6)`;
   const key='data_budget:'+provider+':'+new Date().toISOString().slice(0,10);
   const [r]=await tx`select value from edgebot_research.configuration where key=${key}`;const n=Number(r?.value??0);
   if(n>=max)throw new InputError('Daily provider request budget reached');
   await tx`insert into edgebot_research.configuration(key,value) values(${key},${String(n+1)}) on conflict(key) do update set value=excluded.value`;
  });
 }
}
