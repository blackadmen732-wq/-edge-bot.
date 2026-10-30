import {chat} from './chat.ts';
import {object,string,InputError,diagnose,calibrate,safeError} from './core.ts';
import type {Store} from './store.ts';
import {runAgent,type AgentConfig} from './agent.ts';
import {collectConnections} from './connections.ts';
const uuid=(v:unknown)=>{
 const id=string(v,'id');if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new InputError('Invalid ID');return id;
};
const schema=(properties:Record<string,unknown>={},required:string[]=[])=>({type:'object',properties,required,additionalProperties:false});
const text={type:'string'};
export const TOOLS=[
 {name:'get_data_health',description:'Read research source freshness, coverage, queue and configuration health.',inputSchema:schema()},
 {name:'get_connections',description:'Read provider configuration presence and collector results; never returns secret values.',inputSchema:schema()},
 {name:'list_datasets',description:'List immutable research datasets and their fingerprints.',inputSchema:schema()},
 {name:'create_dataset',description:'Snapshot recorded examples, or supplied educational observations, for reproducible testing.',inputSchema:schema({name:text,examples:{type:'array',maxItems:5000,items:{type:'object'}}},['name'])},
 {name:'diagnose_dataset',description:'Compare all recorded outcomes, groups and quality flags. Associations are not causes.',inputSchema:schema({datasetId:text},['datasetId'])},
 {name:'start_analysis_job',description:'Queue a bounded diagnosis, calibration experiment, or AI review. No external execution.',inputSchema:schema({datasetId:text,kind:{enum:['diagnose','calibrate','agent']},requestId:text},['datasetId','kind','requestId'])},
 {name:'get_job_status',description:'Read a queued analysis result, status and limitations.',inputSchema:schema({id:text},['id'])},
 {name:'list_experiments',description:'List recorded analysis jobs, including failures.',inputSchema:schema()},
 {name:'list_models',description:'Read candidate and active research model versions. These never change execution rules.',inputSchema:schema()},
 {name:'propose_hypothesis',description:'Record a research question with evidence for later evaluation.',inputSchema:schema({question:text,evidence:{type:'array',maxItems:30}},['question'])},
 {name:'list_hypotheses',description:'Read previous research questions and evidence.',inputSchema:schema()},
 {name:'import_observations',description:'Archive 1-200 timestamped records under a configured import source.',inputSchema:schema({observations:{type:'array',maxItems:200,items:{type:'object'}}},['observations'])},
] as const;
export class Service {
 store:Store;agentConfig:AgentConfig;
 constructor(store:Store,agentConfig:AgentConfig={}){this.store=store;this.agentConfig=agentConfig;}
 async call(name:string,input:unknown,actor:string):Promise<any> {
  const def=TOOLS.find(t=>t.name===name);if(!def)throw new InputError('Unknown research tool');
  const a=object(input??{}), allowed=Object.keys(def.inputSchema.properties);
  if(Object.keys(a).some(k=>!allowed.includes(k)))throw new InputError('Unexpected tool argument');
  let result:any;
  switch(name) {
   case 'get_data_health':result={...await this.store.health(),aiConfigured:!!this.agentConfig.key||!!await this.store.providerKey('xai'),aiModel:this.agentConfig.model??'grok-4.3'};break;
   case 'get_connections':result=await this.store.connections();break;
   case 'list_datasets':result=await this.store.datasets();break;
   case 'create_dataset':result=await this.store.createDataset(a,actor);break;
   case 'diagnose_dataset':result=diagnose((await this.store.dataset(uuid(a.datasetId))).examples);break;
   case 'start_analysis_job':uuid(a.datasetId);result=await this.store.enqueue(a,actor);break;
   case 'get_job_status':result=await this.store.getJob(uuid(a.id));break;
   case 'list_experiments':result=await this.store.jobs();break;
   case 'list_models':result=await this.store.models();break;
   case 'propose_hypothesis':result=await this.store.propose(a,actor);break;
   case 'list_hypotheses':result=await this.store.hypotheses();break;
   case 'import_observations':result=await this.store.importObservations(a.observations,actor);break;
  }
  await this.store.audit(actor,'tool:'+name,{ok:true});return result;
 }
 async chat(input:unknown,actor:string){return chat(this,input,actor);}
 async worker() {
  const job=await this.store.claim();if(!job)return {processed:0};
  try {
   const data=await this.store.dataset(job.dataset_id);
   const report=job.kind==='diagnose'?diagnose(data.examples):job.kind==='calibrate'?calibrate(data.examples):await runAgent(this,job,data,{...this.agentConfig,key:this.agentConfig.key||await this.store.providerKey('xai')||undefined});
   const result={...report,datasetFingerprint:data.fingerprint,analysisVersion:'research-1'};
   const recorded=await this.store.finish(job,result);
   return {processed:1,id:job.id,recorded};
  }catch(e){
   const error=safeError(e);const recorded=await this.store.finish(job,null,error);
   return {processed:1,id:job.id,recorded,error};
  }
 }
 async promote(id:unknown,actor:string){return this.store.promote(uuid(id),actor);}
 async configure(input:unknown,actor:string){return this.store.setProviderKey(input,actor);}
 async collect(){return collectConnections(this.store);}
}
