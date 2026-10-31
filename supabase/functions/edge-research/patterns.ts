// Private, deterministic pattern measurements. Research only: no trade orders,
// no AI-generated win probabilities, and no claimed causal relationships.
import { InputError } from './core.ts';

export type MarketSeriesInput = {
  name: string;
  source: string;
  market: 'forex' | 'crypto' | 'equities' | 'commodities' | 'prediction' | 'weather' | 'other';
  asOf: string;
  points: Array<{ time: string; availableAt: string; value: number }>;
};
type Pattern = { kind: string; value: number; explanation: string; validation: 'untested' };
const ACCEPTED = new Set(['forex','crypto','equities','commodities','prediction','weather','other']);
function utc(s: unknown, field: string): number {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(s) || !/(?:Z|\+00:00)$/.test(s)) {
    throw new InputError(field + ' must be an ISO UTC timestamp');
  }
  const v = Date.parse(s);
  if (!Number.isFinite(v)) throw new InputError('Invalid ' + field);
  return v;
}
function mean(a: number[]): number { return a.reduce((s,x)=>s+x,0) / a.length; }
function std(a: number[]): number {
  const m=mean(a);
  return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/a.length);
}
const dec=(n: number)=>Number(n.toFixed(6));
export function analyzeNumericSeries(input: MarketSeriesInput) {
  if (!input || typeof input !== 'object') throw new InputError('Series input must be an object');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length>120) throw new InputError('Invalid series name');
  if (typeof input.source !== 'string' || !input.source.trim() || input.source.length>200) throw new InputError('A named data source is required');
  if (!ACCEPTED.has(input.market)) throw new InputError('Unknown market category');
  const asOf = utc(input.asOf,'asOf');
  if (!Array.isArray(input.points) || input.points.length<30 || input.points.length>2000) {
    throw new InputError('Supply 30 to 2000 time-ordered observations');
  }
  let previous=-Infinity;
  for (let i=0;i<input.points.length;i++) {
    const p=input.points[i];
    if (!p || typeof p.value!=='number' || !Number.isFinite(p.value) || p.value<=0) {
      throw new InputError('Invalid positive numeric value at row ' + i);
    }
    const event=utc(p.time,'point.time'), available=utc(p.availableAt,'point.availableAt');
    if (event<=previous) throw new InputError('Duplicate or unsorted observation times');
    if (available<event) throw new InputError('An observation cannot be available before its event time');
    if (available>asOf || event>asOf) throw new InputError('Future information is not allowed in a historical snapshot');
    previous=event;
  }
  const prices=input.points.map(x=>x.value);
  const last=prices[prices.length-1], prior=prices.slice(-21,-1);
  const priorAvg=mean(prior), priorStd=std(prior);
  const recentReturns=prices.slice(-21).slice(1).map((x,i)=>(x/prices[prices.length-21+i]-1)*100);
  const priorLow=Math.min(...prior), priorHigh=Math.max(...prior);
  const z=priorStd===0?null:(last-priorAvg)/priorStd;
  const patterns:Pattern[]=[];
  if (last>priorHigh)patterns.push({kind:'range_breakout_up',value:dec((last/priorHigh-1)*100),explanation:'Latest value above the prior 20 observations; value is distance above the prior high in percent.',validation:'untested'});
  if (last<priorLow)patterns.push({kind:'range_breakout_down',value:dec((priorLow/last-1)*100),explanation:'Latest value below the prior 20 observations; value is distance below the prior low in percent.',validation:'untested'});
  if (z!==null && Math.abs(z)>=2)patterns.push({kind:'level_deviation',value:dec(z),explanation:'Latest value is at least two standard deviations from the prior 20-value mean. This is not a return prediction.',validation:'untested'});
  const returnStd=std(recentReturns);
  const report={
    status:'descriptive_only' as const,
    source:{name:input.source,verification:'caller_supplied_unverified' as const},
    series:{name:input.name,market:input.market,observations:prices.length,asOf:new Date(asOf).toISOString(),firstTime:input.points[0].time,lastTime:input.points[input.points.length-1].time},
    statistics:{lastValue:dec(last),prior20Mean:dec(priorAvg),prior20Min:dec(priorLow),prior20Max:dec(priorHigh),lastVsPrior20MeanZ:z===null?null:dec(z),recentReturnVolatilityPct:dec(returnStd),recent20ChangePct:dec((last/prices[prices.length-21]-1)*100)},
    patterns,
    limitations:[
      'Pattern measurements do not establish profitable trading signals or future probabilities.',
      'No out-of-sample testing, realistic costs, causal inference, or live execution is performed.',
      'Data provenance and completeness are supplied by the caller, not independently verified.',
      'Samples may be irregularly spaced; time-based interpretation requires checking timestamps.',
    ],
    canExecuteTrades:false as const,
  };
  return report;
}

