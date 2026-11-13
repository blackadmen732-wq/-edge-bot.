# Usage: python3 stock_arena.py <dir from stocks_fetch_daily.py> [rounds=15] [population=120]
# Stock Survival Arena (research only, no orders).
# Question: do simple daily swing rules work better on ignored ("ugly") stocks than on popular ones?
# Every trade is measured AGAINST the average stock in the same group over the same days, after costs,
# so a rising market can't make a rule look smart. Same survival rules as the weather arena
# (supabase/functions/wx-score/arena.ts): kill the worst 30%, mutate the best 20%, 10% newcomers;
# PROVEN only if it clears a bar raised for every recipe tried AND wins on the newest data (vault),
# which selection never sees.
import glob, json, math, os, random, sys
import numpy as np

D = sys.argv[1]; GENS = int(sys.argv[2]) if len(sys.argv) > 2 else 15; SIZE = int(sys.argv[3]) if len(sys.argv) > 3 else 120
COST = {"ugly": 0.006, "popular": 0.001}       # round trip: spread + slippage
HOLDS = [1, 2, 3, 5, 10, 20]

# ---------- load and align ----------
series = {}
for p in glob.glob(f"{D}/*.json"):
    try: r = json.load(open(p))["chart"]["result"][0]
    except Exception: continue
    ts = r.get("timestamp"); q = r["indicators"]["quote"][0]; adj = (r["indicators"].get("adjclose") or [{}])[0].get("adjclose")
    if not ts or not adj or len(ts) < 300: continue
    series[os.path.basename(p)[:-5]] = (ts, q, adj)
days = sorted({t // 86400 for ts, _, _ in series.values() for t in ts}); col = {d: i for i, d in enumerate(days)}
S, T = len(series), len(days)
O, H, L, C, V = (np.full((S, T), np.nan, np.float32) for _ in range(5))
for i, (ts, q, adj) in enumerate(series.values()):
    for j, t in enumerate(ts):
        c, a = q["close"][j], adj[j]
        if c is None or a is None or c <= 0 or q["open"][j] is None: continue
        f = a / c; k = col[t // 86400]
        O[i, k], H[i, k], L[i, k], C[i, k], V[i, k] = q["open"][j] * f, q["high"][j] * f, q["low"][j] * f, a, (q["volume"][j] or 0) / f

def shift(x, n):  # value n days earlier (n>0) or later (n<0), per row
    y = np.full_like(x, np.nan)
    if n > 0: y[:, n:] = x[:, :-n]
    elif n < 0: y[:, :n] = x[:, -n:]
    else: y[:] = x
    return y
import pandas as pd
def roll(x, n, fn):  # trailing window of n days ending today, per stock
    return getattr(pd.DataFrame(x.T).rolling(n, min_periods=max(1, n * 3 // 4)), fn)().to_numpy(np.float32).T

with np.errstate(all="ignore"):
    dv60 = roll(C * V, 60, "median")
    band = {"ugly": (dv60 >= 3e5) & (dv60 <= 2e7) & (C >= 2), "popular": (dv60 >= 2e8) & (C >= 2)}
    ma = {n: roll(C, n, "mean") for n in (50, 200)}
    avgv50 = roll(V, 50, "mean")
    ret = {k: C / shift(C, k) - 1 for k in (1, 2, 3, 5, 10, 20, 120)}
    hi = {n: roll(C, n, "max") for n in (20, 55, 120, 250)}
    gap = O / shift(C, 1) - 1
    nxt_open = shift(O, -1)
    fwd = {h: shift(C, -h) / nxt_open - 1 for h in HOLDS}
    minlow = {h: roll(L, h, "min") for h in HOLDS}
    minlow = {h: shift(minlow[h], -h) for h in HOLDS}       # lowest low over the next h days
    bench = {b: {h: np.nanmean(np.where(band[b], fwd[h], np.nan), axis=0) for h in HOLDS} for b in band}
week = np.array([d // 7 for d in days]); W = week.max() + 1
vault_from = int(T * 0.75)

print(f"{S} stocks, {T} days; avg stocks per day: ugly {np.nanmean(band['ugly'].sum(0)):.0f}, popular {np.nanmean(band['popular'].sum(0)):.0f}")

# ---------- recipes ----------
SIG = ["drop", "breakout", "momentum", "gapdown", "volspike", "rise"]
def rand_g(r):
    return {"sig": r.choice(SIG), "k": r.choice([1, 2, 3, 5, 10, 20]), "x": r.choice([0.03, 0.05, 0.08, 0.12, 0.2, 0.3]),
            "n": r.choice([20, 55, 120, 250]), "v": r.choice([2, 3, 5]), "trend": r.choice(["none", "up", "down"]),
            "hold": r.choice(HOLDS), "stop": r.choice([0, 0, 0.05, 0.1, 0.15]), "band": r.choice(["ugly", "popular"])}
def mutate(g, r):
    g = dict(g); key = r.choice(list(g)); g[key] = rand_g(r)[key]; return g
def signal(g):
    s = g["sig"]
    with np.errstate(all="ignore"):
        if s == "drop": m = ret[g["k"]] <= -g["x"]
        elif s == "rise": m = ret[g["k"]] >= g["x"]
        elif s == "breakout": m = C >= hi[g["n"]]
        elif s == "momentum": m = (ret[120] >= g["x"] * 3) & (C > ma[50])
        elif s == "gapdown": m = gap <= -g["x"]
        else: m = (V >= g["v"] * avgv50) & (ret[1] > 0)
        if g["trend"] == "up": m &= C > ma[200]
        elif g["trend"] == "down": m &= C < ma[200]
    return m & band[g["band"]]
def evaluate(g, lo, hi_):
    h = g["hold"]; m = signal(g); m[:, :lo] = False; m[:, hi_:] = False
    r = fwd[h].copy()
    if g["stop"]:
        with np.errstate(all="ignore"): hit = minlow[h] <= nxt_open * (1 - g["stop"])
        r = np.where(hit, -g["stop"] - 0.005, r)
    ex = r - bench[g["band"]][h][None, :] - COST[g["band"]]
    ok = m & np.isfinite(ex)
    ex = np.clip(ex[ok], -0.9, 1.0); t = np.nonzero(ok)[1]
    n = ex.size
    if n < 2: return {"trades": int(n), "mean": 0.0, "z": 0.0}
    wk = week[t]; s = np.bincount(wk, ex, W); c = np.bincount(wk, minlength=W); wm = s[c > 0] / c[c > 0]
    z = wm.mean() / (wm.std(ddof=1) / math.sqrt(wm.size)) if wm.size > 2 and wm.std() > 0 else 0.0
    return {"trades": int(n), "mean": float(ex.mean()), "z": float(z)}
def required_z(tried):
    p = 0.05 / max(tried, 1); t = math.sqrt(-2 * math.log(p))
    return t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t ** 3)
fmt = lambda s: f"{s['trades']:>6} trades  {s['mean'] * 100:+.2f}% vs group per trade  z {s['z']:+.1f}"

# ---------- 1. the thesis test: same classic rules, ugly vs popular, whole period ----------
print("\nClassic rules, after costs, measured against the average stock in the same group:")
classic = {"buy a 5-day drop of 10%, hold 5": {"sig": "drop", "k": 5, "x": 0.1, "hold": 5},
           "buy a 55-day high, hold 20": {"sig": "breakout", "n": 55, "hold": 20},
           "momentum (6-month +45%, above 50-day avg), hold 20": {"sig": "momentum", "x": 0.15, "hold": 20},
           "buy an 8% gap down, hold 3": {"sig": "gapdown", "x": 0.08, "hold": 3},
           "volume 3x average on an up day, hold 5": {"sig": "volspike", "v": 3, "hold": 5}}
for name, part in classic.items():
    for b in ("ugly", "popular"):
        g = {"k": 5, "x": 0.1, "n": 55, "v": 3, "trend": "none", "stop": 0, **part, "band": b}
        print(f"  {name:<52} {b:<8} {fmt(evaluate(g, 0, T))}")

# ---------- 2. evolution ----------
r = random.Random(11); size = SIZE; pop = [rand_g(r) for _ in range(size)]; tried = 0; proven = []
for gen in range(1, GENS + 1):
    sc = [evaluate(g, 0, vault_from) for g in pop]
    fit = [s["z"] if s["trades"] >= 100 else -10 for s in sc]
    order = sorted(range(size), key=lambda i: -fit[i]); pop = [pop[i] for i in order]; sc = [sc[i] for i in order]
    tried += size; zr = required_z(tried)
    for g, s in zip(pop, sc):
        if s["trades"] >= 200 and s["z"] >= zr and g not in [p[0] for p in proven]:
            v = evaluate(g, vault_from, T)
            if v["trades"] >= 100 and v["mean"] > 0 and v["z"] >= 2: proven.append((g, s, v))
    if gen in (1, GENS) or gen % 5 == 0:
        print(f"\ngen {gen}: tried {tried}, bar z {zr:.2f}, best on selection data: {fmt(sc[0])}  {pop[0]}")
    keep = pop[: size - int(size * 0.3)]; elite = keep[: int(size * 0.2)]
    born = [mutate(r.choice(elite), r) for _ in range(size - len(keep) - int(size * 0.1))]
    pop = keep + born + [rand_g(r) for _ in range(int(size * 0.1))]

print(f"\nPROVEN: {len(proven)}")
for g, s, v in proven: print("  ", g, "\n     selection:", fmt(s), "\n     vault:    ", fmt(v))
best = pop[0]; print("\nBest survivor, checked on the vault (newest 25%, never used to pick):", fmt(evaluate(best, vault_from, T)), best)
