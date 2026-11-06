import { test } from "node:test";
import assert from "node:assert/strict";
import { bestPlan, fillPnl, fills, parseBook, parseProgram, rewardPerDay, sideScore, type Program } from "../supabase/functions/lip/score.ts";

const week: Program = { ticker: "KXSTATELEG-WISEN26-R", reward: 95, start: "2026-11-06T00:00:00Z", end: "2026-11-13T00:00:00Z", target: 1000, discount: 0.5 };

test("program units: period_reward is hundredths of a cent", () => {
  const p = parseProgram({ incentive_type: "liquidity", market_ticker: "X", period_reward: 950000, start_date: week.start, end_date: week.end, target_size_fp: "1000.00", discount_factor_bps: 5000 })!;
  assert.equal(p.reward, 95);
  assert.equal(p.discount, 0.5);
  assert.ok(Math.abs(rewardPerDay(p) - 95 / 7) < 1e-9);
  assert.equal(parseProgram({ incentive_type: "volume", market_ticker: "X", period_reward: 1 }), null);
});

test("book parsing (real Kalshi shape) and side scoring with the reference price and discount", () => {
  const b = parseBook({ orderbook_fp: { no_dollars: [["0.0100", "1017.69"], ["0.9800", "733.00"], ["0.9900", "3461.00"]], yes_dollars: [] } });
  assert.equal(b.yes.length, 0);
  assert.equal(b.no.length, 3);
  // target 1000 -> reference at the first level reaching 200: 0.99 (3461). 0.98 is 1 tick below -> x0.5, 0.01 is 98 ticks -> ~0
  const n = sideScore(b.no, 1000, 0.5);
  assert.equal(n.reference, 0.99);
  assert.ok(Math.abs(n.score - (3461 + 733 * 0.5)) < 1e-6);
  assert.ok(Math.abs(n.depth - 5211.69) < 1e-6);
});

test("an empty side behind 99c bids is NOT free money: a 1c bid would trade instantly, so no plan", () => {
  const b = parseBook({ orderbook_fp: { no_dollars: [["0.9900", "3461.00"]], yes_dollars: [] } });
  assert.equal(bestPlan(week, b), null);
});

test("an empty side with room: post at the highest price that doesn't cross and own that side", () => {
  const b = parseBook({ orderbook_fp: { no_dollars: [["0.9000", "3461.00"]], yes_dollars: [] } });
  const p = bestPlan(week, b)!;
  assert.deepEqual(p.sides, ["yes"]);
  assert.equal(p.yesPrice, 0.09);     // 1 - 0.90 - 0.01
  assert.equal(p.collateral, 90);
  assert.equal(p.validNow, false);
  assert.equal(p.validWithUs, true);
  assert.equal(p.shareYes, 1);
  assert.ok(Math.abs(p.estDaily - 95 / 7 / 2) < 0.01);
});

test("a crowded market pays little per dollar, and we never post an expensive side", () => {
  const b = parseBook({ orderbook_fp: { yes_dollars: [["0.4000", "20000"]], no_dollars: [["0.5800", "20000"]] } });
  const p = bestPlan(week, b)!;
  assert.deepEqual(p.sides, ["yes"]); // 58c NO side is above the 50c limit
  assert.ok(p.shareYes < 0.05 && p.roiDaily < 0.002);
});

test("fills and marking", () => {
  assert.equal(fills("yes", 0.01, 0.01), true);
  assert.equal(fills("yes", 0.01, 0.02), false);
  assert.equal(fills("no", 0.3, 0.75), true);  // NO bid 30c fills when YES trades at 70c+
  assert.equal(fills("no", 0.3, 0.6), false);
  assert.equal(fillPnl("yes", 1000, 0.01, 0.005), -5);
  assert.equal(fillPnl("no", 100, 0.3, 0.6), 10);
});
