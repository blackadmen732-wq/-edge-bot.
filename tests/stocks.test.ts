import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveStockSettings, nyClock, orbSignal, riskBlocks, sizeShares, stockLiveGate, STOCK_HARD, type Bar } from "../supabase/functions/stocks/orb.ts";

// Monday Nov 9 2026, New York is UTC-5 (daylight saving ended Nov 1). 9:30 ET = 14:30 UTC.
const bar = (hhmmUtc: string, o: number, h: number, l: number, c: number): Bar => ({ t: `2026-11-09T${hhmmUtc}:00Z`, o, h, l, c, v: 1000 });
const RANGE = [bar("14:30", 100, 101, 99.5, 100.5), bar("14:35", 100.5, 101.2, 100, 100.8), bar("14:40", 100.8, 101, 99, 100.2)]; // hi 101.2, lo 99

test("new york clock handles standard time", () => {
  assert.deepEqual(nyClock(new Date("2026-11-09T14:30:00Z")), { date: "2026-11-09", minutes: 570 });
  assert.equal(nyClock(new Date("2026-07-06T13:30:00Z")).minutes, 570); // summer: UTC-4
});

test("orb: waits until the opening range is complete", () => {
  assert.equal(orbSignal(RANGE.slice(0, 2), new Date("2026-11-09T14:41:00Z")).action, "wait");
});

test("orb: buys the first completed close above the range, stop at the midpoint, 1R target", () => {
  const bars = [...RANGE, bar("14:45", 100.2, 101.6, 100.1, 101.5)];
  const s = orbSignal(bars, new Date("2026-11-09T14:51:00Z"), 1);
  assert.equal(s.action, "buy");
  if (s.action !== "buy") return;
  assert.equal(s.entry, 101.5);
  assert.equal(s.stop, 100.1); // (101.2 + 99) / 2
  assert.equal(s.target, 102.9); // 101.5 + 1.4
});

test("orb: ignores a bar that is still forming", () => {
  const bars = [...RANGE, bar("14:45", 100.2, 101.6, 100.1, 101.5)];
  assert.equal(orbSignal(bars, new Date("2026-11-09T14:48:00Z")).action, "wait");
});

test("orb: does not chase a breakout that happened on an earlier bar", () => {
  const bars = [...RANGE, bar("14:45", 100.2, 101.6, 100.1, 101.5), bar("14:50", 101.5, 102, 101.3, 101.9)];
  assert.equal(orbSignal(bars, new Date("2026-11-09T14:56:00Z")).action, "skip");
});

test("orb: skips a close too far above the range", () => {
  const bars = [...RANGE, bar("14:45", 100.2, 103, 100.1, 102.9)]; // 1.7% over 101.2
  assert.equal(orbSignal(bars, new Date("2026-11-09T14:51:00Z")).action, "skip");
});

test("sizing: max loss decides, and never over the position or cash caps", () => {
  const s = { max_loss_per_trade: 50, max_position_usd: 2000 };
  assert.equal(sizeShares(364.18, 358.32, s, 5000), 5); // 50/5.86 = 8.5 by loss, 2000/364 = 5.49 by position
  assert.equal(sizeShares(101.5, 100.1, s, 500), 4); // cash decides
  assert.equal(sizeShares(100, 101, s, 5000), 0); // stop above entry
});

test("settings: garbage and greed are squeezed inside the hard caps", () => {
  const s = effectiveStockSettings({ mode: "yolo", watchlist: ["tsla", "DROP TABLE", 7], max_loss_per_trade: 99999, max_position_usd: 1e9, max_trades_per_day: 50, daily_loss_limit: 1e6, target_r: 9 });
  assert.equal(s.mode, "paused");
  assert.deepEqual(s.watchlist, ["TSLA"]);
  assert.equal(s.max_loss_per_trade, STOCK_HARD.MAX_LOSS_PER_TRADE_USD);
  assert.equal(s.max_position_usd, STOCK_HARD.MAX_POSITION_USD);
  assert.equal(s.max_trades_per_day, STOCK_HARD.MAX_TRADES_PER_DAY);
  assert.equal(s.daily_loss_limit, STOCK_HARD.DAILY_LOSS_LIMIT_USD);
  assert.equal(s.target_r, STOCK_HARD.MAX_TARGET_R);
});

test("risk: blocks after the daily loss limit, the trade count, or a repeat symbol", () => {
  const s = effectiveStockSettings({ mode: "live", watchlist: ["SPY"], max_loss_per_trade: 50, max_position_usd: 2000, max_trades_per_day: 2, daily_loss_limit: 50 });
  const base = { s, tradesToday: 0, dayPnl: 0, alreadyTradedSymbol: false, shares: 5, entry: 100, stop: 99, nowMinutes: 600 };
  assert.deepEqual(riskBlocks(base), []);
  assert.equal(riskBlocks({ ...base, dayPnl: -50 }).length, 1);
  assert.equal(riskBlocks({ ...base, tradesToday: 2 }).length, 1);
  assert.equal(riskBlocks({ ...base, alreadyTradedSymbol: true }).length, 1);
  assert.equal(riskBlocks({ ...base, nowMinutes: 700 }).length, 1);
  assert.ok(riskBlocks({ ...base, shares: 100 }).length >= 1); // $100 loss at stop, over the $50 cap
});

test("live gate: needs a paper record in profit, the secret, and the keys", () => {
  assert.equal(stockLiveGate({ closed: 3, pnl: 20 }, true, true).length, 1);
  assert.equal(stockLiveGate({ closed: 12, pnl: -5 }, true, true).length, 1);
  assert.equal(stockLiveGate({ closed: 12, pnl: 5 }, false, false).length, 2);
  assert.deepEqual(stockLiveGate({ closed: 12, pnl: 5 }, true, true), []);
});
