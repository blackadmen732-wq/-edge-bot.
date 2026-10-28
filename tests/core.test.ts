import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { createPublicKey, verify, constants } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ceilCent, kalshiFee, devig, evPerDollar, maxMakerPrice, sizeBet, averageFair } from "../supabase/functions/edgebot/lib/pricing.ts";
import { decide } from "../supabase/functions/edgebot/lib/decide.ts";
import { effectiveSettings, HARD } from "../supabase/functions/edgebot/lib/rules.ts";
import type { Settings } from "../supabase/functions/edgebot/lib/rules.ts";
import { matchGame, nameScore, normalize, isTieLabel } from "../supabase/functions/edgebot/lib/match.ts";
import { fairLine } from "../supabase/functions/edgebot/lib/odds.ts";
import { importKalshiKey, signRequest } from "../supabase/functions/edgebot/lib/kalshi.ts";
import { aiFromEnv, explain } from "../supabase/functions/edgebot/lib/ai.ts";

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

const baseSettings: Settings = effectiveSettings({
  mode: "paper", paused_reason: null, leagues: ["ncaaf", "nfl", "epl", "bogus"], order_style: "smart",
  min_edge: 0.03, min_prob: 0.15, max_prob: 0.85, kelly_fraction: 0.25, max_stake_pct: 0.05,
  max_bets_per_day: 5, max_open_exposure_pct: 0.3, stop_balance: 10, paper_start_bankroll: 20,
  min_hours_before_start: 1, max_hours_before_start: 48, resting_order_minutes: 120, report_email: null,
});

// ---------------- fees

test("fee matches Kalshi's published table (taker)", () => {
  // 100 contracts at 50c -> $1.75; at 10c -> $0.63; at 25c -> $1.32 (rounded up)
  assert.equal(kalshiFee(0.5, 100, "taker"), 1.75);
  assert.equal(kalshiFee(0.1, 100, "taker"), 0.63);
  assert.equal(kalshiFee(0.25, 100, "taker"), 1.32);
  assert.equal(kalshiFee(0.95, 100, "taker"), 0.34);
});

test("fee rounds up per order — tiny orders pay a big percentage", () => {
  // 1 contract at 50c: 0.0175 -> $0.02 (4% of a $0.50 stake)
  assert.equal(kalshiFee(0.5, 1, "taker"), 0.02);
  assert.equal(kalshiFee(0.5, 2, "taker"), 0.04);
});

test("maker fees: 25% on maker-fee series, zero on plain quadratic", () => {
  assert.equal(kalshiFee(0.5, 100, "maker", { feeType: "quadratic_with_maker_fees", feeMultiplier: 1 }), 0.44);
  assert.equal(kalshiFee(0.5, 100, "maker", { feeType: "quadratic", feeMultiplier: 1 }), 0);
  assert.equal(kalshiFee(0.5, 100, "maker", { feeType: "quadratic_with_combo_maker_fees", feeMultiplier: 1 }), 0.88);
});

test("ceilCent does not over-round float noise", () => {
  assert.equal(ceilCent(0.07), 0.07);
  assert.equal(ceilCent(0.0700000001), 0.07);
  assert.equal(ceilCent(0.0701), 0.08);
});

// ---------------- fair odds

test("devig: two-way and three-way sum to 1", () => {
  const two = devig({ A: 1.91, B: 1.91 })!;
  near(two.A, 0.5); near(two.B, 0.5);
  const three = devig({ Home: 2.1, Draw: 3.4, Away: 3.6 })!;
  near(three.Home + three.Draw + three.Away, 1);
  assert.ok(three.Home > three.Away);
});

test("devig rejects broken prices", () => {
  assert.equal(devig({ A: 1.0, B: 1.9 }), null);
  assert.equal(devig({ A: 5, B: 5 }), null); // sums to 0.4: nonsense
  assert.equal(devig({ A: 1.9 }), null);
});

test("averageFair needs matching outcomes", () => {
  near(averageFair([{ A: 0.6, B: 0.4 }, { A: 0.5, B: 0.5 }])!.A, 0.55);
  assert.equal(averageFair([{ A: 0.6, B: 0.4 }, { A: 0.5, C: 0.5 }]), null);
});

// ---------------- EV and sizing

test("EV per dollar includes the fee", () => {
  // p=0.6, buy 1 at 0.50 with 0.02 fee: payout 0.6, spend 0.52 -> +15.4%
  near(evPerDollar(0.6, 0.5, 1, 0.02), (0.6 - 0.52) / 0.52);
  assert.ok(evPerDollar(0.5, 0.5, 1, 0.02) < 0);
});

test("maxMakerPrice finds the highest price that still clears the edge", () => {
  const price = maxMakerPrice(0.6, 1, 0.03)!;
  const f = kalshiFee(price, 1, "maker");
  assert.ok(evPerDollar(0.6, price, 1, f) >= 0.03);
  const higher = price + 0.01;
  assert.ok(evPerDollar(0.6, higher, 1, kalshiFee(higher, 1, "maker")) < 0.03);
});

test("sizing never breaks the caps", () => {
  const r = sizeBet({ p: 0.7, price: 0.5, bankroll: 20, cashAvailable: 20, openExposure: 0, kellyFraction: 1, maxStakePct: 0.05, maxStakeUsd: 20, maxOpenExposurePct: 0.3 });
  assert.ok(r.stake <= 20 * 0.05 + 1e-9, `stake ${r.stake}`);
  assert.equal(r.contracts, 2); // $1 cap / $0.50
  const big = sizeBet({ p: 0.7, price: 0.5, bankroll: 10000, cashAvailable: 10000, openExposure: 0, kellyFraction: 1, maxStakePct: 0.05, maxStakeUsd: 20, maxOpenExposurePct: 0.3 });
  assert.ok(big.stake <= 20 + 1e-9, "hard $20 cap");
  const noRoom = sizeBet({ p: 0.7, price: 0.5, bankroll: 20, cashAvailable: 20, openExposure: 6, kellyFraction: 1, maxStakePct: 0.05, maxStakeUsd: 20, maxOpenExposurePct: 0.3 });
  assert.equal(noRoom.contracts, 0, "exposure cap reached");
  const noEdge = sizeBet({ p: 0.4, price: 0.5, bankroll: 20, cashAvailable: 20, openExposure: 0, kellyFraction: 0.25, maxStakePct: 0.05, maxStakeUsd: 20, maxOpenExposurePct: 0.3 });
  assert.equal(noEdge.contracts, 0);
});

test("per-bet dollar cap is $300 and only binds on a big bankroll", () => {
  assert.equal(HARD.MAX_STAKE_USD, 300);
  const base = { p: 0.7, price: 0.5, cashAvailable: 1e9, openExposure: 0, kellyFraction: 1, maxStakePct: 0.05, maxStakeUsd: HARD.MAX_STAKE_USD, maxOpenExposurePct: 0.3 };
  assert.equal(sizeBet({ ...base, bankroll: 20 }).stake, 1, "$20 bankroll: 5% = $1");
  assert.equal(sizeBet({ ...base, bankroll: 2000 }).stake, 100, "$2,000 bankroll: 5% = $100");
  assert.equal(sizeBet({ ...base, bankroll: 100000 }).stake, 300, "$100,000 bankroll: capped at $300");
});

test("settings cannot loosen hard caps", () => {
  const loose = effectiveSettings({ ...baseSettings, max_stake_pct: 0.5, min_edge: 0, max_bets_per_day: 999, stop_balance: 0, max_prob: 0.99, min_prob: 0.01, kelly_fraction: 3 });
  assert.equal(loose.max_stake_pct, HARD.MAX_STAKE_PCT);
  assert.equal(loose.min_edge, HARD.MIN_EDGE_FLOOR);
  assert.equal(loose.max_bets_per_day, HARD.MAX_BETS_PER_DAY);
  assert.equal(loose.stop_balance, HARD.STOP_BALANCE_FLOOR);
  assert.equal(loose.max_prob, HARD.PROB_CEILING);
  assert.equal(loose.min_prob, HARD.PROB_FLOOR);
  assert.equal(loose.kelly_fraction, 0.5);
  assert.deepEqual(baseSettings.leagues, ["ncaaf", "nfl", "epl"], "unknown leagues dropped");
});

// ---------------- decisions

const bank = { equity: 20, cash: 20, openExposure: 0 };

test("decide: takes a clearly underpriced ask", () => {
  const d = decide(0.6, { yesBid: 0.5, yesAsk: 0.52, askSize: 100 }, baseSettings, bank, { feeType: "quadratic_with_maker_fees", feeMultiplier: 1 });
  assert.equal(d.action, "taker");
  if (d.action === "taker") {
    assert.equal(d.price, 0.52);
    assert.ok(d.ev >= 0.03);
    assert.ok(d.contracts * d.price <= 1 + 1e-9);
  }
});

test("decide: fairly priced market -> waits below or skips, never takes", () => {
  const d = decide(0.55, { yesBid: 0.53, yesAsk: 0.56, askSize: 100 }, baseSettings, bank, { feeType: "quadratic_with_maker_fees", feeMultiplier: 1 });
  assert.notEqual(d.action, "taker");
  if (d.action === "rest") {
    assert.ok(d.price < 0.56);
    assert.ok(d.ev >= 0.03);
  }
});

test("decide: skips long shots and heavy favorites", () => {
  assert.equal(decide(0.1, { yesBid: 0.01, yesAsk: 0.02, askSize: 100 }, baseSettings, bank, { feeType: "quadratic", feeMultiplier: 1 }).action, "skip");
  assert.equal(decide(0.95, { yesBid: 0.5, yesAsk: 0.51, askSize: 100 }, baseSettings, bank, { feeType: "quadratic", feeMultiplier: 1 }).action, "skip");
});

test("decide: taker-only style never posts waiting orders", () => {
  const s = { ...baseSettings, order_style: "taker" as const };
  const d = decide(0.55, { yesBid: 0.53, yesAsk: 0.56, askSize: 100 }, s, bank, { feeType: "quadratic", feeMultiplier: 1 });
  assert.equal(d.action, "skip");
});

test("decide: respects the ask size", () => {
  const d = decide(0.7, { yesBid: 0.5, yesAsk: 0.5, askSize: 0 }, baseSettings, bank, { feeType: "quadratic", feeMultiplier: 1 });
  assert.notEqual(d.action, "taker");
});

// ---------------- matching

test("names: mascots, abbreviations, accents", () => {
  assert.equal(normalize("Ohio St."), "ohio state");
  assert.equal(normalize("St. Louis"), "saint louis");
  assert.ok(nameScore("Ohio St.", "Ohio State Buckeyes") >= 0.9);
  assert.ok(nameScore("Ohio St.", "Ohio Bobcats") < 0.8);
  assert.ok(nameScore("UCF", "UCF Knights") >= 0.9);
  assert.ok(nameScore("LSU", "LSU Tigers") >= 0.9);
  assert.ok(nameScore("Miami (FL)", "Miami Hurricanes") >= 0.9);
  assert.ok(nameScore("Kansas City", "Kansas City Chiefs") >= 0.9);
  assert.ok(nameScore("Los Angeles R", "Los Angeles Rams") >= 0.9);
  assert.ok(nameScore("Los Angeles R", "Los Angeles Chargers") < 0.8);
  assert.ok(nameScore("Atlético Madrid", "Atletico Madrid") >= 0.9);
  assert.ok(nameScore("Man City", "Manchester City") >= 0.9);
  assert.ok(nameScore("Man Utd", "Manchester United") >= 0.9);
  assert.ok(nameScore("Spurs", "Tottenham Hotspur") >= 0.9);
  assert.ok(isTieLabel("Tie") && isTieLabel("Draw") && !isTieLabel("Texas"));
});

test("matchGame: finds the right game and maps sides", () => {
  const games = [
    { id: "g1", commence: "2026-10-31T16:00:00Z", home: "Ohio State Buckeyes", away: "Penn State Nittany Lions" },
    { id: "g2", commence: "2026-10-31T19:30:00Z", home: "Ohio Bobcats", away: "Kent State Golden Flashes" },
  ];
  const m = matchGame({ eventTicker: "E1", teams: ["Penn St.", "Ohio St."], startHint: "2026-10-31T16:00:00Z" }, games)!;
  assert.equal(m.game.id, "g1");
  assert.deepEqual(m.mapping, ["Penn State Nittany Lions", "Ohio State Buckeyes"]);
});

test("matchGame: refuses when kickoff is far away or names don't fit", () => {
  const games = [{ id: "g1", commence: "2026-11-07T16:00:00Z", home: "Ohio State Buckeyes", away: "Penn State Nittany Lions" }];
  assert.equal(matchGame({ eventTicker: "E1", teams: ["Penn St.", "Ohio St."], startHint: "2026-10-31T16:00:00Z" }, games), null);
  assert.equal(matchGame({ eventTicker: "E1", teams: ["Texas", "Oklahoma"], startHint: null }, games), null);
});

test("matchGame: refuses ambiguous duplicates", () => {
  const games = [
    { id: "a", commence: "2026-10-31T16:00:00Z", home: "Miami Hurricanes", away: "Boston College Eagles" },
    { id: "b", commence: "2026-10-31T17:00:00Z", home: "Miami Hurricanes", away: "Boston College Eagles" },
  ];
  assert.equal(matchGame({ eventTicker: "E", teams: ["Miami (FL)", "Boston College"], startHint: "2026-10-31T16:30:00Z" }, games), null);
});

// ---------------- sharp line

const now = Date.parse("2026-10-30T12:00:00Z");
const fresh = "2026-10-30T11:50:00Z";
const stale = "2026-10-30T09:00:00Z";
function ev(books: Record<string, [number, number, string]>) {
  return {
    id: "x", sport_key: "americanfootball_ncaaf", commence_time: "2026-10-31T16:00:00Z", home_team: "H", away_team: "A",
    bookmakers: Object.entries(books).map(([key, [h, a, upd]]) => ({ key, title: key, markets: [{ key: "h2h", last_update: upd, outcomes: [{ name: "H", price: h }, { name: "A", price: a }] }] })),
  };
}

test("fairLine prefers Pinnacle and cross-checks it", () => {
  const f = fairLine(ev({ pinnacle: [1.6, 2.5, fresh], betonlineag: [1.62, 2.45, fresh] }), false, now)!;
  assert.equal(f.source, "pinnacle");
  near(f.fair.H + f.fair.A, 1);
});

test("fairLine skips stale or disagreeing prices", () => {
  assert.equal(fairLine(ev({ pinnacle: [1.6, 2.5, stale] }), false, now), null, "stale pinnacle, no backup");
  assert.equal(fairLine(ev({ pinnacle: [1.6, 2.5, fresh], betonlineag: [2.5, 1.6, fresh] }), false, now), null, "books disagree");
  assert.equal(fairLine(ev({ draftkings: [1.6, 2.5, fresh] }), false, now), null, "retail-only never used");
});

test("fairLine falls back to two agreeing sharp books", () => {
  const f = fairLine(ev({ lowvig: [1.6, 2.5, fresh], betonlineag: [1.62, 2.45, fresh] }), false, now)!;
  assert.equal(f.source, "sharp_consensus");
});

// ---------------- optional AI writer

test("AI: off without keys, Claude by default, Grok when chosen", () => {
  const env = (m: Record<string, string>) => (k: string) => m[k];
  assert.equal(aiFromEnv(env({})), null);
  assert.deepEqual(aiFromEnv(env({ ANTHROPIC_API_KEY: "a" })), { provider: "anthropic", key: "a", model: "claude-haiku-5-5" });
  assert.deepEqual(aiFromEnv(env({ XAI_API_KEY: "x" })), { provider: "xai", key: "x", model: "grok-4.3" });
  assert.equal(aiFromEnv(env({ ANTHROPIC_API_KEY: "a", XAI_API_KEY: "x" }))!.provider, "anthropic");
  assert.equal(aiFromEnv(env({ ANTHROPIC_API_KEY: "a", XAI_API_KEY: "x", AI_PROVIDER: "grok" }))!.provider, "xai");
  assert.equal(aiFromEnv(env({ XAI_API_KEY: "x", AI_MODEL: "grok-4.7" }))!.model, "grok-4.7");
});

test("AI: calls Claude and Grok with the right request shape", async () => {
  const calls: any[] = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (url.includes("anthropic")) return new Response(JSON.stringify({ content: [{ type: "text", text: "Claude says hi." }] }), { status: 200 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "Grok says hi." } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal(await explain({ provider: "anthropic", key: "k1", model: "claude-haiku-5-5" }, "sys", { a: 1 }, fakeFetch), "Claude says hi.");
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].init.headers["x-api-key"], "k1");
  assert.equal(calls[0].body.system, "sys");
  assert.ok(calls[0].body.max_tokens <= 500);
  assert.equal(await explain({ provider: "xai", key: "k2", model: "grok-4.3" }, "sys", { a: 1 }, fakeFetch), "Grok says hi.");
  assert.equal(calls[1].url, "https://api.x.ai/v1/chat/completions");
  assert.equal(calls[1].init.headers.authorization, "Bearer k2");
  assert.equal(calls[1].body.messages[0].role, "system");
});

test("AI: errors and empty answers throw so the report falls back", async () => {
  const bad = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(explain({ provider: "anthropic", key: "k", model: "m" }, "s", {}, bad), /401/);
  const empty = (async () => new Response(JSON.stringify({ content: [] }), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(explain({ provider: "anthropic", key: "k", model: "m" }, "s", {}, empty), /no text/);
});

// ---------------- Kalshi request signing

test("Kalshi signature verifies with the public key (PKCS#1 key like Kalshi gives you)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kalshi-"));
  const keyPath = join(dir, "k.pem");
  execSync(`openssl genrsa -traditional -out ${keyPath} 2048 2>/dev/null || openssl genrsa -out ${keyPath} 2048 2>/dev/null`);
  const pem = readFileSync(keyPath, "utf8");
  assert.ok(pem.includes("BEGIN RSA PRIVATE KEY"), "test key should be PKCS#1");
  const key = await importKalshiKey(pem);
  const ts = "1761600000000";
  const sig = await signRequest(key, ts, "post", "/trade-api/v2/portfolio/events/orders?x=1");
  const pub = createPublicKey(pem);
  const ok = verify("sha256", Buffer.from(ts + "POST" + "/trade-api/v2/portfolio/events/orders"), { key: pub, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(sig, "base64"));
  assert.ok(ok, "signature must verify over timestamp+METHOD+path without query");
  // Also works when the key was pasted with literal \n sequences.
  const key2 = await importKalshiKey(pem.replace(/\n/g, "\\n"));
  assert.ok(key2);
});
