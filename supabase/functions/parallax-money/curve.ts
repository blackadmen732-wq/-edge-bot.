// Paper money over time, rebuilt from what the bot actually did. No imports: tested with node --test.
// Market making value at time t = cash so far + contracts held × the latest Kalshi mid we knew at t
// (or the settled payout once a market has settled). Sports value = start + profit of bets settled by t.

export type Fill = { ticker: string; side: "bid" | "ask"; price: number; contracts: number; fee: number; mid_at_fill: number | null; markout: number | null; filled_at: string };
export type Mid = { ticker: string; mid: number; at: string };
export type Pos = { ticker: string; position: number; cash: number; last_mid: number | null; settled: boolean; result: string | null; updated_at: string };
export type Bet = { status: string; pnl: number | null; settled_at: string | null };
export type Run = { task: string; ok: boolean | null; started_at: string };

const ms = (x: string | number | Date) => new Date(x).getTime();
const r2 = (x: number) => Math.round(x * 100) / 100;
const okMid = (m: number | null | undefined) => typeof m === "number" && Number.isFinite(m) && m >= 0 && m <= 1;

/** Value of every market-making position at each time in `times` (ms), as profit vs the starting bankroll. */
export function mmCurve(fills: Fill[], mids: Mid[], positions: Pos[], times: number[]) {
  const byTicker = new Map<string, { fills: Fill[]; marks: { at: number; mid: number }[]; pos?: Pos }>();
  const get = (t: string) => { let v = byTicker.get(t); if (!v) { v = { fills: [], marks: [] }; byTicker.set(t, v); } return v; };
  for (const f of fills) { const v = get(f.ticker); v.fills.push(f); if (okMid(f.mid_at_fill)) v.marks.push({ at: ms(f.filled_at), mid: f.mid_at_fill! }); }
  for (const m of mids) if (okMid(m.mid)) get(m.ticker).marks.push({ at: ms(m.at), mid: m.mid });
  for (const p of positions) { const v = get(p.ticker); v.pos = p; if (okMid(p.last_mid)) v.marks.push({ at: ms(p.updated_at), mid: p.last_mid! }); }
  for (const v of byTicker.values()) { v.fills.sort((a, b) => ms(a.filled_at) - ms(b.filled_at)); v.marks.sort((a, b) => a.at - b.at); }
  return times.map((t) => {
    let value = 0;
    for (const v of byTicker.values()) {
      let position = 0, cash = 0;
      for (const f of v.fills) {
        if (ms(f.filled_at) > t) break;
        if (f.side === "bid") { position += f.contracts; cash -= f.price * f.contracts + f.fee; }
        else { position -= f.contracts; cash += f.price * f.contracts - f.fee; }
      }
      if (!position && !cash) continue;
      const p = v.pos;
      if (p?.settled && (p.result === "yes" || p.result === "no") && ms(p.updated_at) <= t) { value += cash + position * (p.result === "yes" ? 1 : 0); continue; }
      let mid = 0.5;
      for (const m of v.marks) { if (m.at > t) break; mid = m.mid; }
      value += cash + position * mid;
    }
    return value;
  });
}

/** How good is it, in one line. Needs a few hundred fills and settled markets before saying anything strong. */
export function verdict(s: { fills: number; settled_markets: number; markout_cents: number | null; pnl: number }) {
  const progress = Math.min(1, Math.min(s.fills / 300, s.settled_markets / 20));
  if (s.fills < 300 || s.settled_markets < 20) {
    return { stage: "warming_up", progress, text: `Too early to tell. ${s.fills} of ~300 fills and ${s.settled_markets} of ~20 settled markets needed for a real read.` };
  }
  const mk = s.markout_cents ?? 0;
  if (mk > 0.2 && s.pnl > 0) return { stage: "promising", progress, text: "Promising: its fills keep moving its way and the paper money is up." };
  if (mk < -0.2) return { stage: "picked_off", progress, text: "Getting picked off: prices move against it right after it trades." };
  return { stage: "no_edge_yet", progress, text: "No clear edge yet: roughly breaking even." };
}

export function buildMoney(input: {
  now: number; sportsStart: number; mmStart: number; mmEnabled: boolean; mode: string;
  fills: Fill[]; mids: Mid[]; positions: Pos[]; bets: Bet[]; runs: Run[]; dayStart: number | null;
}) {
  const { now, fills, mids, positions, bets } = input;
  const startAt = Math.min(now, ...fills.map((f) => ms(f.filled_at)), ...mids.map((m) => ms(m.at)), ...bets.filter((b) => b.settled_at).map((b) => ms(b.settled_at!)));
  const step = 30 * 60 * 1000, span = now - startAt;
  const every = span / step > 1500 ? step * Math.ceil(span / step / 1500) : step;
  const times: number[] = [];
  for (let t = Math.floor(startAt / every) * every; t < now; t += every) times.push(t);
  times.push(now);
  const mm = mmCurve(fills, mids, positions, times);
  const settledBets = bets.filter((b) => b.settled_at && ["won", "lost", "void"].includes(b.status)).sort((a, b) => ms(a.settled_at!) - ms(b.settled_at!));
  const sportsAt = (t: number) => settledBets.reduce((a, b) => (ms(b.settled_at!) <= t ? a + (b.pnl ?? 0) : a), 0);
  const fillsAt = (t: number) => fills.reduce((a, f) => (ms(f.filled_at) <= t ? a + 1 : a), 0);
  const start = input.sportsStart + (input.mmEnabled ? input.mmStart : 0);
  const points = times.map((t, i) => {
    const s = sportsAt(t), m = input.mmEnabled ? mm[i] : 0;
    return { t: new Date(t).toISOString(), total: r2(start + s + m), pnl: r2(s + m), mm: r2(m), sports: r2(s), fills: fillsAt(t) };
  });
  const last = points[points.length - 1];
  const marked = fills.filter((f) => typeof f.markout === "number");
  const markedContracts = marked.reduce((a, f) => a + f.contracts, 0);
  const markoutDollars = marked.reduce((a, f) => a + f.markout! * f.contracts, 0);
  const markoutCents = markedContracts ? (markoutDollars / markedContracts) * 100 : null;
  const open = positions.filter((p) => !p.settled && p.position !== 0);
  const settledMarkets = positions.filter((p) => p.settled).length;
  const dayAgo = now - 24 * 3600 * 1000;
  const prevDay = [...points].reverse().find((p) => ms(p.t) <= dayAgo);
  const score = {
    fills: fills.length,
    contracts: fills.reduce((a, f) => a + f.contracts, 0),
    good_fills: marked.filter((f) => f.markout! > 0.0005).length,
    bad_fills: marked.filter((f) => f.markout! < -0.0005).length,
    even_fills: marked.filter((f) => Math.abs(f.markout!) <= 0.0005).length,
    markout_cents: markoutCents === null ? null : r2(markoutCents),
    markout_dollars: r2(markoutDollars),
    fees: r2(fills.reduce((a, f) => a + f.fee, 0)),
    open_markets: open.length,
    contracts_held: open.reduce((a, p) => a + Math.abs(p.position), 0),
    settled_markets: settledMarkets,
    sports_orders: bets.length,
    sports_settled: settledBets.length,
    sports_canceled: bets.filter((b) => b.status === "canceled").length,
    runs: input.runs.length,
    failed_runs: input.runs.filter((r) => r.ok === false).length,
    running_since: input.runs.length ? input.runs.reduce((a, r) => (ms(r.started_at) < ms(a) ? r.started_at : a), input.runs[0].started_at) : null,
  };
  return {
    generated_at: new Date(now).toISOString(),
    mode: input.mode,
    paper_only: true,
    start: { total: r2(start), sports: input.sportsStart, mm: input.mmEnabled ? input.mmStart : 0 },
    now: { total: last.total, pnl: last.pnl, sports: last.sports, mm: last.mm },
    change_24h: prevDay ? r2(last.total - prevDay.total) : null,
    points,
    score,
    verdict: verdict({ fills: score.fills, settled_markets: settledMarkets, markout_cents: score.markout_cents, pnl: last.pnl }),
  };
}

export type Snap = { t: string; total: number; pnl: number; mm: number; sports: number; fills: number };

/** Recorded snapshots win; the rebuilt line only fills the time before the first snapshot. */
export function mergeHistory<P extends { t: string }>(rebuilt: P[], recorded: Snap[], nowPoint: P) {
  const first = recorded.length ? ms(recorded[0].t) : Infinity;
  const before = rebuilt.filter((p) => ms(p.t) < first && ms(p.t) < ms(nowPoint.t)).map((p) => ({ ...p, rebuilt: true }));
  const rec = recorded.filter((s) => ms(s.t) < ms(nowPoint.t)).map((s) => ({ ...s, rebuilt: false }));
  return [...before, ...rec, { ...nowPoint, rebuilt: false }];
}

/** Add a snapshot if the last one is at least `gapMin` minutes old; keep at most `cap`. */
export function appendSnapshot(recorded: Snap[], point: Snap, gapMin = 25, cap = 3000) {
  const last = recorded[recorded.length - 1];
  if (last && ms(point.t) - ms(last.t) < gapMin * 60_000) return null;
  return [...recorded, point].slice(-cap);
}
