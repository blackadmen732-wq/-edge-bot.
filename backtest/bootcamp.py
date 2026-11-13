# Bootcamp (research only, no orders). Owner-approved design, Nov 13 2026: docs/strategy-pipeline.md stage 1.
#
#   Training years are cut into 8 levels, oldest first. A bot must pass every level, each on time it has never
#   traded, with a bar that rises per level. Fail one level: deleted. Judged on many trades per level, never one.
#   The crowd bar: a graduate must also clear a z that rises with every bot that ever tried (luck filter).
#   Copy only bots that reached the highest levels; a copy that does worse than its parent dies, parent stays.
#   Graveyard: rule pieces that keep appearing in dead bots and never in survivors are banned for new bots.
#   Variety: two bots with the same trades can't both live; the better one stays.
#   Exam: the newest years are locked. Graduates trade them once. Pass -> paper trading candidate.
#   Alarm (run first, every time): pure noise must give 0 graduates; a planted pattern must be found.
#
# Usage: python3 bootcamp.py <dir of Yahoo daily JSON (stocks_fetch_daily.py)> [generations=30] [population=300]
import glob, json, math, os, random, sys
from collections import Counter
import numpy as np, pandas as pd

HOLDS = [1, 2, 3, 5, 10, 20]
COST = {"ugly": 0.006, "popular": 0.001}
LEVELS = 8
LEVEL_Z = [None, 0.0, 0.0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5]   # level 1 = "works at all"; then the bar rises
MIN_TRADES = 30

# ---------------- market data -> feature arrays ----------------
def load_yahoo(d):
    series = {}
    for p in glob.glob(f"{d}/*.json"):
        try: r = json.load(open(p))["chart"]["result"][0]
        except Exception: continue
        ts = r.get("timestamp"); q = r["indicators"]["quote"][0]; adj = (r["indicators"].get("adjclose") or [{}])[0].get("adjclose")
        if ts and adj and len(ts) >= 300: series[os.path.basename(p)[:-5]] = (ts, q, adj)
    days = sorted({t // 86400 for ts, _, _ in series.values() for t in ts}); col = {x: i for i, x in enumerate(days)}
    S, T = len(series), len(days)
    O, L, C, V = (np.full((S, T), np.nan, np.float32) for _ in range(4))
    for i, (ts, q, adj) in enumerate(series.values()):
        for j, t in enumerate(ts):
            c, a = q["close"][j], adj[j]
            if c is None or a is None or c <= 0 or q["open"][j] is None or q["low"][j] is None: continue
            f = a / c; k = col[t // 86400]
            O[i, k], L[i, k], C[i, k], V[i, k] = q["open"][j] * f, q["low"][j] * f, a, (q["volume"][j] or 0) / f
    return O, L, C, V, np.array(days)

def shift(x, n):
    y = np.full_like(x, np.nan)
    if n > 0: y[:, n:] = x[:, :-n]
    elif n < 0: y[:, :n] = x[:, -n:]
    else: y[:] = x
    return y
def roll(x, n, fn):
    return getattr(pd.DataFrame(x.T).rolling(n, min_periods=max(1, n * 3 // 4)), fn)().to_numpy(np.float32).T

class Market:
    def __init__(self, O, L, C, V, days):
        self.T = C.shape[1]; self.week = days // 7; self.W = int(self.week.max()) + 1
        with np.errstate(all="ignore"):
            dv = roll(C * V, 60, "median")
            self.band = {"ugly": (dv >= 3e5) & (dv <= 2e7) & (C >= 2), "popular": (dv >= 2e8) & (C >= 2)}
            self.ma200 = roll(C, 200, "mean"); self.ma50 = roll(C, 50, "mean"); self.C = C
            self.avgv = roll(V, 50, "mean"); self.V = V
            self.ret = {k: C / shift(C, k) - 1 for k in (1, 2, 3, 5, 10, 20, 120)}
            self.hi = {n: roll(C, n, "max") for n in (20, 55, 120, 250)}
            self.gap = O / shift(C, 1) - 1
            self.nxt = shift(O, -1)
            self.fwd = {h: shift(C, -h) / self.nxt - 1 for h in HOLDS}
            self.minlow = {h: shift(roll(L, h, "min"), -h) for h in HOLDS}
            self.bench = {b: {h: np.nanmean(np.where(self.band[b], self.fwd[h], np.nan), axis=0) for h in HOLDS} for b in self.band}

# ---------------- bots ----------------
GENES = {"sig": ["drop", "rise", "breakout", "momentum", "gapdown", "volspike"], "k": [1, 2, 3, 5, 10, 20],
         "x": [0.03, 0.05, 0.08, 0.12, 0.2, 0.3], "n": [20, 55, 120, 250], "v": [2, 3, 5], "trend": ["none", "up", "down"],
         "hold": HOLDS, "stop": [0, 0, 0.05, 0.1, 0.15], "band": ["ugly", "popular"]}
def random_bot(r, banned):
    for _ in range(50):
        g = {k: r.choice(v) for k, v in GENES.items()}
        if not pieces(g) & banned: return g
    return g
def mutate(g, r, banned):
    for _ in range(50):
        c = dict(g); k = r.choice(list(GENES)); c[k] = r.choice(GENES[k])
        if c != g and not pieces(c) & banned: return c
    return dict(g)
def pieces(g):  # the rule pieces a bot is built from (what the graveyard tracks)
    s = g["sig"]; p = {f"sig={s}", f"hold={g['hold']}", f"band={g['band']}", f"trend={g['trend']}", f"stop={g['stop']}"}
    if s in ("drop", "rise"): p |= {f"k={g['k']}", f"x={g['x']}"}
    if s == "breakout": p.add(f"n={g['n']}")
    if s in ("momentum", "gapdown"): p.add(f"x={g['x']}")
    if s == "volspike": p.add(f"v={g['v']}")
    return frozenset(p)

def signal(m, g):
    s = g["sig"]
    with np.errstate(all="ignore"):
        if s == "drop": x = m.ret[g["k"]] <= -g["x"]
        elif s == "rise": x = m.ret[g["k"]] >= g["x"]
        elif s == "breakout": x = m.C >= m.hi[g["n"]]
        elif s == "momentum": x = (m.ret[120] >= g["x"] * 3) & (m.C > m.ma50)
        elif s == "gapdown": x = m.gap <= -g["x"]
        else: x = (m.V >= g["v"] * m.avgv) & (m.ret[1] > 0)
        if g["trend"] == "up": x &= m.C > m.ma200
        elif g["trend"] == "down": x &= m.C < m.ma200
    return x & m.band[g["band"]]

def trades(m, g):
    """Every trade the bot would make: (day index, return vs the average stock in its group, after costs)."""
    h = g["hold"]; r = m.fwd[h]
    if g["stop"]:
        with np.errstate(all="ignore"): r = np.where(m.minlow[h] <= m.nxt * (1 - g["stop"]), -g["stop"] - 0.005, r)
    ex = r - m.bench[g["band"]][h][None, :] - COST[g["band"]]
    ok = signal(m, g) & np.isfinite(ex)
    return np.nonzero(ok)[1], np.clip(ex[ok], -0.9, 1.0)

def score(m, t, ex, lo, hi):
    k = (t >= lo) & (t < hi); t, ex = t[k], ex[k]
    if ex.size < 3: return {"n": int(ex.size), "mean": 0.0, "z": 0.0}
    wk = m.week[t] - m.week[t].min(); s = np.bincount(wk, ex); c = np.bincount(wk); wm = s[c > 0] / c[c > 0]
    z = wm.mean() / (wm.std(ddof=1) / math.sqrt(wm.size)) if wm.size > 2 and wm.std() > 0 else 0.0
    return {"n": int(ex.size), "mean": float(ex.mean()), "z": float(z)}

def required_z(tried):
    p = 0.05 / max(tried, 1); t = math.sqrt(-2 * math.log(p))
    return t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t ** 3)

# ---------------- the bootcamp ----------------
def run(m, gens=30, size=300, seed=1, exam_frac=0.3, quiet=False):
    exam_from = int(m.T * (1 - exam_frac)); start = 250            # first year only warms up the 250-day features
    cut = np.linspace(start, exam_from, LEVELS + 1).astype(int)
    r = random.Random(seed); banned = set(); dead_pieces = Counter(); alive_pieces = Counter()
    tried = 0; graduates = []; log = []
    def go(g):
        t, ex = trades(m, g); lv = []
        for i in range(LEVELS):
            s = score(m, t, ex, cut[i], cut[i + 1]); lv.append(s)
            need = MIN_TRADES if i == 0 else MIN_TRADES
            if s["n"] < need or (i > 0 and (s["mean"] <= 0 or s["z"] < LEVEL_Z[i + 1])):
                return i, lv, t, ex          # reached level i (0-based count of levels passed)
        return LEVELS, lv, t, ex
    pop = []                                                    # (bot, levels passed, trade fingerprint, overall score)
    for gen in range(1, gens + 1):
        parents = sorted(pop, key=lambda p: (-p[1], -p[3]["z"]))[: max(1, size // 5)]
        new = []
        while len(new) < size:
            if parents and r.random() < 0.8:
                par = r.choice(parents); new.append((mutate(par[0], r, banned), par))
            else: new.append((random_bot(r, banned), None))
        tried += len(new); zr = required_z(tried); pop_next = [p for p in parents]
        fps = {p[2]: i for i, p in enumerate(pop_next)}
        for g, par in new:
            lvl, lv, t, ex = go(g)
            overall = score(m, t, ex, cut[0], cut[-1])
            if par is not None and (lvl, overall["z"]) <= (par[1], par[3]["z"]):   # a copy that's no better than its parent dies
                dead_pieces.update(pieces(g)); continue
            if lvl < LEVELS and lvl < 3:                                           # failed early: deleted
                dead_pieces.update(pieces(g)); continue
            fp = hash(t.tobytes()) if t.size else 0
            if fp in fps:                                                         # same trades as a living bot: keep the better
                j = fps[fp]
                if (lvl, overall["z"]) <= (pop_next[j][1], pop_next[j][3]["z"]): continue
                pop_next[j] = (g, lvl, fp, overall); continue
            fps[fp] = len(pop_next); pop_next.append((g, lvl, fp, overall)); alive_pieces.update(pieces(g))
            if lvl == LEVELS and overall["z"] >= zr and g not in [x[0] for x in graduates]:
                graduates.append((g, overall, score(m, t, ex, exam_from, m.T)))
        pop = sorted(pop_next, key=lambda p: (-p[1], -p[3]["z"]))[:size]
        banned = {p for p, n in dead_pieces.items() if n >= 200 and alive_pieces[p] == 0}
        best = pop[0] if pop else None
        log.append((gen, tried, zr, len(banned), best))
        if not quiet and (gen in (1, gens) or gen % 10 == 0) and best:
            print(f"  gen {gen}: bots tried {tried}, crowd bar z {zr:.2f}, banned pieces {len(banned)}, "
                  f"best reached level {best[1]}/8: {best[3]['n']} trades {best[3]['mean'] * 100:+.2f}% z {best[3]['z']:+.1f}  {best[0]}")
    exam = [(g, o, e, e["n"] >= MIN_TRADES and e["mean"] > 0 and e["z"] >= 2) for g, o, e in graduates]
    return {"graduates": exam, "tried": tried, "banned": sorted(banned)}

# ---------------- alarm: noise must fail, a planted pattern must be found ----------------
def synthetic(S=300, T=1250, plant=False, seed=3):
    rs = np.random.default_rng(seed)
    ret = rs.normal(0.0003, 0.025, (S, T)).astype(np.float32)
    if plant:  # after a 5-day fall of 12%+, the next 5 days drift up 1% a day
        C = 50 * np.exp(np.cumsum(ret, axis=1))
        for t in range(6, T - 6):
            hit = C[:, t] / C[:, t - 5] - 1 <= -0.12
            ret[hit, t + 1:t + 6] += 0.01
    C = (50 * np.exp(np.cumsum(ret, axis=1))).astype(np.float32)
    O = shift(C, 1); O[:, 0] = C[:, 0]
    L = np.minimum(O, C) * (1 - np.abs(rs.normal(0, 0.01, (S, T)))).astype(np.float32)
    V = np.full((S, T), 2e5, np.float32)                       # ~$10M a day: the "ugly" group
    return Market(O, L, C, V, np.arange(19000, 19000 + T) + (np.arange(T) // 5) * 2)

def alarm(gens, size):
    print("ALARM 1: pure noise, nothing should graduate")
    a = run(synthetic(plant=False), gens, size, quiet=True); n1 = sum(x[3] for x in a["graduates"])
    print(f"  graduates {len(a['graduates'])}, passed exam {n1}  -> {'OK' if n1 == 0 else 'BROKEN: luck got through'}")
    print("ALARM 2: planted pattern (buy after a 5-day 12% fall), it must be found")
    b = run(synthetic(plant=True), gens, size, quiet=True)
    found = [x for x in b["graduates"] if x[3] and x[0]["sig"] == "drop"]
    print(f"  graduates {len(b['graduates'])}, dip-buyers that passed the exam {len(found)}  -> {'OK' if found else 'BROKEN: missed a real pattern'}")
    return n1 == 0 and bool(found)

if __name__ == "__main__":
    d = sys.argv[1]; gens = int(sys.argv[2]) if len(sys.argv) > 2 else 30; size = int(sys.argv[3]) if len(sys.argv) > 3 else 300
    if not alarm(gens, size): sys.exit("Alarm failed: bootcamp results can't be trusted. Fix before reading them.")
    m = Market(*load_yahoo(d))
    print(f"\nREAL DATA: {m.C.shape[0]} stocks, {m.T} days. Levels 1-8 on the training years, exam on the newest 30% (locked).")
    res = run(m, gens, size)
    print(f"\nbots tried {res['tried']}; graduates {len(res['graduates'])}; banned pieces: {', '.join(res['banned']) or 'none'}")
    for g, o, e, ok in res["graduates"]:
        print(f"  {'PASSED EXAM' if ok else 'failed exam'}: {g}\n     training {o['n']} trades {o['mean'] * 100:+.2f}% z {o['z']:+.1f} | exam {e['n']} trades {e['mean'] * 100:+.2f}% z {e['z']:+.1f}")
