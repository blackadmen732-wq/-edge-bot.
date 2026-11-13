# Usage: python3 insider_test.py <daily price dir> <dir of SEC Form 3/4/5 data set zips (sec.gov insider-transactions-data-sets)> [confirm]
# Insider buying test (research only, no orders).
# Question: when insiders buy their own company's stock on the open market (SEC Form 4, code P),
# does the stock beat the average stock in its group afterwards, after costs? Small ignored stocks vs popular.
# Entry: next day's open after the FILING date (when the public can first know). Luck filter: every variant
# counts toward the bar; a variant is PROVEN only if it clears the bar on older data AND wins on the newest 25%.
import glob, io, json, math, os, sys, zipfile, itertools
import numpy as np, pandas as pd
PRICES, INS = sys.argv[1], sys.argv[2]
COST = {"ugly": 0.006, "mid": 0.003, "popular": 0.001}
HOLDS = [5, 20, 60]

# ---------- prices (same alignment as stock_arena.py) ----------
series = {}
for p in glob.glob(f"{PRICES}/*.json"):
    try: r = json.load(open(p))["chart"]["result"][0]
    except Exception: continue
    ts = r.get("timestamp"); q = r["indicators"]["quote"][0]; adj = (r["indicators"].get("adjclose") or [{}])[0].get("adjclose")
    if ts and adj and len(ts) >= 300: series[os.path.basename(p)[:-5]] = (ts, q, adj)
days = sorted({t // 86400 for ts, _, _ in series.values() for t in ts}); col = {d: i for i, d in enumerate(days)}
names = list(series); row = {s: i for i, s in enumerate(names)}; S, T = len(names), len(days)
O, L, C, V = (np.full((S, T), np.nan, np.float32) for _ in range(4))
for i, (ts, q, adj) in enumerate(series.values()):
    for j, t in enumerate(ts):
        c, a = q["close"][j], adj[j]
        if c is None or a is None or c <= 0 or q["open"][j] is None: continue
        f = a / c; k = col[t // 86400]
        O[i, k], L[i, k], C[i, k], V[i, k] = q["open"][j] * f, q["low"][j] * f, a, (q["volume"][j] or 0) / f
def shift(x, n):
    y = np.full_like(x, np.nan)
    if n > 0: y[:, n:] = x[:, :-n]
    else: y[:, :n] = x[:, -n:]
    return y
with np.errstate(all="ignore"):
    dv60 = pd.DataFrame((C * V).T).rolling(60, min_periods=45).median().to_numpy(np.float32).T
    grp = np.where((dv60 >= 3e5) & (dv60 <= 2e7) & (C >= 2), 0, np.where((dv60 >= 2e8) & (C >= 2), 2, np.where((dv60 > 2e7) & (C >= 2), 1, -1)))
    nxt = shift(O, -1); fwd = {h: shift(C, -h) / nxt - 1 for h in HOLDS}
    bench = {h: [np.nanmean(np.where(grp == g, fwd[h], np.nan), axis=0) for g in range(3)] for h in HOLDS}
GN = ["ugly", "mid", "popular"]

# ---------- insider purchases ----------
subs, trans, owners = [], [], []
for z in sorted(glob.glob(f"{INS}/*_form345.zip")):
    with zipfile.ZipFile(z) as f:
        rd = lambda n, cols: pd.read_csv(io.BytesIO(f.read(n)), sep="\t", dtype=str, usecols=cols, quoting=3, on_bad_lines="skip")
        subs.append(rd("SUBMISSION.tsv", ["ACCESSION_NUMBER", "FILING_DATE", "DOCUMENT_TYPE", "ISSUERTRADINGSYMBOL"]))
        trans.append(rd("NONDERIV_TRANS.tsv", ["ACCESSION_NUMBER", "TRANS_CODE", "TRANS_SHARES", "TRANS_PRICEPERSHARE", "TRANS_ACQUIRED_DISP_CD"]))
        owners.append(rd("REPORTINGOWNER.tsv", ["ACCESSION_NUMBER", "RPTOWNERCIK", "RPTOWNER_RELATIONSHIP"]))
sub = pd.concat(subs).drop_duplicates("ACCESSION_NUMBER"); tr = pd.concat(trans); ow = pd.concat(owners).drop_duplicates("ACCESSION_NUMBER")
tr = tr[(tr.TRANS_CODE == "P") & (tr.TRANS_ACQUIRED_DISP_CD == "A")].copy()
tr["value"] = pd.to_numeric(tr.TRANS_SHARES, errors="coerce") * pd.to_numeric(tr.TRANS_PRICEPERSHARE, errors="coerce")
tr = tr[tr.value > 0].groupby("ACCESSION_NUMBER", as_index=False).value.sum()
ev = tr.merge(sub, on="ACCESSION_NUMBER").merge(ow, on="ACCESSION_NUMBER", how="left")
ev = ev[ev.DOCUMENT_TYPE.isin(["4", "4/A"])]
ev["sym"] = ev.ISSUERTRADINGSYMBOL.str.upper().str.strip()
ev["date"] = pd.to_datetime(ev.FILING_DATE, format="%d-%b-%Y", errors="coerce")
ev["officer"] = ev.RPTOWNER_RELATIONSHIP.fillna("").str.contains("Officer")
print(f"open-market insider purchases filed: {len(ev):,} across {ev.sym.nunique():,} tickers; with prices here: {ev.sym.isin(row).sum():,}")
ev = ev[ev.sym.isin(row) & ev.date.notna()]
# per stock per filing day: dollars bought, officer involved, distinct insiders buying in the last 30 days
day_idx = np.array(days)
evd = ev.groupby(["sym", "date"]).agg(value=("value", "sum"), officer=("officer", "max")).reset_index()
cl = []
for (s, d) in zip(evd.sym, evd.date):
    w = ev[(ev.sym == s) & (ev.date <= d) & (ev.date > d - pd.Timedelta(days=30))]
    cl.append(w.RPTOWNERCIK.nunique())
evd["cluster"] = cl
evd["t"] = np.searchsorted(day_idx, (evd.date - pd.Timestamp("1970-01-01")).dt.days.to_numpy())   # filing day or next trading day
evd = evd[(evd.t > 60) & (evd.t < T - 1)]
vault_from = int(np.quantile(evd.t, 0.75))
print(f"insider buying days on these stocks: {len(evd):,}; vault starts {pd.to_datetime(days[vault_from], unit='D').date()}")

def evaluate(e, h, lo, hi_):
    e = e[(e.t >= lo) & (e.t < hi_)].sort_values("t"); out = []; last = {}
    for s, t in zip(e.sym, e.t):
        if t - last.get(s, -10**9) < h: continue        # one position per stock at a time
        i = row[s]; g = grp[i, t]
        if g < 0: continue
        r = fwd[h][i, t]; b = bench[h][g][t]
        if not (np.isfinite(r) and np.isfinite(b)): continue
        out.append((t, float(np.clip(r - b - COST[GN[g]], -0.9, 1.0)), GN[g])); last[s] = t
    return out
def score(trades, band):
    x = [(t, r) for t, r, g in trades if band == "any" or g == band]
    if len(x) < 3: return {"n": len(x), "mean": 0.0, "z": 0.0}
    wk = pd.Series([r for _, r in x], index=[days[t] // 7 for t, _ in x]).groupby(level=0).mean()
    z = wk.mean() / (wk.std(ddof=1) / math.sqrt(len(wk))) if len(wk) > 2 and wk.std() > 0 else 0.0
    return {"n": len(x), "mean": float(np.mean([r for _, r in x])), "z": float(z)}
def required_z(tried):
    p = 0.05 / max(tried, 1); t = math.sqrt(-2 * math.log(p))
    return t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t ** 3)

grid = list(itertools.product([25e3, 100e3, 250e3], [1, 2, 3], [False, True], ["ugly", "mid", "popular", "any"], HOLDS))
zr = required_z(len(grid)); rows = []
for val, cluster, off, band, h in grid:
    e = evd[(evd.value >= val) & (evd.cluster >= cluster) & (evd.officer | (not off))]
    sel = score(evaluate(e, h, 0, vault_from), band); vlt = score(evaluate(e, h, vault_from, T), band)
    rows.append((val, cluster, off, band, h, sel, vlt))
rows.sort(key=lambda r: -r[5]["z"])
f = lambda s: f"{s['n']:>5} trades {s['mean'] * 100:+6.2f}% z {s['z']:+.1f}"
print(f"\n{len(grid)} variants tried, luck bar z {zr:.2f}. Top 12 on older data, then their result on the newest 25%:")
for val, cluster, off, band, h, sel, vlt in rows[:12]:
    tag = "PROVEN" if sel["n"] >= 50 and sel["z"] >= zr and vlt["n"] >= 30 and vlt["mean"] > 0 and vlt["z"] >= 2 else ""
    print(f"  buys>=${val / 1e3:.0f}k insiders>={cluster} {'officer ' if off else ''}{band:<7} hold {h:>2}: older {f(sel)} | newest {f(vlt)} {tag}")
print("\nBaseline, every insider buy >= $25k, hold 20, by group (whole period):")
for band in ("ugly", "mid", "popular"): print(f"  {band:<8}", f(score(evaluate(evd[evd.value >= 25e3], 20, 0, T), band)))

# Fixed-in-advance rule on these stocks, whole period and by year (confirmation run)
if len(sys.argv) > 3 and sys.argv[3] == "confirm":
    e = evd[(evd.value >= 25e3) & evd.officer]
    print("\nCONFIRM: officer buys >= $25k, ugly stocks, hold 20, whole period:", f(score(evaluate(e, 20, 0, T), "ugly")))
    for y in range(2022, 2027):
        lo = int(np.searchsorted(day_idx, (pd.Timestamp(f"{y}-01-01") - pd.Timestamp("1970-01-01")).days))
        hi = int(np.searchsorted(day_idx, (pd.Timestamp(f"{y + 1}-01-01") - pd.Timestamp("1970-01-01")).days))
        print(f"  {y}:", f(score(evaluate(e, 20, lo, hi), "ugly")))
