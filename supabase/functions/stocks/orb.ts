// Opening-range breakout (the setup from the day-trader-skill pack), as pure functions.
// No network, no database: index.ts feeds it bars and money, it answers "trade or not, and how big".
// Its own author's replay called this setup "close to a coin flip". The caps below are what keep a coin flip cheap.

/** Hard caps baked into code. The settings row can make them stricter, never looser. Changing these needs a PR. */
export const STOCK_HARD = {
  /** Never risk more than this on one trade (entry minus stop, times shares). */
  MAX_LOSS_PER_TRADE_USD: 50,
  /** Never put more than this into one position. */
  MAX_POSITION_USD: 2000,
  /** Never open more than this many trades in one day. */
  MAX_TRADES_PER_DAY: 3,
  /** Stop opening trades once the account is down this much today. */
  DAILY_LOSS_LIMIT_USD: 100,
  /** Real money only after this many closed paper trades... */
  LIVE_GATE_MIN_PAPER_TRADES: 10,
  /** ...and only if those paper trades made money in total. */
  LIVE_GATE_REQUIRE_PAPER_PROFIT: true,
  /** Don't take a breakout that already ran more than this far past the range. */
  MAX_CHASE_PCT: 0.01,
  /** Ignore ranges so tight the stop sits inside the noise. */
  MIN_RISK_PCT: 0.002,
  /** Target at most this many times the risk. */
  MAX_TARGET_R: 2,
} as const;

/** Entry window and the flat-by time, in New York minutes since midnight. */
export const WINDOW = { OPEN: 9 * 60 + 30, RANGE_END: 9 * 60 + 45, LAST_ENTRY: 11 * 60, FLAT: 15 * 60 + 55 } as const;

export interface Bar { t: string; o: number; h: number; l: number; c: number; v: number }

export interface StockSettings {
  mode: "paper" | "live" | "paused";
  watchlist: string[];
  max_loss_per_trade: number;
  max_position_usd: number;
  max_trades_per_day: number;
  daily_loss_limit: number;
  target_r: number;
}

const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Database settings, squeezed inside the hard caps. Garbage becomes the safe default. */
export function effectiveStockSettings(row: any): StockSettings {
  const mode = row?.mode === "live" || row?.mode === "paper" ? row.mode : "paused";
  const watchlist = (Array.isArray(row?.watchlist) ? row.watchlist : [])
    .map((s: unknown) => String(s).toUpperCase().trim())
    .filter((s: string) => /^[A-Z.]{1,6}$/.test(s))
    .slice(0, 30);
  return {
    mode,
    watchlist,
    max_loss_per_trade: clamp(num(row?.max_loss_per_trade, 25), 0, STOCK_HARD.MAX_LOSS_PER_TRADE_USD),
    max_position_usd: clamp(num(row?.max_position_usd, 1000), 0, STOCK_HARD.MAX_POSITION_USD),
    max_trades_per_day: Math.floor(clamp(num(row?.max_trades_per_day, 2), 0, STOCK_HARD.MAX_TRADES_PER_DAY)),
    daily_loss_limit: clamp(num(row?.daily_loss_limit, 50), 1, STOCK_HARD.DAILY_LOSS_LIMIT_USD),
    target_r: clamp(num(row?.target_r, 1), 0.5, STOCK_HARD.MAX_TARGET_R),
  };
}

/** New York wall-clock for an instant: date (YYYY-MM-DD) and minutes since midnight. Handles daylight saving. */
export function nyClock(at: Date): { date: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export type Signal =
  | { action: "wait" | "skip"; reason: string }
  | { action: "buy"; reason: string; entry: number; stop: number; target: number; rangeHigh: number; rangeLow: number };

/**
 * Today's 5-minute bars (bar time = bar start) -> breakout signal.
 * Fires only on the FIRST completed 5-minute close above the 9:30-9:45 range, before 11:00 New York.
 */
export function orbSignal(bars: Bar[], now: Date, targetR = 1): Signal {
  const today = nyClock(now).date;
  const day = bars.filter((b) => nyClock(new Date(b.t)).date === today)
    .map((b) => ({ ...b, m: nyClock(new Date(b.t)).minutes }))
    .sort((a, b) => a.m - b.m);
  const range = day.filter((b) => b.m >= WINDOW.OPEN && b.m < WINDOW.RANGE_END);
  if (range.length < 3) return { action: "wait", reason: "opening range not complete" };
  const hi = Math.max(...range.map((b) => b.h));
  const lo = Math.min(...range.map((b) => b.l));
  const nowMin = nyClock(now).minutes;
  // a bar is complete once its 5 minutes have passed
  const after = day.filter((b) => b.m >= WINDOW.RANGE_END && b.m + 5 <= nowMin);
  const firstBreak = after.find((b) => b.c > hi);
  if (!firstBreak) return nowMin >= WINDOW.LAST_ENTRY ? { action: "skip", reason: "no breakout before 11:00" } : { action: "wait", reason: "no close above the range yet" };
  if (firstBreak !== after[after.length - 1]) return { action: "skip", reason: "breakout already happened earlier" };
  if (firstBreak.m + 5 > WINDOW.LAST_ENTRY) return { action: "skip", reason: "breakout after 11:00" };
  const entry = firstBreak.c;
  if (entry > hi * (1 + STOCK_HARD.MAX_CHASE_PCT)) return { action: "skip", reason: "too far past the range to chase" };
  const stop = round2((hi + lo) / 2);
  const risk = entry - stop;
  if (risk <= 0 || risk / entry < STOCK_HARD.MIN_RISK_PCT) return { action: "skip", reason: "range too tight" };
  const target = round2(entry + clamp(targetR, 0.5, STOCK_HARD.MAX_TARGET_R) * risk);
  return { action: "buy", reason: "first close above the opening range", entry: round2(entry), stop, target, rangeHigh: hi, rangeLow: lo };
}

/** Shares to buy so a stop-out loses at most the max loss, the position stays under its cap, and it fits in cash. */
export function sizeShares(entry: number, stop: number, s: Pick<StockSettings, "max_loss_per_trade" | "max_position_usd">, cash: number): number {
  const risk = entry - stop;
  if (!(risk > 0) || !(entry > 0)) return 0;
  const byLoss = Math.min(s.max_loss_per_trade, STOCK_HARD.MAX_LOSS_PER_TRADE_USD) / risk;
  const byPos = Math.min(s.max_position_usd, STOCK_HARD.MAX_POSITION_USD) / entry;
  const byCash = Math.max(cash, 0) / entry;
  return Math.max(0, Math.floor(Math.min(byLoss, byPos, byCash)));
}

/** Last check before any order. Returns the reasons to block; empty means go. */
export function riskBlocks(i: {
  s: StockSettings; tradesToday: number; dayPnl: number; alreadyTradedSymbol: boolean; shares: number;
  entry: number; stop: number; nowMinutes: number;
}): string[] {
  const r: string[] = [];
  if (i.s.mode === "paused") r.push("stocks are paused");
  if (i.tradesToday >= i.s.max_trades_per_day) r.push(`already ${i.tradesToday} trades today`);
  if (i.dayPnl <= -i.s.daily_loss_limit) r.push(`down $${(-i.dayPnl).toFixed(2)} today, at the daily limit`);
  if (i.alreadyTradedSymbol) r.push("already traded this symbol today");
  if (i.shares < 1) r.push("position size rounds to zero");
  if (i.shares * (i.entry - i.stop) > STOCK_HARD.MAX_LOSS_PER_TRADE_USD + 1e-9) r.push("loss at stop over the hard cap");
  if (i.shares * i.entry > STOCK_HARD.MAX_POSITION_USD + 1e-9) r.push("position over the hard cap");
  if (i.nowMinutes < WINDOW.RANGE_END || i.nowMinutes >= WINDOW.LAST_ENTRY + 5) r.push("outside the entry window");
  return r;
}

/** Paper record -> may real money start? */
export function stockLiveGate(paper: { closed: number; pnl: number }, liveSecret: boolean, keysPresent: boolean): string[] {
  const r: string[] = [];
  if (paper.closed < STOCK_HARD.LIVE_GATE_MIN_PAPER_TRADES) r.push(`needs ${STOCK_HARD.LIVE_GATE_MIN_PAPER_TRADES} closed paper trades (has ${paper.closed})`);
  if (STOCK_HARD.LIVE_GATE_REQUIRE_PAPER_PROFIT && !(paper.pnl > 0)) r.push(`paper trades must be in profit (now $${paper.pnl.toFixed(2)})`);
  if (!liveSecret) r.push("secret STOCKS_LIVE_ENABLED is not set to true");
  if (!keysPresent) r.push("live Alpaca key secrets are missing");
  return r;
}

export function round2(x: number) { return Math.round(x * 100) / 100; }
