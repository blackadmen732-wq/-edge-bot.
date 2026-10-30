// Read-only presentation of existing archived research metadata. It does not infer
// relationships from visual proximity, create market signals, or expose raw secrets.
type Rows = Record<string, any>[];
const time=(v:unknown)=> {
  const d=v ? new Date(v as string) : new Date(0);
  return Number.isFinite(d.valueOf()) ? d.toISOString() : new Date(0).toISOString();
};
const market=(v:unknown)=>{
  const x=String(v||'').toLowerCase();
  return ({sports:'prediction',fx:'forex',currencies:'forex',stocks:'equities',equity:'equities'} as Record<string,string>)[x] ?? (['crypto','equities','commodities','prediction','weather'].includes(x)?x:'other');
};
const key=(prefix:string,v:unknown)=>prefix+':'+String(v);
const status=(v:unknown)=>String(v??'unknown');
export function buildResearchUniverse(data:{sources:Rows;datasets:Rows;jobs:Rows;models:Rows;hypotheses:Rows}) {
  const sourceRows=data.sources.slice(0,100), datasetRows=data.datasets.slice(0,30), jobRows=data.jobs.slice(0,30), modelRows=data.models.slice(0,30), hypothesisRows=data.hypotheses.slice(0,30);
  const datasetIds=new Set(datasetRows.map(x=>key('dataset',x.id)));
  const jobIds=new Set(jobRows.map(x=>key('experiment',x.id)));
  const records:any[]=[];
  for(const x of sourceRows)records.push({
    id:key('source',x.id),kind:'source',name:String(x.name||'Unnamed source'),market:market(x.track),
    status:status(x.status),updatedAt:time(x.last_received),
    description:'Recorded observations: '+String(Number(x.observations??0))+' · expected freshness: '+String(Number(x.expected_seconds??0))+'s',
    provenance:{source:String(x.name||'unknown'),observedAt:x.last_received?time(x.last_received):null,version:'research-archive'},
    evidence:{track:x.track,observations:Number(x.observations??0),lastReceived:x.last_received??null,collectorStatus:x.status},
    relatedIds:[],
  });
  for(const x of datasetRows)records.push({
    id:key('dataset',x.id),kind:'dataset',name:String(x.name||'Unnamed dataset'),market:'other',status:'snapshot',
    updatedAt:time(x.created_at),description:'Immutable dataset snapshot · '+String(Number(x.samples??0))+' examples',
    provenance:{source:'existing research archive',version:String(x.fingerprint||'unknown')},
    evidence:{datasetId:x.id,exampleCount:Number(x.samples??0),fingerprint:x.fingerprint??null},
    relatedIds:jobRows.filter(j=>j.dataset_id===x.id).map(j=>key('experiment',j.id)),
  });
  for(const x of jobRows)records.push({
    id:key('experiment',x.id),kind:'experiment',name:String(x.kind||'Analysis')+' · '+String(x.id).slice(0,8),market:'other',
    status:status(x.status),updatedAt:time(x.finished_at??x.created_at),
    description:'Bounded research job; a completed job is not evidence of profitable predictions',
    provenance:{source:'existing research worker',version:'research-1',observedAt:time(x.created_at)},
    evidence:{jobId:x.id,kind:x.kind,attempts:x.attempts,status:x.status},
    relatedIds:datasetIds.has(key('dataset',x.dataset_id))?[key('dataset',x.dataset_id)]:[],
  });
  for(const x of modelRows)records.push({
    id:key('model',x.id),kind:'experiment',name:'Research model · '+String(x.id).slice(0,8),market:'other',
    status:status(x.state),updatedAt:time(x.created_at),description:'Research-only model record; cannot authorize execution',
    provenance:{source:'research model registry',version:'research-1'},
    evidence:{modelId:x.id,state:x.state,parameters:x.parameters??null},
    relatedIds:jobIds.has(key('experiment',x.job_id))?[key('experiment',x.job_id)]:[],
  });
  for(const x of hypothesisRows)records.push({
    id:key('hypothesis',x.id),kind:'pattern',name:String(x.question||'Unverified hypothesis').slice(0,150),market:'other',
    status:'hypothesis_only',updatedAt:time(x.created_at),
    description:'Proposed research question, not a validated discovered pattern',
    provenance:{source:'research hypothesis registry',version:String(x.fingerprint||'unversioned')},
    evidence:{hypothesisId:x.id,evidence:x.evidence??[],status:x.status??'unverified'},
    relatedIds:[],
  });
  return {mode:'private_research',records:records.slice(0,220),counts:{
    sources:sourceRows.length,datasets:datasetRows.length,analysisJobs:jobRows.length,
    researchModels:modelRows.length,hypotheses:hypothesisRows.length,
  },notes:['Only documented dataset/job/model associations become graph edges.','Source proximity does not imply a correlation.','No private credentials or raw transaction instructions are included.']};
}
