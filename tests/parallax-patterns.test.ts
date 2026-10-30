import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeNumericSeries} from '../supabase/functions/edge-research/patterns.ts';
import {buildResearchUniverse} from '../supabase/functions/edge-research/universe.ts';
import {Service} from '../supabase/functions/edge-research/service.ts';
import {handler} from '../supabase/functions/edge-research/http.ts';

const start=Date.parse('2026-10-28T12:00:00Z');
function series(step=0.5, count=40):any {
 const points=Array.from({length:count},(_,i)=>{
  const time=new Date(start+i*60000).toISOString();
  return {time,availableAt:time,value:100+i*step};
 });
 return {name:'Research series',source:'Test fixture, not a provider',market:'crypto',asOf:points.at(-1).time,points};
}
test('numeric pattern analyzer detects a high breakout but never claims a trading edge',()=>{
 const r=analyzeNumericSeries(series());
 assert.equal(r.status,'descriptive_only');
 assert.equal(r.canExecuteTrades,false);
 assert.equal(r.source.verification,'caller_supplied_unverified');
 assert(r.patterns.some(x=>x.kind==='range_breakout_up'&&x.validation==='untested'));
 assert(r.limitations.some(x=>x.includes('out-of-sample')));
});
test('falling sequence yields downward breakout',()=>{
 const r=analyzeNumericSeries(series(-0.5));
 assert(r.patterns.some(x=>x.kind==='range_breakout_down'));
});
test('constant values do not fabricate a z-score or breakout',()=>{
 const r=analyzeNumericSeries(series(0));
 assert.equal(r.statistics.lastVsPrior20MeanZ,null);
 assert.equal(r.patterns.length,0);
 assert.equal(r.statistics.recentReturnVolatilityPct,0);
});
test('future inputs, duplicated observations and invented availability are blocked',()=>{
 const a=series();a.points.at(-1).availableAt='2026-11-01T12:00:00Z';
 assert.throws(()=>analyzeNumericSeries(a),/Future information/);
 const b=series();b.points[30].time=b.points[29].time;
 assert.throws(()=>analyzeNumericSeries(b),/Duplicate or unsorted/);
 const c=series();c.points[5].availableAt='2026-10-27T12:00:00Z';
 assert.throws(()=>analyzeNumericSeries(c),/cannot be available before/);
 const d=series();d.points[2].value=Number.NaN;
 assert.throws(()=>analyzeNumericSeries(d),/Invalid positive numeric/);
});
test('min length and invalid market cannot bypass validation',()=>{
 const a=series();a.points=a.points.slice(0,29);
 assert.throws(()=>analyzeNumericSeries(a),/30 to 2000/);
 const b=series();b.market='forever_profit';
 assert.throws(()=>analyzeNumericSeries(b),/Unknown market/);
});
const rows={
 sources:[{id:'s1',name:'Daily currency research',track:'fx',status:'receiving',observations:8,last_received:'2026-10-29T20:00:00Z',expected_seconds:86400}],
 datasets:[{id:'d1',name:'Historical experiment',created_at:'2026-10-29T20:00:00Z',fingerprint:'abc',samples:100}],
 jobs:[{id:'j1',dataset_id:'d1',kind:'diagnose',status:'succeeded',attempts:1,created_at:'2026-10-29T20:00:00Z',finished_at:'2026-10-29T20:02:00Z'}],
 models:[{id:'m1',job_id:'j1',state:'candidate',parameters:{offset:0},created_at:'2026-10-29T20:03:00Z'}],
 hypotheses:[{id:'h1',question:'Does a reported pattern repeat?',created_at:'2026-10-29T20:05:00Z',fingerprint:'h',evidence:[{source:'test'}]}],
};
test('universe includes only known dataset/job/model links and marks hypotheses unverified',()=>{
 const r=buildResearchUniverse(rows);
 assert.equal(r.mode,'private_research');
 assert.equal(r.records.length,5);
 assert.equal(r.records.find(x=>x.id==='source:s1').market,'forex');
 assert.deepEqual(r.records.find(x=>x.id==='dataset:d1').relatedIds,['experiment:j1']);
 assert.deepEqual(r.records.find(x=>x.id==='experiment:j1').relatedIds,['dataset:d1']);
 assert.deepEqual(r.records.find(x=>x.id==='model:m1').relatedIds,['experiment:j1']);
 assert.deepEqual(r.records.find(x=>x.id==='hypothesis:h1').relatedIds,[]);
 assert.equal(r.records.find(x=>x.id==='hypothesis:h1').status,'hypothesis_only');
 assert.equal(r.notes.some(x=>x.includes('does not imply a correlation')),true);
});
test('existing research service exposes two new read-only tools',async()=>{
 let audited=0;
 const store:any={
  health:async()=>({sources:rows.sources}),datasets:async()=>rows.datasets,
  jobs:async()=>rows.jobs,models:async()=>rows.models,hypotheses:async()=>rows.hypotheses,
  audit:async()=>{audited++},
 };
 const service=new Service(store);
 const graph=await service.call('get_universe',{},'test');
 assert.equal(graph.counts.sources,1);
 const measured=await service.call('analyze_numeric_series',series(),'test');
 assert.equal(measured.status,'descriptive_only');
 assert.equal(audited,2);
 await assert.rejects(()=>service.call('analyze_numeric_series',{...series(),sql:'DROP TABLE'},'test'),/Unexpected tool argument/);
});
test('universe HTTP endpoint requires authentication and invokes existing tool',async()=>{
 const calls:string[]=[];
 const service:any={call:async(name:string)=>{calls.push(name);return {records:[]};}};
 const route=handler({service,tokens:async()=>({agent:'agent-secret',owner:'owner-secret'})});
 const url='https://example.test/functions/v1/edge-research?task=universe';
 assert.equal((await route(new Request(url))).status,401);
 const res=await route(new Request(url,{headers:{authorization:'Bearer owner-secret'}}));
 assert.equal(res.status,200);
 assert.deepEqual(calls,['get_universe']);
});
