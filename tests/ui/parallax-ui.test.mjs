import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountParallax} from '../../dashboard/desk/parallax.mjs';
function setup(fetcher){const dom=new JSDOM('<section id="parallax"></section>',{url:'https://local.test/'});globalThis.document=dom.window.document;globalThis.CustomEvent=dom.window.CustomEvent;globalThis.fetch=fetcher;mountParallax();const $=id=>document.getElementById(id);$('px-token').value='private-test-token';return {dom,$};}
const graph={records:[{id:'source:kraken.spot',kind:'source',name:'Kraken',market:'crypto',status:'receiving',updatedAt:'2026-01-01T00:00:00Z'}]};
const series={series:[{id:'kraken:BTC-USD',name:'BTC/USD',source:'kraken.spot',samples:40,minimumSamples:30,ready:true},{id:'jupiter:SOL-USD',name:'SOL/USD',source:'jupiter.prices',samples:1,minimumSamples:30,ready:false}]};
test('private panel loads real source metadata, saves an analysis and clears credentials on disconnect',async()=>{
const calls=[];let analyzed=false;
const {dom,$}=setup(async(url,init)=>{assert.equal(init.headers.authorization,'Bearer private-test-token');calls.push(String(url));if(String(url).includes('task=universe'))return Response.json(graph);const body=JSON.parse(init.body);switch(body.name){case 'list_archive_series':return Response.json(series);case 'list_numeric_results':return Response.json({results:analyzed?[{id:'1',name:'BTC/USD',created_at:'2026-01-01T00:00:00Z'}]:[]});case 'analyze_archived_series':analyzed=true;return Response.json({id:'1',fingerprint:'abc',report:{status:'descriptive_only'},cached:false});case 'get_universe':return Response.json(graph);default:throw Error('Unexpected request '+body.name);}});
await $('px-load').onclick();assert.equal($('px-source').textContent,'CONNECTED');assert.equal($('px-archive-series').options.length,2);assert.equal($('px-archive-run').disabled,false);
await $('px-archive-run').onclick();assert.match($('px-archive-output').textContent,/descriptive_only/);assert.match($('px-archive-status').textContent,/1 saved analyses/);assert.equal(dom.window.localStorage.length,0);
$('px-archive-series').value='jupiter:SOL-USD';$('px-archive-series').onchange();assert.equal($('px-archive-run').disabled,true);
$('px-disconnect').onclick();assert.equal($('px-token').value,'');assert.equal($('px-source').textContent,'NOT CONNECTED');assert.equal($('px-saved-results').children.length,0);dom.window.close();
});
test('failed credentials never claim to be connected',async()=>{const {dom,$}=setup(async()=>Response.json({error:'Unauthorized'},{status:401}));await $('px-load').onclick();assert.equal($('px-source').textContent,'NOT CONNECTED');assert.match($('px-status').textContent,/401/);dom.window.close();});
