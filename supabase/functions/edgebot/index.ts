// Football Edge Bot — Supabase Edge Function.
//
// Tasks (?task=...):
//   scan      every few hours: pull sharp odds + Kalshi prices, find mispriced games, place bets
//   tick      every 30 min: fill/expire waiting orders, record closing prices, settle finished games, kill switch
//   report    weekly email summary
//   dashboard public read-only JSON for the dashboard page
//   control   pause / resume / go_live (needs the control token)
//   mm        every 30 min: paper market making on weather markets (fake money only)
//   discover  list Kalshi series, ?category=Sports (default) or Climate (needs the control token)
//
// Paper trading always runs. Real money only runs in "live" mode, and only after the live gate passes.

import postgres from "npm:postgres@3.4.5";
import { decide } from "./lib/decide.ts";
import type { Bankroll, Decision } from "./lib/decide.ts";

type BetDecision = Exclude<Decision, { action: "skip" }>;
import { getMarket, getOpenEvents, getSeries, getTrades, KalshiTrader, listSportsSeries } from "./lib/kalshi.ts";
import type { KalshiEvent, KalshiMarket } from "./lib/kalshi.ts";
import { aiFromEnv, explain, REPORT_SYSTEM } from "./lib/ai.ts";
import { isTieLabel, matchGame } from "./lib/match.ts";
import { fairLine, fetchOdds, redactSecrets } from "./lib/odds.ts";
import { DEFAULT_FEE, dollars, kalshiFee, validPrice } from "./lib/pricing.ts";
import type { FeeInfo } from "./lib/pricing.ts";
import { effectiveSettings, HARD, LEAGUES } from "./lib/rules.ts";
import type { Settings } from "./lib/rules.ts";
import {
  applyFill, bracketProb, daysBetween, effectiveMm, eventDate, fairPrice, forecastSigma, inNewsWindow, lipCompetitive, localDateHour,
  makeQuotes, markout, markValue, marketMid, MM_CITIES, MM_HARD, parseBracket, settleValue, simulateFill, worstCase,
} from "./lib/mm.ts";
import type { MmSettings } from "./lib/mm.ts";
import { forecastHighs } from "./lib/weather.ts";

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
  await sql`update edgebot.runs set finished_at = now(), ok = ${ok}, summary = ${sql.json(summary as any)}, error = ${error === undefined ? null : redactSecrets(error)} where id = ${id}`;
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
  await push(`Edge Bot paused`, reason);
}

/** Phone notification through ntfy.sh (free app). Only if the NTFY_TOPIC secret is set. */
async function push(title: string, text: string): Promise<string> {
  const topic = Deno.env.get("NTFY_TOPIC");
  if (!topic) return "push not configured";
  try {
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, { method: "POST", headers: { Title: title.slice(0, 200) }, body: text.slice(0, 2000), signal: AbortSignal.timeout(10000) });
    return res.ok ? "push sent" : `push failed ${res.status}`;
  } catch (e) {
    return `push failed: ${(e as Error).message.slice(0, 80)}`;
  }
}

/** Email + phone alert, at most once per `everyHours` for the same key. */
async function alertOnce(key: string, subject: string, text: string, everyHours: number): Promise<string | null> {
  const prev = await stateGet<{ at: string }>(`alert:${key}`);
  if (prev && Date.now() - new Date(prev.updated_at).getTime() < everyHours * 3.6e6) return null;
  await stateSet(`alert:${key}`, { at: new Date().toISOString() });
  const mail = await sendEmail(subject, `<p>${escapeHtml(text)}</p><p style="color:#666;font-size:12px">Market making is paper trading: fake money only.</p>`);
  return `${mail}, ${await push(subject, text)}`;
}

/** No ceiling on winnings: the bot keeps going, and emails once each time a new $1,000 level is passed. */
async function milestone(mode: Mode, equity: number): Promise<string | null> {
  const step = HARD.MILESTONE_STEP_USD;
  const level = Math.floor(equity / step) * step;
  if (level < step) return null;
  const key = `milestone:${mode}`;
  const prev = await stateGet<{ level: number }>(key);
  if (prev && Number(prev.value.level) >= level) return null;
  await stateSet(key, { level, equity, at: new Date().toISOString() });
  const label = mode === "paper" ? "Paper (fake money)" : "Real money";
  const pretty = `$${level.toLocaleString("en-US")}`;
  await sendEmail(
    `Edge Bot: ${label} bankroll passed ${pretty}`,
    `<p>${label} bankroll is now $${equity.toFixed(2)}.</p><p>There's no ceiling, so the bot keeps going under the same rules (at most ${HARD.MAX_STAKE_PCT * 100}% of the bankroll and $${HARD.MAX_STAKE_USD} per bet).</p>` +
      (mode === "live" ? `<p>Money left on Kalshi is still at risk. Withdrawing some winnings to your bank locks them in.</p>` : ""),
  );
  return `${mode} bankroll passed ${pretty}`;
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
      ls.error = redactSecrets((e as Error).message).slice(0, 300);
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
        // Re-read the balance before every game: Kalshi takes each fill out of the balance, so a balance
        // read at the start of the scan would count money already riding twice and oversize later bets.
        try {
          live!.balance = await live!.trader.balance();
        } catch (e) {
          console.error("balance refresh failed; stopping real-money bets this scan", (e as Error).message);
          break;
        }
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
    // Check for a partial fill. syncLiveOrder writes the true state ("filled" or "canceled")
    // once Kalshi no longer shows the order as waiting.
    await syncLiveOrder(b);
    const [fresh] = await sql`select status from edgebot.bets where id = ${b.id}`;
    if (fresh?.status === "resting") {
      // Kalshi still has the order open (the cancel didn't go through). Never mark it canceled here:
      // it could still fill, and a row marked canceled would hide that money from the exposure caps
      // and let the next scan put a second bet on the same game. The next tick tries again.
      console.error("cancel did not go through; leaving order open", b.kalshi_order_id);
    }
    return;
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

  // 4) Kill switches (losses) and milestones (wins: no ceiling, just an email at each new $1,000 level).
  if (s.mode !== "paused") {
    const paper = await paperBankroll(s.paper_start_bankroll);
    if (paper.equity <= s.stop_balance) {
      await pause(`paper bankroll fell to $${paper.equity.toFixed(2)} (stop level $${s.stop_balance})`);
      out.notes.push("paused: paper stop level");
    } else {
      const m = await milestone("paper", paper.equity);
      if (m) out.notes.push(m);
      if (s.mode === "live") {
        try {
          const t = await trader();
          if (t) {
            const bal = await t.balance();
            const ex = await liveExposure();
            const liveEquity = bal + ex.riding + ex.reserved;
            if (liveEquity <= s.stop_balance) {
              await pause(`real-money balance fell to $${liveEquity.toFixed(2)} (stop level $${s.stop_balance})`);
              out.notes.push("paused: live stop level");
            } else {
              const lm = await milestone("live", liveEquity);
              if (lm) out.notes.push(lm);
            }
          }
        } catch (e) {
          out.notes.push(`live balance check failed: ${(e as Error).message.slice(0, 120)}`);
        }
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

// ------------------------------------------------------------------ market making (paper only, fake money)

const SETTLED_STATES = ["determined", "finalized", "amended", "settled"];

function bookOf(mk: KalshiMarket) {
  const bid = dollars(mk.yes_bid_dollars), ask = dollars(mk.yes_ask_dollars), last = dollars(mk.last_price_dollars);
  return { bid, ask, mid: marketMid(bid, ask, last) };
}

/**
 * One market-making round:
 * 1) read Kalshi prices, 2) fake-fill last round's quotes from real trades (strictly through our price),
 * 3) score fills an hour later ("picked off" check), 4) settle and value positions, 5) daily loss limit,
 * 6) post new quotes, unless a weather model update is due, the day's loss limit is hit, or the bot is paused.
 */
async function mmRun(runId: number) {
  const [row] = await sql`select * from edgebot.settings where id = 1`;
  const base = effectiveSettings(row as unknown as Settings);
  const m: MmSettings = effectiveMm(row as any);
  const now = Date.now();
  const nowDate = new Date(now);
  const notes: string[] = [];
  const out: Record<string, unknown> = { fills: 0, contracts_filled: 0, markouts: 0, settled: 0, quotes: 0, notes };

  // 1) Current prices for every market in the chosen weather series.
  const markets = new Map<string, { mk: KalshiMarket; series: string; event: string }>();
  for (const series of m.mm_series) {
    try {
      const events = await getOpenEvents(series);
      if (events.length === 0) notes.push(`${series}: no open markets (check the ticker with ?task=discover&category=Climate)`);
      for (const e of events) for (const mk of e.markets ?? []) markets.set(mk.ticker, { mk, series, event: e.event_ticker });
    } catch (e) {
      notes.push(`${series}: ${redactSecrets((e as Error).message).slice(0, 120)}`);
    }
  }
  out.markets_seen = markets.size;

  // 2) Fake fills for the quotes that rested since the last round.
  const active = await sql`select * from edgebot.mm_quotes where status = 'active'`;
  const byTicker = new Map<string, any[]>();
  for (const q of active) byTicker.set(q.ticker, [...(byTicker.get(q.ticker) ?? []), q]);
  const bigFills: string[] = [];
  for (const [ticker, qs] of byTicker) {
    let trades: Awaited<ReturnType<typeof getTrades>> | null = null;
    try {
      const since = Math.min(...qs.map((q) => new Date(q.posted_at).getTime()));
      trades = await getTrades(ticker, since - 1000);
    } catch (e) {
      notes.push(`fills ${ticker}: could not read trades (${redactSecrets((e as Error).message).slice(0, 80)}); counted as unfilled`);
    }
    const fee = await feeInfo(qs[0].series);
    const live = markets.get(ticker);
    const midNow = live ? bookOf(live.mk).mid : NaN;
    for (const q of qs) {
      const size = Number(q.size), price = Number(q.price);
      const filled = trades ? simulateFill(q.side, price, size, new Date(q.posted_at).getTime(), now, trades) : 0;
      const status = filled <= 0 ? "expired" : filled >= size ? "filled" : "partial";
      const upd = await sql`update edgebot.mm_quotes set status = ${status}, filled = ${filled}, closed_at = now() where id = ${q.id} and status = 'active' returning id`;
      if (filled <= 0 || upd.length === 0) continue;
      const f = kalshiFee(price, filled, "maker", fee);
      await sql`insert into edgebot.mm_fills ${sql({
        quote_id: q.id, series: q.series, event_ticker: q.event_ticker, ticker, side: q.side, strategy: q.strategy,
        price, contracts: filled, fee: f, mid_at_fill: Number.isFinite(midNow) ? midNow : null,
      })}`;
      const [p] = await sql`select position, cash from edgebot.mm_positions where ticker = ${ticker}`;
      const np = applyFill({ position: Number(p?.position ?? 0), cash: Number(p?.cash ?? 0) }, q.side, price, filled, f);
      await sql`insert into edgebot.mm_positions (ticker, series, event_ticker, position, cash, fees)
                values (${ticker}, ${q.series}, ${q.event_ticker}, ${np.position}, ${np.cash}, ${f})
                on conflict (ticker) do update set position = excluded.position, cash = excluded.cash,
                  fees = edgebot.mm_positions.fees + excluded.fees, updated_at = now()`;
      out.fills = Number(out.fills) + 1;
      out.contracts_filled = Number(out.contracts_filled) + filled;
      if (filled >= m.mm_alert_fill_contracts) bigFills.push(`${q.side === "bid" ? "bought" : "sold"} ${filled} of ${ticker} at ${Math.round(price * 100)}¢`);
    }
  }
  if (bigFills.length) {
    const a = await alertOnce("mm-bigfill", "Edge Bot (paper): big market-making fill", bigFills.join("; "), 1);
    if (a) notes.push(`alert: ${a}`);
  }

  // 3) "Picked off" score: where did the price go about an hour after each fill?
  const due = await sql`select * from edgebot.mm_fills where markout is null
                        and filled_at < now() - make_interval(mins => ${MM_HARD.MARKOUT_MINUTES})
                        and filled_at > now() - interval '3 days' order by filled_at limit 300`;
  const marketCache = new Map<string, KalshiMarket | null>();
  const marketFor = async (ticker: string): Promise<KalshiMarket | null> => {
    const live = markets.get(ticker);
    if (live) return live.mk;
    if (!marketCache.has(ticker)) {
      try {
        marketCache.set(ticker, await getMarket(ticker));
      } catch {
        marketCache.set(ticker, null);
      }
    }
    return marketCache.get(ticker) ?? null;
  };
  for (const f of due) {
    const mk = await marketFor(f.ticker);
    if (!mk) continue;
    let later = bookOf(mk).mid;
    if (SETTLED_STATES.includes(mk.status) && (mk.result === "yes" || mk.result === "no")) later = mk.result === "yes" ? 0.999999 : 0.000001;
    const mo = markout(f.side, Number(f.price), later);
    if (!Number.isFinite(mo)) continue;
    await sql`update edgebot.mm_fills set markout = ${mo}, markout_at = now() where id = ${f.id}`;
    out.markouts = Number(out.markouts) + 1;
  }

  // 4) Settle finished markets; value the rest at the market's price.
  const open = await sql`select * from edgebot.mm_positions where not settled`;
  const inventory = new Map<string, number>();
  let openValue = 0, worst = 0;
  const atLimit: string[] = [];
  for (const p of open) {
    const pos = { position: Number(p.position), cash: Number(p.cash) };
    const mk = await marketFor(p.ticker);
    if (mk && SETTLED_STATES.includes(mk.status) && (mk.result === "yes" || mk.result === "no")) {
      const pnl = settleValue(pos, mk.result === "yes");
      await sql`update edgebot.mm_positions set settled = true, result = ${mk.result}, pnl = ${pnl}, updated_at = now() where ticker = ${p.ticker}`;
      out.settled = Number(out.settled) + 1;
      continue;
    }
    const mid = mk ? bookOf(mk).mid : Number(p.last_mid);
    if (mk && Number.isFinite(mid)) await sql`update edgebot.mm_positions set last_mid = ${mid}, updated_at = now() where ticker = ${p.ticker}`;
    openValue += markValue(pos, Number.isFinite(mid) ? mid : NaN);
    worst += worstCase(pos);
    inventory.set(p.ticker, pos.position);
    if (m.mm_max_inventory > 0 && Math.abs(pos.position) >= m.mm_max_inventory) atLimit.push(`${p.ticker} (${pos.position})`);
  }
  const [rz] = await sql`select coalesce(sum(pnl), 0) as realized from edgebot.mm_positions where settled`;
  const equity = m.mm_bankroll + n(rz.realized) + openValue;
  out.equity = Math.round(equity * 100) / 100;
  out.money_at_risk = Math.round(worst * 100) / 100;
  if (atLimit.length) {
    const a = await alertOnce("mm-inventory", "Edge Bot (paper): inventory limit reached", `Holding the most allowed in: ${atLimit.join(", ")}. It now only quotes the side that shrinks these positions.`, 6);
    if (a) notes.push(`alert: ${a}`);
  }

  // 5) Daily loss limit (UTC day).
  const today = nowDate.toISOString().slice(0, 10);
  const day = await stateGet<{ date: string; start: number; halted?: boolean }>("mm:day");
  const start = day?.value.date === today ? Number(day.value.start) : equity;
  let halted = day?.value.date === today && !!day.value.halted;
  if (!halted && m.mm_daily_loss_limit > 0 && equity - start <= -m.mm_daily_loss_limit) {
    halted = true;
    const a = await alertOnce("mm-dayloss", "Edge Bot (paper): market making stopped for today",
      `Paper market making is down $${(start - equity).toFixed(2)} today (limit $${m.mm_daily_loss_limit}). It stops quoting until tomorrow (UTC).`, 12);
    if (a) notes.push(`alert: ${a}`);
  }
  await stateSet("mm:day", { date: today, start, halted });
  out.day_pnl = Math.round((equity - start) * 100) / 100;

  // 6) New quotes.
  if (!m.mm_enabled) return { ...out, note: "market making is switched off (mm_enabled = false)" };
  if (base.mode === "paused") return { ...out, note: `bot paused: ${base.paused_reason ?? ""}` };
  if (halted) return { ...out, note: "daily loss limit hit: no quotes until tomorrow (UTC)" };
  if (inNewsWindow(nowDate)) return { ...out, note: "stepped aside: a weather model update is due" };

  const forecasts = new Map<string, Map<string, number>>();
  for (const series of m.mm_series) {
    try {
      forecasts.set(series, await forecastHighs(MM_CITIES[series]));
    } catch (e) {
      notes.push(`forecast ${series}: ${(e as Error).message.slice(0, 80)} (quoting on market price alone)`);
    }
  }
  const riskFull = m.mm_bankroll > 0 && worst >= 0.8 * m.mm_bankroll;
  if (riskFull) notes.push("money at risk is near the bankroll: only quoting sides that shrink positions");
  const rows: any[] = [];
  const skipped: Record<string, number> = {};
  for (const [ticker, { mk, series, event }] of markets) {
    if (mk.status !== "active") continue;
    const city = MM_CITIES[series];
    const ed = eventDate(event);
    if (!city || !ed) continue;
    const local = localDateHour(nowDate, city.tz);
    const ahead = daysBetween(local.date, ed);
    if (ahead < 0 || ahead > 2) continue;
    if (ahead === 0 && local.hour >= MM_HARD.SAME_DAY_CUTOFF_HOUR) {
      skipped["same day, live readings take over"] = (skipped["same day, live readings take over"] ?? 0) + 1;
      continue;
    }
    const book = bookOf(mk);
    const bracket = parseBracket(mk);
    const mu = forecasts.get(series)?.get(ed);
    const forecastP = bracket && mu !== undefined ? bracketProb(bracket, mu, forecastSigma(ahead)) : null;
    const fair = fairPrice(book.mid, forecastP, m.mm_forecast_weight);
    const q = makeQuotes({ mid: book.mid, fair, forecastP, marketBid: book.bid, marketAsk: book.ask, inventory: inventory.get(ticker) ?? 0, riskFull, s: m });
    if (q.strategy === "none") {
      skipped[q.reason] = (skipped[q.reason] ?? 0) + 1;
      continue;
    }
    const lip = lipCompetitive(q, book.bid, book.ask);
    const common = {
      run_id: runId, series, event_ticker: event, ticker, strategy: q.strategy, fair: Number.isFinite(fair) ? fair : null,
      market_mid: Number.isFinite(book.mid) ? book.mid : null, market_bid: Number.isFinite(book.bid) ? book.bid : null,
      market_ask: Number.isFinite(book.ask) ? book.ask : null, forecast_p: forecastP === null || !Number.isFinite(forecastP) ? null : forecastP,
      lip_competitive: lip,
    };
    if (q.bid) rows.push({ ...common, side: "bid", price: q.bid.price, size: q.bid.size });
    if (q.ask) rows.push({ ...common, side: "ask", price: q.ask.price, size: q.ask.size });
  }
  for (let i = 0; i < rows.length; i += 200) await sql`insert into edgebot.mm_quotes ${sql(rows.slice(i, i + 200))}`;
  out.quotes = rows.length;
  out.skipped = skipped;
  return out;
}

/** Market-making numbers for the dashboard and weekly report. Null until the market-making tables exist. */
async function mmStats() {
  try {
    const [row] = await sql`select * from edgebot.settings where id = 1`;
    const m = effectiveMm(row as any);
    const [f] = await sql`select count(*)::int as fills, coalesce(sum(contracts), 0)::int as contracts, coalesce(sum(fee), 0) as fees,
                            avg(markout) filter (where markout is not null) as avg_markout, count(markout)::int as markout_count,
                            coalesce(sum(markout * contracts) filter (where markout is not null), 0) as markout_dollars
                          from edgebot.mm_fills`;
    const [q] = await sql`select count(*)::int as quotes, count(*) filter (where lip_competitive)::int as competitive,
                            count(*) filter (where filled > 0)::int as hit, count(*) filter (where size >= ${m.mm_lip_target})::int as big_enough
                          from edgebot.mm_quotes where posted_at > now() - interval '7 days'`;
    const [p] = await sql`select coalesce(sum(pnl) filter (where settled), 0) as realized,
                            coalesce(sum(cash + position * coalesce(last_mid, 0.5)) filter (where not settled), 0) as open_value,
                            count(*) filter (where not settled and position <> 0)::int as open_positions,
                            count(*) filter (where settled)::int as settled_markets
                          from edgebot.mm_positions`;
    const byStrategy = await sql`select strategy, count(*)::int as fills, coalesce(sum(contracts), 0)::int as contracts, avg(markout) as avg_markout
                                 from edgebot.mm_fills group by strategy order by strategy`;
    const recent = await sql`select filled_at, ticker, side, strategy, price, contracts, fee, markout from edgebot.mm_fills order by filled_at desc limit 20`;
    const day = await stateGet<{ date: string; start: number; halted?: boolean }>("mm:day");
    const realized = n(p.realized), openValue = n(p.open_value);
    return {
      enabled: m.mm_enabled,
      cities: m.mm_series.map((s) => MM_CITIES[s]?.name ?? s),
      bankroll_start: m.mm_bankroll,
      equity: m.mm_bankroll + realized + openValue,
      pnl: realized + openValue,
      realized,
      open_positions: p.open_positions,
      settled_markets: p.settled_markets,
      fills: f.fills,
      contracts_filled: f.contracts,
      fees: n(f.fees),
      avg_markout_cents: f.avg_markout === null ? null : n(f.avg_markout) * 100,
      markout_count: f.markout_count,
      markout_dollars: n(f.markout_dollars),
      quotes_7d: q.quotes,
      quotes_hit_7d: q.hit,
      lip_competitive_share_7d: q.quotes > 0 ? q.competitive / q.quotes : null,
      lip_size_ok_share_7d: q.quotes > 0 ? q.big_enough / q.quotes : null,
      lip_target: m.mm_lip_target,
      halted_today: !!day?.value.halted && day.value.date === new Date().toISOString().slice(0, 10),
      by_strategy: byStrategy,
      recent_fills: recent,
    };
  } catch {
    return null;
  }
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
  // This endpoint is public: show only the first line of an error (no stack trace), with secrets hidden.
  const runs = (await sql`select task, started_at, finished_at, ok, summary, error from edgebot.runs order by started_at desc limit 8`)
    .map((r) => ({ ...r, error: r.error ? redactSecrets(String(r.error).split("\n")[0]).slice(0, 200) : null }));
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
    market_making: await mmStats(),
  };
}

async function report() {
  const d = await dashboard();
  const p = d.paper;
  const money = (x: number | null) => (x === null ? "—" : `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`);
  const pctf = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
  const rows = (d.recent_bets as any[]).slice(0, 10).map((b) =>
    `<tr><td>${escapeHtml(b.label ?? "")}</td><td>${escapeHtml(b.team ?? "")}</td><td>${b.status}</td><td>${money(n(b.pnl))}</td></tr>`).join("");

  // Optional plain-English summary written by Claude or Grok from these exact numbers.
  const ai = aiFromEnv((k) => Deno.env.get(k));
  let summary = "";
  let aiStatus = ai ? "failed" : "off (no ANTHROPIC_API_KEY or XAI_API_KEY secret)";
  if (ai) {
    const r2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);
    const facts = {
      mode: d.mode, paused_reason: d.paused_reason, odds_key_present: d.odds_key_present,
      paper_simulation: {
        start_bankroll: p.start, bankroll: r2(p.equity), profit: r2(p.pnl), settled_bets: p.settled, won: p.won, lost: p.lost,
        open_bets: p.open_bets, waiting_orders: p.waiting, return_on_stakes_pct: p.roi === null ? null : r2(p.roi * 100),
        win_rate_pct: p.win_rate === null ? null : r2(p.win_rate * 100), expected_win_rate_pct: p.expected_win_rate === null ? null : r2(p.expected_win_rate * 100),
        beat_the_close_cents: p.avg_clv === null ? null : r2(p.avg_clv * 100), beat_the_close_bets: p.clv_count, fees_paid: r2(p.fees),
      },
      real_money: { settled_bets: d.live.settled, open_bets: d.live.open_bets, profit: r2(d.live.pnl) },
      real_money_unlock: { settled_needed: d.gate.min_settled, settled_so_far: d.gate.settled, paper_profit: r2(d.gate.paper_profit), paper_part_passed: d.gate.passes_paper_part },
      recent_results: (d.recent_bets as any[]).slice(0, 10).map((b) => ({ game: b.label, pick: b.team, money: b.mode === "live" ? "real" : "paper", result: b.status, profit: r2(n(b.pnl)) })),
      last_runs: (d.runs as any[]).slice(0, 4).map((r) => ({ task: r.task, ok: r.ok, note: r.summary?.note ?? null })),
    };
    try {
      summary = await explain(ai, REPORT_SYSTEM, facts);
      aiStatus = `ok (${ai.provider} ${ai.model})`;
    } catch (e) {
      aiStatus = `failed: ${(e as Error).message.slice(0, 160)}`;
    }
  }
  const summaryHtml = summary
    ? `<div style="background:#f3f6f2;border-radius:8px;padding:12px 14px;margin:8px 0 4px">${summary.split(/\n+/).map((para) => `<p style="margin:0 0 8px">${escapeHtml(para)}</p>`).join("")}<p style="margin:0;color:#666;font-size:12px">Written by AI from the numbers below. It explains; it doesn't pick bets.</p></div>`
    : "";

  const html = `
  <div style="font-family:system-ui,sans-serif;max-width:560px">
    <h2>Edge Bot weekly report</h2>
    ${summaryHtml}
    <p>Mode: <b>${d.mode}</b>${d.paused_reason ? ` (${escapeHtml(d.paused_reason)})` : ""}</p>
    <h3>Paper money (fake)</h3>
    <p>Bankroll ${money(p.equity)} (started ${money(p.start)}) · Profit ${money(p.pnl)} · ROI ${pctf(p.roi)}</p>
    <p>Settled ${p.settled} (won ${p.won}, lost ${p.lost}) · Win rate ${pctf(p.win_rate)} vs expected ${pctf(p.expected_win_rate)}</p>
    <p>Beat the closing price by ${p.avg_clv === null ? "—" : (p.avg_clv * 100).toFixed(1) + "¢"} on average (${p.clv_count} bets). Positive is the best early sign of a real edge.</p>
    <p>Fees paid: ${money(p.fees)}</p>
    <p>Real-money gate: ${d.gate.settled}/${d.gate.min_settled} settled bets, paper profit ${money(d.gate.paper_profit)} — ${d.gate.passes_paper_part ? "paper part passed" : "not yet"}.</p>
    ${d.live.settled + d.live.open_bets > 0 ? `<h3>Real money</h3><p>Profit ${money(d.live.pnl)} · Settled ${d.live.settled} · Open ${d.live.open_bets}</p>` : ""}
    ${d.market_making ? `<h3>Market making (paper)</h3><p>Profit ${money(d.market_making.pnl)} on a ${money(d.market_making.bankroll_start)} fake bankroll · ${d.market_making.fills} fills (${d.market_making.contracts_filled} contracts) · Price an hour after our fills: ${d.market_making.avg_markout_cents === null ? "—" : d.market_making.avg_markout_cents.toFixed(2) + "¢"} per contract (negative means better-informed traders are picking us off).</p>` : ""}
    <h3>Latest results</h3>
    <table cellpadding="4" style="border-collapse:collapse;font-size:14px">${rows || "<tr><td>No settled bets yet.</td></tr>"}</table>
    <p style="color:#666;font-size:12px">Odds credits left this month: ${d.odds_credits?.remaining ?? "—"}. Small samples are mostly luck; judge after a few hundred bets.</p>
  </div>`;
  return { email: await sendEmail(`Edge Bot: ${money(p.pnl)} paper profit, ${p.settled} bets settled`, html), ai: aiStatus };
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

async function discover(category = "Sports") {
  const series = await listSportsSeries(category);
  const games = category === "Sports" ? series.filter((x: any) => /GAME/i.test(x.ticker ?? "")) : series;
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

    if (task === "scan" || task === "tick" || task === "report" || task === "mm") {
      const expected = await vault("edgebot_cron_secret");
      if (!expected || req.headers.get("x-edgebot-cron") !== expected) {
        // The control token may also trigger these by hand (e.g. "run a scan now" from the dashboard).
        const ctl = await vault("edgebot_control_token");
        if (!ctl || req.headers.get("x-edgebot-token") !== ctl) return json({ error: "unauthorized" }, 401);
      }
      const id = await startRun(task);
      try {
        const result = task === "scan" ? await scan(id) : task === "tick" ? await tick() : task === "mm" ? await mmRun(id) : await report();
        await finishRun(id, true, result);
        return json({ ok: true, run: id, result });
      } catch (e) {
        await finishRun(id, false, {}, (e as Error).stack ?? String(e));
        return json({ ok: false, run: id, error: redactSecrets((e as Error).message) }, 500);
      }
    }

    if (task === "control" || task === "discover") {
      const ctl = await vault("edgebot_control_token");
      if (!ctl || req.headers.get("x-edgebot-token") !== ctl) return json({ error: "unauthorized" }, 401);
      if (task === "discover") return json(await discover(url.searchParams.get("category") ?? "Sports"));
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      return json(await control(body));
    }

    return json({ error: "unknown task" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: redactSecrets((e as Error).message) }, 500);
  }
});
