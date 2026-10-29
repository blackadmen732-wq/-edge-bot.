import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeForex } from "../supabase/functions/edgebot/lib/forex.ts";
import type { FxCandle, FxInput } from "../supabase/functions/edgebot/lib/forex.ts";

function candles(n = 80, pair: FxInput["pair"] = "EUR_USD"): FxCandle[] {
  const t0 = Date.parse("2026-10-01T00:00:00Z");
  const base = pair === "USD_JPY" ? 149 : 1.1;
  const step = pair === "USD_JPY" ? 0.02 : 0.0002;
  return Array.from({ length: n }, (_, i) => {
    const close = base + i * step;
    const open = close - step / 3;
    return {
      time: new Date(t0 + (i + 1) * 15 * 60000).toISOString(),
      open, close, high: close + step / 3, low: open - step / 3,
    };
  });
}
function input(pair: FxInput["pair"] = "EUR_USD"): FxInput {
  const data = candles(80, pair);
  const t = Date.parse(data[data.length - 1].time) + 10 * 60000;
  const asOf = new Date(t).toISOString();
  return {
    pair, intervalMinutes: 15, candles: data, asOf,
    spreadPips: 1, equityUsd: 10000, drawdownPct: 0,
    calendarAsOf: asOf, events: [],
  };
}
test("five named agents, paper-only response, no claims of proven profitability", () => {
  const report = analyzeForex(input());
  assert.equal(report.mode, "analysis_only");
  assert.ok(report.patternAgent && report.quantAgent && report.macroAgent && report.riskAgent && report.strategyAgent);
  assert.equal(report.strategyAgent.provenProfitability, false);
  assert.equal(report.strategyAgent.estimatedWinRate, null);
});
test("breakout, upward trend and complete fresh event calendar make a WATCH candidate, never an order", () => {
  const r = analyzeForex(input());
  assert.ok(r.patternAgent.patterns.includes("breakout_up_20"));
  assert.equal(r.quantAgent.bias, "up");
  assert.equal(r.strategyAgent.action, "WATCH_LONG");
  assert.equal(r.riskAgent.maxNotionalMultiple, 1);
  assert.ok((r.riskAgent.paperPositionUnits ?? 0) > 0);
});
test("high-impact news on either currency blocks research entry", () => {
  const x = input();
  x.events = [{ time: x.asOf!, currency: "USD", title: "Employment", impact: "high" }];
  const r = analyzeForex(x);
  assert.equal(r.macroAgent.status, "high_impact_window");
  assert.equal(r.strategyAgent.action, "NO_TRADE");
});
test("missing calendar is unknown and blocks, rather than assuming news is safe", () => {
  const x = input();
  delete x.calendarAsOf;
  delete x.events;
  assert.equal(analyzeForex(x).macroAgent.status, "unknown");
  assert.equal(analyzeForex(x).strategyAgent.action, "NO_TRADE");
});
test("stale calendar and stale candles independently block a setup", () => {
  const a = input();
  a.calendarAsOf = new Date(Date.parse(a.asOf!) - 31 * 60000).toISOString();
  assert.equal(analyzeForex(a).strategyAgent.action, "NO_TRADE");
  const b = input();
  const late = Date.parse(b.asOf!) + 50 * 60000;
  b.asOf = new Date(late).toISOString();
  b.calendarAsOf = b.asOf;
  assert.ok(analyzeForex(b).riskAgent.blockers.some(s => s.includes("stale")));
});
test("high spread, drawdown, absent spread and absent equity block", () => {
  const a = input();
  a.spreadPips = 2.5;
  assert.equal(analyzeForex(a).strategyAgent.action, "NO_TRADE");
  const b = input();
  b.drawdownPct = 5;
  assert.equal(analyzeForex(b).strategyAgent.action, "NO_TRADE");
  const c = input();
  delete c.spreadPips;
  assert.equal(analyzeForex(c).strategyAgent.action, "NO_TRADE");
  const d = input();
  delete d.equityUsd;
  assert.equal(analyzeForex(d).strategyAgent.action, "NO_TRADE");
});
test("USD/JPY has 0.01 pip size and no leverage in estimated units", () => {
  const x = input("USD_JPY");
  const r = analyzeForex(x);
  assert.ok(r.quantAgent.range20Pips > 0);
  assert.ok((r.riskAgent.paperPositionUnits ?? 0) <= x.equityUsd!);
});
test("rejects malformed, unordered, future and inconsistent candles", () => {
  const x = input();
  const duplicate = { ...x, candles: x.candles.slice() };
  duplicate.candles[79] = { ...duplicate.candles[78] };
  assert.throws(() => analyzeForex(duplicate), /strictly increasing/);
  const broken = { ...x, candles: x.candles.map(c => ({ ...c })) };
  broken.candles[10].high = 0;
  assert.throws(() => analyzeForex(broken), /Inconsistent OHLC/);
  const future = { ...x, asOf: x.candles[60].time };
  assert.throws(() => analyzeForex(future), /Future or unfinished/);
  const short = { ...x, candles: x.candles.slice(0, 30) };
  assert.throws(() => analyzeForex(short), /between 60 and 5000/);
});
test("inputs with NaN or negative spread cannot bypass the risk engine", () => {
  const a = input();
  a.spreadPips = Number.NaN;
  assert.throws(() => analyzeForex(a), /Invalid spread/);
  const b = input();
  b.drawdownPct = -1;
  assert.throws(() => analyzeForex(b), /Invalid drawdown/);
});
test("indicator outputs are numeric and repeatable for identical historical snapshots", () => {
  const x = input();
  const a = analyzeForex(x), b = analyzeForex(x);
  assert.deepEqual(a, b);
  assert.ok(a.quantAgent.atr14 > 0);
  assert.ok(a.quantAgent.sma20 > a.quantAgent.sma50);
  assert.ok(a.quantAgent.rsi14 >= 0 && a.quantAgent.rsi14 <= 100);
});
