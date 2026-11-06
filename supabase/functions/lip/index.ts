// lip: finds Kalshi markets that PAY for resting liquidity where little or none is posted, and paper-trades it.
// Paper only: no Kalshi keys, no orders. Each hour:
//   1. list active liquidity programs, read each order book, work out the best way to join (lip/score.ts)
//   2. paper book: for each pretend order, check public trades for fills (marked to the mid), else accrue
//      our estimated share of that hour's reward; close when the program ends
//   3. open new pretend orders on the best reward-per-dollar plans, within a $500 paper budget
//   ?task=scan   cron hourly (cron secret or control token)
//   ?task=board  public, read-only: today's best opportunities and the paper book's result
import postgres from "npm:postgres@3.4.5";
import { getTrades } from "../edgebot/lib/kalshi.ts";
import { bestPlan, fillPnl, fills, parseBook, parseProgram, rewardPerDay, sideScore, type Book, type Plan, type Program } from "./score.ts";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1, idle_timeout: 20 });
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type", "access-control-allow-methods": "GET, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "content-type": "application/json" } });
const KALSHI = "https://external-api.kalshi.com/trade-api/v2";
const BUDGET = 500, MAX_PER_POSITION = 100, MIN_DAILY = 0.5, MAX_BOOKS = 200;

async function kget(path: string): Promise<any> {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(KALSHI + path, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 1000 * (i + 1))); continue; }
    if (!res.ok) throw new Error(`Kalshi ${path.slice(0, 60)} -> ${res.status}`);
    return await res.json();
  }
  throw new Error("Kalshi rate limited");
}
async function vault(name: string): Promise<string | null> {
  const [r] = await sql`select decrypted_secret from vault.decrypted_secrets where name = ${name}`;
  return r?.decrypted_secret ?? null;
}

async function programs(): Promise<Program[]> {
  const out: Program[] = [];
  let cursor = "";
  for (let page = 0; page < 15; page++) {
    const j = await kget(`/incentive_programs?status=active&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    for (const x of j.incentive_programs ?? []) { const p = parseProgram(x); if (p && Date.parse(p.end) > Date.now()) out.push(p); }
    cursor = j.next_cursor ?? j.cursor ?? "";
    if (!cursor) break;
  }
  return out;
}

const yesMid = (b: Book) => {
  const y = sideScore(b.yes, 1, 1).best, n = sideScore(b.no, 1, 1).best;
  const bid = Number.isFinite(y) ? y : 0, ask = Number.isFinite(n) ? 1 - n : 1;
  return (bid + ask) / 2;
};

async function scan() {
  const t0 = Date.now();
  const progs = (await programs()).sort((a, b) => rewardPerDay(b) - rewardPerDay(a));
  const byTicker = new Map(progs.map((p) => [p.ticker, p]));
  const books = new Map<string, Book>();
  const plans: Plan[] = [];
  for (const p of progs.filter((p) => rewardPerDay(p) >= 3).slice(0, MAX_BOOKS)) {
    if (Date.now() - t0 > 90_000) break;
    try {
      const b = parseBook(await kget(`/markets/${encodeURIComponent(p.ticker)}/orderbook`));
      books.set(p.ticker, b);
      const plan = bestPlan(p, b);
      const Y = sideScore(b.yes, p.target, p.discount), N = sideScore(b.no, p.target, p.discount);
      await sql`insert into edgebot.lip_scan (scanned_at, ticker, reward_day, ends_at, target, depth_yes, depth_no, best_yes, best_no, valid_now, plan, est_daily, collateral, roi_daily)
                values (date_trunc('hour', now()), ${p.ticker}, ${rewardPerDay(p)}, ${p.end}, ${p.target}, ${Y.depth}, ${N.depth},
                        ${Number.isFinite(Y.best) ? Y.best : null}, ${Number.isFinite(N.best) ? N.best : null}, ${Y.depth >= p.target && N.depth >= p.target},
                        ${plan ? sql.json(plan as any) : null}, ${plan?.estDaily ?? 0}, ${plan?.collateral ?? null}, ${plan?.roiDaily ?? null})
                on conflict (scanned_at, ticker) do nothing`;
      if (plan) plans.push(plan);
    } catch { /* skip this market this hour */ }
  }

  // ---- paper book: fills, accrual, closing
  const open = await sql`select * from edgebot.lip_book where status = 'resting'`;
  let filled = 0, accrued = 0;
  for (const o of open) {
    const prog = byTicker.get(o.ticker) ?? (o.program as Program);
    // never accrue past the program's end
    const until = Math.min(Date.now(), Date.parse(prog.end));
    const hours = Math.max(0, Math.min((until - new Date(o.last_check).getTime()) / 3_600_000, 3));
    let book = books.get(o.ticker);
    try { book ??= parseBook(await kget(`/markets/${encodeURIComponent(o.ticker)}/orderbook`)); } catch { continue; }
    const plan = o.plan as Plan;
    let hit: "yes" | "no" | null = null;
    try {
      const trades = await getTrades(o.ticker, new Date(o.last_check).getTime());
      for (const s of plan.sides) {
        const price = s === "yes" ? plan.yesPrice! : plan.noPrice!;
        if (trades.some((t) => fills(s, price, t.price))) { hit = s; break; }
      }
    } catch { /* no trade data this hour: assume no fill, check again next hour */ }
    if (hit) {
      // pessimistic: a filled bid is booked as a total loss of what we paid (marked-to-mid kept for reference)
      const price = hit === "yes" ? plan.yesPrice! : plan.noPrice!;
      const pnl = Math.min(-plan.q * price, fillPnl(hit, plan.q, price, yesMid(book)));
      await sql`update edgebot.lip_book set status = 'filled', filled_side = ${hit}, fill_pnl = ${pnl}, closed_at = now(), last_check = now() where id = ${o.id}`;
      filled++;
      continue;
    }
    // accrue this stretch at today's competition (the live book never contains our pretend order)
    const Y = sideScore(book.yes, prog.target, prog.discount), N = sideScore(book.no, prog.target, prog.discount);
    const onY = plan.sides.includes("yes"), onN = plan.sides.includes("no");
    const valid = Y.depth + (onY ? plan.q : 0) >= prog.target && N.depth + (onN ? plan.q : 0) >= prog.target;
    const share = ((onY ? plan.q / (Y.score + plan.q) : 0) + (onN ? plan.q / (N.score + plan.q) : 0)) / 2;
    const earn = valid ? rewardPerDay(prog) * share * hours / 24 : 0;
    accrued += earn;
    const ended = Date.parse(prog.end) <= Date.now() || !byTicker.has(o.ticker);
    await sql`update edgebot.lip_book set reward_accrued = reward_accrued + ${earn}, last_check = now(),
              status = ${ended ? "closed" : "resting"}, closed_at = ${ended ? new Date() : null} where id = ${o.id}`;
  }

  // ---- open new pretend orders on the best reward per dollar
  const [{ used }] = await sql`select coalesce(sum(collateral), 0)::float8 as used from edgebot.lip_book where status = 'resting'`;
  const resting = new Set((await sql`select ticker from edgebot.lip_book where status = 'resting'`).map((r: any) => r.ticker));
  let room = BUDGET - used, opened = 0;
  for (const p of plans.sort((a, b) => b.roiDaily - a.roiDaily)) {
    if (resting.has(p.ticker) || p.estDaily < MIN_DAILY || p.collateral > MAX_PER_POSITION || p.collateral > room) continue;
    await sql`insert into edgebot.lip_book (ticker, plan, program, collateral, est_daily_at_open, ends_at)
              values (${p.ticker}, ${sql.json(p as any)}, ${sql.json(byTicker.get(p.ticker) as any)}, ${p.collateral}, ${p.estDaily}, ${byTicker.get(p.ticker)!.end})`;
    room -= p.collateral; opened++; resting.add(p.ticker);
  }
  await sql`delete from edgebot.lip_scan where scanned_at < now() - interval '3 days'`;
  return { programs: progs.length, books: books.size, plans: plans.length, filled, accrued: Math.round(accrued * 100) / 100, opened, budget_left: Math.round(room) };
}

async function board() {
  const top = await sql`select ticker, reward_day::float8, depth_yes::float8, depth_no::float8, best_yes::float8, best_no::float8, valid_now,
                               est_daily::float8, collateral::float8, roi_daily::float8, plan->'sides' as sides, ends_at
                        from edgebot.lip_scan where scanned_at = (select max(scanned_at) from edgebot.lip_scan) and est_daily > 0
                        order by roi_daily desc nulls last limit 25`;
  const [b] = await sql`select count(*) filter (where status = 'resting')::int as resting, count(*) filter (where status = 'filled')::int as filled,
                               count(*) filter (where status = 'closed')::int as closed,
                               coalesce(sum(collateral) filter (where status = 'resting'), 0)::float8 as collateral_in_use,
                               coalesce(sum(reward_accrued), 0)::float8 as rewards, coalesce(sum(fill_pnl), 0)::float8 as fill_pnl,
                               min(opened_at) as since from edgebot.lip_book`;
  const net = (b.rewards ?? 0) + (b.fill_pnl ?? 0);
  return { paper_book: { ...b, net: Math.round(net * 100) / 100, budget: BUDGET }, opportunities_now: top,
           note: "Paper only. Rewards are estimates from the public book; fills are counted on any trade at or through our price (pessimistic)." };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const task = new URL(req.url).searchParams.get("task") ?? "board";
  try {
    if (task === "board") return json(await board());
    if (task === "scan") {
      const cron = await vault("edgebot_cron_secret"), ctl = await vault("edgebot_control_token");
      if (!((cron && req.headers.get("x-edgebot-cron") === cron) || (ctl && req.headers.get("x-edgebot-token") === ctl))) return json({ error: "unauthorized" }, 401);
      return json({ ok: true, ...(await scan()) });
    }
    return json({ error: "unknown task" }, 404);
  } catch (e) {
    return json({ error: String((e as Error).message).slice(0, 200) }, 500);
  }
});
