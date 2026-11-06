// Kalshi Liquidity Incentive Program (LIP) math. Pure functions: no network, no database.
// Rules (help.kalshi.com, Nov 2026): once a second Kalshi snapshots the book. On each side (YES bids, NO bids)
// the Reference Price is the first level, walking down from the best bid, where cumulative size reaches
// Target/5. Each order scores size x DiscountFactor^(ticks below reference). Your snapshot score is your
// share of the YES side + your share of the NO side (max 2.0 in total). A snapshot only counts if BOTH sides
// have at least Target Size resting. Reward = your share of all scores x period reward x valid-snapshot share.
// So: an empty or thin side in a rewarded market is money nobody is collecting.

export interface Level { price: number; size: number }
export interface Book { yes: Level[]; no: Level[] } // resting BIDS on each side, in dollars

export interface Program { ticker: string; reward: number; start: string; end: string; target: number; discount: number }

/** Kalshi orderbook JSON -> bids per side. */
export function parseBook(j: any): Book {
  const ob = j?.orderbook_fp ?? j?.orderbook ?? {};
  const side = (rows: unknown) =>
    (Array.isArray(rows) ? rows : [])
      .map((r: any) => ({ price: Number(r[0]), size: Number(r[1]) }))
      .filter((l) => l.price > 0 && l.price < 1 && l.size > 0);
  return { yes: side(ob.yes_dollars ?? ob.yes), no: side(ob.no_dollars ?? ob.no) };
}

/** Kalshi incentive_programs row -> Program (period_reward is in hundredths of a cent). */
export function parseProgram(x: any): Program | null {
  if (x?.incentive_type !== "liquidity" || !x?.market_ticker) return null;
  const reward = Number(x.period_reward) / 10000;
  const target = Number(x.target_size_fp ?? x.target_size);
  const discount = Number(x.discount_factor_bps) / 10000;
  if (!(reward > 0) || !(target > 0) || !(discount >= 0 && discount <= 1)) return null;
  return { ticker: x.market_ticker, reward, start: x.start_date, end: x.end_date, target, discount };
}

export function rewardPerDay(p: Program): number {
  const days = Math.max((Date.parse(p.end) - Date.parse(p.start)) / 86_400_000, 1 / 24);
  return p.reward / days;
}

/** One side of the book: total depth, best bid, reference price and everyone's raw score. */
export function sideScore(bids: Level[], target: number, discount: number) {
  const sorted = [...bids].sort((a, b) => b.price - a.price);
  const depth = sorted.reduce((a, l) => a + l.size, 0);
  let cum = 0, reference = sorted.length ? sorted[sorted.length - 1].price : NaN;
  for (const l of sorted) { cum += l.size; if (cum >= target / 5) { reference = l.price; break; } }
  const score = sorted.reduce((a, l) => a + l.size * Math.pow(discount, Math.max(0, Math.round((reference - l.price) * 100))), 0);
  return { depth, best: sorted.length ? sorted[0].price : NaN, reference, score };
}

export interface Plan {
  ticker: string; rewardDay: number; sides: ("yes" | "no")[]; q: number;
  yesPrice: number | null; noPrice: number | null;
  collateral: number; shareYes: number; shareNo: number;
  validNow: boolean; validWithUs: boolean; estDaily: number; roiDaily: number;
}

/**
 * Best way to join this program with `q` contracts per side we post on: YES only, NO only, or both.
 * We join each side AT its best bid (or 1c if the side is empty), which always scores the full multiplier.
 * Only sides priced at or below `maxPrice` are considered (cheap to hold, small loss if filled).
 */
export function bestPlan(p: Program, book: Book, opts: { q?: number; maxPrice?: number } = {}): Plan | null {
  const q = opts.q ?? p.target, maxPrice = opts.maxPrice ?? 0.5;
  const Y = sideScore(book.yes, p.target, p.discount), N = sideScore(book.no, p.target, p.discount);
  // Where we can REST a bid without trading instantly: a YES bid at p matches any NO bid at 1 - p or more,
  // so p must stay below 1 - bestNo. Join the best bid when the side has one; if the side is empty, take the
  // highest price that doesn't cross (an empty side is usually empty because there is no such price).
  const room = (best: number, otherBest: number) => {
    const cap = Number.isFinite(otherBest) ? Math.round((1 - otherBest - 0.01) * 100) / 100 : 0.99;
    const price = Number.isFinite(best) ? Math.min(best, cap) : cap;
    return price >= 0.01 ? price : NaN;
  };
  const yPrice = room(Y.best, N.best), nPrice = room(N.best, Y.best);
  const crossOk = yPrice + nPrice < 1;
  const rd = rewardPerDay(p);
  const validNow = Y.depth >= p.target && N.depth >= p.target;
  const options: ("yes" | "no")[][] = [["yes"], ["no"], ["yes", "no"]];
  let best: Plan | null = null;
  for (const sides of options) {
    const onY = sides.includes("yes"), onN = sides.includes("no");
    if ((onY && !(yPrice <= maxPrice)) || (onN && !(nPrice <= maxPrice)) || (onY && onN && !crossOk)) continue;
    const validWithUs = Y.depth + (onY ? q : 0) >= p.target && N.depth + (onN ? q : 0) >= p.target;
    const shareYes = onY ? q / (Y.score + q) : 0, shareNo = onN ? q / (N.score + q) : 0;
    const estDaily = validWithUs ? rd * (shareYes + shareNo) / 2 : 0;
    const collateral = (onY ? q * yPrice : 0) + (onN ? q * nPrice : 0);
    const plan: Plan = {
      ticker: p.ticker, rewardDay: r2(rd), sides, q, yesPrice: onY ? yPrice : null, noPrice: onN ? nPrice : null,
      collateral: r2(collateral), shareYes: r4(shareYes), shareNo: r4(shareNo), validNow, validWithUs,
      estDaily: r2(estDaily), roiDaily: collateral > 0 ? r4(estDaily / collateral) : 0,
    };
    if (!best || plan.roiDaily > best.roiDaily) best = plan;
  }
  return best && best.estDaily > 0 ? best : null;
}

/** Did a trade at YES price `yesPrice` reach our resting bid? (YES bid fills on trades at or below it; NO bid at or above 1 - price.) */
export function fills(side: "yes" | "no", ourPrice: number, yesPrice: number): boolean {
  return side === "yes" ? yesPrice <= ourPrice + 1e-9 : yesPrice >= 1 - ourPrice - 1e-9;
}

/** Mark a filled bid to the current mid: what we paid vs what it's worth now. */
export function fillPnl(side: "yes" | "no", q: number, ourPrice: number, yesMid: number): number {
  const worth = side === "yes" ? yesMid : 1 - yesMid;
  return r2(q * (worth - ourPrice));
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10000) / 10000;
