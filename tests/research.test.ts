import test from 'node:test';
import assert from 'node:assert/strict';
import {example,examples,metrics,diagnose,calibrate,InputError,safeError,digest} from '../supabase/functions/edge-research/core.ts';
import {handler} from '../supabase/functions/edge-research/http.ts';
import {Service} from '../supabase/functions/edge-research/service.ts';
import {runAgent} from '../supabase/functions/edge-research/agent.ts';
const row=(id=0,extra:any={})=>({id:String(id),predictedAt:new Date(Date.UTC(2025,0,1+id)).toISOString(),availableAt:new Date(Date.UTC(2025,0,1+id)).toISOString(),outcomeAt:new Date(Date.UTC(2025,0,1+id,1)).toISOString(),probability:0.2,outcome:id%2===0,result:null,cost:null,group:'a',flags:[],...extra});
test('data validation rejects hindsight, false labels, invalid probabilities and duplicate IDs',()=>{
 assert.throws(()=>example(row(0,{availableAt:'2026-01-01'})),/after/);
 assert.throws(()=>example(row(0,{outcome:'false'})),/outcome/);
 assert.throws(()=>example(row(0,{probability:NaN})),/probability/);
 assert.throws(()=>example(row(0,{probability:2})),/probability/);
 assert.throws(()=>example(row(0,{outcomeAt:null})),/require/);
 assert.throws(()=>examples([row(),row()]),/Duplicate/);
 assert.throws(()=>example(row(0,{cost:-1})),/cost/);
});
test('unknown results are not converted into zero, and extreme Brier scores are exact',()=>{
 const report=metrics([example(row(0,{outcome:null,outcomeAt:null}))]);
 assert.equal(report.brier,null);assert.equal(report.recordedResult,null);assert.equal(report.recordedCosts,null);
 assert.equal(metrics([example(row(0,{probability:1,outcome:true}))]).brier,0);
 assert.equal(metrics([example(row(0,{probability:0,outcome:true}))]).brier,1);
});
test('failure analysis compares gains, losses and unflagged controls without claiming causation',()=>{
 const r=diagnose([example(row(0,{result:-4,cost:1,flags:['stale']})),example(row(1,{result:7,cost:2})),example(row(2,{outcome:null,outcomeAt:null}))]);
 assert.equal(r.summary.recordedResult,3);assert.equal(r.summary.recordedCosts,3);
 assert.equal(r.summary.unresolved,1);assert.equal(r.groups[0].losses,1);assert.equal(r.groups[0].gains,1);
 assert.equal(r.flags[0].withFlag.total,1);assert.equal(r.flags[0].withoutFlag.total,2);
 assert.equal(r.flags[0].evidence,'association_only');
});
test('large high-cardinality datasets have bounded diagnostic output',()=>{
 const r=diagnose(Array.from({length:5000},(_,i)=>example(row(i,{group:'g'+i,flags:['f'+i]}))));
 assert.equal(r.groups.length,30);assert.equal(r.flags.length,30);assert.equal(r.omittedGroups,4970);
});
test('calibration trains on earlier resolved labels and holds later examples out',()=>{
 const r:any=calibrate(Array.from({length:90},(_,i)=>example(row(i))));
 assert.equal(r.status,'evaluated');assert.equal(r.test,30);assert.equal(r.model.offset,0.2);
 assert(r.improvement>0);assert.equal(r.recommendation,'review_candidate');
});
test('late outcomes cannot leak into calibration training',()=>{
 const r:any=calibrate(Array.from({length:90},(_,i)=>example(row(i,{outcomeAt:'2026-12-01T00:00:00Z'}))));
 assert.equal(r.status,'insufficient_temporal_separation');assert.equal(r.train,0);
 assert.equal(calibrate([]).status,'insufficient_data');
});
test('perfect predictions are retained and worse recalibration is not promoted',()=>{
 const r:any=calibrate(Array.from({length:90},(_,i)=>example(row(i,{probability:i%2===0?1:0}))));
 assert.equal(r.baseline.brier,0);assert.equal(r.recommendation,'retain_baseline');
});
test('secret-bearing runtime errors never reach the API',()=>{
 assert.equal(safeError(new Error('https://example.com?key=secret')),'Operation failed; inspect the server run ID');
 assert.equal(safeError(new InputError('Missing field')),'Missing field');
});
function httpFixture(){
 const calls:any[]=[];const service:any={call:async(...args:any[])=>{calls.push(args);return {ok:true};},worker:async()=>({processed:0}),promote:async()=>({state:'active'})};
 return {calls,handle:handler({service,tokens:async()=>({agent:'agent-secret',owner:'owner-secret'}),origins:['http://localhost:8000']})};
}
const request=(path:string,body?:any,token='agent-secret',headers:any={})=>new Request('https://example.test/functions/v1/edge-research'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
test('every research route and MCP discovery require authentication',async()=>{
 const {handle,calls}=httpFixture();assert.equal((await handle(request('?task=health',undefined,''))).status,401);
 assert.equal((await handle(request('/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'},''))).status,401);assert.equal(calls.length,0);
});
test('MCP handshake, notification, discovery and tool calls use JSON-RPC envelopes',async()=>{
 const {handle}=httpFixture();
 const init=await (await handle(request('/mcp',{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}}))).json();
 assert.equal(init.result.protocolVersion,'2025-06-18');
 assert.equal((await handle(request('/mcp',{jsonrpc:'2.0',method:'notifications/initialized'}))).status,202);
 const list=await (await handle(request('/mcp',{jsonrpc:'2.0',id:2,method:'tools/list'}))).json();assert(list.result.tools.length>=10);
 assert(!list.result.tools.some((x:any)=>/trade|withdraw|promote/i.test(x.name)));
 const result=await(await handle(request('/mcp',{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_data_health'}}))).json();assert.equal(result.result.isError,false);
});
test('MCP rejects batches, invalid IDs and unsupported methods',async()=>{
 const {handle}=httpFixture();assert.equal((await handle(request('/mcp',[]))).status,400);
 assert.equal((await handle(request('/mcp',{jsonrpc:'2.0',id:{},method:'ping'}))).status,400);
 const r=await(await handle(request('/mcp',{jsonrpc:'2.0',id:1,method:'unknown'}))).json();assert.equal(r.error.code,-32601);
});
test('unexpected origins and agent attempts to activate a model are denied',async()=>{
 const {handle}=httpFixture();assert.equal((await handle(request('?task=health',undefined,'agent-secret',{origin:'https://hostile.test'}))).status,403);
 assert.equal((await handle(request('?task=promote',{id:'test'}))).status,403);
 assert.equal((await handle(request('?task=promote',{id:'test'},'owner-secret'))).status,200);
});
test('oversized payload is rejected before JSON parsing',async()=>{
 const {handle}=httpFixture();const req=new Request('https://example.test/mcp',{method:'POST',headers:{authorization:'Bearer agent-secret'},body:'x'.repeat(2_000_001)});
 assert.equal((await handle(req)).status,400);
});
test('service rejects invented tools, extra arguments, and malformed dataset IDs',async()=>{
 const s=new Service({audit:async()=>{}} as any);
 await assert.rejects(()=>s.call('execute_trade',{},'test'),/Unknown/);
 await assert.rejects(()=>s.call('get_data_health',{sql:'drop table'},'test'),/Unexpected/);
 await assert.rejects(()=>s.call('diagnose_dataset',{datasetId:'not-an-id'},'test'),/Invalid ID/);
});
test('AI review is off without a key and cannot execute unlisted tools',async()=>{
 const usage:any[]=[];const s:any={store:{reserveUsage:async()=>1,finishUsage:async(...a:any[])=>usage.push(a)},call:async()=>{throw Error('must not execute');}};
 const d={id:'dataset',fingerprint:await digest([]),examples:[]};
 await assert.rejects(()=>runAgent(s,{id:'job'},d,{}),/not configured/);
 await assert.rejects(()=>runAgent(s,{id:'job'},d,{key:'not-printed',fetch:async()=>Response.json({choices:[{message:{tool_calls:[{id:'1',function:{name:'execute_trade',arguments:'{}'}}]}}]})}),/outside/);
});
test('AI usage is recorded and final interpretation is labeled as a hypothesis',async()=>{
 let calls=0;const s:any={store:{reserveUsage:async()=>++calls,finishUsage:async()=>{}},call:async()=>({ok:true})};
 const result=await runAgent(s,{id:'job'},{id:'d',examples:[]},{key:'test',fetch:async()=>Response.json({usage:{prompt_tokens:20,completion_tokens:5},choices:[{message:{content:'Insufficient evidence.'}}]})});
 assert.equal(result.status,'reviewed');assert.equal(calls,1);assert.match(result.limitation,/hypothesis/);
});
