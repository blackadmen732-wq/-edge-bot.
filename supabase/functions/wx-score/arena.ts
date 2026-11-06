// Survival Arena (weather, v1). Pure functions: no network, no database.
// A population of strategy "recipes" competes on settled Kalshi weather markets. Each night:
// score every recipe on days it was not built on, kill the worst, copy-and-mutate the best, add a few
// random newcomers. A recipe is only PROVEN if it also wins on the newest days (the vault), which no
// selection step ever looks at, and clears a bar raised for how many recipes were tried (no lucky winners).
import { bracketProb } from "../edgebot/lib/mm.ts";
import { takerFee, type CalRow } from "./score.ts";

export const CITIES = ["KXHIGHNY", "KXHIGHCHI", "KXHIGHMIA", "KXHIGHAUS", "KXHIGHLAX", "KXHIGHDEN"] as const;

export interface Genome {
  minEdge: number;      // learned chance must beat the price by this much (after spread)
  priceLo: number;      // only trade markets priced inside [priceLo, priceHi]
  priceHi: number;
  side: "yes" | "no" | "both";
  cities: string[];     // which cities it trades
  useBias: boolean;     // correct the forecast with each city's learned bias
  sigmaMult: number;    // widen / narrow the learned spread
}

export interface Recipe { id: string; genome: Genome; generation: number; parent: string | null; status: "alive" | "dead" | "proven" }
export interface Score { trades: number; mean: number; z: number; total: number }

/** Small seeded RNG so a night's evolution can be replayed exactly. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function randomGenome(r: () => number): Genome {
  const lo = r3(0.03 + r() * 0.6);
  const cities = CITIES.filter(() => r() < 0.6);
  return {
    minEdge: r3(0.03 + r() * 0.2),
    priceLo: lo,
    priceHi: r3(clamp(lo + 0.1 + r() * 0.6, lo + 0.05, 0.97)),
    side: (["yes", "no", "both"] as const)[Math.floor(r() * 3)],
    cities: cities.length ? cities : [CITIES[Math.floor(r() * CITIES.length)]],
    useBias: r() < 0.7,
    sigmaMult: r3(0.7 + r() * 0.8),
  };
}

/** Copy with one or two small changes. */
export function mutate(g: Genome, r: () => number): Genome {
  const c: Genome = { ...g, cities: [...g.cities] };
  const n = 1 + (r() < 0.4 ? 1 : 0);
  for (let i = 0; i < n; i++) {
    switch (Math.floor(r() * 6)) {
      case 0: c.minEdge = r3(clamp(c.minEdge + (r() - 0.5) * 0.06, 0.02, 0.3)); break;
      case 1: c.priceLo = r3(clamp(c.priceLo + (r() - 0.5) * 0.1, 0.02, c.priceHi - 0.05)); break;
      case 2: c.priceHi = r3(clamp(c.priceHi + (r() - 0.5) * 0.1, c.priceLo + 0.05, 0.98)); break;
      case 3: c.side = (["yes", "no", "both"] as const)[Math.floor(r() * 3)]; break;
      case 4: {
        const city = CITIES[Math.floor(r() * CITIES.length)];
        c.cities = c.cities.includes(city) ? (c.cities.length > 1 ? c.cities.filter((x) => x !== city) : c.cities) : [...c.cities, city];
        break;
      }
      default: c.useBias = r() < 0.5 ? !c.useBias : c.useBias; c.sigmaMult = r3(clamp(c.sigmaMult + (r() - 0.5) * 0.2, 0.5, 2));
    }
  }
  return c;
}

export interface CityModel { bias: number; sigma: number }

/** Per-city forecast bias and spread, from rows with a known actual high (one error per city-day). */
export function fitCities(rows: CalRow[]): Map<string, CityModel> {
  const errs = new Map<string, Map<string, number>>();
  for (const r of rows) if (r.actual !== null && Number.isFinite(r.fcMean)) (errs.get(r.series) ?? errs.set(r.series, new Map()).get(r.series)!).set(r.date, r.actual - r.fcMean);
  const out = new Map<string, CityModel>();
  for (const [s, m] of errs) {
    const e = [...m.values()];
    if (e.length < 10) continue;
    const bias = e.reduce((a, b) => a + b, 0) / e.length;
    out.set(s, { bias, sigma: Math.max(Math.sqrt(e.reduce((a, b) => a + (b - bias) ** 2, 0) / (e.length - 1)), 1) });
  }
  return out;
}

/** What a recipe would have made per $1 contract on these rows: buy at market + halfSpread, pay Kalshi's taker fee. */
export function evaluate(g: Genome, rows: CalRow[], models: Map<string, CityModel>, halfSpread = 0.01): Score {
  const pnl: number[] = [];
  for (const r of rows) {
    if (!g.cities.includes(r.series) || r.market < g.priceLo || r.market > g.priceHi || !Number.isFinite(r.fcMean)) continue;
    const m = models.get(r.series);
    if (!m) continue;
    const p = bracketProb({ min: r.bmin, max: r.bmax }, r.fcMean + (g.useBias ? m.bias : 0), m.sigma * g.sigmaMult);
    const ask = r.market + halfSpread, bid = r.market - halfSpread;
    if (g.side !== "no" && ask < 0.99 && p - ask >= g.minEdge) pnl.push(r.y - ask - takerFee(ask));
    else if (g.side !== "yes" && bid > 0.01 && bid - p >= g.minEdge) pnl.push((1 - r.y) - (1 - bid) - takerFee(1 - bid));
  }
  const n = pnl.length;
  const mean = n ? pnl.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(pnl.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
  return { trades: n, mean: r3(mean), z: n > 1 && sd > 0 ? r3(mean / (sd / Math.sqrt(n))) : 0, total: r3(pnl.reduce((a, b) => a + b, 0)) };
}

/** z a winner must clear when `tried` recipes competed (one-sided 5%, Bonferroni). */
export function requiredZ(tried: number): number {
  const p = 0.05 / Math.max(tried, 1);
  // Acklam-style tail approximation of the inverse normal, fine for p < 0.05
  const t = Math.sqrt(-2 * Math.log(p));
  return r3(t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t));
}

/** Split days: fit (oldest 40%) -> select (next 40%) -> vault (newest 20%, never used to pick survivors). */
export function splitDays(rows: CalRow[]) {
  const days = [...new Set(rows.map((r) => r.date))].sort();
  const a = days[Math.floor(days.length * 0.4)], b = days[Math.floor(days.length * 0.8)];
  return { fit: rows.filter((r) => r.date < a), select: rows.filter((r) => r.date >= a && r.date < b), vault: rows.filter((r) => r.date >= b), days: days.length, selectFrom: a, vaultFrom: b };
}

export interface NightResult {
  population: Recipe[];
  scores: Record<string, { select: Score; vault?: Score }>;
  killed: string[];
  born: string[];
  proven: string[];
  requiredZ: number;
}

/**
 * One night of evolution. Survival is judged on the select days only; the vault is checked just for
 * promotion. Population stays at `size`: kill the worst 30%, refill with mutated copies of the best 20%
 * and 10% random newcomers.
 */
export function night(pop: Recipe[], rows: CalRow[], opts: { size?: number; seed: number; generation: number; tried: number; newId: () => string }): NightResult {
  const size = opts.size ?? 120;
  const r = rng(opts.seed);
  const { fit, select, vault } = splitDays(rows);
  const models = fitCities(fit);
  let alive = pop.filter((p) => p.status !== "dead");
  while (alive.length < size) alive.push({ id: opts.newId(), genome: randomGenome(r), generation: opts.generation, parent: null, status: "alive" });

  const scores: NightResult["scores"] = {};
  for (const p of alive) scores[p.id] = { select: evaluate(p.genome, select, models) };
  // fitness: confidence the recipe makes money (z), small samples pulled toward zero
  const fitness = (id: string) => { const s = scores[id].select; return s.trades < 20 ? -10 + s.trades / 10 : s.z; };
  alive.sort((x, y) => fitness(y.id) - fitness(x.id));

  const tried = opts.tried + alive.length;
  const zReq = requiredZ(tried);
  const proven: string[] = [];
  for (const p of alive) {
    const s = scores[p.id].select;
    if (s.trades >= 50 && s.z >= zReq) {
      const v = evaluate(p.genome, vault, models);
      scores[p.id].vault = v;
      if (v.trades >= 30 && v.mean > 0 && v.z >= 2) { p.status = "proven"; proven.push(p.id); }
    }
  }

  const nKill = Math.floor(alive.length * 0.3);
  const killed = alive.slice(alive.length - nKill).filter((p) => p.status !== "proven").map((p) => p.id);
  const survivors = alive.filter((p) => !killed.includes(p.id));
  const elite = survivors.slice(0, Math.max(1, Math.floor(size * 0.2)));
  const born: Recipe[] = [];
  const nImmigrants = Math.floor(size * 0.1);
  while (survivors.length + born.length < size - nImmigrants) {
    const parent = elite[Math.floor(r() * elite.length)];
    born.push({ id: opts.newId(), genome: mutate(parent.genome, r), generation: opts.generation, parent: parent.id, status: "alive" });
  }
  while (survivors.length + born.length < size) born.push({ id: opts.newId(), genome: randomGenome(r), generation: opts.generation, parent: null, status: "alive" });

  const dead = alive.filter((p) => killed.includes(p.id)).map((p) => ({ ...p, status: "dead" as const }));
  return { population: [...survivors, ...born, ...dead], scores, killed, born: born.map((b) => b.id), proven, requiredZ: zReq };
}
