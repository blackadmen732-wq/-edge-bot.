// Reproducible analysis of recorded outcomes. No order execution or money movement.
export type Example = {
  id: string; predictedAt: string; availableAt: string; outcomeAt: string | null;
  probability: number; outcome: boolean | null; result: number | null;
  cost: number | null; group: string; flags: string[];
};
export class InputError extends Error {}
export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Expected an object');
  return value as Record<string, any>;
}
export function string(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new InputError(`Invalid ${name}`);
  return value.trim();
}
export function date(value: unknown, name: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new InputError(`Invalid ${name}`);
  return new Date(value).toISOString();
}
export function finite(value: unknown, name: string, min = -1e12, max = 1e12): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new InputError(`Invalid ${name}`);
  return value;
}
export function example(value: unknown): Example {
  const x = object(value);
  const p = date(x.predictedAt, 'predictedAt');
  const a = date(x.availableAt, 'availableAt');
  if (Date.parse(a) > Date.parse(p)) throw new InputError('Input became available after the prediction');
  const o = x.outcomeAt == null ? null : date(x.outcomeAt, 'outcomeAt');
  if (o && Date.parse(o) < Date.parse(p)) throw new InputError('Outcome precedes prediction');
  if (x.outcome != null && typeof x.outcome !== 'boolean') throw new InputError('Invalid outcome');
  if (x.outcome != null && !o) throw new InputError('Resolved outcomes require outcomeAt');
  if (x.outcome == null && o) throw new InputError('Unresolved outcomes cannot have outcomeAt');
  const flags = x.flags ?? [];
  if (!Array.isArray(flags) || flags.length > 20) throw new InputError('Invalid flags');
  return {
    id: string(x.id, 'id'), predictedAt: p, availableAt: a, outcomeAt: o,
    probability: finite(x.probability, 'probability', 0, 1), outcome: x.outcome ?? null,
    result: x.result == null ? null : finite(x.result, 'result'),
    cost: x.cost == null ? null : finite(x.cost, 'cost', 0),
    group: string(x.group ?? 'ungrouped', 'group', 100),
    flags: [...new Set(flags.map(f => string(f, 'flag', 80)))],
  };
}
export function examples(value: unknown): Example[] {
  if (!Array.isArray(value) || value.length > 5000) throw new InputError('Expected at most 5000 examples');
  const out = value.map(example);
  if (new Set(out.map(x => x.id)).size !== out.length) throw new InputError('Duplicate example IDs');
  return out;
}
const mean = (a: number[]) => a.length ? a.reduce((s, n) => s + n, 0) / a.length : null;
export function metrics(rows: Example[], offset = 0) {
  const resolved = rows.filter(x => x.outcome !== null);
  const p = (x: Example) => Math.max(0, Math.min(1, x.probability + offset));
  return {
    total: rows.length, resolved: resolved.length, unresolved: rows.length - resolved.length,
    brier: mean(resolved.map(x => (p(x) - Number(x.outcome)) ** 2)),
    logLoss: mean(resolved.map(x => x.outcome ? -Math.log(Math.max(1e-12,p(x))) : -Math.log(Math.max(1e-12,1-p(x))))),
    predictedRate: mean(resolved.map(p)), observedRate: mean(resolved.map(x => Number(x.outcome))),
    recordedResult: rows.some(x => x.result !== null) ? rows.reduce((s, x) => s + (x.result ?? 0), 0) : null,
    resultCoverage: rows.filter(x => x.result !== null).length,
    recordedCosts: rows.some(x => x.cost !== null) ? rows.reduce((s, x) => s + (x.cost ?? 0), 0) : null,
    costCoverage: rows.filter(x => x.cost !== null).length,
    calibration: Array.from({length: 5}, (_, bin) => {
      const rs = resolved.filter(x => Math.min(4, Math.floor(p(x) * 5)) === bin);
      return {bin, count: rs.length, predicted: mean(rs.map(p)), observed: mean(rs.map(x => Number(x.outcome)))};
    }),
  };
}
export function diagnose(input: Example[]) {
  const rows = examples(input);
  const groupCounts = new Map<string,number>(),flagCounts=new Map<string,number>();
  for(const x of rows){groupCounts.set(x.group,(groupCounts.get(x.group)??0)+1);for(const f of x.flags)flagCounts.set(f,(flagCounts.get(f)??0)+1);}
  const largest=(m:Map<string,number>)=>[...m].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,30).map(([k])=>k);
  const groups = largest(groupCounts).map(group => {
    const rs = rows.filter(x => x.group === group);
    return {group, ...metrics(rs), losses: rs.filter(x => x.result !== null && x.result < 0).length,
      gains: rs.filter(x => x.result !== null && x.result > 0).length};
  });
  const flags = largest(flagCounts).map(flag => {
    const rs = rows.filter(x => x.flags.includes(flag));
    const others = rows.filter(x => !x.flags.includes(flag));
    return {flag, withFlag: metrics(rs), withoutFlag: metrics(others), evidence: 'association_only'};
  });
  return {summary: metrics(rows), groups, flags, omittedGroups:Math.max(0,groupCounts.size-30),omittedFlags:Math.max(0,flagCounts.size-30),
    limitations: ['Associations do not establish causes.', 'Unknown outcomes and costs remain unknown.',
      'A single unfavorable outcome does not establish a bad decision.',
      'Recorded results are supplied observations, not verified income.']};
}
export function calibrate(input: Example[]) {
  const rows = examples(input).filter(x => x.outcome !== null).sort((a,b) => a.predictedAt.localeCompare(b.predictedAt) || a.id.localeCompare(b.id));
  if (rows.length < 60) return {status: 'insufficient_data', resolved: rows.length, required: 60};
  const split = Math.floor(rows.length * 2 / 3);
  const firstTest = rows[split].predictedAt;
  // No label from the future can enter training. Predictions at a boundary stay together.
  const train = rows.slice(0, split).filter(x => x.predictedAt < firstTest && x.outcomeAt! < firstTest);
  const test = rows.slice(split);
  if (train.length < 30 || test.length < 20) return {status:'insufficient_temporal_separation', train:train.length, test:test.length};
  const offset = Math.max(-0.2, Math.min(0.2, mean(train.map(x => Number(x.outcome) - x.probability))!));
  const baseline = metrics(test), candidate = metrics(test, offset);
  return {status:'evaluated', model:{kind:'probability_offset', offset}, train:train.length, test:test.length,
    firstTest, baseline, candidate, improvement:baseline.brier! - candidate.brier!,
    recommendation:candidate.brier! < baseline.brier! ? 'review_candidate' : 'retain_baseline',
    limitations:['One held-out period is not proof of generalization.',
      'Repeated experiments on this dataset reuse its holdout.', 'This model does not change any execution rules.']};
}
export async function digest(value: unknown): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export function safeError(e: unknown): string {
  return e instanceof InputError ? e.message : 'Operation failed; inspect the server run ID';
}

