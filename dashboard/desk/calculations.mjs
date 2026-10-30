import {patternMath,neuronMath,planningMath,attentionMath} from './math-core.mjs';

// This view runs real local math using illustrative inputs, not live agents or trades.
export function mountCalculations(navigate) {
 const root=document.getElementById('calculations');if(!root)return;
 root.innerHTML=`
 <div class="bh-heading"><div><div class="eyebrow">PRIVATE INTELLIGENCE / MATHEMATICS</div><h1>Black Hole <em>Calculations.</em></h1><p>Trace every number through the core. Each result includes its formula, intermediate values, and limitations.</p></div><span class="pill">LOCAL EXAMPLES · NO ORDERS</span></div>
 <div class="bh-frame"><div class="bh-visual">
   <img src="assets/core.jpg" alt="Luminous black hole reference used as the calculation laboratory background"/>
   <div class="bh-vignette" aria-hidden="true"></div>
   <div class="bh-orbits" aria-hidden="true"><span></span><span></span><i></i><i></i><i></i></div>
   <div class="bh-visual-top"><small>INPUT → CALCULATE → EVIDENCE</small><strong id="bh-status">READY</strong></div>
   <div class="bh-visual-bottom"><strong id="bh-visual-title">PATTERN MATHEMATICS</strong><span id="bh-index">01 / 04</span></div>
 </div><div class="bh-interactive">
  <div role="tablist" aria-label="Mathematics demonstrations" class="bh-tabs">
   <button role="tab" data-mode="pattern" aria-selected="true">01 Patterns</button>
   <button role="tab" data-mode="neuron" aria-selected="false">02 Learning</button>
   <button role="tab" data-mode="attention" aria-selected="false">03 Attention</button>
   <button role="tab" data-mode="plan" aria-selected="false">04 Planning</button>
  </div>
  <div id="bh-form"></div><p id="bh-error" role="alert"></p>
  <div class="bh-result"><small>MATHEMATICAL RESULT</small><h2 id="bh-answer">Ready</h2><p id="bh-explainer">Run a calculation to see the exact result.</p><svg id="bh-chart" viewBox="0 0 460 130" role="img" aria-label="Visualization of calculated numbers"></svg></div>
 </div></div>
 <div class="bh-info">
  <section><div class="eyebrow">OPEN THE MATH</div><h2>Every calculation, step by step</h2><ol id="bh-steps"></ol><p>Examples are not predictions. The simplified neural network and planner cannot replace a trained model or tested trading strategy.</p></section>
  <section><div class="eyebrow">ACTUAL DATA PIPELINE</div><h2>How your cloud connects</h2>
   <p><strong>Sources</strong> provide timestamped measurements → <strong>Edge Research</strong> stores provenance and dataset versions → <strong>Calculators</strong> process eligible records → <strong>Research Memory</strong> preserves verified experiment results → <strong>Parallax</strong> displays the evidence.</p>
   <p>This screen calculates locally from your inputs. It does not silently read cloud data or create real trading activity.</p><button id="bh-open-universe" class="secondary">Open the connected Data Universe</button>
  </section>
 </div>`;
 const $=id=>root.querySelector('#'+id),form=$('bh-form'),tabs=[...root.querySelectorAll('[data-mode]')];
 let mode='pattern';
 const f=n=>Number.isFinite(n)?n.toFixed(5):'undefined';
 const html={
 pattern:`<label>Observations, oldest to newest<textarea id="bh-series" rows="4">100, 100.4, 100.2, 101.1, 100.8, 101.4, 101.7, 102.2, 102.1, 103</textarea></label><p>Use 6–2000 positive values. Import a local CSV with a <code>value</code> column, or enter your own.</p><input id="bh-csv" type="file" accept=".csv,text/csv" aria-label="Import a CSV with a value column"><button id="bh-run">Calculate pattern statistics</button>`,
 neuron:`<div class="bh-fields"><label>Input x<input id="bh-x" type="number" value="0.8" step="any"></label><label>Weight w<input id="bh-w" type="number" value="0.5" step="any"></label><label>Bias b<input id="bh-b" type="number" value="0.1" step="any"></label><label>Correct target y<input id="bh-target" type="number" value="0.9" step="any"></label><label>Learning rate η<input id="bh-rate" type="number" value="0.1" min="0" max="1" step="any"></label></div><p>One linear neuron, one training example, one gradient-descent step.</p><button id="bh-run">Calculate a weight update</button>`,
 attention:`<label>Query vector (comma separated)<input id="bh-query" value="1,0"></label><label>Keys (one vector per line)<textarea id="bh-keys" rows="3">1,0\n0,1\n1,1</textarea></label><label>Values (one number for each key)<input id="bh-attention-values" value="0.3,0.8,0.5"></label><p>Scaled dot-product attention: similarity scores, softmax weights, and weighted sum. These are not trained model explanations.</p><button id="bh-run">Compute attention weights</button>`,
 plan:`<div class="bh-fields"><label>Current x<input id="bh-pos" type="number" value="0" step="any"></label><label>Goal<input id="bh-goal" type="number" value="3" step="any"></label><label>Effort penalty λ<input id="bh-penalty" type="number" value="0.3" min="0" step="any"></label></div><p>Compare five candidate moves (−2, −1, 0, +1, +2) with a cost function, like a very simplified planner.</p><button id="bh-run">Evaluate possible actions</button>`
 };
 function chart(values,kind){
  const s=$('bh-chart');s.replaceChildren();
  const mk=(tag,attrs,text)=>{const e=document.createElementNS(s.namespaceURI,tag);for(const [key,val] of Object.entries(attrs))e.setAttribute(key,String(val));if(text!==undefined)e.textContent=text;s.append(e);return e;};
  for(let y=30;y<120;y+=40)mk('path',{d:'M10 '+y+' H450',stroke:'#ffffff24','stroke-width':1});
  if(kind==='pattern'){const mi=Math.min(...values),ma=Math.max(...values),span=ma-mi||1;mk('polyline',{points:values.map((v,i)=>(10+i*440/Math.max(1,values.length-1)).toFixed(1)+','+(111-85*(v-mi)/span).toFixed(1)).join(' '),stroke:'#f3d49b','stroke-width':2.5,fill:'none'});}
  else if(kind==='neuron'){values.forEach((v,i)=>{const h=Math.max(3,Math.min(90,v*65));mk('rect',{x:80+i*180,y:115-h,width:85,height:h,rx:5,fill:i===0?'#cf8669':'#99bde6'});mk('text',{x:80+i*180,y:20,fill:'#dce9f5','font-size':12},(i===0?'Before ':'After ')+f(v));});}
  else {const ma=Math.max(...values,1),min=Math.min(...values);values.forEach((v,i)=>{const h=Math.max(3,85*v/ma),x=15+i*435/values.length;mk('rect',{x,y:115-h,width:Math.min(60,400/values.length),height:h,rx:4,fill:kind==='attention'?'#a7cef0':v===min?'#edc78f':'#6b85a5'});mk('text',{x:x+8,y:127,fill:'#e1e9f4','font-size':10},kind==='attention'?'K'+(i+1):String(i-2));});}
 }
 function calculate(){
  try{
   $('bh-error').textContent='';
   let r,values=null;
   if(mode==='pattern'){
    values=form.querySelector('#bh-series').value.trim().split(/[,\s]+/).filter(Boolean).map(Number);
    r=patternMath(values);
    $('bh-answer').textContent=r.label;
    $('bh-explainer').textContent='Mean '+f(r.mean)+' · z-score '+(r.z===null?'undefined':f(r.z))+' · last return '+f(r.lastReturnPct)+'% · return volatility '+f(r.volatilityPct)+'%';
    chart(values,'pattern');
   }else if(mode==='neuron'){
    const val=k=>{const e=form.querySelector('#'+k);if(e.value==='')throw Error('Fill every field.');return Number(e.value);};
    r=neuronMath({x:val('bh-x'),w:val('bh-w'),b:val('bh-b'),target:val('bh-target'),rate:val('bh-rate')});
    $('bh-answer').textContent='Loss '+f(r.loss)+' → '+f(r.afterLoss);
    $('bh-explainer').textContent='Original prediction '+f(r.predicted)+' · updated weight '+f(r.nextW)+' · updated bias '+f(r.nextB);
    chart([r.loss,r.afterLoss],'neuron');
   }else if(mode==='attention'){
    const list=s=>s.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    const query=list(form.querySelector('#bh-query').value),keys=form.querySelector('#bh-keys').value.trim().split(/\r?\n/).filter(Boolean).map(list),values=list(form.querySelector('#bh-attention-values').value);
    r=attentionMath({query,keys,values});
    $('bh-answer').textContent='Context value '+f(r.output);
    $('bh-explainer').textContent='Softmax weights: '+r.weights.map(x=>f(x)).join(' · ');
    chart(r.weights,'attention');
   }else{
    const val=k=>{const e=form.querySelector('#'+k);if(e.value==='')throw Error('Fill every field.');return Number(e.value);};
    r=planningMath({position:val('bh-pos'),goal:val('bh-goal'),penalty:val('bh-penalty')});
    $('bh-answer').textContent='Best move '+(r.best.action>=0?'+':'')+r.best.action;
    $('bh-explainer').textContent='Predicted next position '+f(r.best.next)+' · lowest model cost '+f(r.best.cost);
    chart([-2,-1,0,1,2].map(a=>r.candidates.find(x=>x.action===a).cost),'plan');
   }
   $('bh-steps').replaceChildren();r.steps.forEach(step=>{const li=document.createElement('li');li.textContent=step;$('bh-steps').append(li);});
   $('bh-status').textContent='CALCULATED';root.classList.add('bh-processed');
  }catch(err){$('bh-error').textContent=String(err.message??err);$('bh-status').textContent='INPUT ERROR';root.classList.remove('bh-processed');}
 }
 function render(){
  form.innerHTML=html[mode];$('bh-error').textContent='';$('bh-answer').textContent='Ready';$('bh-explainer').textContent='Run a calculation to inspect every step.';
  $('bh-chart').replaceChildren();$('bh-steps').replaceChildren();$('bh-status').textContent='READY';root.classList.remove('bh-processed');
  $('bh-visual-title').textContent=({pattern:'PATTERN STATISTICS',neuron:'NEURAL LEARNING',attention:'TRANSFORMER ATTENTION',plan:'PREDICTIVE PLANNING'})[mode];
  $('bh-index').textContent=({pattern:'01',neuron:'02',attention:'03',plan:'04'})[mode]+' / 04';
  tabs.forEach(b=>b.setAttribute('aria-selected',String(b.dataset.mode===mode)));
  form.querySelector('#bh-run').onclick=calculate;
  if(mode==='pattern')form.querySelector('#bh-csv').onchange=async e=>{
   try{const file=e.target.files[0];if(!file)return;if(file.size>1000000)throw Error('CSV must be smaller than 1 MB.');
    const lines=(await file.text()).replace(/\r/g,'').trim().split('\n'),headers=lines.shift().split(',').map(s=>s.trim().toLowerCase()),idx=headers.indexOf('value');
    if(idx<0)throw Error('CSV needs a column called value.');if(lines.length>2000)throw Error('Maximum 2000 numeric observations.');
    const values=lines.filter(Boolean).map(row=>Number(row.split(',')[idx]?.trim()));
    if(values.some(v=>!Number.isFinite(v)))throw Error('CSV contains invalid values.');
    form.querySelector('#bh-series').value=values.join(', ');$('bh-error').textContent='Local import: '+values.length+' observations. No cloud upload.';
   }catch(error){$('bh-error').textContent=error.message;}
  };
 }
 tabs.forEach(t=>t.onclick=()=>{mode=t.dataset.mode;render();});
 $('bh-open-universe').onclick=()=>navigate('parallax');
 render();
}
