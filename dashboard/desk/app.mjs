import {mountWorkflow} from './workflow.mjs';
import {mountEye} from './eye.mjs';
import {mountImmersive} from './immersive.mjs';
import {mountParallax} from './parallax.mjs';
import {mountCalculations} from './calculations.mjs';
import {mountScene,soundSystem} from './scene.mjs';
import {mountAgentChat} from './chat.mjs';
import {mountCosmos} from './cosmos.mjs';
import {roles,createDesk,processCandidate,markPosition,metrics} from './engine.mjs';
const $=id=>document.getElementById(id);let state=createDesk();try{const saved=JSON.parse(localStorage.getItem('edge-paper-v1'));if(saved?.mode==='paper'&&Number.isFinite(saved.cash)&&saved.cash>=0&&Number.isFinite(saved.initial)&&['positions','closed','events','seen'].every(k=>Array.isArray(saved[k])))state=saved;}catch{}const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n);
function page(id){if(window.parallaxNavigate?.(id))return;window.scrollTo({top:0,behavior:'instant'});document.querySelectorAll('.page').forEach(e=>e.hidden=e.id!==id);document.querySelectorAll('nav button').forEach(e=>e.classList.toggle('active',e.dataset.page===id));$('breadcrumb').textContent='Workspace / '+id;}
document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>page(b.dataset.page));
function blade(title,data){$('blade-title').textContent=title;$('blade-content').textContent=JSON.stringify(data,null,2);$('blade').showModal();}$('close-blade').onclick=()=>$('blade').close();
function el(tag,text,cls){const e=document.createElement(tag);e.textContent=text;if(cls)e.className=cls;return e;}
function download(name,obj){const url=URL.createObjectURL(new Blob([JSON.stringify(obj,null,2)],{type:'application/json'}));const a=el('a','Download');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
const cosmos=mountCosmos($('cosmos'),(role,events)=>blade(role+' / context',{role,status:events.length?'Recorded evidence':'Waiting for evidence',events}));
function render(){cosmos.update(state.events);window.dispatchEvent(new CustomEvent('edge-desk-events',{detail:state.events}));try{localStorage.setItem('edge-paper-v1',JSON.stringify(state));}catch{}const m=metrics(state);for(const id of ['overview-metrics','money-metrics']){$(id).replaceChildren();for(const [label,value] of [['Paper equity',m.equity],['Realized paper P&L',m.realized],['Unrealized paper P&L',m.unrealized],['Available paper cash',state.cash]]){const box=el('div','','metric');box.append(el('span',label),el('strong',money(value)));$(id).append(box);}}
 $('roles').replaceChildren();for(const role of roles){const b=el('button',role,'role');const events=state.events.filter(e=>e.agent===role);b.append(el('small',events.length+' recorded events'));b.onclick=()=>blade(role,{role,mode:'paper',events});$('roles').append(b);}
 for(const [id,items] of [['positions',state.positions],['closed',state.closed]]){$(id).replaceChildren();if(!items.length)$(id).append(el('p','No '+(id==='closed'?'closed':'open')+' paper positions.'));for(const p of items){const b=el('button',p.mint+' · '+(id==='closed'?money(p.pnl):money(p.quantity*p.mark)),'position');b.onclick=()=>blade('Position evidence',p);$(id).append(b);}}
 $('events').replaceChildren();const query=$('search').value.toLowerCase();for(const e of [...state.events].reverse().filter(e=>JSON.stringify(e).toLowerCase().includes(query))){const b=el('button',e.agent+' / '+e.mint+' — '+e.reason,'event');b.append(el('small',' · '+new Date(e.at).toLocaleTimeString()));b.onclick=()=>blade('Decision evidence',e);$('events').append(b);}if(!state.events.length)$('events').append(el('p','No decisions yet. Import timestamped candidate evidence in Agent desk.'));}
function action(fn){try{fn();render();$('status').textContent='Paper session updated';}catch(e){$('status').textContent=e.message;}}
$('reset').onclick=()=>{if(state.events.length&&!confirm('Export first if needed. Starting a new paper session clears this browser session.'))return;action(()=>state=createDesk(Number($('bankroll').value)));};
$('import').onchange=async()=>{try{const f=$('import').files[0];if(!f)return;if(f.size>2000000)throw Error('Maximum file size is 2 MB');const rows=JSON.parse(await f.text());if(!Array.isArray(rows)||rows.length>500)throw Error('Import an array of at most 500 candidates');let accepted=0;const cfg={stopPct:Number($('stop').value),trailPct:Number($('trail').value),costBps:Number($('cost').value)};for(const c of rows)if(processCandidate(state,c,cfg).accepted)accepted++;$('import-result').textContent=`${rows.length} evaluated · ${accepted} paper entries · ${rows.length-accepted} rejected`;render();}catch(e){$('import-result').textContent=e.message;}};
$('quote').onclick=()=>action(()=>markPosition(state,$('quote-mint').value,Number($('quote-price').value),$('quote-time').value));$('search').oninput=render;$('export').onclick=()=>download('edge-paper-session.json',state);
$('sample').onclick=()=>download('candidate-template.json',[{mint:'REPLACE_WITH_TOKEN_MINT',observedAt:new Date().toISOString(),mintRevoked:null,freezeRevoked:null,liquidityVerified:null,devRugLinked:null,bundledLaunch:null,top10Percent:null,volume1hUsd:null,score:null,scoreVersion:'REPLACE_WITH_MODEL_VERSION',price:null}]);
const providers=[['Existing research API','Available through authenticated research workspace','../research/index.html'],['Optional AI · dormant','Prepared for later; no paid AI is needed for archive calculations','https://console.x.ai/'],['Helius Solana RPC','Backend credential configured; read-only network observations','https://dashboard.helius.dev/'],['Jupiter prices','Backend credential configured; read-only reference prices','https://portal.jup.ag/'],['Pump.fun / PumpSwap','Launch and migration decoder not connected','https://pump.fun/'],['Bonk.fun / Raydium','LaunchLab and pool decoders not connected','https://docs.raydium.io/'],['Meteora','Pool-specific evidence decoder not connected','https://docs.meteora.ag/']];for(const [name,status,url] of providers){const c=el('article','','role');c.append(el('h2',name),el('p',status));const a=el('a','Open provider ↗');a.href=url;a.target='_blank';a.rel='noopener noreferrer';c.append(a);$('providers').append(c);}page('overview');render();

mountAgentChat($('agent-chat'),()=>state);

for(const section of document.querySelectorAll('.page')){
 const ambient=document.createElement('div');ambient.className='section-flow';ambient.setAttribute('aria-hidden','true');
 for(let i=0;i<24;i++){const dot=document.createElement('i');dot.style.setProperty('--angle',(i*137.5)+'deg');dot.style.setProperty('--delay',(-i*.41)+'s');dot.style.setProperty('--radius',(80+i%6*22)+'px');ambient.append(dot);}
 section.prepend(ambient);
}

const sounds=soundSystem();
const galaxy=mountScene($('galaxy-scene'),{select(role){page('conversations');window.dispatchEvent(new CustomEvent('edge-select-agent',{detail:role}));}});
const moneyScene=mountScene($('money-scene'),{mode:'money'});
$('sound-toggle').onclick=async()=>{try{const on=await sounds.toggle();$('sound-toggle').textContent=on?'Sound on':'Sound off';if(on)sounds.play();}catch{$('status').textContent='Audio is unavailable in this browser.';}};
window.addEventListener('edge-agent-state',e=>{galaxy.working(e.detail.state==='running'?e.detail.role:null);sounds.play(e.detail.state==='running'?'start':e.detail.state==='failed'?'error':'done');});
let lastClosed=state.closed.length;const oldQuote=$('quote').onclick;$('quote').onclick=()=>{oldQuote();if(state.closed.length>lastClosed){const close=state.closed.at(-1);moneyScene.money(close.pnl);sounds.play(close.pnl<0?'error':'done');}lastClosed=state.closed.length;};

mountParallax();mountCalculations(page);page('parallax');

const observatory=mountImmersive(page);page('observatory');
document.querySelector('.brand').onclick=e=>{e.preventDefault();page('observatory');};
observatory.setVideo('https://d8j0ntlcm91z4.cloudfront.net/user_36nirQ0Q9RM6LsQk7YYAZf75ceZ/hf_20261030_013817_1f3f5ad4-93fb-4ece-9e50-f9fe7247444c.mp4');

mountWorkflow(()=>metrics(state));

// The Eye is home: every record, agent and decision in one living nebula.
const eye=mountEye({navigate:id=>window.parallaxNavigate?.(id)});eye.show();

