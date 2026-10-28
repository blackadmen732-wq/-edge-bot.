// Pure math: fees, fair odds, expected value, bet sizing. No network, no database.

export interface FeeInfo {
  /** Kalshi series fee type. */
  feeType: string;
  /** Kalshi series fee multiplier (1 = standard). */
  feeMultiplier: number;
}

export const DEFAULT_FEE: FeeInfo = { feeType: "quadratic_with_maker_fees", feeMultiplier: 1 };

const TAKER_RATE = 0.07;

/** Round a dollar amount up to the next cent (Kalshi rounds fees up per order). */
export function ceilCent(x: number): number {
  // Small epsilon so 0.0700000001 from float error doesn't become 0.08.
  return Math.ceil(x * 100 - 1e-6) / 100;
}

export function floorCent(x: number): number {
  return Math.floor(x * 100 + 1e-9) / 100;
}

/**
 * Kalshi trading fee for one order, in dollars.
 * Taker: 0.07 x contracts x price x (1 - price), rounded up to the cent, scaled by the series multiplier.
 * Maker: 25% of that on series with maker fees (50% on "combo" maker series), 0 otherwise.
 */
export function kalshiFee(price: number, contracts: number, role: "taker" | "maker", fee: FeeInfo = DEFAULT_FEE): number {
  if (contracts <= 0) return 0;
  const mult = Number.isFinite(fee.feeMultiplier) && fee.feeMultiplier > 0 ? Math.min(fee.feeMultiplier, 3) : 1;
  if (fee.feeType === "flat") {
    // Flat-fee series are rare for sports; charge the taker curve as a conservative stand-in.
    return ceilCent(TAKER_RATE * mult * contracts * price * (1 - price));
  }
  let roleMult = 1;
  if (role === "maker") {
    if (fee.feeType === "quadratic_with_maker_fees") roleMult = 0.25;
    else if (fee.feeType === "quadratic_with_combo_maker_fees") roleMult = 0.5;
    else roleMult = 0; // plain "quadratic": makers pay nothing
  }
  if (roleMult === 0) return 0;
  return ceilCent(TAKER_RATE * mult * roleMult * contracts * price * (1 - price));
}

/** Convert decimal odds for every outcome into no-vig probabilities (proportional method). */
export function devig(decimalOdds: Record<string, number>): Record<string, number> | null {
  const entries = Object.entries(decimalOdds).filter(([, d]) => Number.isFinite(d) && d > 1);
  if (entries.length < 2 || entries.length !== Object.keys(decimalOdds).length) return null;
  const implied = entries.map(([k, d]) => [k, 1 / d] as const);
  const total = implied.reduce((s, [, q]) => s + q, 0);
  // A real two/three-way market has total > 1 (the book's cut). Reject nonsense.
  if (total < 0.98 || total > 1.25) return null;
  const out: Record<string, number> = {};
  for (const [k, q] of implied) out[k] = q / total;
  return out;
}

/**
 * No-vig probabilities with the "power" method: find k so that the implied chances raised to k sum to 1.
 * Bookmakers put more of their cut on long shots; the proportional method leaves long shots ~1 point too
 * high (enough to fake an "edge" on cheap contracts). The power method takes more of the cut from them.
 */
export function devigPower(decimalOdds: Record<string, number>): Record<string, number> | null {
  const entries = Object.entries(decimalOdds).filter(([, d]) => Number.isFinite(d) && d > 1);
  if (entries.length < 2 || entries.length !== Object.keys(decimalOdds).length) return null;
  const implied = entries.map(([k, d]) => [k, 1 / d] as const);
  const total = implied.reduce((s, [, q]) => s + q, 0);
  if (total < 0.98 || total > 1.25) return null;
  let lo = 0.2, hi = 10;
  for (let i = 0; i < 80; i++) {
    const k = (lo + hi) / 2;
    const s = implied.reduce((a, [, q]) => a + Math.pow(q, k), 0);
    if (s > 1) lo = k; else hi = k;
  }
  const k = (lo + hi) / 2;
  const raw = implied.map(([name, q]) => [name, Math.pow(q, k)] as const);
  const sum = raw.reduce((a, [, p]) => a + p, 0);
  const out: Record<string, number> = {};
  for (const [name, p] of raw) out[name] = p / sum;
  return out;
}

/** Average several sets of no-vig probabilities that share the same outcome names. */
export function averageFair(sets: Record<string, number>[]): Record<string, number> | null {
  if (sets.length === 0) return null;
  const keys = Object.keys(sets[0]);
  for (const s of sets) {
    if (Object.keys(s).length !== keys.length || !keys.every((k) => k in s)) return null;
  }
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = sets.reduce((a, s) => a + s[k], 0) / sets.length;
  return out;
}

export function maxDisagreement(a: Record<string, number>, b: Record<string, number>): number {
  let m = 0;
  for (const k of Object.keys(a)) {
    if (!(k in b)) return 1;
    m = Math.max(m, Math.abs(a[k] - b[k]));
  }
  return m;
}

/**
 * Expected profit per $1 spent (including the fee) when buying `contracts` YES at `price`
 * and the true win chance is `p`.
 */
export function evPerDollar(p: number, price: number, contracts: number, fee: number): number {
  const spend = contracts * price + fee;
  if (spend <= 0) return -1;
  const expectedPayout = p * contracts * 1;
  return (expectedPayout - spend) / spend;
}

/**
 * Highest limit price (whole cents) where buying `contracts` as a maker still clears `minEdge`.
 * Returns null if no price >= 1 cent works.
 */
export function maxMakerPrice(p: number, contracts: number, minEdge: number, fee: FeeInfo = DEFAULT_FEE): number | null {
  for (let cents = 99; cents >= 1; cents--) {
    const price = cents / 100;
    const f = kalshiFee(price, contracts, "maker", fee);
    if (evPerDollar(p, price, contracts, f) >= minEdge) return price;
  }
  return null;
}

export interface SizingInput {
  p: number;              // fair win probability
  price: number;          // price per contract
  bankroll: number;       // equity used for sizing
  cashAvailable: number;  // cash we can actually spend now
  openExposure: number;   // dollars already riding on open bets
  kellyFraction: number;
  maxStakePct: number;
  maxStakeUsd: number;
  maxOpenExposurePct: number;
  availableSize?: number; // contracts available at this price (taker only)
}

export interface SizingResult {
  contracts: number;
  stake: number;
  reason: string;
}

/** Fractional-Kelly sizing with hard caps. Always whole contracts. */
export function sizeBet(i: SizingInput): SizingResult {
  if (!(i.price > 0 && i.price < 1)) return { contracts: 0, stake: 0, reason: "bad price" };
  const kelly = (i.p - i.price) / (1 - i.price);
  if (kelly <= 0) return { contracts: 0, stake: 0, reason: "no edge at this price" };
  const capByPct = i.bankroll * i.maxStakePct;
  const exposureRoom = i.bankroll * i.maxOpenExposurePct - i.openExposure;
  const cap = Math.min(capByPct, i.maxStakeUsd, exposureRoom, i.cashAvailable * 0.95);
  if (cap < i.price) return { contracts: 0, stake: 0, reason: `stake cap $${cap.toFixed(2)} is below one contract` };
  const target = Math.min(i.bankroll * kelly * i.kellyFraction, cap);
  let contracts = Math.floor(target / i.price + 1e-9);
  // One contract is fine if it fits under every cap: Kelly says "a little", the cap allows it.
  if (contracts < 1) contracts = 1;
  contracts = Math.min(contracts, Math.floor(cap / i.price + 1e-9));
  if (i.availableSize !== undefined) contracts = Math.min(contracts, Math.floor(i.availableSize));
  if (contracts < 1) return { contracts: 0, stake: 0, reason: "not enough contracts offered" };
  return { contracts, stake: contracts * i.price, reason: "ok" };
}

/** Parse a Kalshi fixed-point dollar string like "0.5400". Returns NaN when missing. */
export function dollars(x: unknown): number {
  if (x === null || x === undefined || x === "") return NaN;
  const n = typeof x === "number" ? x : parseFloat(String(x));
  return Number.isFinite(n) ? n : NaN;
}

/** A usable price is strictly between 0 and 1. */
export function validPrice(x: number): boolean {
  return Number.isFinite(x) && x > 0 && x < 1;
}
