# Replays the stocks bot's opening-range breakout rule (supabase/functions/stocks/orb.ts) on past 5-minute bars.
# Usage: python3 stocks_orb_replay.py <dir from stocks_fetch5m.py>
# No daily trade limit. Costs: 0.02% slippage on entry and on stop exits.
import json, sys, glob, os, math, statistics as st
from datetime import datetime
from zoneinfo import ZoneInfo
NY = ZoneInfo("America/New_York"); D = sys.argv[1]; SLIP = 0.0002
def load(p):
    r = json.load(open(p))["chart"]["result"][0]; q = r["indicators"]["quote"][0]; days = {}
    for i, t in enumerate(r.get("timestamp") or []):
        if q["close"][i] is None or q["high"][i] is None: continue
        dt = datetime.fromtimestamp(t, NY); m = dt.hour * 60 + dt.minute
        if 570 <= m < 960: days.setdefault(dt.date(), []).append((m, q["open"][i], q["high"][i], q["low"][i], q["close"][i]))
    return {d: sorted(b) for d, b in days.items()}
def trade(bars, prev_close, rng=15, stop_kind="mid", tgt_r=1.0, gap=False):
    rb = [b for b in bars if 570 <= b[0] < 570 + rng]
    if len(rb) < rng // 5: return None
    if gap and not (prev_close and bars[0][1] > prev_close): return None
    hi = max(b[2] for b in rb); lo = min(b[3] for b in rb)
    fb = next((b for b in bars if b[0] >= 570 + rng and b[4] > hi), None)
    if not fb or fb[0] + 5 > 660 or fb[4] > hi * 1.01: return None
    e = fb[4] * (1 + SLIP); stop = round((hi + lo) / 2, 2) if stop_kind == "mid" else lo
    risk = e - stop
    if risk <= 0 or risk / e < 0.002: return None
    tgt = e + tgt_r * risk; x = None
    for b in bars:
        if b[0] <= fb[0]: continue
        if b[0] >= 955: x = b[1]; break
        if b[3] <= stop: x = stop * (1 - SLIP); break
        if b[2] >= tgt: x = tgt; break
    if x is None: x = bars[-1][4]
    sh = math.floor(min(25 / risk, 1000 / e))
    return (x - e) / risk, (x - e) * sh
data = {os.path.basename(p)[:-5]: load(p) for p in glob.glob(f"{D}/*.json")}
dates = sorted({d for v in data.values() for d in v}); mid = dates[len(dates) // 2]
V = {"A  bot as it is (15-min range, stop at middle, target 1R)": {},
     "B  target 2R": {"tgt_r": 2.0},
     "C  stop at range low": {"stop_kind": "low"},
     "D  30-min range": {"rng": 30},
     "E  only stocks that gapped up": {"gap": True}}
print(f"{len(data)} symbols, {dates[0]} to {dates[-1]} ({len(dates)} days), halves split at {mid}\n")
for name, kw in V.items():
    rs = []; ds = []; h1 = []; h2 = []
    for s, days in data.items():
        prev = None
        for d in sorted(days):
            t = trade(days[d], prev, **kw); prev = days[d][-1][4]
            if t: rs.append(t[0]); ds.append(t[1]); (h1 if d < mid else h2).append(t[0])
    n = len(rs); avg = st.mean(rs); tval = avg / (st.stdev(rs) / math.sqrt(n))
    print(f"{name}\n   trades {n}  wins {sum(r > 0 for r in rs) / n:.0%}  avg {avg:+.3f}R  t={tval:+.1f}  "
          f"1st half {st.mean(h1):+.3f}R  2nd half {st.mean(h2):+.3f}R  avg ${st.mean(ds):+.2f}/trade at your settings, total ${sum(ds):+,.0f}")
