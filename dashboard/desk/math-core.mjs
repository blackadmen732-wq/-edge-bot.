// Transparent math demonstrations for the private Black Hole calculation panel.
// All functions are deterministic, local, research/education only. No orders.
// They do not train a deep network or claim predictive trading performance.
const num=(n,name,min=-1e6,max=1e6)=>{
 if(typeof n!=='number'||!Number.isFinite(n)||n<min||n>max)throw new Error(name+' must be a finite number in range.');
 return n;
};
const mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
const sd=a=>{const m=mean(a);return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/a.length);};
export function patternMath(values){
 if(!Array.isArray(values)||values.length<6||values.length>2000)throw new Error('Enter 6 to 2000 observations.');
 values.forEach((v,i)=>num(v,'Observation '+(i+1),0.000000001,1e9));
 const last=values.at(-1),previous=values.at(-2),prior=values.slice(-21,-1);
 const mu=mean(prior),sigma=sd(prior),high=Math.max(...prior),low=Math.min(...prior);
 const z=sigma===0?null:(last-mu)/sigma;
 const lastReturnPct=100*(last/previous-1);
 const returns=values.slice(1).map((v,i)=>100*(v/values[i]-1));
 return {
  label:last>high?'Range breakout UP':last<low?'Range breakout DOWN':'Within prior range',
  count:values.length,window:prior.length,latest:last,previous,mean:mu,std:sigma,z,
  previousHigh:high,previousLow:low,lastReturnPct,volatilityPct:sd(returns),
  steps:[
   'Use the previous '+prior.length+' numbers as the comparison window; exclude the latest point.',
   'Mean μ = sum(previous values) / '+prior.length+' = '+mu.toFixed(5),
   'Population deviation σ = √[sum((x − μ)²) / '+prior.length+'] = '+sigma.toFixed(5),
   'Z = (latest − μ) / σ = '+(z===null?'undefined (σ = 0)':z.toFixed(5)),
   'Last return = (latest / previous − 1) × 100 = '+lastReturnPct.toFixed(4)+'%',
   'Breakout compares latest with previous min '+low.toFixed(5)+' and max '+high.toFixed(5)+'.'
  ],canTrade:false,
 };
}
export function neuronMath({x,w,b,target,rate}){
 x=num(x,'Input x',-100,100);w=num(w,'Weight w',-100,100);
 b=num(b,'Bias b',-100,100);target=num(target,'Target y',-100,100);
 rate=num(rate,'Learning rate',0,1);
 const predicted=x*w+b,error=predicted-target,loss=.5*error**2;
 const gradW=error*x,gradB=error;
 const nextW=w-rate*gradW,nextB=b-rate*gradB;
 const nextPrediction=nextW*x+nextB,afterLoss=.5*(nextPrediction-target)**2;
 return {predicted,error,loss,gradW,gradB,nextW,nextB,nextPrediction,afterLoss,steps:[
  'Forward pass: ŷ = w × x + b = '+w+' × '+x+' + '+b+' = '+predicted.toFixed(5),
  'Prediction error e = ŷ − y = '+predicted.toFixed(5)+' − '+target+' = '+error.toFixed(5),
  'Loss L = ½(ŷ − y)² = '+loss.toFixed(6),
  'Derivative ∂L/∂w = e × x = '+gradW.toFixed(6)+'; ∂L/∂b = e = '+gradB.toFixed(6),
  'Gradient descent: w′ = w − η∂L/∂w = '+nextW.toFixed(6),
  'Bias update: b′ = b − η∂L/∂b = '+nextB.toFixed(6),
  'Recompute the same example: new loss = '+afterLoss.toFixed(6)
 ],canTrade:false};
}
export function planningMath({position,goal,penalty}){
 position=num(position,'Position',-1000,1000);goal=num(goal,'Goal',-1000,1000);
 penalty=num(penalty,'Action penalty',0,1000);
 const actions=[-2,-1,0,1,2];
 const candidates=actions.map(action=>({action,next:position+action,distanceCost:(position+action-goal)**2,effortCost:penalty*action**2,cost:(position+action-goal)**2+penalty*action**2}));
 candidates.sort((a,b)=>a.cost-b.cost||Math.abs(a.action)-Math.abs(b.action)||a.action-b.action);
 const best=candidates[0];
 return {position,goal,penalty,best,candidates,steps:[
  'Predict the next state: x(next) = x(now) + action (simplified one-step model).',
  'Cost J(action) = (x(next) − goal)² + λ × action².',
  'Evaluate actions −2, −1, 0, +1, +2 using the same cost function.',
  'Choose the lowest-cost candidate: action '+(best.action>=0?'+':'')+best.action+'; J = '+best.cost.toFixed(5)+'.',
  'After observing the real next state, recalculate. This is a one-step illustration of receding-horizon planning.'
 ],canTrade:false};
}


// One-head scaled dot-product attention, as in a minimal transformer demonstration.
// This function computes attention weights; it does not load or train any model.
export function attentionMath({query,keys,values}){
 if(!Array.isArray(query)||query.length<1||query.length>16)throw new Error('Query must contain 1–16 numbers.');
 query.forEach((v,i)=>num(v,'Query '+i,-100,100));
 if(!Array.isArray(keys)||keys.length<2||keys.length>12)throw new Error('Enter 2–12 key vectors.');
 if(!Array.isArray(values)||values.length!==keys.length)throw new Error('Supply one value per key.');
 for(const [i,key] of keys.entries()){
  if(!Array.isArray(key)||key.length!==query.length)throw new Error('Key '+(i+1)+' must match query dimension.');
  key.forEach((v,j)=>num(v,'Key '+i+':'+j,-100,100));
  num(values[i],'Value '+(i+1),-1000,1000);
 }
 const d=query.length;
 const raw=keys.map(key=>query.reduce((acc,x,j)=>acc+x*key[j],0));
 const scores=raw.map(v=>v/Math.sqrt(d));
 const top=Math.max(...scores),exponents=scores.map(s=>Math.exp(s-top)),denom=exponents.reduce((a,b)=>a+b,0);
 const weights=exponents.map(x=>x/denom);
 const output=weights.reduce((acc,weight,i)=>acc+weight*values[i],0);
 return {dimension:d,rawScores:raw,scaledScores:scores,weights,output,steps:[
  'Similarity: dot products q · kᵢ = '+raw.map(x=>x.toFixed(4)).join(', '),
  'Scale each dot product by √d = '+Math.sqrt(d).toFixed(4)+': '+scores.map(x=>x.toFixed(4)).join(', '),
  'Softmax converts scaled scores to weights: '+weights.map(x=>x.toFixed(4)).join(' + ')+' = 1.',
  'Context output = Σ(weightᵢ × valueᵢ) = '+output.toFixed(6)+'.',
  'These weights are mathematical relevance scores, not explanations of a real trained model.'
 ],canTrade:false};
}
