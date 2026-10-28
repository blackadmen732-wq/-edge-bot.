import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyFill, bracketProb, daysBetween, effectiveMm, eventDate, fairPrice, inNewsWindow, lipCompetitive, localDateHour,
  makeQuotes, markout, markValue, marketMid, MM_HARD, normCdf, parseBracket, settleValue, simulateFill, worstCase,
} from "../supabase/functions/edgebot/lib/mm.ts";
import type { QuoteInput } from "../supabase/functions/edgebot/lib/mm.ts";

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const s = effectiveMm({});
const base: QuoteInput = { mid: 0.5, fair: 0.5, forecastP: null, marketBid: 0.47, marketAsk: 0.53, inventory: 0, riskFull: false, s };

test("mm settings: safe defaults, hard caps, garbage falls back", () => {
  assert.equal(s.mm_enabled, true);
  assert.ok(s.mm_series.length >= 6);
  const loose = effectiveMm({ mm_quote_size: 5000, mm_max_inventory: 9999, mm_forecast_weight: 1, mm_half_spread_cents: 0, mm_series: ["KXHIGHNY", "BOGUS"] });
  assert.equal(loose.mm_quote_size, MM_HARD.MAX_QUOTE_SIZE);
  assert.equal(loose.mm_max_inventory, MM_HARD.MAX_INVENTORY);
  assert.equal(loose.mm_forecast_weight, MM_HARD.MAX_FORECAST_WEIGHT);
  assert.equal(loose.mm_half_spread_cents, MM_HARD.MIN_HALF_SPREAD_CENTS);
  assert.deepEqual(loose.mm_series, ["KXHIGHNY"]);
  const junk = effectiveMm({ mm_quote_size: "x", mm_bankroll: NaN, mm_enabled: "false" });
  assert.equal(junk.mm_quote_size, 20);
  assert.equal(junk.mm_bankroll, 500);
  assert.equal(junk.mm_enabled, false);
});

test("market price: middle of buy/sell, else last trade", () => {
  near(marketMid(0.4, 0.44), 0.42);
  near(marketMid(NaN, 0.44, 0.41), 0.41);
  assert.ok(Number.isNaN(marketMid(NaN, NaN)));
  assert.ok(Number.isNaN(marketMid(0.5, 0.4)), "crossed book is not a price");
});

test("brackets: Kalshi fields and subtitles", () => {
  assert.deepEqual(parseBracket({ strike_type: "between", floor_strike: 72, cap_strike: 73 }), { min: 72, max: 73 });
  assert.deepEqual(parseBracket({ strike_type: "greater", floor_strike: 79 }), { min: 80, max: null });
  assert.deepEqual(parseBracket({ strike_type: "less", cap_strike: 66 }), { min: null, max: 65 });
  assert.deepEqual(parseBracket({ yes_sub_title: "72° to 73°" }), { min: 72, max: 73 });
  assert.deepEqual(parseBracket({ yes_sub_title: "80° or above" }), { min: 80, max: null });
  assert.deepEqual(parseBracket({ yes_sub_title: "65° or below" }), { min: null, max: 65 });
  assert.equal(parseBracket({ yes_sub_title: "Rain in NYC" }), null);
});

test("bracket chances add up to 1 across a full ladder", () => {
  near(normCdf(0), 0.5);
  near(normCdf(1.96), 0.975, 1e-3);
  const ladder = [{ min: null, max: 69 }, { min: 70, max: 71 }, { min: 72, max: 73 }, { min: 74, max: 75 }, { min: 76, max: null }];
  const total = ladder.reduce((a, b) => a + bracketProb(b, 72.6, 2.6), 0);
  near(total, 1, 1e-6);
  assert.ok(bracketProb({ min: 72, max: 73 }, 72.6, 2.6) > bracketProb({ min: 76, max: null }, 72.6, 2.6));
});

test("fair price: the forecast only nudges the market, capped at 3¢", () => {
  near(fairPrice(0.4, null, 0.15), 0.4);
  near(fairPrice(0.4, 0.5, 0.15), 0.415);
  near(fairPrice(0.4, 0.95, 0.3), 0.43, 1e-9);
  near(fairPrice(0.4, 0.0, 0.3), 0.37, 1e-9);
});

test("quotes: symmetric around fair, never cross the market", () => {
  const q = makeQuotes(base);
  assert.equal(q.strategy, "two_sided");
  near(q.bid!.price, 0.48);
  near(q.ask!.price, 0.52);
  assert.equal(q.bid!.size, s.mm_quote_size);
  const tight = makeQuotes({ ...base, marketBid: 0.49, marketAsk: 0.5 });
  assert.ok(tight.bid === null || tight.bid.price < 0.5, "buy below the best sell");
  assert.ok(tight.ask === null || tight.ask.price > 0.49, "sell above the best buy");
});

test("quotes: inventory skews prices and stops buying at the limit", () => {
  const long = makeQuotes({ ...base, inventory: 30 });
  assert.ok(long.bid!.price < 0.48 && long.ask!.price < 0.52, "own a lot -> both prices drop");
  const full = makeQuotes({ ...base, inventory: s.mm_max_inventory });
  assert.equal(full.bid, null, "no more buying at the limit");
  assert.ok(full.ask && full.ask.size > 0);
  const short = makeQuotes({ ...base, inventory: -s.mm_max_inventory });
  assert.equal(short.ask, null, "no more selling at the limit");
});

test("quotes: when money at risk is near the bankroll, only shrink the position", () => {
  const q = makeQuotes({ ...base, inventory: 10, riskFull: true });
  assert.equal(q.bid, null);
  assert.ok(q.ask);
  assert.equal(makeQuotes({ ...base, inventory: 0, riskFull: true }).strategy, "none");
});

test("quotes: overpriced long shot gets a sell-only quote; extremes are skipped", () => {
  const t = makeQuotes({ ...base, mid: 0.1, fair: 0.1, forecastP: 0.03, marketBid: 0.08, marketAsk: 0.12 });
  assert.equal(t.strategy, "tail_sell");
  assert.equal(t.bid, null);
  assert.ok(t.ask!.price >= 0.1 && t.ask!.price > 0.08);
  const fine = makeQuotes({ ...base, mid: 0.1, fair: 0.1, forecastP: 0.09, marketBid: 0.08, marketAsk: 0.12 });
  assert.equal(fine.strategy, "two_sided", "not overpriced enough -> normal quotes");
  assert.equal(makeQuotes({ ...base, mid: 0.99, fair: 0.99, marketBid: 0.98, marketAsk: 0.99 }).strategy, "none");
});

test("liquidity-reward check needs both sides near the best prices", () => {
  const q = makeQuotes(base);
  assert.equal(lipCompetitive(q, 0.47, 0.53), true);
  assert.equal(lipCompetitive({ ...q, ask: null }, 0.47, 0.53), false);
  assert.equal(lipCompetitive({ ...q, bid: { price: 0.4, size: 20 } }, 0.47, 0.53), false);
});

test("news windows: step aside before model runs, quote in quiet hours", () => {
  assert.equal(inNewsWindow(new Date("2026-10-28T16:00:00Z")), true, "inside GFS 12z");
  assert.equal(inNewsWindow(new Date("2026-10-28T15:10:00Z")), true, "window opens before next refresh");
  assert.equal(inNewsWindow(new Date("2026-10-28T13:00:00Z")), false);
  assert.equal(inNewsWindow(new Date("2026-10-28T00:30:00Z")), false);
});

test("dates: event ticker, local day and hour, days apart", () => {
  assert.equal(eventDate("KXHIGHNY-26OCT29"), "2026-10-29");
  assert.equal(eventDate("KXHIGHNY-26OCT29-B72.5"), "2026-10-29");
  assert.equal(eventDate("garbage"), null);
  assert.deepEqual(localDateHour(new Date("2026-10-28T03:30:00Z"), "America/New_York"), { date: "2026-10-27", hour: 23 });
  assert.equal(daysBetween("2026-10-28", "2026-10-29"), 1);
});

test("fake fills: only trades strictly through our price, after we posted, capped at our size", () => {
  const trades = [
    { price: 0.48, count: 50, time: 2000 }, // at our price: last in line, no fill
    { price: 0.47, count: 5, time: 500 },   // before we posted
    { price: 0.47, count: 7, time: 3000 },  // through: fills 7
    { price: 0.45, count: 40, time: 4000 }, // through: fills the rest
  ];
  assert.equal(simulateFill("bid", 0.48, 20, 1000, 10_000, trades), 20);
  assert.equal(simulateFill("bid", 0.48, 20, 1000, 3500, trades), 7);
  assert.equal(simulateFill("ask", 0.52, 20, 1000, 10_000, trades), 0);
  assert.equal(simulateFill("ask", 0.52, 20, 0, 10, [{ price: 0.55, count: 3, time: 5 }]), 3);
});

test("accounting: fills, value, settlement, worst case, markouts", () => {
  let p = { position: 0, cash: 0 };
  p = applyFill(p, "bid", 0.48, 10, 0);
  p = applyFill(p, "ask", 0.52, 10, 0);
  near(p.cash, 0.4);
  assert.equal(p.position, 0);
  near(settleValue(p, true), 0.4);
  const short = applyFill({ position: 0, cash: 0 }, "ask", 0.1, 10, 0.01);
  near(settleValue(short, false), 0.99);
  near(settleValue(short, true), -9.01);
  near(worstCase(short), 9.01);
  near(markValue(short, 0.1), -0.01);
  near(markout("bid", 0.48, 0.45), -0.03);
  near(markout("ask", 0.52, 0.45), 0.07);
});

test("forecast reader: Open-Meteo daily highs by local date, skipping blanks", async () => {
  const { forecastHighs } = await import("../supabase/functions/edgebot/lib/weather.ts");
  let asked = "";
  const fake = (async (u: any) => {
    asked = String(u);
    return new Response(JSON.stringify({ daily: { time: ["2026-10-28", "2026-10-29", "2026-10-30"], temperature_2m_max: [61.2, 64.8, null] } }), { status: 200 });
  }) as typeof fetch;
  const highs = await forecastHighs({ name: "NYC", lat: 40.78, lon: -73.97, tz: "America/New_York" }, fake);
  assert.equal(highs.get("2026-10-29"), 64.8);
  assert.equal(highs.has("2026-10-30"), false);
  assert.ok(asked.includes("temperature_unit=fahrenheit") && asked.includes("timezone=America%2FNew_York"));
});
