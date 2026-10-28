// Replays past games through the bot's real decision code (decide, fees, sizing).
// Usage: node backtest/replay.ts <games_with_candles.json> [more.json ...]
// Only information known at bet time is used to decide. Closing prices and results are used only to score.

import { decide } from "../supabase/functions/edgebot/lib/decide.ts";
import type { Bankroll, Decision } from "../supabase/functions/edgebot/lib/decide.ts";
import { devig, devigPower, evPerDollar, kalshiFee, maxDisagreement, validPrice } from "../supabase/functions/edgebot/lib/pricing.ts";
import type { FeeInfo } from "../supabase/functions/edgebot/lib/pricing.ts";
import { effectiveSettings } from "../supabase/functions/edgebot/lib/rules.ts";
import type { Settings } from "../supabase/functions/edgebot/lib/rules.ts";
import { readFileSync, writeFileSync } from "node:fs";

type Bet = Exclude<Decision, { action: "skip" }>;

export interface Candle { t: number; ask_c: string | null; ask_l: string | null; bid_c: string | null; px: string | null; vol: string | null }
export interface GameMarket { ticker: string; outcome: string; candles: Candle[] }
export interface Game {
  league: string; event: string; label: string; kickoff: string; odds_time: string | null;
  result: string; markets: GameMarket[];
  odds: { source: string; pre: number[] | Record<string, number>; close: number[] | Record<string, number>; avg_pre?: (number | null)[] };
}

/** Odds as {outcome: decimal odds}. Soccer files store [home, draw, away]. */
export function oddsMap(x: number[] | Record<string, number>): Record<string, number> {
  return Array.isArray(x) ? { home: x[0], draw: x[1], away: x[2] } : x;
}

/** The bot's live settings (from the database defaults). */
export const BOT_SETTINGS: Settings = effectiveSettings({
  mode: "paper", paused_reason: null, leagues: [], order_style: "smart", min_edge: 0.03, min_prob: 0.15, max_prob: 0.85,
  kelly_fraction: 0.25, max_stake_pct: 0.05, max_bets_per_day: 5, max_open_exposure_pct: 0.3, stop_balance: 10,
  paper_start_bankroll: 20, min_hours_before_start: 1, max_hours_before_start: 48, resting_order_minutes: 120, report_email: null,
});

export interface Config {
  name: string;
  lagHours: number;          // bet this long after the sportsbook odds were collected
  settings: Settings;
  bankroll: number | null;   // null = flat $100 per bet, no compounding (pure edge test)
  takerOnly?: boolean;
  filter?: (g: Game) => boolean;
  devigMethod?: "proportional" | "power";
  /** Like the live bot: skip games where the answer key and a second source disagree by more than this. */
  maxDisagreement?: number;
}

/** Volume traded in the 3 hours up to ts: a stand-in for how much could really be bought at the ask. */
function recentVolume(m: GameMarket, ts: number): number {
  let v = 0;
  for (const c of m.candles) if (c.t <= ts && c.t > ts - 3 * 3600) v = Math.max(v, num(c.vol) || 0);
  return v;
}

const num = (x: string | null | undefined) => (x === null || x === undefined ? NaN : parseFloat(x));

/** Kalshi quote as of time ts (seconds): the last hourly candle that ended at or before ts, within 3 hours. */
export function quoteAt(m: GameMarket, ts: number) {
  let c: Candle | null = null;
  for (const x of m.candles) if (x.t <= ts && x.t > ts - 3 * 3600 && (!c || x.t > c.t)) c = x;
  return { yesBid: num(c?.bid_c), yesAsk: num(c?.ask_c), askSize: NaN, t: c?.t ?? null };
}

/** Kalshi mid price at kickoff (last candle ending at or before kickoff). */
export function kickoffPrice(m: GameMarket, koTs: number): number {
  let c: Candle | null = null;
  for (const x of m.candles) if (x.t <= koTs && x.t > koTs - 3 * 3600 && (!c || x.t > c.t)) c = x;
  if (!c) return NaN;
  const b = num(c.bid_c), a = num(c.ask_c);
  if (validPrice(b) && validPrice(a)) return (a + b) / 2;
  return num(c.px);
}

export interface Placed {
  game: string; league: string; label: string; outcome: string; source: string; kind: "taker" | "maker";
  betAt: string; kickoff: string; hoursBefore: number;
  fairPre: number; fairClose: number; price: number; contracts: number; fee: number; cost: number;
  won: boolean; pnl: number; expEdgePre: number; expEdgeClose: number; kalshiAtKickoff: number; beatClose: number;
}

export function run(games: Game[], fees: Record<string, FeeInfo>, cfg: Config) {
  const s = cfg.settings;
  const list = games.filter((g) => g.odds_time && (!cfg.filter || cfg.filter(g)))
    .map((g) => ({ g, betTs: Date.parse(g.odds_time!) / 1000 + cfg.lagHours * 3600, koTs: Date.parse(g.kickoff) / 1000 }))
    .sort((a, b) => a.betTs - b.betTs);

  const placed: Placed[] = [];
  const counts = { games: list.length, outOfWindow: 0, noQuote: 0, noFair: 0, sourcesDisagree: 0, skipped: 0, restingUnfilled: 0, noLiquidity: 0, dailyLimit: 0, stopped: 0 };
  const dv = cfg.devigMethod === "power" ? devigPower : devig;
  // Bankroll state (only used when cfg.bankroll is a number).
  let cash = cfg.bankroll ?? 0;
  const open: { settleTs: number; releaseTs: number; spend: number; payout: number; filled: boolean }[] = [];
  /** Daily-limit slots: filled bets count for 24h. */
  const slots: { t: number; until: number }[] = [];
  const curve: { t: string; equity: number }[] = [];
  let paused = false;

  const settleUntil = (ts: number) => {
    for (let i = open.length - 1; i >= 0; i--) {
      const p = open[i];
      if (p.filled && p.settleTs <= ts) { cash += p.payout; open.splice(i, 1); }
      else if (!p.filled && p.releaseTs <= ts) { cash += p.spend; open.splice(i, 1); }
    }
  };
  const exposure = () => open.reduce((a, p) => a + p.spend, 0);

  for (const { g, betTs, koTs } of list) {
    const hoursBefore = (koTs - betTs) / 3600;
    if (hoursBefore < s.min_hours_before_start || hoursBefore > s.max_hours_before_start) { counts.outOfWindow++; continue; }
    const fair = dv(oddsMap(g.odds.pre));
    const fairC = dv(oddsMap(g.odds.close));
    if (!fair || !fairC) { counts.noFair++; continue; }
    if (cfg.maxDisagreement !== undefined && g.odds.avg_pre && !g.odds.avg_pre.includes(null)) {
      const second = dv(oddsMap(g.odds.avg_pre as number[]));
      if (!second || maxDisagreement(fair, second) > cfg.maxDisagreement) { counts.sourcesDisagree++; continue; }
    }

    let bank: Bankroll;
    if (cfg.bankroll === null) {
      bank = { cash: 1e9, openExposure: 0, equity: 1e9 };
    } else {
      settleUntil(betTs);
      const ex = exposure();
      bank = { cash, openExposure: ex, equity: cash + ex };
      if (paused || bank.equity <= s.stop_balance) { paused = true; counts.stopped++; continue; }
    }
    const fee = fees[g.league];
    let best: { m: GameMarket; d: Bet; q: ReturnType<typeof quoteAt> } | null = null;
    let anyQuote = false;
    for (const m of g.markets) {
      const q = quoteAt(m, betTs);
      if (!validPrice(q.yesAsk) && !validPrice(q.yesBid)) continue;
      anyQuote = true;
      const st = cfg.takerOnly ? { ...s, order_style: "taker" as const } : s;
      const d = decide(fair[m.outcome], q, st, bank, fee);
      if (d.action === "skip") continue;
      const rank = (x: Bet) => (x.action === "taker" ? 1 : 0) + x.ev;
      if (!best || rank(d) > rank(best.d)) best = { m, d, q };
    }
    if (!anyQuote) { counts.noQuote++; continue; }
    if (!best) { counts.skipped++; continue; }

    if (cfg.bankroll !== null) {
      const recent = slots.filter((x) => x.t > betTs - 86400 && x.until > betTs).length;
      if (recent >= s.max_bets_per_day) { counts.dailyLimit++; continue; }
    }

    // Flat-stake mode: $100 per bet at the decided price (pure edge test, fee recomputed for that size).
    let { price, contracts } = best.d;
    if (cfg.bankroll === null) contracts = Math.max(1, Math.floor(100 / price));
    const kind: "taker" | "maker" = best.d.action === "taker" ? "taker" : "maker";
    // Can't buy more than was actually trading around then.
    const liq = Math.floor(recentVolume(best.m, betTs));
    if (kind === "taker") contracts = Math.min(contracts, liq);
    if (contracts < 1) { counts.noLiquidity++; continue; }
    const feeAmt = kalshiFee(price, contracts, kind, fee);

    // Waiting order: fills only if the ask later dropped below our price before it expired.
    let filled = kind === "taker";
    const expiry = Math.min(betTs + s.resting_order_minutes * 60, koTs - 15 * 60);
    if (!filled) {
      filled = best.m.candles.some((c) => c.t > betTs && c.t <= expiry + 1 && validPrice(num(c.ask_l)) && num(c.ask_l) < price);
    }
    const spend = price * contracts + feeAmt;
    if (!filled) {
      counts.restingUnfilled++;
      if (cfg.bankroll !== null) {
        // Unfilled waiting orders don't use a daily slot here: the replay decides each weekend at one moment,
        // while the live bot rechecks every 6 hours after its waiting orders have expired.
        cash -= spend; open.push({ settleTs: 0, releaseTs: expiry, spend, payout: 0, filled: false });
      }
      continue;
    }
    const won = g.result === best.m.outcome;
    const payout = won ? contracts : 0;
    const pC = fairC[best.m.outcome], pP = fair[best.m.outcome];
    const kk = kickoffPrice(best.m, koTs);
    placed.push({
      game: g.event, league: g.league, label: g.label, outcome: best.m.outcome, source: g.odds.source, kind,
      betAt: new Date(betTs * 1000).toISOString(), kickoff: g.kickoff, hoursBefore,
      fairPre: pP, fairClose: pC, price, contracts, fee: feeAmt, cost: price * contracts,
      won, pnl: payout - spend, expEdgePre: (pP * contracts - spend) / spend, expEdgeClose: (pC * contracts - spend) / spend,
      kalshiAtKickoff: kk, beatClose: Number.isFinite(kk) ? kk - price : NaN,
    });
    if (cfg.bankroll !== null) {
      cash -= spend;
      slots.push({ t: betTs, until: Infinity });
      open.push({ settleTs: koTs + 2.5 * 3600, releaseTs: 0, spend, payout, filled: true });
      curve.push({ t: new Date(betTs * 1000).toISOString(), equity: cash + exposure() });
    }
  }
  if (cfg.bankroll !== null) settleUntil(Infinity);
  return { cfg: cfg.name, counts, placed, finalBankroll: cfg.bankroll === null ? null : cash, paused, curve };
}


/** How far Kalshi's prices sat from the sharp books' fair chances, across every market at bet time. */
export function priceGaps(games: Game[], fees: Record<string, FeeInfo>, lagHours: number, s: Settings) {
  const gaps: number[] = [], evs: number[] = [];
  let markets = 0;
  for (const g of games) {
    if (!g.odds_time) continue;
    const betTs = Date.parse(g.odds_time) / 1000 + lagHours * 3600, koTs = Date.parse(g.kickoff) / 1000;
    const h = (koTs - betTs) / 3600;
    if (h < s.min_hours_before_start || h > s.max_hours_before_start) continue;
    const fair = devig(oddsMap(g.odds.pre));
    if (!fair) continue;
    for (const m of g.markets) {
      const q = quoteAt(m, betTs);
      if (!validPrice(q.yesAsk) || !validPrice(q.yesBid) || q.yesAsk - q.yesBid > 0.1) continue;
      const p = fair[m.outcome];
      if (!(p >= s.min_prob && p <= s.max_prob)) continue;
      markets++;
      gaps.push((q.yesAsk + q.yesBid) / 2 - p);
      evs.push(evPerDollar(p, q.yesAsk, 100, kalshiFee(q.yesAsk, 100, "taker", fees[g.league])));
    }
  }
  const absMean = gaps.reduce((a, b) => a + Math.abs(b), 0) / Math.max(1, gaps.length);
  const share = (t: number) => evs.filter((e) => e >= t).length / Math.max(1, evs.length);
  const sorted = [...gaps].map(Math.abs).sort((a, b) => a - b);
  return {
    markets, avgGapCents: 100 * absMean, medianGapCents: 100 * (sorted[Math.floor(sorted.length / 2)] ?? NaN),
    avgSignedGapCents: 100 * gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length),
    shareBuyNowProfitable: share(0), shareBuyNowOver3pct: share(0.03), shareBuyNowOver5pct: share(0.05),
  };
}

export function summarize(placed: Placed[]) {
  const n = placed.length;
  if (!n) return { bets: 0 };
  const staked = placed.reduce((a, p) => a + p.cost + p.fee, 0);
  const pnl = placed.reduce((a, p) => a + p.pnl, 0);
  const fees = placed.reduce((a, p) => a + p.fee, 0);
  const rets = placed.map((p) => p.pnl / (p.cost + p.fee));
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const ec = placed.map((p) => p.expEdgeClose);
  const ecMean = ec.reduce((a, b) => a + b, 0) / n;
  const ecSd = Math.sqrt(ec.reduce((a, b) => a + (b - ecMean) ** 2, 0) / Math.max(1, n - 1));
  const bc = placed.map((p) => p.beatClose).filter(Number.isFinite);
  const won = placed.filter((p) => p.won).length;
  return {
    bets: n, won, winRate: won / n, expectedWinRate: placed.reduce((a, p) => a + p.fairPre, 0) / n,
    staked, pnl, fees, roi: pnl / staked,
    roiPerBet: mean, roiCI95: n >= 30 ? [mean - 1.96 * sd / Math.sqrt(n), mean + 1.96 * sd / Math.sqrt(n)] : null,
    promisedEdge: placed.reduce((a, p) => a + p.expEdgePre, 0) / n,
    edgeVsClose: ecMean, edgeVsCloseCI95: n >= 10 ? [ecMean - 1.96 * ecSd / Math.sqrt(n), ecMean + 1.96 * ecSd / Math.sqrt(n)] : null,
    beatKalshiCloseCents: bc.length ? (100 * bc.reduce((a, b) => a + b, 0)) / bc.length : null,
    takerShare: placed.filter((p) => p.kind === "taker").length / n,
    avgPrice: placed.reduce((a, p) => a + p.price, 0) / n,
  };
}

function groupBy<T>(xs: T[], k: (x: T) => string) {
  const m: Record<string, T[]> = {};
  for (const x of xs) (m[k(x)] ??= []).push(x);
  return m;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2).filter((f) => !f.startsWith("--") && f.endsWith(".json"));
  const fees: Record<string, FeeInfo> = JSON.parse(readFileSync(new URL("./fees.json", import.meta.url), "utf8"));
  const games: Game[] = files.flatMap((f) => JSON.parse(readFileSync(f, "utf8")));
  const loose = { ...BOT_SETTINGS, max_hours_before_start: 168 };
  const us = process.argv.includes("--us");
  const usConfigs: Config[] = [
    { name: "main: bot rules, flat $100 per bet", lagHours: 2, settings: BOT_SETTINGS, bankroll: null },
    { name: "taker only (no waiting orders)", lagHours: 2, settings: BOT_SETTINGS, bankroll: null, takerOnly: true },
    { name: "min edge 5%", lagHours: 2, settings: { ...BOT_SETTINGS, min_edge: 0.05 }, bankroll: null },
    { name: "min edge 8%", lagHours: 2, settings: { ...BOT_SETTINGS, min_edge: 0.08 }, bankroll: null },
    { name: "NFL only", lagHours: 2, settings: BOT_SETTINGS, bankroll: null, filter: (g) => g.league === "KXNFLGAME" },
    { name: "college only", lagHours: 2, settings: BOT_SETTINGS, bankroll: null, filter: (g) => g.league === "KXNCAAFGAME" },
    { name: "real bot: $20 start, compounding", lagHours: 2, settings: BOT_SETTINGS, bankroll: 20 },
    { name: "real bot: $1,000 start, compounding", lagHours: 2, settings: BOT_SETTINGS, bankroll: 1000 },
  ];
  const B = { settings: BOT_SETTINGS, bankroll: null, maxDisagreement: 0.04 } as const;
  const pin = (g: Game) => g.odds.source === "pinnacle";
  const soccerConfigs: Config[] = [
    { ...B, name: "main: bot rules, flat $100 per bet", lagHours: 2 },
    { ...B, name: "main with power de-vig", lagHours: 2, devigMethod: "power" },
    { ...B, name: "bet right when odds were collected", lagHours: 0 },
    { ...B, name: "taker only (no waiting orders)", lagHours: 2, takerOnly: true },
    { ...B, name: "min edge 2%", lagHours: 2, settings: { ...BOT_SETTINGS, min_edge: 0.02 } },
    { ...B, name: "min edge 5%", lagHours: 2, settings: { ...BOT_SETTINGS, min_edge: 0.05 } },
    { ...B, name: "no 48h limit", lagHours: 2, settings: loose },
    { ...B, name: "Pinnacle games, proportional de-vig (live bot today)", lagHours: 2, filter: pin },
    { ...B, name: "Pinnacle games, power de-vig", lagHours: 2, filter: pin, devigMethod: "power" },
    { ...B, name: "Betfair games only", lagHours: 2, filter: (g) => !pin(g) },
    { ...B, name: "without the source-disagreement check", lagHours: 2, maxDisagreement: undefined },
    { ...B, name: "real bot: $20 start, compounding", lagHours: 2, bankroll: 20 },
    { ...B, name: "real bot: $100 start, compounding", lagHours: 2, bankroll: 100 },
    { ...B, name: "real bot: $1,000 start, compounding", lagHours: 2, bankroll: 1000 },
  ];
  const configs = us ? usConfigs : soccerConfigs;
  const out: any = { generated: new Date().toISOString(), games: games.length, runs: [], gaps: {} };
  const gapGroups = Object.entries(groupBy(games, (g) => g.league));
  for (const [lg, gs] of [["ALL", games] as [string, Game[]], ...gapGroups]) out.gaps[lg] = priceGaps(gs, fees, 2, BOT_SETTINGS);
  out.gapsByMonth = Object.fromEntries(Object.entries(groupBy(games, (g) => g.kickoff.slice(0, 7))).sort().map(([k, gs]) => [k, priceGaps(gs, fees, 2, BOT_SETTINGS)]));
  console.log("Kalshi vs sharp fair price at bet time:");
  for (const [k, v] of [...Object.entries(out.gaps), ...Object.entries(out.gapsByMonth)] as [string, any][]) console.log(`   ${k.padEnd(22)} markets ${String(v.markets).padStart(5)}  avg gap ${v.avgGapCents.toFixed(2)}¢  median ${v.medianGapCents.toFixed(2)}¢  Kalshi-minus-fair ${v.avgSignedGapCents.toFixed(2)}¢  buy-now >=0: ${(100 * v.shareBuyNowProfitable).toFixed(1)}%  >=3%: ${(100 * v.shareBuyNowOver3pct).toFixed(1)}%  >=5%: ${(100 * v.shareBuyNowOver5pct).toFixed(1)}%`);
  for (const c of configs) {
    const r = run(games, fees, c);
    const sum = summarize(r.placed);
    const byLeague = Object.fromEntries(Object.entries(groupBy(r.placed, (p) => p.league)).map(([k, v]) => [k, summarize(v)]));
    const byOutcome = Object.fromEntries(Object.entries(groupBy(r.placed, (p) => p.outcome)).map(([k, v]) => [k, summarize(v)]));
    const byKind = Object.fromEntries(Object.entries(groupBy(r.placed, (p) => p.kind)).map(([k, v]) => [k, summarize(v)]));
    out.runs.push({ name: c.name, counts: r.counts, summary: sum, byLeague, byOutcome, byKind, finalBankroll: r.finalBankroll, paused: r.paused, curve: r.curve, bets: c.name.startsWith("main") || c.bankroll !== null ? r.placed : undefined });
    const f = (x: number | null | undefined, d = 3) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : x.toFixed(d));
    console.log(`\n== ${c.name}`);
    console.log(`   games ${r.counts.games}  out-of-window ${r.counts.outOfWindow}  no-quote ${r.counts.noQuote}  disagree ${r.counts.sourcesDisagree}  skipped ${r.counts.skipped}  unfilled ${r.counts.restingUnfilled}  no-liquidity ${r.counts.noLiquidity}  daily-limit ${r.counts.dailyLimit}  stopped ${r.counts.stopped}`);
    if (sum.bets) {
      const s2 = sum as any;
      console.log(`   bets ${s2.bets}  won ${s2.won} (${f(100 * s2.winRate, 1)}% vs expected ${f(100 * s2.expectedWinRate, 1)}%)  staked $${f(s2.staked, 0)}  profit $${f(s2.pnl, 2)}  ROI ${f(100 * s2.roi, 1)}%${s2.roiCI95 ? `  95% range [${f(100 * s2.roiCI95[0], 1)}%, ${f(100 * s2.roiCI95[1], 1)}%]` : " (too few bets for a range)"}`);
      console.log(`   promised edge ${f(100 * s2.promisedEdge, 1)}%  edge vs closing line ${f(100 * s2.edgeVsClose, 2)}%${s2.edgeVsCloseCI95 ? ` [${f(100 * s2.edgeVsCloseCI95[0], 2)}%, ${f(100 * s2.edgeVsCloseCI95[1], 2)}%]` : ""}  beat Kalshi close ${f(s2.beatKalshiCloseCents, 2)}¢  taker ${f(100 * s2.takerShare, 0)}%  fees $${f(s2.fees, 2)}`);
    }
    if (c.bankroll !== null) console.log(`   bankroll $${c.bankroll} -> $${f(r.finalBankroll, 2)}${r.paused ? " (hit the stop level and paused)" : ""}`);
  }
  const target = process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? "backtest/results.json";
  writeFileSync(target, JSON.stringify(out));
  console.log(`\nwrote ${target}`);
}
