// End-to-end test of the real edge function against an in-memory Postgres, with Kalshi,
// The Odds API and Resend replaced by a fake network. Run via tests/e2e/run.sh.
import { assert, assertEquals } from "jsr:@std/assert@1";

// ------------------------------------------------------------------ fake network

const HOUR = 3.6e6;
const kickoff1 = new Date(Date.now() + 2 * HOUR).toISOString();   // Penn St at Ohio St — underpriced
const kickoff2 = new Date(Date.now() + 5 * HOUR).toISOString();   // Texas at Oklahoma — fairly priced
const kickoff3 = new Date(Date.now() + 26 * HOUR).toISOString();  // Arsenal v Chelsea (3-way)

type M = Record<string, any>;
const markets: Record<string, M> = {
  "KXNCAAFGAME-T1-OSU": { ticker: "KXNCAAFGAME-T1-OSU", event_ticker: "KXNCAAFGAME-T1", yes_sub_title: "Ohio St.", status: "active", result: "", occurrence_datetime: kickoff1, yes_bid_dollars: "0.5300", yes_ask_dollars: "0.5500", yes_ask_size_fp: "500.00", last_price_dollars: "0.5400" },
  "KXNCAAFGAME-T1-PSU": { ticker: "KXNCAAFGAME-T1-PSU", event_ticker: "KXNCAAFGAME-T1", yes_sub_title: "Penn St.", status: "active", result: "", occurrence_datetime: kickoff1, yes_bid_dollars: "0.4300", yes_ask_dollars: "0.4600", yes_ask_size_fp: "500.00" },
  "KXNCAAFGAME-T2-TEX": { ticker: "KXNCAAFGAME-T2-TEX", event_ticker: "KXNCAAFGAME-T2", yes_sub_title: "Texas", status: "active", result: "", occurrence_datetime: kickoff2, yes_bid_dollars: "0.5900", yes_ask_dollars: "0.6100", yes_ask_size_fp: "500.00" },
  "KXNCAAFGAME-T2-OU": { ticker: "KXNCAAFGAME-T2-OU", event_ticker: "KXNCAAFGAME-T2", yes_sub_title: "Oklahoma", status: "active", result: "", occurrence_datetime: kickoff2, yes_bid_dollars: "0.3800", yes_ask_dollars: "0.4100", yes_ask_size_fp: "500.00" },
  "KXNCAAFGAME-T3-AAA": { ticker: "KXNCAAFGAME-T3-AAA", event_ticker: "KXNCAAFGAME-T3", yes_sub_title: "Nowhere St.", status: "active", result: "", occurrence_datetime: kickoff2, yes_bid_dollars: "0.4000", yes_ask_dollars: "0.4200" },
  "KXNCAAFGAME-T3-BBB": { ticker: "KXNCAAFGAME-T3-BBB", event_ticker: "KXNCAAFGAME-T3", yes_sub_title: "Imaginary Tech", status: "active", result: "", occurrence_datetime: kickoff2, yes_bid_dollars: "0.5600", yes_ask_dollars: "0.5900" },
  "KXEPLGAME-S1-ARS": { ticker: "KXEPLGAME-S1-ARS", event_ticker: "KXEPLGAME-S1", yes_sub_title: "Arsenal", status: "active", result: "", occurrence_datetime: kickoff3, yes_bid_dollars: "0.4800", yes_ask_dollars: "0.5000", yes_ask_size_fp: "300.00" },
  "KXEPLGAME-S1-TIE": { ticker: "KXEPLGAME-S1-TIE", event_ticker: "KXEPLGAME-S1", yes_sub_title: "Tie", status: "active", result: "", occurrence_datetime: kickoff3, yes_bid_dollars: "0.2500", yes_ask_dollars: "0.2700", yes_ask_size_fp: "300.00" },
  "KXEPLGAME-S1-CHE": { ticker: "KXEPLGAME-S1-CHE", event_ticker: "KXEPLGAME-S1", yes_sub_title: "Chelsea", status: "active", result: "", occurrence_datetime: kickoff3, yes_bid_dollars: "0.2500", yes_ask_dollars: "0.2700", yes_ask_size_fp: "300.00" },
};
const events: Record<string, any[]> = {
  KXNCAAFGAME: [
    { event_ticker: "KXNCAAFGAME-T1", series_ticker: "KXNCAAFGAME", title: "Penn St. at Ohio St.", sub_title: "", marketKeys: ["KXNCAAFGAME-T1-PSU", "KXNCAAFGAME-T1-OSU"] },
    { event_ticker: "KXNCAAFGAME-T2", series_ticker: "KXNCAAFGAME", title: "Texas at Oklahoma", sub_title: "", marketKeys: ["KXNCAAFGAME-T2-TEX", "KXNCAAFGAME-T2-OU"] },
    { event_ticker: "KXNCAAFGAME-T3", series_ticker: "KXNCAAFGAME", title: "Nowhere St. at Imaginary Tech", sub_title: "", marketKeys: ["KXNCAAFGAME-T3-AAA", "KXNCAAFGAME-T3-BBB"] },
  ],
  KXEPLGAME: [{ event_ticker: "KXEPLGAME-S1", series_ticker: "KXEPLGAME", title: "Arsenal vs Chelsea", sub_title: "", marketKeys: ["KXEPLGAME-S1-ARS", "KXEPLGAME-S1-TIE", "KXEPLGAME-S1-CHE"] }],
};
const fresh = () => new Date(Date.now() - 5 * 60000).toISOString();
const odds: Record<string, any[]> = {
  americanfootball_ncaaf: [
    // Pinnacle: Ohio St ~65% (Kalshi asks 55c -> clear edge). Texas ~60% (Kalshi 61c -> no edge).
    { id: "o1", sport_key: "americanfootball_ncaaf", commence_time: kickoff1, home_team: "Ohio State Buckeyes", away_team: "Penn State Nittany Lions",
      bookmakers: [bk("pinnacle", { "Ohio State Buckeyes": 1.50, "Penn State Nittany Lions": 2.72 }), bk("betonlineag", { "Ohio State Buckeyes": 1.49, "Penn State Nittany Lions": 2.70 })] },
    { id: "o2", sport_key: "americanfootball_ncaaf", commence_time: kickoff2, home_team: "Oklahoma Sooners", away_team: "Texas Longhorns",
      bookmakers: [bk("pinnacle", { "Oklahoma Sooners": 2.45, "Texas Longhorns": 1.61 })] },
  ],
  soccer_epl: [
    { id: "o3", sport_key: "soccer_epl", commence_time: kickoff3, home_team: "Arsenal", away_team: "Chelsea",
      bookmakers: [bk("pinnacle", { Arsenal: 2.0, Draw: 3.6, Chelsea: 3.9 })] },
  ],
  americanfootball_nfl: [],
};
function bk(key: string, prices: Record<string, number>) {
  return { key, title: key, markets: [{ key: "h2h", last_update: fresh(), outcomes: Object.entries(prices).map(([name, price]) => ({ name, price })) }] };
}

let oddsCalls = 0;
const emails: any[] = [];
const aiCalls: any[] = [];
let aiFail = false;
const liveOrders: Record<string, any> = {};
let liveBalance = 20;
let lastSignatureHeaders: Record<string, string> | null = null;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  const ok = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  if (url.hostname === "external-api.kalshi.com") {
    const p = url.pathname.replace("/trade-api/v2", "");
    if (p === "/events") {
      const list = (events[url.searchParams.get("series_ticker") ?? ""] ?? []).map((e) => ({ ...e, markets: e.marketKeys.map((k: string) => markets[k]) }));
      return ok({ events: list, cursor: "" });
    }
    if (p.startsWith("/series/")) return ok({ series: { ticker: p.split("/")[2], fee_type: "quadratic_with_maker_fees", fee_multiplier: 1 } });
    if (p === "/series") return ok({ series: [{ ticker: "KXNCAAFGAME", title: "College football game" }, { ticker: "KXNFLGAME", title: "NFL game" }] });
    if (p.startsWith("/markets/")) return ok({ market: markets[decodeURIComponent(p.split("/")[2])] });
    // Authenticated endpoints: require signature headers.
    const h = new Headers(init?.headers);
    if (!h.get("KALSHI-ACCESS-SIGNATURE") || !h.get("KALSHI-ACCESS-KEY") || !h.get("KALSHI-ACCESS-TIMESTAMP")) return ok({ error: "unauthorized" }, 401);
    lastSignatureHeaders = { sig: h.get("KALSHI-ACCESS-SIGNATURE")!, ts: h.get("KALSHI-ACCESS-TIMESTAMP")!, method, path: url.pathname };
    if (p === "/portfolio/balance") return ok({ balance: Math.round(liveBalance * 100), balance_dollars: liveBalance.toFixed(4) });
    if (p === "/portfolio/events/orders" && method === "POST") {
      const body = JSON.parse(String(init?.body));
      const id = `ord-${Object.keys(liveOrders).length + 1}`;
      const price = parseFloat(body.price), count = parseFloat(body.count);
      const ask = parseFloat(markets[body.ticker].yes_ask_dollars);
      const fills = price >= ask;
      liveOrders[id] = { body, fills };
      if (fills) liveBalance -= count * ask + 0.02;
      return ok({ order_id: id, client_order_id: body.client_order_id, fill_count: fills ? body.count : "0.00", remaining_count: fills ? "0.00" : body.count, ts_ms: Date.now() }, 201);
    }
    if (p.startsWith("/portfolio/orders/")) {
      const id = p.split("/")[3];
      const o = liveOrders[id];
      const ask = parseFloat(markets[o.body.ticker].yes_ask_dollars);
      const count = parseFloat(o.body.count);
      return ok({ order: { order_id: id, client_order_id: o.body.client_order_id, ticker: o.body.ticker, outcome_side: "yes", book_side: "bid", type: "limit",
        status: o.fills ? "executed" : "resting", fill_count_fp: o.fills ? o.body.count : "0.00", remaining_count_fp: o.fills ? "0.00" : o.body.count,
        initial_count_fp: o.body.count, taker_fees_dollars: o.fills ? "0.0200" : "0.0000", maker_fees_dollars: "0.0000",
        taker_fill_cost_dollars: o.fills ? (count * ask).toFixed(4) : "0.0000", maker_fill_cost_dollars: "0.0000", yes_price_dollars: o.body.price, no_price_dollars: "0" } });
    }
    if (p.startsWith("/portfolio/events/orders/") && method === "DELETE") return ok({ order_id: p.split("/")[4], reduced_by: "1.00", ts_ms: Date.now() });
    return ok({ error: `unmocked kalshi ${method} ${p}` }, 404);
  }
  if (url.hostname === "api.the-odds-api.com") {
    oddsCalls++;
    assert(url.searchParams.get("apiKey") === "test-key");
    assert((url.searchParams.get("bookmakers") ?? "").split(",").length <= 10, "max 10 books = 1 credit");
    const sport = url.pathname.split("/")[3];
    return ok(odds[sport] ?? [], 200, { "x-requests-remaining": String(500 - oddsCalls), "x-requests-used": String(oddsCalls), "x-requests-last": "1" });
  }
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)));
    return ok({ id: "email-1" });
  }
  if (url.hostname === "api.anthropic.com") {
    aiCalls.push(JSON.parse(String(init?.body)));
    if (aiFail) return new Response("overloaded", { status: 529 });
    return ok({ content: [{ type: "text", text: "This is a simulation summary <b>with tags</b>.\nSecond paragraph." }] });
  }
  return realFetch(input as any, init);
}) as typeof fetch;

// Capture the edge function's request handler instead of opening a port.
let handler: (req: Request) => Promise<Response>;
Object.defineProperty(Deno, "serve", { value: (h: any) => { handler = h; return { finished: Promise.resolve(), shutdown() {} }; }, configurable: true, writable: true });
const mod = await import("../../supabase/functions/edgebot/index.ts");
// Share the function's own connection (the in-memory test database accepts one connection).
const db = mod.sql;

async function call(task: string, opts: { cron?: boolean; token?: boolean; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cron) headers["x-edgebot-cron"] = (await db`select secret from vault.secrets where name = 'edgebot_cron_secret'`)[0].secret;
  if (opts.token) headers["x-edgebot-token"] = (await db`select secret from vault.secrets where name = 'edgebot_control_token'`)[0].secret;
  const res = await handler(new Request(`http://local/edgebot?task=${task}`, { method: opts.body ? "POST" : (opts.cron || opts.token) ? "POST" : "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined }));
  return { status: res.status, body: await res.json() };
}

const opts = { sanitizeOps: false, sanitizeResources: false };

// ------------------------------------------------------------------ tests (run in order)

Deno.test({ name: "auth: scan needs the cron secret", ...opts, fn: async () => {
  const r = await call("scan");
  assertEquals(r.status, 401);
} });

Deno.test({ name: "scan without odds key does nothing", ...opts, fn: async () => {
  await db`update edgebot.settings set leagues = array['ncaaf','nfl','epl']`;
  Deno.env.delete("ODDS_API_KEY");
  const r = await call("scan", { cron: true });
  assertEquals(r.status, 200);
  assert(String(r.body.result.note).includes("ODDS_API_KEY"));
  Deno.env.set("ODDS_API_KEY", "test-key");
} });

Deno.test({ name: "scan finds the mispriced game, skips the fair one, logs the unmatched one", ...opts, fn: async () => {
  const r = await call("scan", { cron: true });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const bets = await db`select * from edgebot.bets order by id`;
  const osu = bets.find((b) => b.ticker === "KXNCAAFGAME-T1-OSU");
  assert(osu, `expected an Ohio St bet; got ${JSON.stringify(bets.map((b) => [b.ticker, b.status]))} / ${JSON.stringify(r.body.result)}`);
  assertEquals(osu.status, "filled");
  assertEquals(osu.mode, "paper");
  assertEquals(Number(osu.fill_price), 0.55);
  assert(Number(osu.cost) + Number(osu.fee) <= 1.0001, "stake within 5% of $20");
  assert(Number(osu.edge) >= 0.03);
  assert(!bets.some((b) => b.event_ticker === "KXNCAAFGAME-T2" && b.status === "filled"), "fair game must not be taken");
  const unmatched = await db`select * from edgebot.signals where decision = 'unmatched'`;
  assert(unmatched.some((s) => s.ticker === "KXNCAAFGAME-T3"));
  // NFL had no Kalshi games -> no odds call for it. NCAAF + EPL = 2 calls.
  assertEquals(oddsCalls, 2);
  const credits = await db`select value from edgebot.state where key = 'odds_credits'`;
  assertEquals(credits[0].value.remaining, 498);
} });

Deno.test({ name: "second scan never doubles up on a game", ...opts, fn: async () => {
  await call("scan", { cron: true });
  const c = await db`select count(*)::int as c from edgebot.bets where event_ticker = 'KXNCAAFGAME-T1' and status in ('filled','resting')`;
  assertEquals(c[0].c, 1);
} });

Deno.test({ name: "waiting (paper) orders fill only when the price trades through", ...opts, fn: async () => {
  const resting = await db`select * from edgebot.bets where status = 'resting'`;
  for (const b of resting) {
    markets[b.ticker].yes_ask_dollars = String(Number(b.limit_price)); // touch, not through
  }
  await call("tick", { cron: true });
  for (const b of resting) {
    const [x] = await db`select status from edgebot.bets where id = ${b.id}`;
    assertEquals(x.status, "resting", "touching our price is not a fill");
    markets[b.ticker].yes_ask_dollars = (Number(b.limit_price) - 0.02).toFixed(4);
  }
  await call("tick", { cron: true });
  for (const b of resting) {
    const [x] = await db`select status, fill_price, fee from edgebot.bets where id = ${b.id}`;
    assertEquals(x.status, "filled");
    assertEquals(Number(x.fill_price), Number(b.limit_price));
  }
} });

Deno.test({ name: "closing price + settlement + P&L", ...opts, fn: async () => {
  // Kickoff in 20 minutes: tick records the closing price.
  await db`update edgebot.bets set commence_time = now() + interval '20 minutes' where ticker = 'KXNCAAFGAME-T1-OSU'`;
  markets["KXNCAAFGAME-T1-OSU"].yes_bid_dollars = "0.6000";
  markets["KXNCAAFGAME-T1-OSU"].yes_ask_dollars = "0.6200";
  await call("tick", { cron: true });
  let [b] = await db`select * from edgebot.bets where ticker = 'KXNCAAFGAME-T1-OSU'`;
  assertEquals(Number(b.closing_price), 0.61);
  assert(Math.abs(Number(b.clv) - 0.06) < 1e-9, "beat the close by 6c");
  // Game over, Ohio St won.
  await db`update edgebot.bets set commence_time = now() - interval '4 hours' where ticker = 'KXNCAAFGAME-T1-OSU'`;
  markets["KXNCAAFGAME-T1-OSU"].status = "finalized";
  markets["KXNCAAFGAME-T1-OSU"].result = "yes";
  await call("tick", { cron: true });
  [b] = await db`select * from edgebot.bets where ticker = 'KXNCAAFGAME-T1-OSU'`;
  assertEquals(b.status, "won");
  assertEquals(Number(b.payout), Number(b.contracts));
  assert(Math.abs(Number(b.pnl) - (Number(b.contracts) - Number(b.cost) - Number(b.fee))) < 1e-9);
} });

Deno.test({ name: "dashboard is public, read-only and consistent", ...opts, fn: async () => {
  const r = await call("dashboard");
  assertEquals(r.status, 200);
  const d = r.body;
  assertEquals(d.mode, "paper");
  assertEquals(d.paper.won, 1);
  assert(d.paper.pnl > 0);
  assert(Math.abs(d.paper.equity - (20 + d.paper.pnl)) < 1e-6 || d.paper.open_bets + d.paper.waiting > 0);
  assertEquals(d.gate.passes_paper_part, false);
  assert(!JSON.stringify(d).includes("client_order_id"), "no order ids leaked");
} });

Deno.test({ name: "control needs the token; pause stops scanning", ...opts, fn: async () => {
  assertEquals((await call("control", { body: { action: "pause" } })).status, 401);
  const p = await call("control", { token: true, body: { action: "pause" } });
  assertEquals(p.body.mode, "paused");
  const s = await call("scan", { cron: true });
  assert(String(s.body.result.note).startsWith("paused"));
  await call("control", { token: true, body: { action: "resume_paper" } });
} });

Deno.test({ name: "go_live is refused until the gate passes", ...opts, fn: async () => {
  const r = await call("control", { token: true, body: { action: "go_live" } });
  assertEquals(r.body.ok, false);
  const reasons = r.body.reasons.join(" ");
  assert(reasons.includes("settled paper bets"));
  assert(reasons.includes("LIVE_TRADING_ENABLED"));
  assert(reasons.includes("Kalshi API key"));
  assertEquals((await call("dashboard")).body.mode, "paper");
} });

Deno.test({ name: "live mode: signed order, exact fills read back, paper keeps running", ...opts, fn: async () => {
  // Fake a passing paper record (50 profitable settled bets).
  for (let i = 0; i < 50; i++) {
    await db`insert into edgebot.bets (mode, status, ticker, event_ticker, label, contracts, cost, fee, fill_price, payout, pnl, settled_at)
             values ('paper', 'won', ${"FAKE-" + i}, ${"FAKE-E" + i}, 'fake', 1, 0.5, 0.02, 0.5, 1, 0.48, now())`;
  }
  // Test key (PKCS#1, like Kalshi issues).
  const keyFile = await Deno.makeTempFile();
  await new Deno.Command("openssl", { args: ["genrsa", "-traditional", "-out", keyFile, "2048"], stderr: "null" }).output();
  Deno.env.set("KALSHI_API_KEY_ID", "test-key-id");
  Deno.env.set("KALSHI_PRIVATE_KEY", await Deno.readTextFile(keyFile));
  Deno.env.set("LIVE_TRADING_ENABLED", "true");
  const g = await call("control", { token: true, body: { action: "go_live" } });
  assertEquals(g.body.ok, true, JSON.stringify(g.body));
  assertEquals(g.body.mode, "live");

  // A fresh mispriced game appears.
  markets["KXNCAAFGAME-T2-TEX"].yes_ask_dollars = "0.5000";
  markets["KXNCAAFGAME-T2-TEX"].yes_bid_dollars = "0.4800";
  await db`update edgebot.bets set status = 'canceled' where event_ticker = 'KXNCAAFGAME-T2' and status = 'resting'`;
  const r = await call("scan", { cron: true });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const liveBets = await db`select * from edgebot.bets where mode = 'live' order by id`;
  const lb = liveBets.find((b) => b.ticker === "KXNCAAFGAME-T2-TEX");
  assert(lb, JSON.stringify(r.body.result));
  assertEquals(lb.status, "filled", "fill read back from Kalshi");
  assertEquals(Number(lb.fee), 0.02, "exact fee from Kalshi");
  assert(Number(lb.cost) <= 1.0001, "5% of $20 cap on real money");
  // Other live bets: filled at a good ask, or waiting below the ask (never chasing).
  for (const other of liveBets.filter((b) => b.id !== lb.id)) {
    assert(["filled", "resting"].includes(other.status));
    if (other.status === "resting") assert(Number(other.limit_price) < parseFloat(markets[other.ticker].yes_ask_dollars));
    if (other.status === "filled") assert(Number(other.edge) >= 0.03);
  }
  assertEquals(new Set(liveBets.map((b) => b.event_ticker)).size, liveBets.length, "one position per game");
  const total = liveBets.reduce((s, b) => s + Number(b.limit_price) * Number(b.contracts), 0);
  assert(total <= 20 * 0.3 + 1e-9, "open exposure cap");
  const order = Object.values(liveOrders).find((o: any) => o.body.ticker === "KXNCAAFGAME-T2-TEX")!;
  assertEquals(order.body.side, "bid");
  assertEquals(order.body.time_in_force, "good_till_canceled");
  assert(order.body.expiration_time > Date.now() / 1000, "orders expire");
  assert(lastSignatureHeaders && lastSignatureHeaders.sig.length > 100, "requests are signed");
  // Paper shadow bet on the same game exists too.
  const shadow = await db`select * from edgebot.bets where mode = 'paper' and event_ticker = 'KXNCAAFGAME-T2' and status in ('filled','resting')`;
  assertEquals(shadow.length, 1);
} });

Deno.test({ name: "kill switch: real-money balance at the stop level pauses everything and emails", ...opts, fn: async () => {
  Deno.env.set("RESEND_API_KEY", "re_test");
  Deno.env.set("REPORT_EMAIL", "me@example.com");
  liveBalance = 3;
  await db`update edgebot.bets set status = 'lost', pnl = -cost - fee, payout = 0, settled_at = now() where mode = 'live'`;
  await call("tick", { cron: true });
  const d = (await call("dashboard")).body;
  assertEquals(d.mode, "paused");
  assert(String(d.paused_reason).includes("real-money balance"));
  assert(emails.some((e) => String(e.subject).includes("paused")));
  // While paused, scans place nothing.
  const before = (await db`select count(*)::int as c from edgebot.bets`)[0].c;
  await call("scan", { cron: true });
  assertEquals((await db`select count(*)::int as c from edgebot.bets`)[0].c, before);
} });

Deno.test({ name: "paper kill switch + weekly report email", ...opts, fn: async () => {
  await db`update edgebot.settings set mode = 'paper', paused_reason = null`;
  await db`update edgebot.bets set status = 'lost', payout = 0, pnl = -cost - fee where mode = 'paper' and ticker like 'FAKE-%'`;
  await db`insert into edgebot.bets (mode, status, ticker, event_ticker, contracts, cost, fee, fill_price, payout, pnl, settled_at)
           values ('paper', 'lost', 'BIGLOSS', 'BIGLOSS-E', 10, 9, 0.1, 0.9, 0, -9.1, now())`;
  await call("tick", { cron: true });
  assertEquals((await call("dashboard")).body.mode, "paused");
  const r = await call("report", { cron: true });
  assertEquals(r.body.result.email, "sent");
  assert(String(r.body.result.ai).startsWith("off"), "AI is off without a key");
  assert(emails.some((e) => String(e.subject).startsWith("Edge Bot:")));
} });

Deno.test({ name: "AI summary: added to the weekly email when a key is set, escaped, and skipped if the AI fails", ...opts, fn: async () => {
  Deno.env.set("ANTHROPIC_API_KEY", "sk-test");
  const before = emails.length;
  const r = await call("report", { cron: true });
  assertEquals(r.body.result.ai, "ok (anthropic claude-haiku-5-5)");
  const sent = emails[emails.length - 1];
  assert(emails.length === before + 1);
  assert(String(sent.html).includes("This is a simulation summary &lt;b&gt;with tags&lt;/b&gt;."), "AI text is escaped");
  assert(String(sent.html).includes("Second paragraph."));
  const req = aiCalls[aiCalls.length - 1];
  assertEquals(req.model, "claude-haiku-5-5");
  const facts = JSON.parse(String(req.messages[0].content).split("\n\n").slice(1).join("\n\n"));
  assert("paper_simulation" in facts && "real_money" in facts, "paper and real money kept separate");
  aiFail = true;
  const r2 = await call("report", { cron: true });
  assertEquals(r2.body.result.email, "sent", "report still goes out");
  assert(String(r2.body.result.ai).startsWith("failed"));
  assert(!String(emails[emails.length - 1].html).includes("Written by AI"));
  aiFail = false;
  Deno.env.delete("ANTHROPIC_API_KEY");
} });

Deno.test({ name: "no ceiling: passing $1,000 sends one milestone email and keeps going", ...opts, fn: async () => {
  await db`update edgebot.settings set mode = 'paper', paused_reason = null`;
  await db`insert into edgebot.bets (mode, status, ticker, event_ticker, contracts, cost, fee, fill_price, payout, pnl, settled_at)
           values ('paper', 'won', 'BIGWIN', 'BIGWIN-E', 2000, 500, 0, 0.25, 2000, 1500, now())`;
  const before = emails.length;
  await call("tick", { cron: true });
  const passed = () => emails.slice(before).filter((e) => String(e.subject).includes("passed $1,000"));
  assertEquals(passed().length, 1, JSON.stringify(emails.slice(before).map((e) => e.subject)));
  assertEquals((await call("dashboard")).body.mode, "paper", "no ceiling: still running");
  await call("tick", { cron: true });
  assertEquals(passed().length, 1, "only one email per level");
} });

Deno.test({ name: "discover lists series (token only)", ...opts, fn: async () => {
  assertEquals((await call("discover")).status, 401);
  const r = await call("discover", { token: true });
  assert(r.body.series.some((s: any) => s.ticker === "KXNCAAFGAME"));
  await db.end();
} });
