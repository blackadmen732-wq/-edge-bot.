import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, fitCities, mutate, night, randomGenome, requiredZ, rng, splitDays, type Recipe } from "../supabase/functions/wx-score/arena.ts";
import type { CalRow } from "../supabase/functions/wx-score/score.ts";
import { bracketProb } from "../supabase/functions/edgebot/lib/mm.ts";

/** 90 days x 2 cities x 8 brackets. `edge`: the station runs 3F warm and the market ignores it. */
function world(edge: boolean, seed = 1): CalRow[] {
  const r = rng(seed);
  const rows: CalRow[] = [];
  for (let d = 0; d < 90; d++) {
    const date = new Date(Date.UTC(2026, 7, 1 + d)).toISOString().slice(0, 10);
    for (const series of ["KXHIGHNY", "KXHIGHDEN"]) {
      const fc = 60 + Math.floor(r() * 20);
      const normal = Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
      const actual = Math.round(fc + (edge ? 3 : 0) + 2 * normal);
      for (let lo = fc - 8; lo <= fc + 8; lo += 2) {
        const y = (actual >= lo && actual <= lo + 1 ? 1 : 0) as 0 | 1;
        // market priced exactly right off the raw forecast: fair when there is no bias, wrong when there is
        const market = Math.min(Math.max(Math.round(bracketProb({ min: lo, max: lo + 1 }, fc, 2) * 100) / 100, 0.02), 0.98);
        rows.push({ series, date, bmin: lo, bmax: lo + 1, market, fcMean: fc, actual, y });
      }
    }
  }
  return rows;
}

test("genomes stay inside their bounds after many mutations", () => {
  const r = rng(42);
  let g = randomGenome(r);
  for (let i = 0; i < 500; i++) {
    g = mutate(g, r);
    assert.ok(g.priceLo >= 0.02 && g.priceHi <= 0.98 && g.priceLo < g.priceHi);
    assert.ok(g.minEdge >= 0.02 && g.minEdge <= 0.3 && g.cities.length >= 1);
  }
});

test("the luck bar rises with the number of recipes tried", () => {
  assert.ok(Math.abs(requiredZ(1) - 1.645) < 0.01);
  assert.ok(requiredZ(120) > 3.2 && requiredZ(120) < 3.5);
  assert.ok(requiredZ(10000) > requiredZ(120));
});

test("days split oldest -> newest: fit, select, vault", () => {
  const s = splitDays(world(false));
  assert.equal(s.days, 90);
  assert.ok(s.fit.every((r) => r.date < s.selectFrom) && s.vault.every((r) => r.date >= s.vaultFrom));
});

test("a recipe that uses the learned bias makes money where the bias is real, after fees", () => {
  const rows = world(true);
  const { fit, select } = splitDays(rows);
  const g = { minEdge: 0.08, priceLo: 0.02, priceHi: 0.6, side: "both" as const, cities: ["KXHIGHNY", "KXHIGHDEN"], useBias: true, sigmaMult: 1 };
  const s = evaluate(g, select, fitCities(fit));
  assert.ok(s.trades > 30 && s.mean > 0 && s.z > 2, JSON.stringify(s));
  const blind = evaluate({ ...g, useBias: false }, select, fitCities(fit));
  assert.ok(blind.mean < s.mean);
});

test("one night: population stays at 120, the worst die, children name their parents", () => {
  let k = 0;
  const res = night([], world(true), { seed: 7, generation: 1, tried: 0, newId: () => `t${++k}` });
  const alive = res.population.filter((p) => p.status !== "dead");
  assert.equal(alive.length, 120);
  assert.ok(res.killed.length >= 30);
  assert.ok(res.population.filter((p) => p.status === "dead").length === res.killed.length);
  assert.ok(res.born.some((id) => res.population.find((p) => p.id === id)?.parent));
});

test("evolution finds a real edge and proves it on the vault; pure noise never gets proven", () => {
  for (const [edge, expectProven] of [[true, true], [false, false]] as const) {
    let pop: Recipe[] = [];
    let k = 0, tried = 0, proven = 0;
    const rows = world(edge, 3);
    for (let gen = 1; gen <= 6; gen++) {
      const res = night(pop, rows, { seed: gen, generation: gen, tried, newId: () => `g${gen}-${++k}` });
      tried += res.born.length + (gen === 1 ? 120 : 0);
      proven += res.proven.length;
      pop = res.population.filter((p) => p.status !== "dead");
    }
    assert.equal(proven > 0, expectProven, `edge=${edge} proven=${proven}`);
  }
});

test("price-only recipes: buying underpriced favorites makes money; fairly priced ones don't", () => {
  // 60 days x 6 cities: a 0.55-0.65 market that comes true `rate` of the time, plus a 5c long shot that never does
  const make = (rate: number): CalRow[] => {
    const r = rng(9), rows: CalRow[] = [];
    for (let d = 0; d < 60; d++) {
      const date = new Date(Date.UTC(2026, 8, 1 + d)).toISOString().slice(0, 10);
      for (const series of ["KXHIGHNY", "KXHIGHCHI", "KXHIGHMIA", "KXHIGHAUS", "KXHIGHLAX", "KXHIGHDEN"]) {
        rows.push({ series, date, bmin: 70, bmax: 71, market: 0.55 + r() * 0.1, fcMean: 70, actual: 70, y: (r() < rate ? 1 : 0) as 0 | 1 });
        rows.push({ series, date, bmin: 90, bmax: null, market: 0.05, fcMean: 70, actual: 70, y: 0 });
      }
    }
    return rows;
  };
  const fav = { minEdge: 0.1, priceLo: 0.5, priceHi: 0.7, side: "yes" as const, cities: ["KXHIGHNY", "KXHIGHCHI", "KXHIGHMIA", "KXHIGHAUS", "KXHIGHLAX", "KXHIGHDEN"], useBias: false, sigmaMult: 1, mode: "price" as const };
  const cheap = evaluate(fav, make(0.75), new Map());
  assert.equal(cheap.trades, 360); // every favorite, no forecast needed
  assert.ok(cheap.mean > 0.05 && cheap.z > 3, JSON.stringify(cheap));
  const fair = evaluate(fav, make(0.6), new Map());
  assert.ok(fair.mean < 0.01, JSON.stringify(fair)); // fair price minus spread and fee loses
  const noLongShots = evaluate({ ...fav, priceLo: 0.02, priceHi: 0.1, side: "no" }, make(0.6), new Map());
  assert.ok(noLongShots.trades === 360 && noLongShots.mean > 0);
});
