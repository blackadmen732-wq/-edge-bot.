// Market making, paper only: quote both a buy and a sell price around the market's own price,
// earn the gap when other people trade, and measure honestly whether better-informed traders pick us off.
// Pure math and rules: no network, no database. The engine (index.ts) feeds it prices, trades and forecasts.
//
// There is deliberately no real-money path for market making. Fills are simulated from Kalshi's real trades.

import { validPrice } from "./pricing.ts";

/** Hard limits for market making. Database settings can make these stricter, never looser. */
export const MM_HARD = {
  /** Most contracts on one side of one quote. */
  MAX_QUOTE_SIZE: 100,
  /** Most contracts held in one market, long or short. */
  MAX_INVENTORY: 200,
  /** Narrowest allowed gap between our price and the middle, in cents. */
  MIN_HALF_SPREAD_CENTS: 1,
  /** The forecast may only nudge the market's price, never replace it. */
  MAX_FORECAST_WEIGHT: 0.3,
  /** Largest nudge the forecast may make, in dollars (3¢). */
  MAX_FORECAST_NUDGE: 0.03,
  /** Minutes after a fill at which we check whether the price moved against us. */
  MARKOUT_MINUTES: 60,
  /** Stop quoting a market on its own day once local time reaches this hour (live readings take over). */
  SAME_DAY_CUTOFF_HOUR: 10,
  /** Don't make a two-sided market when the middle is this close to 0 or 1. */
  MIN_MID: 0.03,
  MAX_MID: 0.97,
} as const;

/** City weather series we quote, with the settlement station's location. Tickers can be checked with ?task=discover&category=Climate. */
export interface City {
  name: string;
  lat: number;
  lon: number;
  tz: string;
}

export const MM_CITIES: Record<string, City> = {
  KXHIGHNY: { name: "New York (Central Park)", lat: 40.7789, lon: -73.9692, tz: "America/New_York" },
  KXHIGHCHI: { name: "Chicago (Midway)", lat: 41.7868, lon: -87.7522, tz: "America/Chicago" },
  KXHIGHMIA: { name: "Miami (airport)", lat: 25.7881, lon: -80.3169, tz: "America/New_York" },
  KXHIGHAUS: { name: "Austin (Bergstrom)", lat: 30.1831, lon: -97.6799, tz: "America/Chicago" },
  KXHIGHLAX: { name: "Los Angeles (LAX)", lat: 33.9382, lon: -118.3866, tz: "America/Los_Angeles" },
  KXHIGHDEN: { name: "Denver (airport)", lat: 39.8466, lon: -104.6562, tz: "America/Denver" },
};

export interface MmSettings {
  mm_enabled: boolean;
  mm_series: string[];
  mm_bankroll: number;
  mm_quote_size: number;
  mm_half_spread_cents: number;
  mm_max_inventory: number;
  mm_daily_loss_limit: number;
  mm_forecast_weight: number;
  mm_tail_max_prob: number;
  mm_tail_edge: number;
  mm_lip_target: number;
  mm_alert_fill_contracts: number;
}

function num(x: unknown, fallback: number): number {
  if (x === null || x === undefined || x === "") return fallback;
  const v = Number(x);
  return Number.isFinite(v) ? v : fallback;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

/** Apply the hard limits. Missing or garbage values fall back to safe defaults. */
export function effectiveMm(row: Partial<Record<keyof MmSettings, unknown>>): MmSettings {
  const series = Array.isArray(row.mm_series) ? (row.mm_series as unknown[]).map(String).filter((s) => s in MM_CITIES) : Object.keys(MM_CITIES);
  return {
    mm_enabled: row.mm_enabled === undefined || row.mm_enabled === null ? true : row.mm_enabled === true || row.mm_enabled === "true",
    mm_series: series,
    mm_bankroll: clamp(num(row.mm_bankroll, 500), 0, 1_000_000),
    mm_quote_size: Math.floor(clamp(num(row.mm_quote_size, 20), 0, MM_HARD.MAX_QUOTE_SIZE)),
    mm_half_spread_cents: clamp(num(row.mm_half_spread_cents, 2), MM_HARD.MIN_HALF_SPREAD_CENTS, 20),
    mm_max_inventory: Math.floor(clamp(num(row.mm_max_inventory, 60), 0, MM_HARD.MAX_INVENTORY)),
    mm_daily_loss_limit: clamp(num(row.mm_daily_loss_limit, 25), 0, 1_000_000),
    mm_forecast_weight: clamp(num(row.mm_forecast_weight, 0.15), 0, MM_HARD.MAX_FORECAST_WEIGHT),
    mm_tail_max_prob: clamp(num(row.mm_tail_max_prob, 0.08), 0, 0.2),
    mm_tail_edge: clamp(num(row.mm_tail_edge, 0.03), 0.01, 0.5),
    mm_lip_target: Math.floor(clamp(num(row.mm_lip_target, 100), 1, 100_000)),
    mm_alert_fill_contracts: Math.floor(clamp(num(row.mm_alert_fill_contracts, 20), 1, 100_000)),
  };
}

// ---------------------------------------------------------------- prices

/** The market's own price: the middle of the best buy and sell, else the last trade. NaN if none. */
export function marketMid(bid: number, ask: number, last: number = NaN): number {
  if (validPrice(bid) && validPrice(ask) && ask > bid) return (bid + ask) / 2;
  return validPrice(last) ? last : NaN;
}

/** Standard normal cumulative distribution (Abramowitz–Stegun 7.1.26, error < 1e-7). */
export function normCdf(z: number): number {
  if (z === Infinity) return 1;
  if (z === -Infinity) return 0;
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** A temperature bracket in whole degrees, inclusive. null = open-ended. */
export interface Bracket {
  min: number | null;
  max: number | null;
}

/**
 * Read a Kalshi temperature market's bracket. Uses strike_type / floor_strike / cap_strike when present,
 * otherwise the subtitle ("72° to 73°", "74° or above", "65° or below"). Returns null if unclear.
 */
export function parseBracket(m: { strike_type?: string; floor_strike?: number | string | null; cap_strike?: number | string | null; yes_sub_title?: string; subtitle?: string }): Bracket | null {
  const f = m.floor_strike === null || m.floor_strike === undefined ? NaN : Number(m.floor_strike);
  const c = m.cap_strike === null || m.cap_strike === undefined ? NaN : Number(m.cap_strike);
  const t = (m.strike_type ?? "").toLowerCase();
  if (t === "between" && Number.isFinite(f) && Number.isFinite(c) && c >= f) return { min: Math.round(f), max: Math.round(c) };
  if (t === "greater" && Number.isFinite(f)) return { min: Math.floor(f) + 1, max: null };
  if (t === "greater_or_equal" && Number.isFinite(f)) return { min: Math.ceil(f), max: null };
  if (t === "less" && Number.isFinite(c)) return { min: null, max: Math.ceil(c) - 1 };
  if (t === "less_or_equal" && Number.isFinite(c)) return { min: null, max: Math.floor(c) };
  const text = (m.yes_sub_title ?? m.subtitle ?? "").replace(/\s+/g, " ");
  let r = text.match(/(-?\d+)\s*°?\s*(?:to|-|–)\s*(-?\d+)\s*°/i);
  if (r) return { min: Number(r[1]), max: Number(r[2]) };
  r = text.match(/(-?\d+)\s*°?\s*or (?:above|higher|more)/i);
  if (r) return { min: Number(r[1]), max: null };
  r = text.match(/(-?\d+)\s*°?\s*or (?:below|lower|less)/i);
  if (r) return { min: null, max: Number(r[1]) };
  return null;
}

/** Chance the official whole-degree high lands in the bracket, if the true high ~ Normal(mu, sigma). */
export function bracketProb(b: Bracket, mu: number, sigma: number): number {
  if (!(sigma > 0) || !Number.isFinite(mu)) return NaN;
  const hi = b.max === null ? 1 : normCdf((b.max + 0.5 - mu) / sigma);
  const lo = b.min === null ? 0 : normCdf((b.min - 0.5 - mu) / sigma);
  return Math.min(Math.max(hi - lo, 0), 1);
}

/** Typical day-ahead forecast miss (°F) by how many days away the market's day is. */
export function forecastSigma(daysAhead: number): number {
  if (daysAhead <= 0) return 1.8;
  if (daysAhead === 1) return 2.6;
  return 3.3;
}

/** The market's price, nudged a little toward the forecast (never replaced by it). */
export function fairPrice(mid: number, forecastP: number | null, weight: number): number {
  if (!validPrice(mid)) return NaN;
  if (forecastP === null || !Number.isFinite(forecastP)) return mid;
  const w = clamp(weight, 0, MM_HARD.MAX_FORECAST_WEIGHT);
  const nudge = clamp(w * (forecastP - mid), -MM_HARD.MAX_FORECAST_NUDGE, MM_HARD.MAX_FORECAST_NUDGE);
  return clamp(mid + nudge, 0.01, 0.99);
}

// ---------------------------------------------------------------- quotes

export interface Quote {
  price: number;
  size: number;
}

export interface QuoteResult {
  bid: Quote | null; // we buy YES at this price
  ask: Quote | null; // we sell YES at this price (same as buying NO at 1 - price)
  strategy: "two_sided" | "tail_sell" | "none";
  reason: string;
}

export interface QuoteInput {
  mid: number;
  fair: number;
  forecastP: number | null;
  marketBid: number;
  marketAsk: number;
  /** Contracts held in this market now: positive = own YES, negative = sold YES. */
  inventory: number;
  /** True when total money at risk is near the bankroll: only quote the side that shrinks the position. */
  riskFull: boolean;
  s: MmSettings;
}

const floorCent = (x: number) => Math.floor(x * 100 + 1e-9) / 100;
const ceilCent = (x: number) => Math.ceil(x * 100 - 1e-9) / 100;
const none = (reason: string): QuoteResult => ({ bid: null, ask: null, strategy: "none", reason });

/**
 * Where to post our buy and sell prices for one market.
 * - Centered on the fair price (market price + small forecast nudge).
 * - Skewed by inventory: the more we own, the lower both prices go, so we buy less and sell more.
 * - Never crosses the market (we only ever wait for others to trade with us).
 * - Long shots the forecast says are overpriced get a sell-only quote instead.
 */
export function makeQuotes(i: QuoteInput): QuoteResult {
  const s = i.s;
  if (s.mm_quote_size < 1) return none("quote size is 0");
  if (!validPrice(i.mid) || !validPrice(i.fair)) return none("no market price");

  // Overpriced long shot: the forecast says it's unlikely and the market charges well above that.
  if (i.forecastP !== null && Number.isFinite(i.forecastP) && i.forecastP <= s.mm_tail_max_prob && i.mid - i.forecastP >= s.mm_tail_edge) {
    let price = ceilCent(Math.max(i.forecastP + s.mm_tail_edge, i.mid));
    if (validPrice(i.marketBid) && price <= i.marketBid) price = ceilCent(i.marketBid + 0.01);
    const room = s.mm_max_inventory + i.inventory; // how many more we may sell
    const size = Math.min(s.mm_quote_size, room);
    if (size < 1 || !validPrice(price) || i.riskFull && i.inventory <= 0) return none("long shot, but at the sell limit");
    return { bid: null, ask: { price, size }, strategy: "tail_sell", reason: `long shot: forecast ${(i.forecastP * 100).toFixed(1)}%, market ${(i.mid * 100).toFixed(1)}%` };
  }

  if (i.mid < MM_HARD.MIN_MID || i.mid > MM_HARD.MAX_MID) return none("price too close to 0 or 100");

  const half = s.mm_half_spread_cents / 100;
  const skew = s.mm_max_inventory > 0 ? (i.inventory / s.mm_max_inventory) * 2 * half : 0;
  const center = i.fair - skew;
  let bidPrice = floorCent(center - half);
  let askPrice = ceilCent(center + half);
  // Never cross the market: a buy at or above the best ask would trade instantly (we'd be the taker).
  if (validPrice(i.marketAsk) && bidPrice >= i.marketAsk) bidPrice = floorCent(i.marketAsk - 0.01);
  if (validPrice(i.marketBid) && askPrice <= i.marketBid) askPrice = ceilCent(i.marketBid + 0.01);

  let bidSize = Math.min(s.mm_quote_size, s.mm_max_inventory - i.inventory);
  let askSize = Math.min(s.mm_quote_size, s.mm_max_inventory + i.inventory);
  if (i.riskFull) {
    if (i.inventory >= 0) bidSize = 0; // only sell down
    if (i.inventory <= 0) askSize = 0; // only buy back
  }
  const bid = bidSize >= 1 && validPrice(bidPrice) ? { price: bidPrice, size: bidSize } : null;
  const ask = askSize >= 1 && validPrice(askPrice) ? { price: askPrice, size: askSize } : null;
  if (bid && ask && bid.price >= ask.price) return none("no room between buy and sell");
  if (!bid && !ask) return none(i.riskFull ? "money at risk is near the bankroll" : "at the inventory limit");
  const notes: string[] = [];
  if (!bid) notes.push("buy side off (inventory limit)");
  if (!ask) notes.push("sell side off (inventory limit)");
  return { bid, ask, strategy: "two_sided", reason: notes.length ? notes.join("; ") : `fair ${(i.fair * 100).toFixed(1)}¢, inventory ${i.inventory}` };
}

/** True if both sides are posted, each at least `target` contracts, close to the best prices (roughly what Kalshi's liquidity rewards count). */
export function lipCompetitive(q: QuoteResult, marketBid: number, marketAsk: number): boolean {
  if (!q.bid || !q.ask) return false;
  const bidOk = !validPrice(marketBid) || q.bid.price >= marketBid - 0.02;
  const askOk = !validPrice(marketAsk) || q.ask.price <= marketAsk + 0.02;
  return bidOk && askOk;
}

// ---------------------------------------------------------------- timing (step aside before news)

/** UTC windows (minutes after midnight) when new weather model runs and NWS forecasts usually land. */
export const NEWS_WINDOWS_UTC: [number, number][] = [
  [3 * 60 + 30, 5 * 60],      // GFS 00z
  [6 * 60, 7 * 60 + 30],      // ECMWF 00z
  [8 * 60, 9 * 60],           // NWS morning forecast (US East)
  [9 * 60 + 30, 10 * 60 + 30],// GFS 06z
  [15 * 60 + 30, 17 * 60],    // GFS 12z
  [18 * 60, 19 * 60 + 30],    // ECMWF 12z
  [20 * 60, 21 * 60],         // NWS afternoon forecast (US East)
  [21 * 60 + 30, 22 * 60 + 30], // GFS 18z
];

/** True if a news window is open now or opens before our quotes would next be refreshed. */
export function inNewsWindow(now: Date, lookaheadMinutes = 31, windows = NEWS_WINDOWS_UTC): boolean {
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  for (const [a, b] of windows) {
    for (const shift of [0, 1440, -1440]) {
      const start = a + shift, end = b + shift;
      if (m < end && m + lookaheadMinutes > start) return true;
    }
  }
  return false;
}

/** Local calendar date (YYYY-MM-DD) and hour for a time zone. */
export function localDateHour(now: Date, tz: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

const MONTHS: Record<string, string> = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };

/** The day a Kalshi weather event is about, from its ticker ("KXHIGHNY-26OCT29" -> "2026-10-29"). */
export function eventDate(eventTicker: string): string | null {
  const r = eventTicker.toUpperCase().match(/-(\d{2})([A-Z]{3})(\d{2})(?:-|$)/);
  if (!r || !MONTHS[r[2]]) return null;
  return `20${r[1]}-${MONTHS[r[2]]}-${r[3]}`;
}

/** Whole days from `fromDate` to `toDate` (both YYYY-MM-DD). */
export function daysBetween(fromDate: string, toDate: string): number {
  return Math.round((Date.parse(toDate + "T00:00:00Z") - Date.parse(fromDate + "T00:00:00Z")) / 86_400_000);
}

// ---------------------------------------------------------------- fills and accounting

export interface Trade {
  price: number; // YES price in dollars
  count: number;
  time: number;  // ms
}

/**
 * Simulated fill for a resting quote. Strict on purpose: we assume we were last in line, so a trade
 * only fills us if it printed strictly *through* our price (below our buy, or above our sell).
 */
export function simulateFill(side: "bid" | "ask", price: number, size: number, postedMs: number, endMs: number, trades: Trade[]): number {
  let filled = 0;
  for (const t of trades) {
    if (!(t.time > postedMs && t.time <= endMs) || !(t.count > 0)) continue;
    const through = side === "bid" ? t.price < price - 1e-9 : t.price > price + 1e-9;
    if (through) filled += t.count;
    if (filled >= size) return size;
  }
  return Math.floor(filled);
}

/** Cents per contract the price moved in our favor (+) or against us (−) after a fill. */
export function markout(side: "bid" | "ask", fillPrice: number, laterMid: number): number {
  if (!validPrice(laterMid)) return NaN;
  return side === "bid" ? laterMid - fillPrice : fillPrice - laterMid;
}

export interface Position {
  position: number; // + own YES, − sold YES
  cash: number;     // money in (+) and out (−), fees included
}

export function applyFill(p: Position, side: "bid" | "ask", price: number, contracts: number, fee: number): Position {
  return side === "bid"
    ? { position: p.position + contracts, cash: p.cash - price * contracts - fee }
    : { position: p.position - contracts, cash: p.cash + price * contracts - fee };
}

/** Value now if we could close at the market's price. */
export function markValue(p: Position, mid: number): number {
  return p.cash + p.position * (validPrice(mid) ? mid : 0.5);
}

/** Final profit when the market settles (YES pays $1). */
export function settleValue(p: Position, yes: boolean): number {
  return p.cash + p.position * (yes ? 1 : 0);
}

/** The most this position can lose, whichever way it settles. */
export function worstCase(p: Position): number {
  return Math.max(0, -Math.min(settleValue(p, true), settleValue(p, false)));
}
