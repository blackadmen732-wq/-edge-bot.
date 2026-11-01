// parallax-money: read-only paper-money history for the PARALLAX screen.
// Public like edgebot?task=dashboard (paper aggregates only, no secrets). Its only write is one history row
// (edgebot.state key 'parallax:money', at most one point per 25 minutes). Separate from the trading engine.
import postgres from "npm:postgres@3.4.5";
import { buildMoney, mergeHistory, appendSnapshot, type Snap } from "./curve.ts";
import { summarizeIntake } from "./intake.ts";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1, idle_timeout: 20 });
const headers = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "GET, OPTIONS",
  "content-type": "application/json",
};
let cache: { at: number; body: string } | null = null;
let intakeCache: { at: number; body: string } | null = null;
const iso = (d: unknown) => new Date(d as string).toISOString();

async function build() {
  const [s] = await sql`select paper_start_bankroll::float8 as sports_start, mm_bankroll::float8 as mm_start, mm_enabled, mode from edgebot.settings where id = 1`;
  const fills = await sql`select ticker, side, price::float8 as price, contracts, fee::float8 as fee, mid_at_fill::float8 as mid_at_fill, markout::float8 as markout, filled_at
                          from edgebot.mm_fills order by filled_at`;
  // one mid per market per half hour keeps this small as history grows
  const mids = await sql`select ticker, date_bin('30 minutes', posted_at, timestamptz '2000-01-01') as at, avg(market_mid)::float8 as mid
                         from edgebot.mm_quotes where market_mid is not null group by 1, 2 order by 2`;
  const positions = await sql`select ticker, position, cash::float8 as cash, last_mid::float8 as last_mid, settled, result, updated_at from edgebot.mm_positions`;
  const bets = await sql`select status, pnl::float8 as pnl, settled_at from edgebot.bets where mode = 'paper'`;
  const runs = await sql`select task, ok, started_at from edgebot.runs where started_at > now() - interval '30 days'`;
  const [hist] = await sql`select value from edgebot.state where key = 'parallax:money'`;
  const recorded: Snap[] = Array.isArray(hist?.value?.points) ? hist.value.points : [];
  const out = buildMoney({
    now: Date.now(), sportsStart: Number(s?.sports_start ?? 0), mmStart: Number(s?.mm_start ?? 0), mmEnabled: !!s?.mm_enabled, mode: String(s?.mode ?? "paper"),
    fills: fills.map((f) => ({ ...f, filled_at: iso(f.filled_at) })) as never,
    mids: mids.map((m) => ({ ticker: m.ticker, mid: m.mid, at: iso(m.at) })),
    positions: positions.map((p) => ({ ...p, updated_at: iso(p.updated_at) })) as never,
    bets: bets.map((b) => ({ ...b, settled_at: b.settled_at ? iso(b.settled_at) : null })) as never,
    runs: runs.map((r) => ({ ...r, started_at: iso(r.started_at) })) as never,
    dayStart: null,
  });
  // Save a real point every ~30 minutes (the schedule calls this at :20 and :50), so the chart stops guessing.
  const nowPoint = out.points[out.points.length - 1];
  const snap: Snap = { t: nowPoint.t, total: nowPoint.total, pnl: nowPoint.pnl, mm: nowPoint.mm, sports: nowPoint.sports, fills: nowPoint.fills };
  const next = appendSnapshot(recorded, snap);
  if (next) await sql`insert into edgebot.state (key, value, updated_at) values ('parallax:money', ${sql.json({ points: next })}, now())
                      on conflict (key) do update set value = excluded.value, updated_at = now()`;
  const history = next ?? recorded;
  const points = mergeHistory(out.points, history, nowPoint);
  const prevDay = [...points].reverse().find((p) => new Date(p.t).getTime() <= Date.now() - 86_400_000);
  return { ...out, points, recorded_points: history.length, change_24h: prevDay ? Math.round((nowPoint.total - prevDay.total) * 100) / 100 : null };
}

// ?view=intake — every piece of real information the system stored: today's count, per hour, per source, and the latest lines.
async function intake() {
  const rows = await sql`select source, payload, recorded_at as at from edgebot_research.observations order by recorded_at desc limit 160`;
  const per = await sql`select source, count(*) filter (where recorded_at > now() - interval '24 hours')::int as day, count(*)::int as total
                        from edgebot_research.observations group by 1`;
  const hours = await sql`select date_trunc('hour', recorded_at) as h, count(*)::int as n from edgebot_research.observations
                          where recorded_at > now() - interval '24 hours' group by 1`;
  return summarizeIntake(rows.map((r) => ({ source: r.source, payload: r.payload, at: iso(r.at) })), per as never, hours.map((h) => ({ h: iso(h.h), n: h.n })));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "GET") return new Response(JSON.stringify({ error: "GET only" }), { status: 405, headers });
  try {
    if (new URL(req.url).searchParams.get("view") === "intake") {
      if (!intakeCache || Date.now() - intakeCache.at > 15_000) intakeCache = { at: Date.now(), body: JSON.stringify(await intake()) };
      return new Response(intakeCache.body, { headers: { ...headers, "cache-control": "max-age=10" } });
    }
    if (!cache || Date.now() - cache.at > 30_000) cache = { at: Date.now(), body: JSON.stringify(await build()) };
    return new Response(cache.body, { headers: { ...headers, "cache-control": "max-age=20" } });
  } catch (e) {
    console.error("parallax-money", e instanceof Error ? e.message : e);
    return new Response(JSON.stringify({ error: "money history unavailable" }), { status: 503, headers });
  }
});
