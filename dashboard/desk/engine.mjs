export const roles=['Scout','Filter','Analyst','Risk','Executor','Logger'];
export function createDesk(bankroll=1000){if(!Number.isFinite(bankroll)||bankroll<=0)throw Error('Invalid paper bankroll');return {mode:'paper',initial:bankroll,cash:bankroll,positions:[],closed:[],events:[],seen:[]};}
export function processCandidate(s,c,cfg,now=Date.now()){
 const log=(agent,reason)=>s.events.push({agent,reason,mint:c?.mint??'unknown',at:new Date(now).toISOString()});
 const kill=(agent,reason)=>{log(agent,reason);log('Logger','Rejected: '+reason);return {accepted:false,reason};};
 if(!c||typeof c.mint!=='string'||!c.mint.trim())return kill('Scout','Missing mint');
 if(s.seen.includes(c.mint))return kill('Scout','Already evaluated');
 s.seen.push(c.mint);log('Scout','Candidate received from imported evidence');
 const fresh=Date.parse(c.observedAt);if(!Number.isFinite(fresh)||fresh>now||now-fresh>60000)return kill('Filter','Evidence is stale or timestamp invalid');
 const checks=[['mintRevoked',true],['freezeRevoked',true],['liquidityVerified',true],['devRugLinked',false],['bundledLaunch',false]];
 for(const [key,expected] of checks)if(c[key]!==expected)return kill('Filter',key+': failed or unknown');
 if(!Number.isFinite(c.top10Percent)||c.top10Percent<0||c.top10Percent>25)return kill('Filter','Holder concentration failed or unknown');
 if(!Number.isFinite(c.volume1hUsd)||c.volume1hUsd<40000)return kill('Filter','Hourly volume below $40,000 or unknown');
 log('Filter','All declared checks passed; imported evidence is not independently verified');
 if(!Number.isFinite(c.score)||c.score<.6||c.score>1)return kill('Analyst','Score below 0.6 or invalid');
 if(typeof c.scoreVersion!=='string'||!c.scoreVersion)return kill('Analyst','Missing scoring model version');
 log('Analyst','Imported score '+c.score+' / '+c.scoreVersion+' (not a win probability)');
 if(!cfg||!Number.isFinite(cfg.stopPct)||cfg.stopPct<=0||cfg.stopPct>=100||!Number.isFinite(cfg.trailPct)||cfg.trailPct<=0||cfg.trailPct>=100)return kill('Risk','Set stop and trailing percentages first');
 if(!Number.isFinite(c.price)||c.price<=0)return kill('Risk','Invalid entry price');
 if(!Number.isFinite(cfg.costBps)||cfg.costBps<0||cfg.costBps>1000)return kill('Risk','Invalid cost assumption');
 const equity=s.cash+s.positions.reduce((a,p)=>a+p.quantity*p.mark,0),allocation=Math.min(equity*.1,s.cash/(1+cfg.costBps/10000));
 if(allocation<1)return kill('Risk','Insufficient available paper cash');
 const fee=allocation*cfg.costBps/10000;log('Risk','10% equity cap, cash reserved, stop configured before entry');
 const p={mint:c.mint,quantity:allocation/c.price,entry:c.price,mark:c.price,high:c.price,stop:c.price*(1-cfg.stopPct/100),trailPct:cfg.trailPct,costBps:cfg.costBps,basis:allocation+fee,openedAt:new Date(now).toISOString(),lastAt:now};
 s.cash-=p.basis;s.positions.push(p);log('Executor','Paper fill at imported price; costs are assumptions');log('Logger','Position recorded');return {accepted:true,position:p};
}
export function markPosition(s,mint,price,at,now=Date.now()){
 if(!Number.isFinite(price)||price<=0)throw Error('Invalid price');const time=Date.parse(at);
 const p=s.positions.find(p=>p.mint===mint);if(!p)throw Error('No open position');
 if(!Number.isFinite(time)||time<=p.lastAt||time>now||now-time>60000)throw Error('Quote must be fresh and newer than the previous observation');
 p.lastAt=time;p.mark=price;p.high=Math.max(p.high,price);if(p.high>=p.entry*1.15)p.stop=Math.max(p.stop,p.high*(1-p.trailPct/100));
 if(price<=p.stop){const proceeds=p.quantity*price*(1-p.costBps/10000);s.cash+=proceeds;const closed={...p,exit:price,pnl:proceeds-p.basis,closedAt:at};s.closed.push(closed);s.positions=s.positions.filter(x=>x!==p);s.events.push({agent:'Risk',mint,at,reason:'Paper stop triggered at observed price, not guaranteed stop price'},{agent:'Logger',mint,at,reason:'Realized paper P&L '+closed.pnl.toFixed(2)});return closed;}return null;
}
export function metrics(s){return {equity:s.cash+s.positions.reduce((a,p)=>a+p.mark*p.quantity,0),realized:s.closed.reduce((a,p)=>a+p.pnl,0),unrealized:s.positions.reduce((a,p)=>a+p.mark*p.quantity-p.basis,0)};}
