// Paper capital allocator across agents: soft elimination, compounding only proven edge.
// Hedge (multiplicative weights) with a forgetting factor, a floor share per agent, a confidence gate
// (Probabilistic Sharpe Ratio + minimum track record + positive leading signal) and a drawdown ladder.
// Pure math: no network, no database. Fake money only; nothing here can unlock real money.

export const ALLOC = {
  /** Learning rate for Hedge. */
  ETA: 0.2,
  /** Forgetting factor per day (~100-day memory). */
  LAMBDA: 0.99,
  /** Every agent keeps at least this share, so it keeps producing data and can recover. */
  FLOOR_SHARE: 0.12,
  /** One agent never gets more than this share. */
  MAX_SHARE: 0.35,
  /** Daily return that counts as one full "risk unit" (score is clipped to [-1, 1]). */
  DAILY_RISK_BUDGET: 0.02,
  /** Confidence needed before an agent may get more than an equal share. */
  PSR_GATE: 0.95,
  /** Never trust a track record shorter than this many days. */
  MIN_DAYS: 30,
  /** Drawdown ladder. */
  DD_HALVE: 0.05,
  DD_FLOOR: 0.10,
  /** Risk multiplier bounds (1 = the agent's normal size). */
  MIN_MULT: 0.25,
  MAX_MULT: 1.5,
} as const;

export type AgentStatus = "probation" | "active" | "floor";

export interface AgentDay {
  agent: string;
  equity: number;
  prevEquity: number | null;
  peak: number;
  prevLogw: number;
  /** Daily scores so far (oldest first), excluding today. */
  history: number[];
  /** Early signal: markout / closing-line value / calibration. > 0 is good. null = none yet. */
  lead: number | null;
  prevStatus: AgentStatus;
}

export interface AgentResult {
  agent: string;
  score: number;
  logw: number;
  psr: number | null;
  minDays: number | null;
  weight: number;
  riskMult: number;
  status: AgentStatus;
  drawdown: number;
  reason: string;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

/** Today's score in risk units, clipped so one fluke day can't dominate. */
export function dayScore(equity: number, prevEquity: number | null): number {
  if (prevEquity === null || !(prevEquity > 0) || !Number.isFinite(equity)) return 0;
  return clamp((equity / prevEquity - 1) / ALLOC.DAILY_RISK_BUDGET, -1, 1);
}

function normCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Probabilistic Sharpe Ratio (chance the true Sharpe > 0) and Minimum Track Record Length at 95%. */
export function psr(xs: number[]): { psr: number; minDays: number } | null {
  const n = xs.length;
  if (n < 3) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  if (!(sd > 0)) return null;
  const sr = mean / sd;
  const m3 = xs.reduce((a, b) => a + ((b - mean) / sd) ** 3, 0) / n;
  const m4 = xs.reduce((a, b) => a + ((b - mean) / sd) ** 4, 0) / n;
  const denom = Math.max(1 - m3 * sr + ((m4 - 1) / 4) * sr * sr, 1e-9);
  const p = normCdf((sr * Math.sqrt(n - 1)) / Math.sqrt(denom));
  const minDays = sr > 0 ? Math.ceil(1 + denom * (1.645 / sr) ** 2) : Infinity;
  return { psr: p, minDays };
}

/** One daily allocation step for all agents. Shares may sum below 1: the rest sits in cash. */
export function allocate(days: AgentDay[]): AgentResult[] {
  const n = days.length;
  if (n === 0) return [];
  const floor = Math.min(ALLOC.FLOOR_SHARE, 1 / n);
  const gamma = floor * n; // mixing weight that gives each agent exactly `floor`
  const scored = days.map((d) => {
    const score = dayScore(d.equity, d.prevEquity);
    const logw = ALLOC.LAMBDA * d.prevLogw + ALLOC.ETA * score;
    const hist = [...d.history, score];
    const s = psr(hist);
    const peak = Math.max(d.peak, d.equity);
    const drawdown = peak > 0 ? Math.max(0, 1 - d.equity / peak) : 0;
    return { d, score, logw, s, drawdown };
  });
  const maxLog = Math.max(...scored.map((x) => x.logw));
  const exps = scored.map((x) => Math.exp(x.logw - maxLog));
  const sum = exps.reduce((a, b) => a + b, 0);

  return scored.map((x, i) => {
    let share = (1 - gamma) * (exps[i] / sum) + gamma / n;
    const days_ = x.d.history.length + 1;
    const proven = x.s !== null && x.s.psr >= ALLOC.PSR_GATE && days_ >= Math.max(ALLOC.MIN_DAYS, x.s.minDays) && (x.d.lead ?? 0) > 0;
    let status: AgentStatus = proven ? "active" : "probation";
    let reason = proven ? "edge passed the confidence gate" : "not proven yet: capped at an equal share";
    // A floored agent stays on the floor until it wins back half its drawdown and passes the gate again.
    if (x.d.prevStatus === "floor" && !(x.drawdown <= ALLOC.DD_FLOOR / 2 && proven)) {
      status = "floor";
      reason = "on the floor: needs to recover half its drawdown and pass the gate again";
    }
    if (x.drawdown >= ALLOC.DD_FLOOR) {
      status = "floor";
      reason = `down ${(x.drawdown * 100).toFixed(1)}% from its peak: back to minimum size for review`;
    }
    if (status !== "active") share = Math.min(share, 1 / n);
    if (status === "floor") share = floor;
    share = Math.min(share, ALLOC.MAX_SHARE * (n <= 2 ? 2 : 1)); // with only two agents a 35% cap would force cash
    let mult = share * n; // 1 = equal share
    if (status !== "active") mult = Math.min(mult, 1);
    if (x.drawdown >= ALLOC.DD_HALVE) mult /= 2;
    mult = status === "floor" ? ALLOC.MIN_MULT : clamp(mult, ALLOC.MIN_MULT, ALLOC.MAX_MULT);
    return {
      agent: x.d.agent, score: x.score, logw: x.logw, psr: x.s?.psr ?? null,
      minDays: x.s && Number.isFinite(x.s.minDays) ? x.s.minDays : null,
      weight: share, riskMult: mult, status, drawdown: x.drawdown, reason,
    };
  });
}
