// wx-score: the weather scoreboard. Records Kalshi's price and a free ensemble forecast (GFS + ECMWF members,
// Open-Meteo) for every open high-temperature market, then fills in what actually happened.
// Places no orders. It decides whether the forecast (or the "cheap favorites" pattern) has EARNED money.
//   ?task=snap   cron hourly: snapshot open markets + settle finished ones (needs the cron secret or control token)
//   ?task=board  public, read-only: the scoreboard and its verdict
import postgres from "npm:postgres@3.4.5";
import { getMarket, getOpenEvents } from "../edgebot/lib/kalshi.ts";
import { daysBetween, eventDate, localDateHour, marketMid, MM_CITIES, parseBracket } from "../edgebot/lib/mm.ts";
import { ensembleProb, memberHighs, scoreboard, type Scored } from "./score.ts";

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
          await sql`insert into edgebot.wx_scores (ticker, event_ticker, series, event_date, days_ahead, market_mid, ens_p, ens_members, snap_hour)
                    values (${m.ticker}, ${ev.event_ticker}, ${series}, ${date}, ${daysBetween(today, date)}, ${mid},
                            ${Number.isFinite(ens) ? ens : null}, ${members.length}, date_trunc('hour', now()))
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
      await sql`update edgebot.wx_scores set outcome = ${r === "yes" ? 1 : 0} where ticker = ${ticker} and outcome is null`;
      n++;
    } catch { /* try again next hour */ }
  }
  return n;
}

async function board() {
  // one snapshot per market: the day-before one when we have it (a real, tradable lead time), else the earliest
  const rows = await sql`select distinct on (ticker) ticker, market_mid::float8 as market, ens_p::float8 as ens, outcome as y, days_ahead
                         from edgebot.wx_scores where outcome is not null
                         order by ticker, (days_ahead = 1) desc nulls last, snap_hour`;
  const scored: Scored[] = rows.map((r: any) => ({ ticker: r.ticker, market: r.market, ens: r.ens, y: r.y, daysAhead: r.days_ahead }));
  const [p] = await sql`select count(*)::int as snapshots, count(distinct ticker)::int as markets, count(*) filter (where outcome is null)::int as waiting, max(snap_hour) as last_snap from edgebot.wx_scores`;
  return { ...scoreboard(scored), recorded: p };
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
    return json({ error: "unknown task" }, 404);
  } catch (e) {
    return json({ error: String((e as Error).message).slice(0, 200) }, 500);
  }
});
