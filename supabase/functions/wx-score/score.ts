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
