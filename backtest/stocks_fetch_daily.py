# Usage: python3 stocks_fetch_daily.py <dir holding nasdaqlisted.txt + otherlisted.txt from nasdaqtrader.com/dynamic/SymDir/> <how many>
# Samples US common stocks from Nasdaq Trader's directories and downloads 5 years of daily bars from Yahoo.
import json, os, random, re, sys, time, urllib.request, urllib.error
D = sys.argv[1]; N = int(sys.argv[2]); out = f"{D}/daily"; os.makedirs(out, exist_ok=True)
syms = set()
for line in open(f"{D}/nasdaqlisted.txt").read().splitlines()[1:]:
    f = line.split("|")
    if len(f) > 6 and f[3] == "N" and f[4] == "N" and f[6] == "N": syms.add((f[0], f[1]))
for line in open(f"{D}/otherlisted.txt").read().splitlines()[1:]:
    f = line.split("|")
    if len(f) > 6 and f[4] == "N" and f[6] == "N": syms.add((f[0], f[1]))
bad = re.compile(r"warrant|right|unit|preferred|depositary share|notes|debenture|%|trust|fund|etn|acquisition", re.I)
pool = sorted(s for s, n in syms if re.fullmatch(r"[A-Z]{1,5}", s) and not bad.search(n) and "common" in n.lower())
random.Random(7).shuffle(pool); pick = pool[:N]
print("common stocks in directory:", len(pool), "sampling", len(pick))
ok = 0
for s in pick:
    p = f"{out}/{s}.json"
    if os.path.exists(p): ok += 1; continue
    for a in range(4):
        try:
            req = urllib.request.Request(f"https://query1.finance.yahoo.com/v8/finance/chart/{s}?interval=1d&range=5y", headers={"User-Agent": "Mozilla/5.0"})
            open(p, "wb").write(urllib.request.urlopen(req, timeout=20).read()); ok += 1; break
        except urllib.error.HTTPError as e:
            if e.code == 429: time.sleep(5 * (a + 1)); continue
            break
        except Exception: break
    time.sleep(0.35)
print("downloaded", ok)
