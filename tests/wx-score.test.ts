import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyMaxByKey, ensembleProb, learnAndTest, localNoonUtc, memberHighs, prevDay, scoreboard, takerFee, type CalRow, type Scored } from "../supabase/functions/wx-score/score.ts";

const day = (d: string) => Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, "0")}:00`);

test("memberHighs: daily max per member per local day, partial days dropped", () => {
  const time = [...day("2026-11-06"), ...day("2026-11-07").slice(0, 6)];
  const a = time.map((_, i) => (i === 14 ? 71.2 : 60));
  const b = time.map((_, i) => (i === 15 ? 69.8 : 55));
  const h = memberHighs({ time, temperature_2m: a, temperature_2m_member01_ecmwf_ifs025: b, other: [1] });
  assert.deepEqual(h.get("2026-11-06"), [71.2, 69.8]);
  assert.equal(h.has("2026-11-07"), false); // only 6 hours
});

test("ensembleProb: members spread over brackets, smoothed", () => {
  const highs = [70, 70, 71, 72, 72, 73, 74, 70, 71, 72];
  const p = ensembleProb({ min: 70, max: 71 }, highs, 0.01);
  assert.ok(Math.abs(p - 0.5) < 1e-6); // 5 of 10 members land in 70-71
  const tail = ensembleProb({ min: 80, max: null }, highs, 1.5);
  assert.ok(tail < 0.01);
  assert.ok(Number.isNaN(ensembleProb({ min: 70, max: 71 }, [70, 71])));
});

test("scoreboard: a forecast that knows more than the market earns its verdict only with enough markets", () => {
  const rows: Scored[] = [];
  for (let i = 0; i < 300; i++) {
    const y = (i % 3 === 0 ? 1 : 0) as 0 | 1;
    rows.push({ ticker: `T${i}`, market: 0.33, ens: y ? 0.7 : 0.15, y });
  }
  const b = scoreboard(rows);
  assert.ok(b.forecast_vs_market.brier_forecast < b.forecast_vs_market.brier_market);
  assert.match(b.verdict.forecast, /^EARNED/);
  assert.match(scoreboard(rows.slice(0, 50)).verdict.forecast, /^not yet/);
});

test("scoreboard: a forecast worse than the market is a no", () => {
  const rows: Scored[] = Array.from({ length: 300 }, (_, i) => {
    const y = (i % 2) as 0 | 1;
    return { ticker: `T${i}`, market: y ? 0.8 : 0.2, ens: 0.5, y };
  });
  assert.match(scoreboard(rows).verdict.forecast, /^no/);
});

test("scoreboard: favorites test needs a real, repeated gap", () => {
  const cheap: Scored[] = Array.from({ length: 250 }, (_, i) => ({ ticker: `F${i}`, market: 0.6, ens: null, y: (i % 5 === 0 ? 0 : 1) as 0 | 1 })); // 80% vs 60¢
  assert.match(scoreboard(cheap).verdict.favorites, /^EARNED/);
  const fair: Scored[] = Array.from({ length: 250 }, (_, i) => ({ ticker: `F${i}`, market: 0.6, ens: null, y: (i % 5 < 3 ? 1 : 0) as 0 | 1 })); // 60% vs 60¢
  assert.match(scoreboard(fair).verdict.favorites, /^no/);
  const bucket = scoreboard(cheap).calibration.find((c) => c.from === 0.55)!;
  assert.equal(bucket.markets, 250);
  assert.equal(bucket.profit_per_contract, 0.2);
});

test("history helpers: daily max per model, noon the day before, Kalshi fee", () => {
  const time = day("2026-10-01");
  const m = dailyMaxByKey({ time, temperature_2m_previous_day1_gfs_seamless: time.map((_, i) => 60 + (i === 15 ? 12 : 0)) });
  assert.equal(m.get("temperature_2m_previous_day1_gfs_seamless")!.get("2026-10-01"), 72);
  assert.equal(prevDay("2026-11-01"), "2026-10-31");
  assert.equal(new Date(localNoonUtc("2026-07-01", "America/New_York")).toISOString(), "2026-07-01T16:00:00.000Z");
  assert.equal(new Date(localNoonUtc("2026-11-10", "America/Los_Angeles")).toISOString(), "2026-11-10T20:00:00.000Z");
  assert.equal(takerFee(0.5), 0.02); // 0.07 x 0.25 = 1.75c -> 2c
  assert.equal(takerFee(0.05), 0.01);
});

test("learnAndTest: learns a city's warm bias on old days and beats a market that ignores it, out of sample", () => {
  const rows: CalRow[] = [];
  for (let d = 0; d < 60; d++) {
    const date = new Date(Date.UTC(2026, 8, 1 + d)).toISOString().slice(0, 10);
    const fc = 70 + (d % 7);
    const actual = fc + 3 + ((d * 37) % 3) - 1; // station runs 3F warmer than the model, +/-1
    for (const lo of [66, 68, 70, 72, 74, 76, 78, 80]) {
      const y = (actual >= lo && actual <= lo + 1 ? 1 : 0) as 0 | 1;
      // a naive market priced off the raw model with no bias
      const market = Math.abs(fc - (lo + 0.5)) < 1.5 ? 0.35 : 0.08;
      rows.push({ series: "KXHIGHNY", date, bmin: lo, bmax: lo + 1, market, fcMean: fc, actual, y });
    }
  }
  const r = learnAndTest(rows, "2026-10-07") as any;
  assert.ok(Math.abs(r.cities.KXHIGHNY.bias_f - 3) < 0.5);
  assert.ok(r.brier_learned < r.brier_market);
  assert.ok(r.strategy.trades > 0 && r.strategy.profit_per_contract > 0);
  assert.ok(r.test_rows > 0 && r.train_rows > 0);
});
