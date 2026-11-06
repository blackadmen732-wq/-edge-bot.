// wx-score: the weather scoreboard. Records Kalshi's price and a free ensemble forecast (GFS + ECMWF members,
// Open-Meteo) for every open high-temperature market, then fills in what actually happened.
// Places no orders. It decides whether the forecast (or the "cheap favorites" pattern) has EARNED money.
//   ?task=snap   cron hourly: snapshot open markets + settle finished ones (needs the cron secret or control token)
//   ?task=board  public, read-only: the scoreboard and its verdict
import postgres from "npm:postgres@3.4.5";
import { getMarket, getOpenEvents } from "../edgebot/lib/kalshi.ts";
import { bracketProb, daysBetween, eventDate, forecastSigma, localDateHour, marketMid, MM_CITIES, parseBracket } from "../edgebot/lib/mm.ts";
import { night, type Recipe } from "./arena.ts";
import { dailyMaxByKey, ensembleProb, learnAndTest, localNoonUtc, memberHighs, prevDay, scoreboard, type CalRow, type Scored } from "./score.ts";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1, idle_timeout: 20 });
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type", "access-control-allow-methods": "GET, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "content-type": "application/json" } });
const dollars = (s?: string) => (s === undefined || s === null || s === "" ? NaN : Number(s));

async function vault(name: string): Promise<string | null> {
  const [r] = await sql`select decrypted_secret from vault.decrypted_secrets where name = ${name}`;
  return r?.decrypted_secret ?? null;
}

async function ensemble(lat: number, lon: number, tz: string) {
  const u = new URL("https://ensemble-api.open-meteo.com/v1/ensemble");
  u.search = new URLSearchParams({ latitude: String(lat), longitude: String(lon), hourly: "temperature_2m", temperature_unit: "fahrenheit", timezone: tz, forecast_days: "3", models: "gfs_seamless,ecmwf_ifs025" }).toString();
  const res = await fetch(u, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Open-Meteo ensemble ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return memberHighs((await res.json())?.hourly);
}

async function snap() {
  const now = new Date();
  const out: Record<string, unknown> = {};
  for (const [series, city] of Object.entries(MM_CITIES)) {
    try {
      const [events, highs] = await Promise.all([getOpenEvents(series), ensemble(city.lat, city.lon, city.tz).catch(() => new Map<string, number[]>())]);
      const today = localDateHour(now, city.tz).date;
      let n = 0;
      for (const ev of events) {
        const date = eventDate(ev.event_ticker);
        if (!date) continue;
        for (const m of ev.markets ?? []) {
          const b = parseBracket(m);
          const mid = marketMid(dollars(m.yes_bid_dollars), dollars(m.yes_ask_dollars), dollars(m.last_price_dollars));
          if (!b || !Number.isFinite(mid)) continue;
          const members = highs.get(date) ?? [];
          const ens = ensembleProb(b, members);
          const mean = members.length ? members.reduce((a, x) => a + x, 0) / members.length : null;
          await sql`insert into edgebot.wx_scores (ticker, event_ticker, series, event_date, days_ahead, market_mid, ens_p, ens_members, snap_hour, fc_src, fc_mean, bmin, bmax)
                    values (${m.ticker}, ${ev.event_ticker}, ${series}, ${date}, ${daysBetween(today, date)}, ${mid},
                            ${Number.isFinite(ens) ? ens : null}, ${members.length}, date_trunc('hour', now()), 'ens', ${mean}, ${b.min}, ${b.max})
                    on conflict (ticker, snap_hour) do nothing`;
          n++;
        }
      }
      out[series] = { markets: n, members: [...highs.values()][0]?.length ?? 0 };
    } catch (e) {
      out[series] = { error: String((e as Error).message).slice(0, 160) };
    }
  }
  return { snapped: out, settled: await settle() };
}

/** Fill in yes/no for markets whose day is over. */
async function settle() {
  const open = await sql`select distinct ticker from edgebot.wx_scores where outcome is null and (event_date is null or event_date < current_date) limit 150`;
  let n = 0;
  for (const { ticker } of open) {
    try {
      const m = await getMarket(ticker);
      const r = String(m.result ?? "").toLowerCase();
      if (r !== "yes" && r !== "no") continue;
      const actual = Number(m.expiration_value);
      await sql`update edgebot.wx_scores set outcome = ${r === "yes" ? 1 : 0}, actual_high = ${Number.isFinite(actual) ? actual : null} where ticker = ${ticker} and outcome is null`;
      n++;
    } catch { /* try again next hour */ }
  }
  return n;
}


// ---------------------------------------------------------------- history backfill (runs every 5 min until done)

const KALSHI = "https://external-api.kalshi.com/trade-api/v2";
async function kget(path: string): Promise<any> {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(KALSHI + path, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 1000 * (i + 1))); continue; }
    if (!res.ok) throw new Error(`Kalshi ${path.slice(0, 60)} -> ${res.status}`);
    return await res.json();
  }
  throw new Error("Kalshi rate limited");
}

/** Step 1: every settled market per city, plus the archived day-ahead GFS/ECMWF forecasts for that span. */
async function listHistory() {
  const out: Record<string, unknown> = {};
  for (const [series, city] of Object.entries(MM_CITIES)) {
    let cursor = "", n = 0, first = "9999", last = "0000";
    for (let page = 0; page < 20; page++) {
      const j = await kget(`/markets?series_ticker=${series}&status=settled&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      for (const m of j.markets ?? []) {
        const date = eventDate(m.event_ticker ?? ""), b = parseBracket(m), r = String(m.result ?? "").toLowerCase();
        if (!date || !b || (r !== "yes" && r !== "no")) continue;
        const actual = Number(m.expiration_value);
        await sql`insert into edgebot.wx_hist (ticker, series, event_ticker, event_date, bmin, bmax, outcome, actual_high)
                  values (${m.ticker}, ${series}, ${m.event_ticker}, ${date}, ${b.min}, ${b.max}, ${r === "yes" ? 1 : 0}, ${Number.isFinite(actual) ? actual : null})
                  on conflict (ticker) do nothing`;
        n++; if (date < first) first = date; if (date > last) last = date;
      }
      cursor = j.cursor ?? "";
      if (!cursor) break;
    }
    if (n) {
      const u = new URL("https://previous-runs-api.open-meteo.com/v1/forecast");
      u.search = new URLSearchParams({ latitude: String(city.lat), longitude: String(city.lon), start_date: first, end_date: last,
        hourly: "temperature_2m_previous_day1", temperature_unit: "fahrenheit", timezone: city.tz, models: "gfs_seamless,ecmwf_ifs025" }).toString();
      const res = await fetch(u, { signal: AbortSignal.timeout(30000) });
      const days = res.ok ? dailyMaxByKey((await res.json())?.hourly) : new Map();
      const gfs = [...days].find(([k]) => k.includes("gfs"))?.[1] ?? new Map<string, number>();
      const ec = [...days].find(([k]) => k.includes("ecmwf"))?.[1] ?? new Map<string, number>();
      for (const d of new Set([...gfs.keys(), ...ec.keys()])) {
        await sql`insert into edgebot.wx_hist_fc (series, date, gfs, ecmwf) values (${series}, ${d}, ${gfs.get(d) ?? null}, ${ec.get(d) ?? null})
                  on conflict (series, date) do update set gfs = excluded.gfs, ecmwf = excluded.ecmwf`;
      }
    }
    out[series] = { markets: n, from: first, to: last };
  }
  return out;
}

/** Step 2: the market's price at noon local the day before, joined with the forecast, into wx_scores. */
async function priceHistory(budgetMs: number) {
  const t0 = Date.now();
  const todo = await sql`select h.*, f.gfs::float8 as gfs, f.ecmwf::float8 as ecmwf from edgebot.wx_hist h
                         left join edgebot.wx_hist_fc f on f.series = h.series and f.date = h.event_date
                         where not h.done order by h.event_date limit 400`;
  let n = 0;
  for (const h of todo) {
    if (Date.now() - t0 > budgetMs) break;
    const date = new Date(h.event_date).toISOString().slice(0, 10);
    const tz = MM_CITIES[h.series]?.tz ?? "America/New_York";
    const target = localNoonUtc(prevDay(date), tz);
    let note = "ok";
    try {
      const j = await kget(`/series/${h.series}/markets/${encodeURIComponent(h.ticker)}/candlesticks?start_ts=${Math.floor(target / 1000) - 3 * 3600}&end_ts=${Math.floor(target / 1000)}&period_interval=60`);
      const c = (j.candlesticks ?? []).filter((x: any) => x.end_period_ts * 1000 <= target).pop();
      const mid = c ? marketMid(Number(c.yes_bid?.close_dollars), Number(c.yes_ask?.close_dollars), Number(c.price?.close_dollars)) : NaN;
      const fcs = [h.gfs, h.ecmwf].filter((x: unknown) => x !== null && Number.isFinite(Number(x))).map(Number);
      const mu = fcs.length ? fcs.reduce((a, b) => a + b, 0) / fcs.length : NaN;
      if (!Number.isFinite(mid)) note = "no price the day before";
      else {
        const p = Number.isFinite(mu) ? bracketProb({ min: h.bmin, max: h.bmax }, mu, forecastSigma(1)) : NaN;
        await sql`insert into edgebot.wx_scores (ticker, event_ticker, series, event_date, days_ahead, market_mid, ens_p, outcome, snap_hour, fc_src, fc_mean, actual_high, bmin, bmax)
                  values (${h.ticker}, ${h.event_ticker}, ${h.series}, ${date}, 1, ${mid}, ${Number.isFinite(p) ? p : null}, ${h.outcome},
                          ${new Date(target).toISOString()}, 'hist_det', ${Number.isFinite(mu) ? mu : null}, ${h.actual_high}, ${h.bmin}, ${h.bmax})
                  on conflict (ticker, snap_hour) do nothing`;
      }
    } catch (e) {
      note = String((e as Error).message).slice(0, 120);
      if (/rate limited|429/.test(note)) break; // leave it for the next run
    }
    await sql`update edgebot.wx_hist set done = true, note = ${note} where ticker = ${h.ticker}`;
    n++;
  }
  return n;
}

async function backfill() {
  const [st] = await sql`select value from edgebot.state where key = 'wx:backfill'`;
  const state = st?.value ?? {};
  if (!state.listed) {
    const listed = await listHistory();
    await sql`insert into edgebot.state (key, value) values ('wx:backfill', ${sql.json({ listed: true, at: new Date().toISOString(), cities: listed } as any)})
              on conflict (key) do update set value = excluded.value, updated_at = now()`;
    return { step: "listed", listed };
  }
  const priced = await priceHistory(100_000);
  const [{ left }] = await sql`select count(*)::int as left from edgebot.wx_hist where not done`;
  if (left === 0) {
    try { await sql`select cron.unschedule('edgebot-wx-backfill')`; } catch { /* already gone */ }
  }
  return { step: "prices", priced, left };
}


// ---------------------------------------------------------------- Survival Arena (nightly)

/** One row per settled market: the day-before snapshot (history or live ensemble) with forecast and actual. */
async function arenaRows(): Promise<CalRow[]> {
  const rows = await sql`select distinct on (ticker) series, event_date::text as date, bmin, bmax, market_mid::float8 as market,
                                fc_mean::float8 as fc, actual_high::float8 as actual, outcome as y
                         from edgebot.wx_scores
                         where outcome is not null and fc_mean is not null and event_date is not null and fc_src in ('hist_det', 'ens')
                         order by ticker, (days_ahead = 1) desc nulls last, snap_hour`;
  return rows.map((r: any) => ({ series: r.series, date: r.date, bmin: r.bmin, bmax: r.bmax, market: r.market, fcMean: r.fc, actual: r.actual, y: r.y }));
}

async function arena() {
  const rows = await arenaRows();
  const days = new Set(rows.map((r) => r.date)).size;
  if (days < 30) return { waiting: `arena needs 30+ settled days, has ${days}` };
  const [st] = await sql`select value from edgebot.state where key = 'arena:wx'`;
  const gen = Number(st?.value?.generation ?? 0) + 1, tried = Number(st?.value?.tried ?? 0);
  const pop: Recipe[] = (await sql`select id, genome, generation, parent, status from edgebot.arena_recipes where family = 'wx' and status <> 'dead'`)
    .map((r: any) => ({ id: r.id, genome: r.genome, generation: r.generation, parent: r.parent, status: r.status }));
  let k = 0;
  const res = night(pop, rows, { seed: gen * 7919 + days, generation: gen, tried, newId: () => `wx-g${gen}-${++k}` });
  for (const p of res.population) {
    const sc = res.scores[p.id];
    await sql`insert into edgebot.arena_recipes (id, family, genome, generation, parent, status, last_select, last_vault, died_at, proven_at, updated_at)
              values (${p.id}, 'wx', ${sql.json(p.genome as any)}, ${p.generation}, ${p.parent}, ${p.status}, ${sc ? sql.json(sc.select as any) : null},
                      ${sc?.vault ? sql.json(sc.vault as any) : null}, ${p.status === "dead" ? new Date() : null}, ${p.status === "proven" ? new Date() : null}, now())
              on conflict (id) do update set status = excluded.status, last_select = coalesce(excluded.last_select, arena_recipes.last_select),
                last_vault = coalesce(excluded.last_vault, arena_recipes.last_vault),
                died_at = coalesce(arena_recipes.died_at, excluded.died_at), proven_at = coalesce(arena_recipes.proven_at, excluded.proven_at), updated_at = now()`;
  }
  // every recipe ever scored counts toward the luck bar
  const [{ n: everTried }] = await sql`select count(*)::int as n from edgebot.arena_recipes where family = 'wx'`;
  const summary = { generation: gen, tried: everTried, days, rows: rows.length, killed: res.killed.length, born: res.born.length, proven: res.proven, required_z: res.requiredZ };
  await sql`insert into edgebot.state (key, value) values ('arena:wx', ${sql.json(summary as any)})
            on conflict (key) do update set value = excluded.value, updated_at = now()`;
  return summary;
}

async function arenaBoard() {
  const [st] = await sql`select value from edgebot.state where key = 'arena:wx'`;
  const top = await sql`select id, generation, status, genome, last_select, last_vault from edgebot.arena_recipes
                        where family = 'wx' and status <> 'dead' order by (last_select->>'z')::float8 desc nulls last limit 5`;
  const [c] = await sql`select count(*) filter (where status = 'alive')::int as alive, count(*) filter (where status = 'dead')::int as dead,
                               count(*) filter (where status = 'proven')::int as proven from edgebot.arena_recipes where family = 'wx'`;
  return { last_night: st?.value ?? null, counts: c, top };
}

async function board() {
  // one snapshot per market: the day-before one when we have it (a real, tradable lead time), else the earliest
  const rows = await sql`select distinct on (ticker) ticker, market_mid::float8 as market, ens_p::float8 as ens, outcome as y, days_ahead
                         from edgebot.wx_scores where outcome is not null
                         order by ticker, (days_ahead = 1) desc nulls last, snap_hour`;
  const scored: Scored[] = rows.map((r: any) => ({ ticker: r.ticker, market: r.market, ens: r.ens, y: r.y, daysAhead: r.days_ahead }));
  const [p] = await sql`select count(*)::int as snapshots, count(distinct ticker)::int as markets, count(*) filter (where outcome is null)::int as waiting, max(snap_hour) as last_snap from edgebot.wx_scores`;
  // Learned forecast: per-city bias and spread fit on the older 60% of days, scored only on the newer 40%.
  const hist = await sql`select series, event_date::text as date, bmin, bmax, market_mid::float8 as market, fc_mean::float8 as fc, actual_high::float8 as actual, outcome as y
                         from edgebot.wx_scores where fc_src = 'hist_det' and fc_mean is not null and outcome is not null`;
  const cal: CalRow[] = hist.map((r: any) => ({ series: r.series, date: r.date, bmin: r.bmin, bmax: r.bmax, market: r.market, fcMean: r.fc, actual: r.actual, y: r.y }));
  const dates = [...new Set(cal.map((r) => r.date))].sort();
  const learned = dates.length >= 20 ? learnAndTest(cal, dates[Math.floor(dates.length * 0.6)]) : { waiting: `history backfill: ${dates.length} days so far` };
  const [bf] = await sql`select count(*) filter (where done)::int as done, count(*)::int as total from edgebot.wx_hist`;
  return { ...scoreboard(scored), learned_forecast: learned, arena: await arenaBoard().catch(() => null), backfill: bf, recorded: p };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const task = new URL(req.url).searchParams.get("task") ?? "board";
  try {
    if (task === "board") return json(await board());
    if (task === "snap") {
      const cron = await vault("edgebot_cron_secret"), ctl = await vault("edgebot_control_token");
      if (!((cron && req.headers.get("x-edgebot-cron") === cron) || (ctl && req.headers.get("x-edgebot-token") === ctl))) return json({ error: "unauthorized" }, 401);
      return json({ ok: true, ...(await snap()) });
    }
    if (task === "arena") {
      const cron = await vault("edgebot_cron_secret"), ctl = await vault("edgebot_control_token");
      if (!((cron && req.headers.get("x-edgebot-cron") === cron) || (ctl && req.headers.get("x-edgebot-token") === ctl))) return json({ error: "unauthorized" }, 401);
      return json({ ok: true, ...(await arena()) });
    }
    if (task === "backfill") {
      const cron = await vault("edgebot_cron_secret"), ctl = await vault("edgebot_control_token");
      if (!((cron && req.headers.get("x-edgebot-cron") === cron) || (ctl && req.headers.get("x-edgebot-token") === ctl))) return json({ error: "unauthorized" }, 401);
      return json({ ok: true, ...(await backfill()) });
    }
    return json({ error: "unknown task" }, 404);
  } catch (e) {
    return json({ error: String((e as Error).message).slice(0, 200) }, 500);
  }
});
