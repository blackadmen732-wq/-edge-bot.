import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOC, allocate, dayScore, psr } from "../supabase/functions/edgebot/lib/allocator.ts";
import type { AgentDay } from "../supabase/functions/edgebot/lib/allocator.ts";

const base = (agent: string, over: Partial<AgentDay> = {}): AgentDay => ({
  agent, equity: 100, prevEquity: 100, peak: 100, prevLogw: 0, history: [], lead: null, prevStatus: "probation", ...over,
});

// Deterministic "noise" so tests never flake.
const wiggle = (i: number) => Math.sin(i * 12.9898) * 0.5;

test("day score is in risk units and clipped", () => {
  assert(Math.abs(dayScore(101, 100) - 0.5) < 1e-9);
  assert.equal(dayScore(150, 100), 1);
  assert.equal(dayScore(50, 100), -1);
  assert.equal(dayScore(100, null), 0);
});

test("PSR: steady winner is confident, zero-mean noise is not", () => {
  const win = Array.from({ length: 120 }, (_, i) => 0.3 + wiggle(i) * 0.5);
  const noise = Array.from({ length: 120 }, (_, i) => wiggle(i));
  assert(psr(win)!.psr > 0.99);
  assert(psr(noise)!.psr < 0.95);
  assert.equal(psr([1, 1]), null);
});

test("nobody proven: everyone stays at or below an equal share, never above normal size", () => {
  const r = allocate([base("a", { equity: 101 }), base("b"), base("c", { equity: 99 })]);
  for (const x of r) {
    assert.equal(x.status, "probation");
    assert(x.weight <= 1 / 3 + 1e-12);
    assert(x.weight >= ALLOC.FLOOR_SHARE - 1e-12);
    assert(x.riskMult <= 1);
  }
  assert(r.reduce((s, x) => s + x.weight, 0) <= 1 + 1e-12);
});

test("a proven agent with a positive early signal compounds: more than an equal share and bigger size", () => {
  const history = Array.from({ length: 90 }, (_, i) => 0.3 + wiggle(i) * 0.5);
  const proven = base("winner", { equity: 101, history, prevLogw: 3, lead: 0.01 });
  const r = allocate([proven, base("b", { prevLogw: -1 }), base("c", { prevLogw: -1 })]);
  const w = r.find((x) => x.agent === "winner")!;
  assert.equal(w.status, "active");
  assert(w.weight > 1 / 3);
  assert(w.weight <= ALLOC.MAX_SHARE + 1e-12);
  assert(w.riskMult > 1);
});

test("same track record but negative early signal: not promoted", () => {
  const history = Array.from({ length: 90 }, (_, i) => 0.3 + wiggle(i) * 0.5);
  const r = allocate([base("x", { history, prevLogw: 3, lead: -0.01 }), base("y")]);
  assert.equal(r[0].status, "probation");
  assert(r[0].riskMult <= 1);
});

test("10% drawdown sends an agent to the floor; it is never removed", () => {
  const r = allocate([base("dd", { equity: 89, prevEquity: 95, peak: 100 }), base("ok"), base("ok2")]);
  const d = r.find((x) => x.agent === "dd")!;
  assert.equal(d.status, "floor");
  assert.equal(d.riskMult, ALLOC.MIN_MULT);
  assert(d.weight > 0);
});

test("5% drawdown halves size", () => {
  const r = allocate([base("dd", { equity: 94, prevEquity: 94, peak: 100 }), base("ok")]);
  assert.equal(r[0].riskMult, 0.5);
});
