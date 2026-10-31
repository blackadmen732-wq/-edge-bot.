// Spatial context map. Filaments are visual grouping, never inferred correlations.
export function mountCosmos(host,onSelect){
 const canvas=document.createElement('canvas');canvas.tabIndex=0;canvas.setAttribute('aria-label','Context map. Drag to pan, use zoom buttons, select a labelled role for evidence.');host.append(canvas);
 const ctx=canvas.getContext('2d');let width=900,height=600,zoom=1,pan={x:0,y:0},drag=null,moved=false,events=[],replay=0,frame=0,disposed=false;
 const names=['Scout','Filter','Analyst','Risk','Executor','Logger'];
 const nodes=names.map((name,i)=>({name,x:Math.cos(i*Math.PI/3-.4)*280,y:Math.sin(i*Math.PI/3-.4)*170}));
 const stars=Array.from({length:650},(_,i)=>({x:Math.sin(i*78.233)*.5+.5,y:Math.sin(i*37.719)*.5+.5,r:i%17===0?1.2:.55}));
 const controls=document.createElement('div');controls.className='map-controls';host.append(controls);
 const make=(label,fn)=>{const b=document.createElement('button');b.textContent=label;b.onclick=fn;controls.append(b);};
 make('+',()=>zoom=Math.min(2.5,zoom*1.2));make('−',()=>zoom=Math.max(.45,zoom/1.2));make('Reset view',()=>{zoom=1;pan={x:0,y:0};});make('Replay recorded handoffs',()=>{replay=events.length?performance.now():0;});
 const accessible=document.createElement('div');accessible.className='map-role-list';host.append(accessible);
 for(const n of nodes){const b=document.createElement('button');b.textContent=n.name;b.onclick=()=>onSelect(n.name,events.filter(e=>e.agent===n.name));accessible.append(b);}
 const ro=new ResizeObserver(()=>{const r=host.getBoundingClientRect();width=r.width;height=host.clientHeight;const d=Math.min(devicePixelRatio||1,2);canvas.width=width*d;canvas.height=height*d;canvas.style.width=width+'px';canvas.style.height=height+'px';ctx.setTransform(d,0,0,d,0,0);});ro.observe(host);
 function coord(e){const r=canvas.getBoundingClientRect();return {x:(e.clientX-r.left-width/2-pan.x)/zoom,y:(e.clientY-r.top-height/2-pan.y)/zoom};}
 canvas.onpointerdown=e=>{drag={x:e.clientX,y:e.clientY};moved=false;canvas.setPointerCapture(e.pointerId);};canvas.onpointermove=e=>{if(drag){const dx=e.clientX-drag.x,dy=e.clientY-drag.y;pan.x+=dx;pan.y+=dy;if(Math.abs(dx)+Math.abs(dy)>2)moved=true;drag={x:e.clientX,y:e.clientY};}};
 canvas.onpointerup=e=>{if(!moved){const p=coord(e),n=nodes.find(n=>Math.hypot(n.x-p.x,n.y-p.y)<50);if(n)onSelect(n.name,events.filter(e=>e.agent===n.name));}drag=null;};canvas.onpointercancel=()=>drag=null;
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 function draw(t){if(disposed)return;frame=requestAnimationFrame(draw);if(host.offsetParent===null)return;ctx.clearRect(0,0,width,height);ctx.fillStyle='#030610';ctx.fillRect(0,0,width,height);
 for(const s of stars){ctx.fillStyle=s.r>1?'#c6d8ff':'#637b9b';ctx.beginPath();ctx.arc(s.x*width,s.y*height,s.r,0,7);ctx.fill();}
 ctx.save();ctx.translate(width/2+pan.x,height/2+pan.y);ctx.scale(zoom,zoom);
 const glow=ctx.createRadialGradient(0,0,0,0,0,330);glow.addColorStop(0,'#b37b2726');glow.addColorStop(1,'#0c142000');ctx.fillStyle=glow;ctx.fillRect(-500,-400,1000,800);
 for(let i=0;i<160;i++){const n=nodes[i%6],spread=(i/6-13)*4;ctx.beginPath();ctx.moveTo(n.x+spread,n.y+spread*.35);ctx.bezierCurveTo(n.x*.65+spread, n.y*.2-spread,100+spread,-65+spread,0,0);ctx.strokeStyle=i%5===0?'#d9b56960':'#a7813530';ctx.lineWidth=i%5===0?.7:.4;ctx.stroke();}
 ctx.beginPath();ctx.arc(0,0,42,0,7);ctx.fillStyle='#010207';ctx.shadowColor='#ffe5a2';ctx.shadowBlur=24;ctx.fill();ctx.strokeStyle='#ead29c';ctx.stroke();ctx.shadowBlur=0;ctx.fillStyle='#f6e6c1';ctx.textAlign='center';ctx.font='11px system-ui';ctx.fillText('CONTEXT',0,4);
 for(const n of nodes){const list=events.filter(e=>e.agent===n.name);ctx.beginPath();ctx.arc(n.x,n.y,list.length?6:4,0,7);ctx.fillStyle=list.length?'#ffd990':'#8395b3';ctx.fill();ctx.font='13px system-ui';ctx.fillStyle='#e9e8e3';ctx.fillText(n.name,n.x,n.y-17);ctx.fillStyle='#8f9bb2';ctx.font='10px system-ui';ctx.fillText(list.length?list.length+' recorded events':'Waiting for evidence',n.x,n.y+23);}
 if(replay&&!reduced.matches){const step=Math.floor((t-replay)/750),progress=((t-replay)%750)/750;if(step>=events.length){replay=0;}else{const n=nodes.find(n=>n.name===events[step].agent);if(n){ctx.fillStyle='#fff0bb';ctx.shadowColor='#ffc568';ctx.shadowBlur=15;ctx.beginPath();ctx.arc(n.x*progress,n.y*progress,4,0,7);ctx.fill();ctx.shadowBlur=0;ctx.fillStyle='#fff';ctx.fillText('RECORDED REPLAY · '+n.name,0,260);}}}
 ctx.restore();}
 frame=requestAnimationFrame(draw);return {update(next){events=next;},destroy(){disposed=true;cancelAnimationFrame(frame);ro.disconnect();}};
}
