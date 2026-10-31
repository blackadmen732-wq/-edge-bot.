import test from 'node:test';
import assert from 'node:assert/strict';
import {patternMath,neuronMath,attentionMath,planningMath} from '../dashboard/desk/math-core.mjs';

const eq=(a,b)=>assert.ok(Math.abs(a-b)<1e-9, a+' ≠ '+b);
test('pattern mean excludes latest observation and breakout uses prior window',()=>{
 const x=patternMath([1,2,3,4,5,6]);
 eq(x.mean,3);eq(x.std,Math.sqrt(2));
 assert.equal(x.label,'Range breakout UP');eq(x.lastReturnPct,20);
 assert.equal(x.window,5);assert.equal(x.canTrade,false);
});
test('flat prices do not fabricate z score or breakout',()=>{
 const r=patternMath(Array(9).fill(100));
 assert.equal(r.z,null);assert.equal(r.volatilityPct,0);assert.equal(r.label,'Within prior range');
});
test('invalid and too-short input fails closed',()=>{
 assert.throws(()=>patternMath([1,2,3]),/6 to 2000/);
 assert.throws(()=>patternMath([1,2,3,4,5,NaN]),/finite/);
 assert.throws(()=>patternMath([1,2,3,4,5,0]),/finite/);
});
test('one-neuron forward/loss/backprop/gradient update exactly match the video illustration',()=>{
 const r=neuronMath({x:.8,w:.5,b:.1,target:.9,rate:.1});
 eq(r.predicted,.5);eq(r.error,-.4);eq(r.loss,.08);
 eq(r.gradW,-.32);eq(r.gradB,-.4);
 eq(r.nextW,.532);eq(r.nextB,.14);
 assert.ok(r.afterLoss<r.loss);assert.equal(r.canTrade,false);
});
test('learning rate and NaN inputs must be valid',()=>{
 assert.throws(()=>neuronMath({x:1,w:2,b:0,target:1,rate:-1}),/finite/);
 assert.throws(()=>neuronMath({x:NaN,w:2,b:0,target:1,rate:.1}),/finite/);
});
test('scaled dot product attention weights sum to 1',()=>{
 const r=attentionMath({query:[1,0],keys:[[1,0],[0,1],[1,1]],values:[.3,.8,.5]});
 eq(r.rawScores[0],1);eq(r.rawScores[1],0);
 eq(r.weights.reduce((a,b)=>a+b,0),1);
 eq(r.output,r.weights.reduce((a,b,i)=>a+b*[.3,.8,.5][i],0));
 assert.equal(r.canTrade,false);
});
test('large scores use numerically stable softmax',()=>{
 const r=attentionMath({query:[100],keys:[[100],[99]],values:[5,10]});
 assert.ok(r.weights.every(Number.isFinite));
 eq(r.weights.reduce((a,b)=>a+b,0),1);
});
test('attention rejects mismatched dimensions and values',()=>{
 assert.throws(()=>attentionMath({query:[1,2],keys:[[1],[2,3]],values:[1,2]}),/match query/);
 assert.throws(()=>attentionMath({query:[1,2],keys:[[1,2],[2,3]],values:[1]}),/one value per key/);
});
test('one-step planner chooses the minimum modeled cost',()=>{
 const r=planningMath({position:0,goal:3,penalty:.3});
 assert.equal(r.best.action,2);eq(r.best.cost,2.2);
 assert.equal(r.candidates.length,5);
 assert.equal(r.canTrade,false);
});
test('effort penalty can prefer staying in place',()=>{
 const r=planningMath({position:0,goal:1,penalty:100});
 assert.equal(r.best.action,0);
 assert.throws(()=>planningMath({position:0,goal:3,penalty:-.1}),/finite/);
});
