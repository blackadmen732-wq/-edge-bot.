import {InputError,object,string,digest,safeError} from './core.ts';
import {TOOLS,type Service} from './service.ts';
export type HttpDeps={service:Service;tokens:()=>Promise<{agent:string;owner:string}>;origins?:string[]};
async function equal(a:string,b:string){
 if(!a||!b)return false;const x=await digest(a),y=await digest(b);let n=0;for(let i=0;i<x.length;i++)n|=x.charCodeAt(i)^y.charCodeAt(i);return n===0;
}
async function body(req:Request){
 if(!req.body)throw new InputError('Request body required');
 const reader=req.body.getReader(),chunks:Uint8Array[]=[];let length=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;
  if(length>2_000_000){await reader.cancel();throw new InputError('Request body too large');}chunks.push(value);}
 }finally{reader.releaseLock();}
 const all=new Uint8Array(length);let i=0;for(const c of chunks){all.set(c,i);i+=c.length;}
 try{return object(JSON.parse(new TextDecoder().decode(all)));}catch(e){if(e instanceof InputError)throw e;throw new InputError('Invalid JSON');}
}
export function handler(deps:HttpDeps){return async(req:Request):Promise<Response>=>{
 const url=new URL(req.url),origin=req.headers.get('origin');
 const originOk=!origin||origin===url.origin||(deps.origins??[]).includes(origin);
 const headers:Record<string,string>={'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'};
 if(origin&&originOk){headers['access-control-allow-origin']=origin;headers.vary='Origin';}
 const respond=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers});
 if(!originOk)return respond({error:'Origin not allowed'},403);
 if(req.method==='OPTIONS'){headers['access-control-allow-methods']='GET, POST, OPTIONS';headers['access-control-allow-headers']='authorization, content-type, accept, mcp-protocol-version';return new Response(null,{status:204,headers});}
 let rpcId:any;
 try{
  const tokens=await deps.tokens(),supplied=req.headers.get('authorization')?.replace(/^Bearer\s+/i,'')??'';
  if(supplied.length>512)return respond({error:'Unauthorized'},401);
  const owner=await equal(supplied,tokens.owner),agent=owner||await equal(supplied,tokens.agent);
  if(!agent)return respond({error:'Unauthorized'},401);
  const actor=(owner?'owner:':'connector:')+(await digest(supplied)).slice(0,16);
  const mcp=url.pathname.endsWith('/mcp');
  if(mcp){
   if(req.method!=='POST'){headers.allow='POST';return respond({error:'This server uses stateless JSON responses; SSE is not offered'},405);}
   const msg=await body(req);rpcId=msg.id;
   if(msg.jsonrpc!=='2.0'||typeof msg.method!=='string'||(rpcId!==undefined&&typeof rpcId!=='number'&&typeof rpcId!=='string'))return respond({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid request'}},400);
   if(rpcId===undefined){if(msg.method==='notifications/initialized')return new Response(null,{status:202,headers});return respond({error:'Unsupported notification'},400);}
   let result:any;
   if(msg.method==='initialize'){
    const versions=['2025-11-25','2025-06-18','2025-03-26'];const requested=msg.params?.protocolVersion;
    result={protocolVersion:versions.includes(requested)?requested:versions[0],capabilities:{tools:{listChanged:false}},serverInfo:{name:'edge-research',version:'1.0.0'}};
   }else if(msg.method==='ping')result={};
   else if(msg.method==='tools/list')result={tools:TOOLS};
   else if(msg.method==='tools/call'){
    try{const p=object(msg.params);const data=await deps.service.call(string(p.name,'tool name'),p.arguments??{},actor);
     result={content:[{type:'text',text:JSON.stringify(data)}],isError:false};
    }catch(e){result={content:[{type:'text',text:safeError(e)}],isError:true};}
   }else return respond({jsonrpc:'2.0',id:rpcId,error:{code:-32601,message:'Method not found'}});
   return respond({jsonrpc:'2.0',id:rpcId,result});
  }
  const task=url.searchParams.get('task')??'health';
  if(req.method==='GET'&&task==='health')return respond(await deps.service.call('get_data_health',{},actor));
  if(req.method==='GET'&&task==='universe')return respond(await deps.service.call('get_universe',{},actor));
  if(req.method!=='POST')return respond({error:'Method not allowed'},405);
  if(task==='worker')return respond(await deps.service.worker());
  if(task==='collect')return respond(await deps.service.collect());
  const input=await body(req);
  if(task==='chat')return respond(await deps.service.chat(input,actor));
  if(task==='credentials'){
   if(!owner)return respond({error:'Owner credential required'},403);
   return respond(await deps.service.configure(input,actor));
  }
  if(task==='promote'){
   if(!owner)return respond({error:'Owner credential required'},403);
   return respond(await deps.service.promote(input.id,actor));
  }
  if(task==='tool')return respond(await deps.service.call(string(input.name,'tool name'),input.arguments??{},actor));
  return respond({error:'Unknown task'},404);
 }catch(e){return respond(rpcId!==undefined?{jsonrpc:'2.0',id:rpcId,error:{code:-32603,message:safeError(e)}}:{error:safeError(e)},e instanceof InputError?400:500);}
};}
