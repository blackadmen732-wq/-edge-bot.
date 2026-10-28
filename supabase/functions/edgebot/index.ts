// Football Edge Bot — Supabase Edge Function.
//
// Tasks (?task=...):
//   scan      every few hours: pull sharp odds + Kalshi prices, find mispriced games, place bets
//   tick      every 30 min: fill/expire waiting orders, record closing prices, settle finished games, kill switch
//   report    weekly email summary
//   dashboard public read-only JSON for the dashboard page
//   control   pause / resume / go_live (needs the control token)
//   discover  list Kalshi sports series (needs the control token)
//
// Paper trading always runs. Real money only runs in "live" mode, and only after the live gate passes.

import postgres from "npm:postgres@3.4.5";
import { decide } from "./lib/decide.ts";
import type { Bankroll, Decision } from "./lib/decide.ts";

type BetDecision = Exclude<Decision, { action: "skip" }>;
import { getMarket, getOpenEvents, getSeries, KalshiTrader, listSportsSeries } from "./lib/kalshi.ts";
import type { KalshiEvent, KalshiMarket } from "./lib/kalshi.ts";
import { isTieLabel, matchGame } from "./lib/match.ts";
import { fairLine, fetchOdds } from "./lib/odds.ts";
import { DEFAULT_FEE, dollars, kalshiFee, validPrice } from "./lib/pricing.ts";
import type { FeeInfo } from "./lib/pricing.ts";
import { effectiveSettings, HARD, LEAGUES } from "./lib/rules.ts";
import type { Settings } from "./lib/rules.ts";

export const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: Number(Deno.env.get("EDGEBOT_DB_MAX_CONN") ?? 3), idle_timeout: 20 });

type Mode = "paper" | "live";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-edgebot-token, x-edgebot-cron, authorization, apikey",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { ...CORS, "content-type": "application/json" } });
}

// ------------------------------------------------------------------ helpers

async function vault(name: string): Promise<string | null> {
  const rows = await sql`select decrypted_secret from vault.decrypted_secrets where name = ${name} limit 1`;
  return rows[0]?.decrypted_secret ?? null;
}

async function loadSettings(): Promise<Settings> {
  const [row] = await sql`select * from edgebot.settings where id = 1`;
  return effectiveSettings(row as unknown as Settings);
}

async function stateGet<T>(key: string): Promise<{ value: T; updated_at: Date } | null> {
  const [row] = await sql`select value, updated_at from edgebot.state where key = ${key}`;
  return row ? { value: row.value as T, updated_at: row.updated_at } : null;
}

async function stateSet(key: string, value: unknown): Promise<void> {
  await sql`insert into edgebot.state (key, value, updated_at) values (${key}, ${sql.json(value as any)}, now())
            on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

async function startRun(task: string): Promise<number> {
  const [r] = await sql`insert into edgebot.runs (task) values (${task}) returning id`;
  return Number(r.id);
}

async function finishRun(id: number, ok: boolean, summary: unknown, error?: string) {
  await sql`update edgebot.runs set finished_at = now(), ok = ${ok}, summary = ${sql.json(summary as any)}, error = ${error ?? null} where id = ${id}`;
}

async function feeInfo(series: string): Promise<FeeInfo> {
  const cached = await stateGet<FeeInfo>(`fee:${series}`);
  if (cached && Date.now() - new Date(cached.updated_at).getTime() < 24 * 3.6e6) return cached.value;
  try {
    const s = await getSeries(series);
    const info: FeeInfo = { feeType: s?.fee_type ?? DEFAULT_FEE.feeType, feeMultiplier: Number(s?.fee_multiplier ?? 1) || 1 };
    await stateSet(`fee:${series}`, info);
    return info;
  } catch {
    return cached?.value ?? DEFAULT_FEE;
  }
}

function seriesOf(eventTicker: string): string {
  return eventTicker.split("-")[0];
}

function quote(m: KalshiMarket) {
  return {
    yesBid: dollars(m.yes_bid_dollars),
    yesAsk: dollars(m.yes_ask_dollars),
    askSize: dollars(m.yes_ask_size_fp),
  };
}

function mid(m: KalshiMarket): number {
  const b = dollars(m.yes_bid_dollars), a = dollars(m.yes_ask_dollars);
  if (validPrice(b) && validPrice(a)) return (a + b) / 2;
  const last = dollars(m.last_price_dollars);
  return validPrice(last) ? last : NaN;
}

const n = (x: unknown) => (x === null || x === undefined ? 0 : Number(x));

/** Paper bankroll from the bets table. */
async function paperBankroll(start: number): Promise<Bankroll & { settled: number; pnl: number }> {
  const [r] = await sql`
    select
      coalesce(sum(case when status in ('filled','won','lost','void') then cost + fee else 0 end), 0) as spent,
      coalesce(sum(case when status in ('won','void') then payout else 0 end), 0) as returned,
      coalesce(sum(case when status = 'filled' then cost + fee else 0 end), 0) as riding,
      coalesce(sum(case when status = 'resting' then limit_price * contracts + fee else 0 end), 0) as reserved,
      count(*) filter (where status in ('won','lost')) as settled,
      coalesce(sum(pnl) filter (where status in ('won','lost','void')), 0) as pnl
    from edgebot.bets where mode = 'paper'`;
  const cash = start - n(r.spent) + n(r.returned) - n(r.reserved);
  const riding = n(r.riding), reserved = n(r.reserved);
  return { cash, openExposure: riding + reserved, equity: cash + riding + reserved, settled: Number(r.settled), pnl: n(r.pnl) };
}

async function liveExposure(): Promise<{ riding: number; reserved: number }> {
  const [r] = await sql`
    select
      coalesce(sum(case when status = 'filled' then cost + fee else 0 end), 0) as riding,
      coalesce(sum(case when status = 'resting' then limit_price * contracts + fee else 0 end), 0) as reserved
    from edgebot.bets where mode = 'live'`;
  return { riding: n(r.riding), reserved: n(r.reserved) };
}

async function betsToday(mode: Mode): Promise<number> {
  // Waiting orders that got canceled (e.g. refreshed with new prices) don't count toward the daily limit.
  const [r] = await sql`select count(*)::int as c from edgebot.bets where mode = ${mode} and placed_at > now() - interval '24 hours'
                        and status in ('resting','filled','won','lost','void')`;
  return r.c;
}

async function trader(): Promise<KalshiTrader | null> {
  return await KalshiTrader.fromEnv(Deno.env.get("KALSHI_API_KEY_ID"), Deno.env.get("KALSHI_PRIVATE_KEY"));
}

/** Everything that must be true before real money moves. */
async function liveGate(): Promise<{ ok: boolean; reasons: string[]; balance?: number }> {
  const reasons: string[] = [];
  const s = await loadSettings();
  const paper = await paperBankroll(s.paper_start_bankroll);
  if (paper.settled < HARD.LIVE_GATE_MIN_SETTLED_PAPER) reasons.push(`needs ${HARD.LIVE_GATE_MIN_SETTLED_PAPER} settled paper bets (has ${paper.settled})`);
  if (HARD.LIVE_GATE_REQUIRE_PAPER_PROFIT && !(paper.pnl > 0)) reasons.push(`paper trading must be in profit (now $${paper.pnl.toFixed(2)})`);
  if (Deno.env.get("LIVE_TRADING_ENABLED") !== "true") reasons.push("secret LIVE_TRADING_ENABLED is not set to true");
  let balance: number | undefined;
  try {
    const t = await trader();
    if (!t) reasons.push("Kalshi API key secrets are missing");
    else balance = await t.balance();
  } catch (e) {
    reasons.push(`Kalshi login failed: ${(e as Error).message.slice(0, 120)}`);
  }
  if (balance !== undefined && balance <= s.stop_balance) reasons.push(`Kalshi balance $${balance.toFixed(2)} is at/below the stop level $${s.stop_balance}`);
  return { ok: reasons.length === 0, reasons, balance };
}

async function pause(reason: string) {
  await sql`update edgebot.settings set mode = 'paused', paused_reason = ${reason}, updated_at = now() where id = 1`;
  await sendEmail(`Edge Bot paused: ${reason}`, `<p>The bot paused itself.</p><p><b>Reason:</b> ${escapeHtml(reason)}</p><p>Nothing else will be bet until you resume it from the dashboard.</p>`);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

async function sendEmail(subject: string, html: string): Promise<string> {
  const key = Deno.env.get("RESEND_API_KEY") ?? (await vault("edgebot_resend_key"));
  const s = await loadSettings().catch(() => null);
  const to = Deno.env.get("REPORT_EMAIL") ?? s?.report_email ?? (await vault("edgebot_report_email"));
  if (!key || !to) return "email not configured";
  const from = Deno.env.get("REPORT_FROM") ?? "Edge Bot <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  return res.ok ? "sent" : `email failed ${res.status}: ${(await res.text()).slice(0, 200)}`;
}

// ------------------------------------------------------------------ scan

interface Candidate {
  league: string;
  event: KalshiEvent;
  market: KalshiMarket;
  team: string;
  fairP: number;
  kickoff: string;
  label: string;
}

async function scan(runId: number) {
  const s = await loadSettings();
  const summary: Record<string, unknown> = { mode: s.mode, leagues: {} as Record<string, unknown> };
  if (s.mode === "paused") return { ...summary, note: `paused: ${s.paused_reason ?? ""}` };

  const oddsKey = Deno.env.get("ODDS_API_KEY");
  if (!oddsKey) return { ...summary, note: "ODDS_API_KEY secret is missing — add it to start finding bets" };

  // Live mode only trades if the gate still passes right now.
  let live: { trader: KalshiTrader; balance: number } | null = null;
  if (s.mode === "live") {
    const gate = await liveGate();
    if (gate.ok) {
      const t = await trader();
      if (t && gate.balance !== undefined) live = { trader: t, balance: gate.balance };
    } else {
      summary.live_blocked = gate.reasons;
    }
  }

  const now = Date.now();
  const from = new Date(now + s.min_hours_before_start * 3.6e6);
  const to = new Date(now + s.max_hours_before_start * 3.6e6);
  const candidates: Candidate[] = [];
  const signalRows: any[] = [];

  for (const lk of s.leagues) {
    const league = LEAGUES[lk];
    const ls: Record<string, unknown> = {};
    (summary.leagues as Record<string, unknown>)[lk] = ls;
    try {
      // 1) Kalshi games for this league.
      const events: KalshiEvent[] = [];
      for (const series of league.series) events.push(...(await getOpenEvents(series)));
      const games = events
        .map((e) => {
          const markets = (e.markets ?? []).filter((m) => m.status === "active" && !m.mve_collection_ticker);
          const teamMarkets = markets.filter((m) => !isTieLabel(m.yes_sub_title ?? ""));
          // Kickoff hint: when the game happens (close_time can be days later, so it isn't used).
          const hint = markets.map((m) => m.occurrence_datetime || m.expected_expiration_time).find(Boolean) ?? null;
          return { e, markets, teamMarkets, hint };
        })
        .filter((g) => g.teamMarkets.length === 2)
        .filter((g) => !g.hint || (Date.parse(g.hint) > now - 6 * 3.6e6 && Date.parse(g.hint) < to.getTime() + 30 * 3.6e6));
      ls.kalshi_games = games.length;
      if (games.length === 0) continue;

      // 2) Sharp odds (1 credit) — only when Kalshi actually has games in range.
      const credits = await stateGet<{ remaining: number | null }>("odds_credits");
      if (credits?.value.remaining !== null && credits?.value.remaining !== undefined && credits.value.remaining < 5) {
        ls.note = "out of odds credits for this month";
        continue;
      }
      const odds = await fetchOdds(oddsKey, league.oddsSport, from.toISOString(), to.toISOString());
      await stateSet("odds_credits", { remaining: odds.remaining, used: odds.used, at: new Date().toISOString() });
      ls.odds_games = odds.events.length;

      const fairById = new Map<string, ReturnType<typeof fairLine>>();
      for (const ev of odds.events) {
        const fl = fairLine(ev, league.threeWay);
        fairById.set(ev.id, fl);
        if (fl) {
          await sql`insert into edgebot.odds (league, odds_event_id, commence_time, home_team, away_team, source, fair, books)
                    values (${lk}, ${ev.id}, ${ev.commence_time}, ${ev.home_team}, ${ev.away_team}, ${fl.source}, ${sql.json(fl.fair)}, ${sql.json(fl.books)})`;
        }
      }
      const oddsGames = odds.events.map((ev) => ({ id: ev.id, commence: ev.commence_time, home: ev.home_team, away: ev.away_team }));

      // 3) Match and price every market.
      let matched = 0;
      for (const g of games) {
        const t0 = g.teamMarkets[0].yes_sub_title ?? "", t1 = g.teamMarkets[1].yes_sub_title ?? "";
        const m = matchGame({ eventTicker: g.e.event_ticker, teams: [t0, t1], startHint: g.hint }, oddsGames);
        const label = g.e.title || `${t0} vs ${t1}`;
        if (!m) {
          signalRows.push({ run_id: runId, league: lk, ticker: g.e.event_ticker, label, team: null, decision: "unmatched", reason: `no confident sportsbook match for "${t0}" / "${t1}"` });
          continue;
        }
        const fl = fairById.get(m.game.id);
        if (!fl) {
          signalRows.push({ run_id: runId, league: lk, ticker: g.e.event_ticker, label, team: null, decision: "skip", reason: "sharp prices stale, missing or disagreeing" });
          continue;
        }
        matched++;
        const teamMap: Record<string, string> = { [g.teamMarkets[0].ticker]: m.mapping[0], [g.teamMarkets[1].ticker]: m.mapping[1] };
        await sql`insert into edgebot.matches (kalshi_event_ticker, league, odds_event_id, commence_time, label, team_map, confidence)
                  values (${g.e.event_ticker}, ${lk}, ${m.game.id}, ${m.game.commence}, ${label}, ${sql.json(teamMap)}, ${m.confidence})
                  on conflict (kalshi_event_ticker) do update set odds_event_id = excluded.odds_event_id, commence_time = excluded.commence_time,
                    team_map = excluded.team_map, confidence = excluded.confidence, updated_at = now()`;
        const kickoffMs = Date.parse(m.game.commence);
        if (kickoffMs < from.getTime() || kickoffMs > to.getTime()) continue;
        for (const mk of g.markets) {
          const isTie = isTieLabel(mk.yes_sub_title ?? "");
          const outcome = isTie ? "Draw" : teamMap[mk.ticker];
          const p = outcome ? fl.fair[outcome] : undefined;
          if (p === undefined) continue;
          candidates.push({ league: lk, event: g.e, market: mk, team: isTie ? "Draw" : (mk.yes_sub_title ?? outcome), fairP: p, kickoff: m.game.commence, label });
        }
      }
      ls.matched = matched;
    } catch (e) {
      ls.error = (e as Error).message.slice(0, 300);
    }
  }

  // 4) Decide per game (best single market per game), for paper and (maybe) live.
  const byEvent = new Map<string, Candidate[]>();
  for (const c of candidates) byEvent.set(c.event.event_ticker, [...(byEvent.get(c.event.event_ticker) ?? []), c]);

  const placed = { paper: 0, live: 0 };
  const modes: Mode[] = live ? ["paper", "live"] : ["paper"];
  for (const mode of modes) {
    let todays = await betsToday(mode);
    for (const [eventTicker, cands] of byEvent) {
      // One position per game. Refresh waiting orders with the new prices.
      const existing = await sql`select * from edgebot.bets where mode = ${mode} and event_ticker = ${eventTicker} and status in ('resting','filled','won','lost')`;
      if (existing.some((b) => b.status !== "resting")) continue;
      for (const b of existing) await cancelBet(b, "refreshed with new prices");
      if (existing.length) {
        // A waiting real-money order may have filled just before we canceled it.
        const after = await sql`select 1 from edgebot.bets where mode = ${mode} and event_ticker = ${eventTicker} and status in ('resting','filled','won','lost') limit 1`;
        if (after.length) continue;
      }

      let bank: Bankroll;
      if (mode === "paper") {
        bank = await paperBankroll(s.paper_start_bankroll);
      } else {
        const ex = await liveExposure();
        bank = { cash: live!.balance, openExposure: ex.riding + ex.reserved, equity: live!.balance + ex.riding + ex.reserved };
      }

      let best: { c: Candidate; d: BetDecision; fee: FeeInfo } | null = null;
      for (const c of cands) {
        const fee = await feeInfo(seriesOf(c.event.event_ticker));
        const d = decide(c.fairP, quote(c.market), s, bank, fee);
        if (mode === "paper") {
          signalRows.push({
            run_id: runId, league: c.league, ticker: c.market.ticker, label: c.label, team: c.team, fair_p: c.fairP,
            ask: Number.isFinite(quote(c.market).yesAsk) ? quote(c.market).yesAsk : null,
            fee: "fee" in d ? d.fee ?? null : null, ev_per_dollar: "ev" in d ? d.ev ?? null : null,
            decision: d.action === "taker" ? "bet_taker" : d.action === "rest" ? "bet_resting" : "skip", reason: d.reason,
          });
        }
        if (d.action === "skip") continue;
        // Prefer an immediate fill, then the bigger edge.
        const rank = (x: BetDecision) => (x.action === "taker" ? 1 : 0) + x.ev;
        if (!best || rank(d) > rank(best.d)) best = { c, d, fee };
      }
      if (!best) continue;
      if (todays >= s.max_bets_per_day) {
        if (mode === "paper") signalRows.push({ run_id: runId, league: best.c.league, ticker: best.c.market.ticker, label: best.c.label, team: best.c.team, decision: "skip", reason: "daily bet limit reached" });
        continue;
      }
      if (bank.equity <= s.stop_balance) continue;
      const ok = await placeBet(mode, best.c, best.d, s, live?.trader ?? null);
      if (ok) {
        placed[mode]++;
        todays++;
      }
    }
  }

  if (signalRows.length) {
    for (let i = 0; i < signalRows.length; i += 200) {
      const chunk = signalRows.slice(i, i + 200).map((r) => ({
        run_id: r.run_id, league: r.league ?? null, ticker: r.ticker ?? null, label: r.label ?? null, team: r.team ?? null,
        fair_p: r.fair_p ?? null, ask: r.ask ?? null, fee: r.fee ?? null, ev_per_dollar: r.ev_per_dollar ?? null,
        decision: r.decision, reason: r.reason ?? null,
      }));
      await sql`insert into edgebot.signals ${sql(chunk)}`;
    }
  }
  return { ...summary, candidates: candidates.length, placed };
}

async function placeBet(mode: Mode, c: Candidate, d: BetDecision, s: Settings, t: KalshiTrader | null): Promise<boolean> {
  const kickoffMs = Date.parse(c.kickoff);
  const expiresMs = Math.min(kickoffMs - 15 * 60000, Date.now() + s.resting_order_minutes * 60000);
  const clientOrderId = crypto.randomUUID();
  const base = {
    mode, league: c.league, ticker: c.market.ticker, event_ticker: c.event.event_ticker, label: c.label, team: c.team,
    commence_time: c.kickoff, limit_price: d.price, contracts: d.contracts, fair_p: c.fairP, edge: d.ev, reason: d.reason,
    client_order_id: clientOrderId, expires_at: new Date(expiresMs).toISOString(),
  };
  try {
    if (mode === "paper") {
      if (d.action === "taker") {
        await sql`insert into edgebot.bets ${sql({ ...base, status: "filled", fill_price: d.price, fee: d.fee, cost: d.price * d.contracts, filled_at: new Date().toISOString() })}`;
      } else {
        await sql`insert into edgebot.bets ${sql({ ...base, status: "resting", fee: d.fee, cost: 0 })}`;
      }
      return true;
    }
    // Real money.
    if (!t) return false;
    // Reserve the row first so a crash can never double-order this game.
    const [row] = await sql`insert into edgebot.bets ${sql({ ...base, status: "resting", fee: d.fee, cost: 0 })} returning id`;
    try {
      const r = await t.buyYes({ ticker: c.market.ticker, contracts: d.contracts, price: d.price, clientOrderId, expirationUnix: Math.floor(expiresMs / 1000) });
      await sql`update edgebot.bets set kalshi_order_id = ${r.order_id}, raw = ${sql.json(r)} where id = ${row.id}`;
      // Read back exact fills and fees from Kalshi (fully filled orders become "filled" right away).
      try {
        await syncLiveOrder({ id: row.id, kalshi_order_id: r.order_id });
      } catch (e) {
        console.error("sync after order", (e as Error).message);
      }
      return true;
    } catch (e) {
      await sql`update edgebot.bets set status = 'error', reason = ${(e as Error).message.slice(0, 500)} where id = ${row.id}`;
      return false;
    }
  } catch (e) {
    // Unique index hit (already have a position on this game) or DB error.
    console.error("placeBet", (e as Error).message);
    return false;
  }
}

async function cancelBet(b: any, why: string) {
  if (b.mode === "live" && b.kalshi_order_id) {
    try {
      const t = await trader();
      if (t) await t.cancelOrder(b.kalshi_order_id, b.ticker);
    } catch (e) {
      // Already filled/expired: the tick will sort out the real state from Kalshi.
      const msg = (e as Error).message;
      if (!/404/.test(msg)) console.error("cancel", msg);
    }
    // Check for a partial fill before marking canceled.
    await syncLiveOrder(b);
    const [fresh] = await sql`select status from edgebot.bets where id = ${b.id}`;
    if (fresh?.status !== "resting") return;
  }
  await sql`update edgebot.bets set status = 'canceled', reason = coalesce(reason, '') || ' | ' || ${why} where id = ${b.id} and status = 'resting'`;
}

/** Pull the true state of a live order from Kalshi into our table. */
async function syncLiveOrder(b: any) {
  const t = await trader();
  if (!t || !b.kalshi_order_id) return;
  const o = await t.getOrder(b.kalshi_order_id);
  const filled = dollars(o.fill_count_fp);
  const cost = dollars(o.taker_fill_cost_dollars) + dollars(o.maker_fill_cost_dollars);
  const fee = dollars(o.taker_fees_dollars) + dollars(o.maker_fees_dollars);
  if (o.status === "resting") return;
  if (filled > 0) {
    await sql`update edgebot.bets set status = 'filled', contracts = ${filled}, cost = ${cost}, fee = ${fee},
              fill_price = ${cost / filled}, filled_at = coalesce(filled_at, now()), raw = ${sql.json(o)} where id = ${b.id}`;
  } else {
    await sql`update edgebot.bets set status = 'canceled', raw = ${sql.json(o)} where id = ${b.id}`;
  }
}

// ------------------------------------------------------------------ tick

async function tick() {
  const s = await loadSettings();
  const out = { filled: 0, expired: 0, closing: 0, settled: 0, notes: [] as string[] };
  const now = Date.now();

  // 1) Waiting orders.
  const resting = await sql`select * from edgebot.bets where status = 'resting'`;
  for (const b of resting) {
    try {
      if (b.mode === "live") {
        await syncLiveOrder(b);
        const [fresh] = await sql`select status from edgebot.bets where id = ${b.id}`;
        if (fresh.status === "resting" && new Date(b.expires_at).getTime() < now) await cancelBet(b, "expired");
        continue;
      }
      const m = await getMarket(b.ticker);
      const q = quote(m);
      if (new Date(b.expires_at).getTime() < now || m.status !== "active") {
        await sql`update edgebot.bets set status = 'canceled', reason = coalesce(reason,'') || ' | expired unfilled' where id = ${b.id}`;
        out.expired++;
        continue;
      }
      // Paper fill only if the market traded *through* our price (conservative about queue position).
      if (validPrice(q.yesAsk) && q.yesAsk < Number(b.limit_price)) {
        const fee = kalshiFee(Number(b.limit_price), Number(b.contracts), "maker", await feeInfo(seriesOf(b.event_ticker)));
        await sql`update edgebot.bets set status = 'filled', fill_price = limit_price, cost = limit_price * contracts, fee = ${fee}, filled_at = now() where id = ${b.id}`;
        out.filled++;
      }
    } catch (e) {
      out.notes.push(`resting ${b.ticker}: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  // 2) Closing price right before kickoff (for closing-line value).
  const closing = await sql`select * from edgebot.bets where status = 'filled' and closing_price is null
                            and commence_time between now() - interval '5 minutes' and now() + interval '35 minutes'`;
  for (const b of closing) {
    try {
      const m = await getMarket(b.ticker);
      const px = mid(m);
      if (validPrice(px)) {
        await sql`update edgebot.bets set closing_price = ${px}, clv = ${px - Number(b.fill_price)} where id = ${b.id}`;
        out.closing++;
      }
    } catch (e) {
      out.notes.push(`closing ${b.ticker}: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  // 3) Settle finished games.
  const open = await sql`select * from edgebot.bets where status = 'filled' and commence_time < now() - interval '2 hours'`;
  for (const b of open) {
    try {
      const m = await getMarket(b.ticker);
      const done = ["determined", "finalized", "amended", "settled"].includes(m.status);
      if (!done || !m.result) continue;
      const contracts = Number(b.contracts), spent = Number(b.cost) + Number(b.fee);
      let status: string, payout: number;
      if (m.result === "yes") { status = "won"; payout = contracts; }
      else if (m.result === "no") { status = "lost"; payout = 0; }
      else { status = "void"; payout = spent; }
      await sql`update edgebot.bets set status = ${status}, payout = ${payout}, pnl = ${payout - spent}, settled_at = now() where id = ${b.id}`;
      out.settled++;
    } catch (e) {
      out.notes.push(`settle ${b.ticker}: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  // 4) Kill switches.
  if (s.mode !== "paused") {
    const paper = await paperBankroll(s.paper_start_bankroll);
    if (paper.equity <= s.stop_balance) {
      await pause(`paper bankroll fell to $${paper.equity.toFixed(2)} (stop level $${s.stop_balance})`);
      out.notes.push("paused: paper stop level");
    } else if (s.mode === "live") {
      try {
        const t = await trader();
        if (t) {
          const bal = await t.balance();
          const ex = await liveExposure();
          if (bal + ex.riding + ex.reserved <= s.stop_balance) {
            await pause(`real-money balance fell to $${(bal + ex.riding + ex.reserved).toFixed(2)} (stop level $${s.stop_balance})`);
            out.notes.push("paused: live stop level");
          }
        }
      } catch (e) {
        out.notes.push(`live balance check failed: ${(e as Error).message.slice(0, 120)}`);
      }
    }
  }

  // 5) Daily housekeeping.
  const d = new Date();
  if (d.getUTCHours() === 8 && d.getUTCMinutes() < 30) {
    await sql`delete from edgebot.signals where created_at < now() - interval '21 days'`;
    await sql`delete from edgebot.odds where fetched_at < now() - interval '21 days'`;
    await sql`delete from edgebot.runs where started_at < now() - interval '30 days'`;
  }
  return out;
}

// ------------------------------------------------------------------ dashboard + report

async function stats(mode: Mode) {
  const [r] = await sql`
    select
      count(*) filter (where status in ('won','lost')) as settled,
      count(*) filter (where status = 'won') as won,
      count(*) filter (where status = 'lost') as lost,
      count(*) filter (where status = 'filled') as open_bets,
      count(*) filter (where status = 'resting') as waiting,
      coalesce(sum(pnl) filter (where status in ('won','lost','void')), 0) as pnl,
      coalesce(sum(cost + fee) filter (where status in ('won','lost')), 0) as staked,
      coalesce(sum(fee) filter (where status in ('won','lost','filled')), 0) as fees,
      avg(clv) filter (where clv is not null) as avg_clv,
      count(clv) as clv_count,
      avg(edge) filter (where status in ('filled','won','lost')) as avg_edge,
      avg(fair_p) filter (where status in ('won','lost')) as avg_fair_p
    from edgebot.bets where mode = ${mode}`;
  const staked = n(r.staked);
  return {
    settled: Number(r.settled), won: Number(r.won), lost: Number(r.lost), open_bets: Number(r.open_bets), waiting: Number(r.waiting),
    pnl: n(r.pnl), roi: staked > 0 ? n(r.pnl) / staked : null, fees: n(r.fees),
    win_rate: Number(r.settled) > 0 ? Number(r.won) / Number(r.settled) : null,
    expected_win_rate: r.avg_fair_p === null ? null : n(r.avg_fair_p),
    avg_clv: r.avg_clv === null ? null : n(r.avg_clv), clv_count: Number(r.clv_count),
    avg_edge: r.avg_edge === null ? null : n(r.avg_edge),
  };
}

async function dashboard() {
  const s = await loadSettings();
  const paperBank = await paperBankroll(s.paper_start_bankroll);
  const paper = await stats("paper");
  const live = await stats("live");
  const openBets = await sql`select id, mode, status, league, label, team, commence_time, limit_price, fill_price, contracts, cost, fee, fair_p, edge, closing_price, clv, placed_at
                             from edgebot.bets where status in ('resting','filled') order by commence_time asc limit 50`;
  const recent = await sql`select id, mode, status, league, label, team, commence_time, fill_price, contracts, cost, fee, fair_p, edge, clv, payout, pnl, settled_at
                           from edgebot.bets where status in ('won','lost','void') order by settled_at desc limit 30`;
  const curve = await sql`select settled_at, mode, pnl from edgebot.bets where status in ('won','lost','void') order by settled_at asc limit 2000`;
  const signals = await sql`select created_at, league, label, team, fair_p, ask, ev_per_dollar, decision, reason from edgebot.signals
                            where created_at > now() - interval '3 days' and decision <> 'unmatched' order by ev_per_dollar desc nulls last limit 25`;
  const unmatched = await sql`select count(*)::int as c from edgebot.signals where decision = 'unmatched' and created_at > now() - interval '1 day'`;
  const runs = await sql`select task, started_at, finished_at, ok, summary, error from edgebot.runs order by started_at desc limit 8`;
  const credits = await stateGet<{ remaining: number | null; used: number | null }>("odds_credits");
  const exposure = await liveExposure();

  let paperRunning = 0, liveRunning = 0;
  const equityCurve = curve.map((r) => {
    if (r.mode === "paper") paperRunning += n(r.pnl); else liveRunning += n(r.pnl);
    return { t: r.settled_at, mode: r.mode, paper: paperRunning, live: liveRunning };
  });

  return {
    generated_at: new Date().toISOString(),
    mode: s.mode,
    paused_reason: s.paused_reason,
    settings: {
      leagues: s.leagues.map((k) => LEAGUES[k]?.name ?? k), order_style: s.order_style, min_edge: s.min_edge,
      kelly_fraction: s.kelly_fraction, max_stake_pct: s.max_stake_pct, max_bets_per_day: s.max_bets_per_day, stop_balance: s.stop_balance,
      hard_caps: HARD,
    },
    paper: { start: s.paper_start_bankroll, ...paperBank, ...paper },
    live: { ...live, riding: exposure.riding, reserved: exposure.reserved, enabled_secret: Deno.env.get("LIVE_TRADING_ENABLED") === "true", keys_present: !!Deno.env.get("KALSHI_API_KEY_ID") },
    gate: {
      min_settled: HARD.LIVE_GATE_MIN_SETTLED_PAPER,
      settled: paperBank.settled,
      paper_profit: paperBank.pnl,
      passes_paper_part: paperBank.settled >= HARD.LIVE_GATE_MIN_SETTLED_PAPER && paperBank.pnl > 0,
    },
    odds_credits: credits?.value ?? null,
    odds_key_present: !!Deno.env.get("ODDS_API_KEY"),
    open_bets: openBets,
    recent_bets: recent,
    equity_curve: equityCurve,
    top_signals: signals,
    unmatched_last_day: unmatched[0]?.c ?? 0,
    runs,
  };
}

async function report() {
  const d = await dashboard();
  const p = d.paper;
  const money = (x: number | null) => (x === null ? "—" : `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`);
  const pctf = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
  const rows = (d.recent_bets as any[]).slice(0, 10).map((b) =>
    `<tr><td>${escapeHtml(b.label ?? "")}</td><td>${escapeHtml(b.team ?? "")}</td><td>${b.status}</td><td>${money(n(b.pnl))}</td></tr>`).join("");
  const html = `
  <div style="font-family:system-ui,sans-serif;max-width:560px">
    <h2>Edge Bot weekly report</h2>
    <p>Mode: <b>${d.mode}</b>${d.paused_reason ? ` (${escapeHtml(d.paused_reason)})` : ""}</p>
    <h3>Paper money (fake)</h3>
    <p>Bankroll ${money(p.equity)} (started ${money(p.start)}) · Profit ${money(p.pnl)} · ROI ${pctf(p.roi)}</p>
    <p>Settled ${p.settled} (won ${p.won}, lost ${p.lost}) · Win rate ${pctf(p.win_rate)} vs expected ${pctf(p.expected_win_rate)}</p>
    <p>Beat the closing price by ${p.avg_clv === null ? "—" : (p.avg_clv * 100).toFixed(1) + "¢"} on average (${p.clv_count} bets). Positive is the best early sign of a real edge.</p>
    <p>Fees paid: ${money(p.fees)}</p>
    <p>Real-money gate: ${d.gate.settled}/${d.gate.min_settled} settled bets, paper profit ${money(d.gate.paper_profit)} — ${d.gate.passes_paper_part ? "paper part passed" : "not yet"}.</p>
    ${d.live.settled + d.live.open_bets > 0 ? `<h3>Real money</h3><p>Profit ${money(d.live.pnl)} · Settled ${d.live.settled} · Open ${d.live.open_bets}</p>` : ""}
    <h3>Latest results</h3>
    <table cellpadding="4" style="border-collapse:collapse;font-size:14px">${rows || "<tr><td>No settled bets yet.</td></tr>"}</table>
    <p style="color:#666;font-size:12px">Odds credits left this month: ${d.odds_credits?.remaining ?? "—"}. Small samples are mostly luck; judge after a few hundred bets.</p>
  </div>`;
  return { email: await sendEmail(`Edge Bot: ${money(p.pnl)} paper profit, ${p.settled} bets settled`, html) };
}

// ------------------------------------------------------------------ control

async function control(body: any) {
  const action = String(body?.action ?? "");
  if (action === "pause") {
    await sql`update edgebot.settings set mode = 'paused', paused_reason = 'paused from dashboard', updated_at = now() where id = 1`;
    return { ok: true, mode: "paused" };
  }
  if (action === "resume_paper") {
    await sql`update edgebot.settings set mode = 'paper', paused_reason = null, updated_at = now() where id = 1`;
    return { ok: true, mode: "paper" };
  }
  if (action === "go_live") {
    const gate = await liveGate();
    if (!gate.ok) return { ok: false, mode: (await loadSettings()).mode, reasons: gate.reasons };
    await sql`update edgebot.settings set mode = 'live', paused_reason = null, updated_at = now() where id = 1`;
    await sendEmail("Edge Bot is now trading real money", `<p>Real-money mode is on. Kalshi balance: $${gate.balance?.toFixed(2)}.</p><p>Hard caps: max ${HARD.MAX_STAKE_PCT * 100}% of bankroll per bet, stop at the stop level.</p>`);
    return { ok: true, mode: "live", balance: gate.balance };
  }
  if (action === "gate") return await liveGate();
  return { ok: false, error: "unknown action (use pause, resume_paper, go_live, gate)" };
}

async function discover() {
  const series = await listSportsSeries();
  const games = series.filter((x: any) => /GAME/i.test(x.ticker ?? ""));
  const out = [];
  for (const g of games.slice(0, 80)) out.push({ ticker: g.ticker, title: g.title, fee_type: g.fee_type, fee_multiplier: g.fee_multiplier });
  return { count: games.length, series: out, configured: Object.values(LEAGUES).map((l) => ({ league: l.key, series: l.series })) };
}

// ------------------------------------------------------------------ server

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  const task = url.searchParams.get("task") ?? "dashboard";
  try {
    if (task === "dashboard") return json(await dashboard());

    if (task === "scan" || task === "tick" || task === "report") {
      const expected = await vault("edgebot_cron_secret");
      if (!expected || req.headers.get("x-edgebot-cron") !== expected) {
        // The control token may also trigger these by hand (e.g. "run a scan now" from the dashboard).
        const ctl = await vault("edgebot_control_token");
        if (!ctl || req.headers.get("x-edgebot-token") !== ctl) return json({ error: "unauthorized" }, 401);
      }
      const id = await startRun(task);
      try {
        const result = task === "scan" ? await scan(id) : task === "tick" ? await tick() : await report();
        await finishRun(id, true, result);
        return json({ ok: true, run: id, result });
      } catch (e) {
        await finishRun(id, false, {}, (e as Error).stack ?? String(e));
        return json({ ok: false, run: id, error: (e as Error).message }, 500);
      }
    }

    if (task === "control" || task === "discover") {
      const ctl = await vault("edgebot_control_token");
      if (!ctl || req.headers.get("x-edgebot-token") !== ctl) return json({ error: "unauthorized" }, 401);
      if (task === "discover") return json(await discover());
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      return json(await control(body));
    }

    return json({ error: "unknown task" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
