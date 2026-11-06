// Weather scoreboard math. Pure functions: no network, no database.
// Question it answers: does our forecast know the day's high better than Kalshi's price does?
// Until the answer is "yes, on 200+ markets", no money should follow the forecast.
import { bracketProb, type Bracket } from "../edgebot/lib/mm.ts";

/** Members' daily highs for each local date, from an Open-Meteo ensemble hourly response (times are local). */
export function memberHighs(hourly: Record<string, unknown> | undefined): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const times = (hourly?.time ?? []) as string[];
  if (!Array.isArray(times) || !times.length) return out;
  const keys = Object.keys(hourly!).filter((k) => k.startsWith("temperature_2m"));
  for (const k of keys) {
    const vals = hourly![k] as unknown[];
    if (!Array.isArray(vals)) continue;
    const perDay = new Map<string, number>();
    times.forEach((t, i) => {
      const v = Number(vals[i]);
      if (vals[i] === null || !Number.isFinite(v)) return;
      const d = String(t).slice(0, 10);
      perDay.set(d, Math.max(perDay.get(d) ?? -Infinity, v));
    });
    for (const [d, hi] of perDay) {
      // a member needs most of the day's hours to count (partial first/last days are dropped)
      const hours = times.filter((t, i) => String(t).startsWith(d) && vals[i] !== null && Number.isFinite(Number(vals[i]))).length;
      if (hours >= 18) (out.get(d) ?? out.set(d, []).get(d)!).push(hi);
    }
  }
  return out;
}

/** Chance the official high lands in the bracket: each member smoothed by `sigma` °F, then averaged. */
export function ensembleProb(b: Bracket, highs: number[], sigma = 1.5): number {
  const ok = highs.filter(Number.isFinite);
  if (ok.length < 5) return NaN;
  return ok.reduce((s, h) => s + bracketProb(b, h, sigma), 0) / ok.length;
}

export interface Scored { ticker: string; market: number; ens: number | null; y: 0 | 1; daysAhead?: number }

const r4 = (x: number) => Math.round(x * 10000) / 10000;

/**
 * The scoreboard. One row per market (the caller passes one snapshot per ticker).
 * verdict says whether the forecast has earned money: 200+ markets, lower Brier than the market,
 * and the gap at least 2 standard errors wide.
 */
export function scoreboard(rows: Scored[], minMarkets = 200) {
  const both = rows.filter((r) => r.ens !== null && Number.isFinite(r.ens) && Number.isFinite(r.market));
  const diffs = both.map((r) => (r.ens! - r.y) ** 2 - (r.market - r.y) ** 2); // < 0 means forecast better
  const n = diffs.length;
  const mean = n ? diffs.reduce((a, b) => a + b, 0) / n : NaN;
  const sd = n > 1 ? Math.sqrt(diffs.reduce((a, d) => a + (d - mean) ** 2, 0) / (n - 1)) : NaN;
  const z = n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : NaN;
  const brierMarket = both.length ? both.reduce((a, r) => a + (r.market - r.y) ** 2, 0) / both.length : NaN;
  const brierEns = both.length ? both.reduce((a, r) => a + (r.ens! - r.y) ** 2, 0) / both.length : NaN;

  // Does the market's own price come true as often as it says? (the "favorites are cheap" test)
  const edges = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.55, 0.7, 0.8, 0.9, 1.0001];
  const buckets = edges.slice(0, -1).map((lo, i) => {
    const hi = edges[i + 1];
    const inB = rows.filter((r) => Number.isFinite(r.market) && r.market >= lo && r.market < hi);
    const price = inB.length ? inB.reduce((s, r) => s + r.market, 0) / inB.length : NaN;
    const rate = inB.length ? inB.reduce((s, r) => s + r.y, 0) / inB.length : NaN;
    // profit per $1 contract from buying YES at the price (before fees)
    return { from: lo, to: Math.min(hi, 1), markets: inB.length, avg_price: r4(price), came_true: r4(rate), profit_per_contract: r4(rate - price) };
  });
  const fav = rows.filter((r) => r.market >= 0.55 && r.market < 0.7);
  const favEdge = fav.length ? fav.reduce((s, r) => s + r.y - r.market, 0) / fav.length : NaN;
  const favSe = fav.length > 1 ? Math.sqrt(fav.reduce((s, r) => s + r.market * (1 - r.market), 0)) / fav.length : NaN;

  const forecastEarned = n >= minMarkets && brierEns < brierMarket && z <= -2;
  const favoritesEarned = fav.length >= minMarkets && favEdge > 0.03 && favEdge / favSe >= 2;
  return {
    markets: rows.length,
    forecast_vs_market: { markets: n, brier_forecast: r4(brierEns), brier_market: r4(brierMarket), z: r4(z) },
    calibration: buckets,
    favorites_55_70: { markets: fav.length, profit_per_contract: r4(favEdge), z: r4(favEdge / favSe) },
    verdict: {
      forecast: forecastEarned ? "EARNED: forecast beats the market" : n < minMarkets ? `not yet: ${n}/${minMarkets} markets` : "no: the market knows more than the forecast",
      favorites: favoritesEarned ? "EARNED: 55-70¢ favorites come true more than priced" : fav.length < minMarkets ? `not yet: ${fav.length}/${minMarkets} markets` : "no: favorites are fairly priced",
    },
  };
}

// ---------------------------------------------------------------- history backfill + learning

/** Daily max per response key per local date (days with fewer than 18 hourly values are dropped). */
export function dailyMaxByKey(hourly: Record<string, unknown> | undefined): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  const times = (hourly?.time ?? []) as string[];
  if (!Array.isArray(times)) return out;
  for (const k of Object.keys(hourly ?? {})) {
    if (k === "time" || !Array.isArray(hourly![k])) continue;
    const vals = hourly![k] as unknown[];
    const max = new Map<string, number>(), count = new Map<string, number>();
    times.forEach((t, i) => {
      const v = Number(vals[i]);
      if (vals[i] === null || !Number.isFinite(v)) return;
      const d = String(t).slice(0, 10);
      max.set(d, Math.max(max.get(d) ?? -Infinity, v));
      count.set(d, (count.get(d) ?? 0) + 1);
    });
    const days = new Map<string, number>();
    for (const [d, m] of max) if ((count.get(d) ?? 0) >= 18) days.set(d, m);
    out.set(k, days);
  }
  return out;
}

/** "YYYY-MM-DD" minus one day. */
export function prevDay(date: string): string {
  return new Date(Date.parse(date + "T00:00:00Z") - 86_400_000).toISOString().slice(0, 10);
}

/** UTC ms of 12:00 local time on `date` in `tz`. */
export function localNoonUtc(date: string, tz: string): number {
  const guess = Date.parse(date + "T12:00:00Z");
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(new Date(guess)));
  let diff = 12 - hour;
  if (diff > 12) diff -= 24;
  if (diff < -12) diff += 24;
  return guess + diff * 3_600_000;
}

/** Kalshi's taker fee per contract at price p (0.07 x p x (1 - p), rounded up to the cent). */
export function takerFee(p: number): number {
  return Math.ceil(0.07 * p * (1 - p) * 100 - 1e-9) / 100;
}

export interface CalRow { series: string; date: string; bmin: number | null; bmax: number | null; market: number; fcMean: number; actual: number | null; y: 0 | 1 }

/**
 * Learn each city's forecast bias and spread on dates before `split`, then test ONLY on dates from `split` on.
 * Reports the learned forecast vs the market (Brier) and what a simple strategy would have made out of sample:
 * buy YES when learned chance is >= minEdge above the ask, buy NO when it's >= minEdge below the bid
 * (ask/bid approximated as market +/- halfSpread), after Kalshi's taker fee.
 */
export function learnAndTest(rows: CalRow[], split: string, minEdge = 0.1, halfSpread = 0.01) {
  const train = rows.filter((r) => r.date < split && r.actual !== null && Number.isFinite(r.fcMean));
  const test = rows.filter((r) => r.date >= split && Number.isFinite(r.fcMean) && Number.isFinite(r.market));
  // one error per city-day, not per bracket
  const errs = new Map<string, Map<string, number>>();
  for (const r of train) (errs.get(r.series) ?? errs.set(r.series, new Map()).get(r.series)!).set(r.date, r.actual! - r.fcMean);
  const model = new Map<string, { bias: number; sigma: number; days: number }>();
  for (const [s, m] of errs) {
    const e = [...m.values()];
    if (e.length < 10) continue;
    const bias = e.reduce((a, b) => a + b, 0) / e.length;
    const sd = Math.sqrt(e.reduce((a, b) => a + (b - bias) ** 2, 0) / (e.length - 1));
    model.set(s, { bias, sigma: Math.max(sd, 1), days: e.length });
  }
  const scored = test.filter((r) => model.has(r.series)).map((r) => {
    const m = model.get(r.series)!;
    return { ...r, p: bracketProb({ min: r.bmin, max: r.bmax }, r.fcMean + m.bias, m.sigma) };
  });
  const n = scored.length;
  const diffs = scored.map((r) => (r.p - r.y) ** 2 - (r.market - r.y) ** 2);
  const mean = n ? diffs.reduce((a, b) => a + b, 0) / n : NaN;
  const sd = n > 1 ? Math.sqrt(diffs.reduce((a, d) => a + (d - mean) ** 2, 0) / (n - 1)) : NaN;
  const trades: number[] = [];
  for (const r of scored) {
    const ask = r.market + halfSpread, bid = r.market - halfSpread;
    if (ask < 0.99 && r.p - ask >= minEdge) trades.push(r.y - ask - takerFee(ask));
    else if (bid > 0.01 && bid - r.p >= minEdge) trades.push((1 - r.y) - (1 - bid) - takerFee(1 - bid));
  }
  const tMean = trades.length ? trades.reduce((a, b) => a + b, 0) / trades.length : NaN;
  const tSd = trades.length > 1 ? Math.sqrt(trades.reduce((a, t) => a + (t - tMean) ** 2, 0) / (trades.length - 1)) : NaN;
  return {
    split, train_rows: train.length, test_rows: n,
    cities: Object.fromEntries([...model].map(([s, m]) => [s, { bias_f: r4(m.bias), sigma_f: r4(m.sigma), days: m.days }])),
    brier_learned: r4(n ? scored.reduce((a, r) => a + (r.p - r.y) ** 2, 0) / n : NaN),
    brier_market: r4(n ? scored.reduce((a, r) => a + (r.market - r.y) ** 2, 0) / n : NaN),
    z: r4(n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : NaN),
    strategy: { min_edge: minEdge, trades: trades.length, profit_per_contract: r4(tMean), total_per_contract: r4(trades.reduce((a, b) => a + b, 0)), z: r4(trades.length > 1 && tSd > 0 ? tMean / (tSd / Math.sqrt(trades.length)) : NaN) },
  };
}
