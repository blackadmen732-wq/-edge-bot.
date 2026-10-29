// Forex research extension for Edge Bot. PAPER/ANALYSIS ONLY.
// Separate from Kalshi sports and weather trading. No broker credentials or order functions.
// Every agent is currently deterministic and explainable; LLM explanations can be layered on later.

export type FxPair = "EUR_USD" | "GBP_USD" | "USD_JPY";
export type FxDirection = "up" | "down" | "neutral";
export type FxAction = "WATCH_LONG" | "WATCH_SHORT" | "NO_TRADE";

export interface FxCandle {
  // Timestamp must be the CLOSED candle's end time in UTC.
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}
export interface FxEvent {
  time: string;
  currency: string;
  impact: "high" | "medium" | "low";
  title: string;
}
export interface FxInput {
  pair: FxPair;
  intervalMinutes: number;
  candles: FxCandle[];
  asOf?: string; // For historical replays; never earlier than any supplied candle.
  spreadPips?: number; // Must come from an external bid/ask data source, never guessed.
  calendarAsOf?: string; // Timestamp of a complete verified economic-calendar snapshot.
  events?: FxEvent[];
  equityUsd?: number; // Hypothetical, used for paper sizing only.
  drawdownPct?: number;
}
export interface FxReport {
  mode: "analysis_only";
  instrument: FxPair;
  asOf: string;
  latestClosedCandle: string;
  patternAgent: { patterns: string[]; bias: FxDirection; evidence: string[] };
  quantAgent: {
    sma20: number; sma50: number; rsi14: number; atr14: number;
    range20Pips: number; return20Pct: number; bias: FxDirection; evidence: string[];
  };
  macroAgent: { status: "unknown" | "clear" | "high_impact_window"; eventsNear: string[]; evidence: string[] };
  riskAgent: {
    allowedForResearch: boolean; blockers: string[]; stopDistancePips: number;
    paperMaxRiskUsd: number | null; paperPositionUnits: number | null; maxNotionalMultiple: 1;
  };
  strategyAgent: { action: FxAction; reasons: string[]; provenProfitability: false; estimatedWinRate: null };
}

const PAIRS: FxPair[] = ["EUR_USD", "GBP_USD", "USD_JPY"];
const FINITE = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const avg = (x: number[]): number => x.reduce((a, b) => a + b, 0) / x.length;
const round = (n: number, digits = 6): number => Number(n.toFixed(digits));
const pip = (pair: FxPair): number => pair === "USD_JPY" ? 0.01 : 0.0001;
function parseTime(value: string, name: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw new Error(name + " must be an ISO UTC timestamp");
  const t = Date.parse(value);
  if (!Number.isFinite(t) || !/(Z|\+00:00)$/.test(value)) throw new Error(name + " must use UTC (Z or +00:00)");
  return t;
}
function validate(input: FxInput, now: number): number {
  if (!input || !PAIRS.includes(input.pair)) throw new Error("Supported pairs: EUR_USD, GBP_USD, USD_JPY");
  if (!FINTE_INTERVAL(input.intervalMinutes)) throw new Error("intervalMinutes must be 1, 5, 15, 30, 60 or 240");
  if (!Array.isArray(input.candles) || input.candles.length < 60 || input.candles.length > 5000) {
    throw new Error("Provide between 60 and 5000 closed OHLC candles");
  }
  let prev = -Infinity;
  for (const [i, c] of input.candles.entries()) {
    if (!c || ![c.open, c.high, c.low, c.close].every(FINITE)) throw new Error("Invalid OHLC at index " + i);
    if (c.low <= 0 || c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close)) {
      throw new Error("Inconsistent OHLC at index " + i);
    }
    const t = parseTime(c.time, "candle.time");
    if (t <= prev) throw new Error("Candles must be strictly increasing by close time with no duplicates");
    if (t > now) throw new Error("Future or unfinished candle: no lookahead allowed");
    prev = t;
  }
  if (input.spreadPips !== undefined && (!FINITE(input.spreadPips) || input.spreadPips < 0)) throw new Error("Invalid spreadPips");
  if (input.equityUsd !== undefined && (!FINITE(input.equityUsd) || input.equityUsd <= 0)) throw new Error("Invalid paper equityUsd");
  if (input.drawdownPct !== undefined && (!FINITE(input.drawdownPct) || input.drawdownPct < 0 || input.drawdownPct > 100)) throw new Error("Invalid drawdownPct");
  if (input.calendarAsOf !== undefined) parseTime(input.calendarAsOf, "calendarAsOf");
  if (input.events !== undefined) {
    if (!Array.isArray(input.events) || input.events.length > 1000) throw new Error("Invalid events list");
    for (const e of input.events) {
      if (!e || !["high", "medium", "low"].includes(e.impact) || typeof e.currency !== "string" || typeof e.title !== "string") {
        throw new Error("Invalid economic event");
      }
      parseTime(e.time, "event.time");
    }
  }
  return prev;
}
function FINTE_INTERVAL(n: number): boolean { return [1, 5, 15, 30, 60, 240].includes(n); }
function patterns(c: FxCandle[], pair: FxPair): FxReport["patternAgent"] {
  const last = c[c.length - 1];
  const prior = c[c.length - 2];
  const found: string[] = [];
  const evidence: string[] = [];
  const body = Math.abs(last.close - last.open);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const upperWick = last.high - Math.max(last.open, last.close);
  const minBody = pip(pair) * 0.1;
  const prior20 = c.slice(-21, -1);
  if (prior.close < prior.open && last.close > last.open && last.open <= prior.close && last.close >= prior.open) {
    found.push("bullish_engulfing");
  }
  if (prior.close > prior.open && last.close < last.open && last.open >= prior.close && last.close <= prior.open) {
    found.push("bearish_engulfing");
  }
  if (body >= minBody && lowerWick >= 2 * body && upperWick <= body) found.push("hammer_shape");
  if (body >= minBody && upperWick >= 2 * body && lowerWick <= body) found.push("shooting_star_shape");
  if (last.high < prior.high && last.low > prior.low) found.push("inside_bar");
  if (last.close > Math.max(...prior20.map(x => x.high))) found.push("breakout_up_20");
  if (last.close < Math.min(...prior20.map(x => x.low))) found.push("breakout_down_20");
  const up = found.some(x => ["bullish_engulfing", "breakout_up_20"].includes(x));
  const down = found.some(x => ["bearish_engulfing", "breakout_down_20"].includes(x));
  const bias: FxDirection = up && !down ? "up" : down && !up ? "down" : "neutral";
  evidence.push("Only the most recent fully closed candle and earlier candles were used");
  evidence.push("A shape is not a profitable signal without out-of-sample testing");
  if (found.length === 0) evidence.push("No supported pattern found on latest candle");
  return { patterns: found, bias, evidence };
}
function quant(c: FxCandle[], pair: FxPair): FxReport["quantAgent"] {
  const closes = c.map(x => x.close);
  const last = closes[closes.length - 1];
  const sma20 = avg(closes.slice(-20));
  const sma50 = avg(closes.slice(-50));
  const diffs = closes.slice(-15).slice(1).map((v, i) => v - closes[closes.length - 15 + i]);
  const gains = diffs.map(d => Math.max(d, 0));
  const losses = diffs.map(d => Math.max(-d, 0));
  const ag = avg(gains), al = avg(losses);
  const rsi14 = al === 0 ? (ag === 0 ? 50 : 100) : 100 - 100 / (1 + ag / al);
  const tr = c.slice(-15).slice(1).map((v, i) => {
    const previousClose = c[c.length - 15 + i].close;
    return Math.max(v.high - v.low, Math.abs(v.high - previousClose), Math.abs(v.low - previousClose));
  });
  const atr14 = avg(tr);
  const highs = c.slice(-20).map(x => x.high), lows = c.slice(-20).map(x => x.low);
  const bias: FxDirection = last > sma20 && sma20 > sma50 ? "up" : last < sma20 && sma20 < sma50 ? "down" : "neutral";
  return {
    sma20: round(sma20), sma50: round(sma50), rsi14: round(rsi14, 2), atr14: round(atr14),
    range20Pips: round((Math.max(...highs) - Math.min(...lows)) / pip(pair), 2),
    return20Pct: round(100 * (last / closes[closes.length - 21] - 1), 3),
    bias,
    evidence: ["SMA20/SMA50 trend determined from closed candles", "RSI14 and ATR14 use last 14 price changes/true ranges", "No win probability is inferred from indicators"],
  };
}
function macro(input: FxInput, now: number): FxReport["macroAgent"] {
  const evidence: string[] = [];
  if (!input.calendarAsOf || !input.events) return {
    status: "unknown", eventsNear: [], evidence: ["No verified complete economic calendar supplied; cannot certify news safety"],
  };
  const snapshot = parseTime(input.calendarAsOf, "calendarAsOf");
  if (snapshot > now || now - snapshot > 30 * 60000) return {
    status: "unknown", eventsNear: [], evidence: ["Economic calendar snapshot is stale or in the future"],
  };
  const constituents = input.pair.split("_");
  const relevant = input.events.filter(e => e.impact === "high" && constituents.includes(e.currency.toUpperCase()) && Math.abs(parseTime(e.time, "event.time") - now) <= 60 * 60000);
  if (relevant.length) evidence.push("High-impact event within 60 minutes of analysis time");
  else evidence.push("No high-impact events in supplied complete calendar within 60 minutes; feed accuracy unverified");
  return { status: relevant.length ? "high_impact_window" : "clear", eventsNear: relevant.map(e => e.currency + ": " + e.title), evidence };
}
function risk(input: FxInput, now: number, lastMs: number, atr: number, m: FxReport["macroAgent"]): FxReport["riskAgent"] {
  const blockers: string[] = [];
  const spread = input.spreadPips;
  if (m.status !== "clear") blockers.push("Macro calendar unavailable/stale or high-impact news window");
  if (spread === undefined) blockers.push("Spread is unknown: bid/ask data required");
  else if (spread > 2) blockers.push("Spread exceeds 2-pip research limit");
  if (now - lastMs > input.intervalMinutes * 2 * 60000) blockers.push("Latest closed candle is stale");
  if (input.drawdownPct === undefined) blockers.push("Simulated drawdown not provided");
  else if (input.drawdownPct >= 5) blockers.push("Paper drawdown >= 5% limit");
  if (input.equityUsd === undefined) blockers.push("Paper equity not provided");
  if (!(atr > 0)) blockers.push("ATR unavailable or zero");
  const stopDistancePips = round(1.5 * atr / pip(input.pair), 2);
  const maxRiskUsd = input.equityUsd === undefined ? null : round(input.equityUsd * 0.0025, 2);
  // USD account: pip USD value per base unit is 0.0001 for XXX/USD, 0.01/spot for USD/JPY.
  const latestClose = input.candles[input.candles.length - 1].close;
  const pipUsdPerUnit = input.pair === "USD_JPY" ? 0.01 / latestClose : 0.0001;
  const baseUnitUsd = input.pair === "USD_JPY" ? 1 : latestClose;
  const riskSizedUnits = maxRiskUsd === null || stopDistancePips <= 0 ? 0 : Math.floor(maxRiskUsd / (stopDistancePips * pipUsdPerUnit));
  // Cap gross notional at 1x simulated equity: no leveraged sizing even in paper mode.
  const notionalSizedUnits = input.equityUsd === undefined ? 0 : Math.floor(input.equityUsd / baseUnitUsd);
  const units = Math.max(0, Math.min(riskSizedUnits, notionalSizedUnits));
  if (units === 0) blockers.push("Paper position size rounds to zero");
  return {
    allowedForResearch: blockers.length === 0,
    blockers, stopDistancePips,
    paperMaxRiskUsd: maxRiskUsd,
    paperPositionUnits: blockers.length === 0 ? units : null,
    maxNotionalMultiple: 1,
  };
}
export function analyzeForex(input: FxInput): FxReport {
  const now = input.asOf ? parseTime(input.asOf, "asOf") : Date.now();
  const lastMs = validate(input, now);
  const patternAgent = patterns(input.candles, input.pair);
  const quantAgent = quant(input.candles, input.pair);
  const macroAgent = macro(input, now);
  const riskAgent = risk(input, now, lastMs, quantAgent.atr14, macroAgent);
  const reasons = [...riskAgent.blockers];
  let action: FxAction = "NO_TRADE";
  if (riskAgent.allowedForResearch && patternAgent.bias !== "neutral" && patternAgent.bias === quantAgent.bias) {
    action = patternAgent.bias === "up" ? "WATCH_LONG" : "WATCH_SHORT";
    reasons.push("Pattern and trend agree: research watchlist candidate ONLY");
  } else {
    if (patternAgent.bias === "neutral") reasons.push("No directional pattern confirmed");
    if (patternAgent.bias !== quantAgent.bias) reasons.push("Pattern and quantitative trend do not agree");
  }
  return {
    mode: "analysis_only",
    instrument: input.pair,
    asOf: new Date(now).toISOString(),
    latestClosedCandle: new Date(lastMs).toISOString(),
    patternAgent, quantAgent, macroAgent, riskAgent,
    strategyAgent: {
      action, reasons, provenProfitability: false, estimatedWinRate: null,
    },
  };
}
