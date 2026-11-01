import { test } from "node:test";
import assert from "node:assert/strict";
import { appendSnapshot, buildMoney, verdict } from "../supabase/functions/parallax-money/curve.ts";
import { describe } from "../supabase/functions/parallax-money/intake.ts";

const NOW = Date.parse("2026-11-01T12:00:00Z");

test("paper money: a bought position is marked at the latest mid", () => {
  const out = buildMoney({
    now: NOW, sportsStart: 20, mmStart: 500, mmEnabled: true, mode: "paper",
    fills: [{ ticker: "A", side: "bid", price: 0.4, contracts: 10, fee: 0, mid_at_fill: 0.4, markout: 0.01, filled_at: "2026-11-01T10:00:00Z" }],
    mids: [{ ticker: "A", mid: 0.5, at: "2026-11-01T11:00:00Z" }],
    positions: [], bets: [], runs: [], dayStart: null,
  });
  assert.equal(out.paper_only, true);
  assert.equal(out.start.total, 520);
  assert.equal(out.now.mm, 1); // 10 contracts x (0.50 - 0.40)
  assert.equal(out.now.total, 521);
});

test("verdict waits for enough fills and settled markets", () => {
  assert.equal(verdict({ fills: 160, settled_markets: 20, markout_cents: -1.15, pnl: 28 }).stage, "warming_up");
  assert.equal(verdict({ fills: 400, settled_markets: 40, markout_cents: -1, pnl: 10 }).stage, "picked_off");
  assert.equal(verdict({ fills: 400, settled_markets: 40, markout_cents: 0.5, pnl: 10 }).stage, "promising");
});

test("snapshots: at most one per 25 minutes", () => {
  const a = appendSnapshot([], { t: "2026-11-01T10:00:00Z", total: 1, pnl: 0, mm: 0, sports: 0, fills: 0 })!;
  assert.equal(a.length, 1);
  assert.equal(appendSnapshot(a, { t: "2026-11-01T10:10:00Z", total: 1, pnl: 0, mm: 0, sports: 0, fills: 0 }), null);
  assert.equal(appendSnapshot(a, { t: "2026-11-01T10:30:00Z", total: 1, pnl: 0, mm: 0, sports: 0, fills: 0 })!.length, 2);
});

test("intake lines read plainly", () => {
  assert.equal(describe("kraken.spot", { pair: "XBTUSD", price: 70000 }), "XBTUSD $70,000");
});
