// stocks: opening-range breakout day trades through Alpaca. Paper by default.
// Real money only when ALL of these hold: settings mode 'live' (set via control go_live), the STOCKS_LIVE_ENABLED
// secret is "true", live Alpaca keys exist, and the paper record passes stockLiveGate. Hard caps live in orb.ts.
// Separate from edgebot on purpose: a bug here can't touch Kalshi.
//   ?task=run      cron, every 5 min on weekdays: sync orders, take signals, flatten at 3:55 PM New York
//   ?task=status   public, read-only: settings, gate, recent trades (no secrets)
//   ?task=control  POST {action: pause | paper | go_live | gate}, needs x-edgebot-token
import postgres from "npm:postgres@3.4.5";
import { Alpaca } from "./alpaca.ts";
import { effectiveStockSettings, nyClock, orbSignal, riskBlocks, round2, sizeShares, stockLiveGate, STOCK_HARD, WINDOW, type StockSettings } from "./orb.ts";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1, idle_timeout: 20 });
const env = (k: string) => Deno.env.get(k);
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, x-edgebot-token",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "content-type": "application/json" } });

async function vault(name: string): Promise<string | null> {
  const [r] = await sql`select decrypted_secret from vault.decrypted_secrets where name = ${name}`;
  return r?.decrypted_secret ?? null;
}
async function settings(): Promise<StockSettings> {
  const [r] = await sql`select * from edgebot.stock_settings where id = 1`;
  return effectiveStockSettings(r);
}
async function paperRecord() {
  const [r] = await sql`select count(*)::int as closed, coalesce(sum(pnl), 0)::float8 as pnl from edgebot.stock_trades where mode = 'paper' and status = 'closed'`;
  return { closed: r.closed as number, pnl: r.pnl as number };
}
async function gate(): Promise<string[]> {
  return stockLiveGate(await paperRecord(), env("STOCKS_LIVE_ENABLED") === "true", !!Alpaca.fromEnv("live", env));
}
async function setMode(mode: "paper" | "live" | "paused", reason: string | null) {
  await sql`update edgebot.stock_settings set mode = ${mode}, paused_reason = ${reason}, updated_at = now() where id = 1`;
}

/** Bring open rows up to date with Alpaca: unfilled, filled, or closed by the stop or the target. */
async function sync(a: Alpaca) {
  const open = await sql`select * from edgebot.stock_trades where mode = ${a.mode} and status in ('open', 'filled')`;
  let changed = 0;
  for (const t of open) {
    // one bad row must never stop the run before the 3:55 flatten
    let o: any;
    try { o = await a.order(t.alpaca_order_id); } catch (e) { console.error(`sync ${t.id}:`, (e as Error).message); continue; }
    const filledQty = Number(o.filled_qty ?? 0);
    if (filledQty === 0 && ["canceled", "expired", "rejected"].includes(o.status)) {
      await sql`update edgebot.stock_trades set status = 'unfilled', closed_at = now(), raw = ${sql.json(o)} where id = ${t.id}`;
      changed++;
      continue;
    }
    if (filledQty === 0) continue;
    const fill = Number(o.filled_avg_price);
    const exitLeg = (o.legs ?? []).find((l: any) => l.status === "filled");
    if (exitLeg) {
      const exit = Number(exitLeg.filled_avg_price);
      const pnl = round2((exit - fill) * filledQty);
      await sql`update edgebot.stock_trades set status = 'closed', qty = ${filledQty}, fill_price = ${fill}, exit_price = ${exit},
                pnl = ${pnl}, exit_reason = ${exitLeg.type === "limit" ? "target" : "stop"}, closed_at = now(), raw = ${sql.json(o)} where id = ${t.id}`;
      changed++;
    } else if (t.status === "open") {
      await sql`update edgebot.stock_trades set status = 'filled', qty = ${filledQty}, fill_price = ${fill}, filled_at = now() where id = ${t.id}`;
      changed++;
    }
  }
  return changed;
}

/** 3:55 PM: close everything, then book still-open rows at the last price (approximate, labelled as such). */
async function flatten(a: Alpaca) {
  const pos = await a.positions();
  // always: also cancels entry orders that never filled, so nothing can fill late and sit overnight
  await a.closeAll();
  const last = Object.fromEntries(pos.map((p: any) => [p.symbol, Number(p.current_price)]));
  const rows = await sql`select * from edgebot.stock_trades where mode = ${a.mode} and status = 'filled'`;
  for (const t of rows) {
    const exit = last[t.symbol];
    if (!exit) continue;
    await sql`update edgebot.stock_trades set status = 'closed', exit_price = ${exit}, pnl = ${round2((exit - Number(t.fill_price)) * t.qty)},
              exit_reason = 'flat at close (approx price)', closed_at = now() where id = ${t.id}`;
  }
  await sql`update edgebot.stock_trades set status = 'unfilled', closed_at = now() where mode = ${a.mode} and status = 'open'`;
  return pos.length;
}

async function run() {
  const s = await settings();
  if (s.mode === "paused") return { skipped: "paused" };
  if (s.mode === "live") {
    const reasons = await gate();
    if (reasons.length) {
      await setMode("paused", `live gate failed: ${reasons.join("; ")}`);
      return { paused: reasons };
    }
  }
  const a = Alpaca.fromEnv(s.mode, env);
  if (!a) return { skipped: `no ${s.mode} Alpaca keys` };
  const clock = await a.clock();
  const synced = await sync(a);
  if (!clock.is_open) return { mode: a.mode, market: "closed", synced };

  const now = new Date();
  const ny = nyClock(now);
  if (ny.minutes >= WINDOW.FLAT) return { mode: a.mode, flattened: await flatten(a), synced };
  if (ny.minutes < WINDOW.RANGE_END || ny.minutes >= WINDOW.LAST_ENTRY + 5 || !s.watchlist.length) return { mode: a.mode, synced, entries: "outside window" };

  const acct = await a.account();
  if (acct.trading_blocked) return { mode: a.mode, blocked: "Alpaca says trading is blocked" };
  const dayPnl = Number(acct.equity) - Number(acct.last_equity);
  let cash = Number(acct.cash);
  const today = await sql`select symbol from edgebot.stock_trades where mode = ${a.mode} and trade_date = ${ny.date}`; // 'error' rows count too: the order may have gone through
  const traded = new Set(today.map((r: any) => r.symbol));
  let tradesToday = today.length;

  const bars = await a.bars5m(s.watchlist, new Date(now.getTime() - 4 * 3600_000).toISOString());
  const out: any[] = [];
  for (const sym of s.watchlist) {
    const sig = orbSignal(bars[sym] ?? [], now, s.target_r);
    if (sig.action !== "buy") { out.push({ sym, ...sig }); continue; }
    const shares = sizeShares(sig.entry, sig.stop, s, cash);
    const blocks = riskBlocks({ s, tradesToday, dayPnl, alreadyTradedSymbol: traded.has(sym), shares, entry: sig.entry, stop: sig.stop, nowMinutes: ny.minutes });
    if (blocks.length) { out.push({ sym, action: "blocked", blocks }); continue; }
    const clientId = `orb-${ny.date}-${sym}-${a.mode}`;
    // limit a hair above the signal close so a fast move doesn't fill far above the planned risk
    const limit = round2(sig.entry * 1.001);
    try {
      const o = await a.bracketBuy({ symbol: sym, qty: shares, limit, stop: sig.stop, target: sig.target, clientId });
      await sql`insert into edgebot.stock_trades (mode, trade_date, symbol, setup, entry, stop, target, qty, alpaca_order_id, client_order_id, status, raw)
                values (${a.mode}, ${ny.date}, ${sym}, 'orb', ${sig.entry}, ${sig.stop}, ${sig.target}, ${shares}, ${o.id}, ${clientId}, 'open', ${sql.json(o)})`;
      tradesToday++; traded.add(sym); cash -= shares * limit;
      out.push({ sym, action: "bought", shares, entry: sig.entry, stop: sig.stop, target: sig.target });
    } catch (e) {
      await sql`insert into edgebot.stock_trades (mode, trade_date, symbol, setup, entry, stop, target, qty, client_order_id, status, raw)
                values (${a.mode}, ${ny.date}, ${sym}, 'orb', ${sig.entry}, ${sig.stop}, ${sig.target}, ${shares}, ${clientId}, 'error', ${sql.json({ error: String((e as Error).message).slice(0, 300) })})
                on conflict (client_order_id) do nothing`;
      out.push({ sym, action: "error", error: String((e as Error).message).slice(0, 200) });
    }
  }
  return { mode: a.mode, dayPnl: round2(dayPnl), synced, signals: out };
}

async function status() {
  const [raw] = await sql`select mode, paused_reason, updated_at from edgebot.stock_settings where id = 1`;
  const trades = await sql`select mode, trade_date, symbol, entry, stop, target, qty, fill_price, exit_price, pnl, status, exit_reason, placed_at, closed_at
                           from edgebot.stock_trades order by placed_at desc limit 50`;
  return { settings: { ...(await settings()), paused_reason: raw?.paused_reason ?? null }, hard_caps: STOCK_HARD, paper: await paperRecord(), live_gate_blocks: await gate(), trades };
}

async function control(body: any) {
  const action = String(body?.action ?? "");
  if (action === "pause") { await setMode("paused", "paused by owner"); return { ok: true, mode: "paused" }; }
  if (action === "paper") { await setMode("paper", null); return { ok: true, mode: "paper" }; }
  if (action === "gate") return { ok: true, blocks: await gate() };
  if (action === "go_live") {
    const blocks = await gate();
    if (blocks.length) return { ok: false, blocks };
    await setMode("live", null);
    return { ok: true, mode: "live" };
  }
  return { ok: false, error: "unknown action (pause, paper, go_live, gate)" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const task = new URL(req.url).searchParams.get("task") ?? "status";
  try {
    if (task === "status") return json(await status());
    if (task === "run") {
      const cron = await vault("edgebot_cron_secret"), ctl = await vault("edgebot_control_token");
      const ok = (cron && req.headers.get("x-edgebot-cron") === cron) || (ctl && req.headers.get("x-edgebot-token") === ctl);
      if (!ok) return json({ error: "unauthorized" }, 401);
      const [r] = await sql`insert into edgebot.runs (task) values ('stocks') returning id`;
      try {
        const result = await run();
        await sql`update edgebot.runs set finished_at = now(), ok = true, summary = ${sql.json(result)} where id = ${r.id}`;
        return json({ ok: true, result });
      } catch (e) {
        await sql`update edgebot.runs set finished_at = now(), ok = false, error = ${String((e as Error).message).slice(0, 500)} where id = ${r.id}`;
        return json({ ok: false, error: String((e as Error).message).slice(0, 200) }, 500);
      }
    }
    if (task === "control") {
      const ctl = await vault("edgebot_control_token");
      if (!ctl || req.headers.get("x-edgebot-token") !== ctl) return json({ error: "unauthorized" }, 401);
      return json(await control(req.method === "POST" ? await req.json().catch(() => ({})) : {}));
    }
    return json({ error: "unknown task" }, 404);
  } catch (e) {
    return json({ error: String((e as Error).message).slice(0, 200) }, 500);
  }
});
