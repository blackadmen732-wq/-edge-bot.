# Downloads 60 days of 5-minute bars (Yahoo chart JSON) for ~100 liquid US stocks. Usage: python3 stocks_fetch5m.py <dir>
import json, sys, time, os, urllib.request, urllib.error
D = sys.argv[1]; os.makedirs(D, exist_ok=True)
U = """SPY QQQ IWM DIA AAPL MSFT NVDA AMZN GOOGL META TSLA AVGO AMD NFLX ADBE CRM ORCL INTC QCOM TXN MU AMAT LRCX KLAC MRVL ARM SMCI PLTR SNOW CRWD PANW NOW SHOP UBER ABNB COIN MSTR HOOD SOFI PYPL JPM BAC WFC C GS MS SCHW V MA AXP BRK-B UNH JNJ LLY PFE MRK ABBV AMGN GILD CVS XOM CVX COP OXY SLB HAL BA CAT DE GE HON LMT RTX UPS FDX WMT COST TGT HD LOW NKE SBUX MCD KO PEP PG DIS CMCSA T VZ TTWO EA RBLX DKNG F GM RIVN LCID NIO BABA PDD JD MARA RIOT""".split()
ok = 0
for s in U:
    p = f"{D}/{s}.json"
    if os.path.exists(p) and os.path.getsize(p) > 10000: ok += 1; continue
    for a in range(4):
        try:
            req = urllib.request.Request(f"https://query1.finance.yahoo.com/v8/finance/chart/{s}?interval=5m&range=60d", headers={"User-Agent": "Mozilla/5.0"})
            open(p, "wb").write(urllib.request.urlopen(req, timeout=20).read()); ok += 1; break
        except urllib.error.HTTPError as e:
            if e.code == 429: time.sleep(5 * (a + 1)); continue
            print("fail", s, e.code); break
        except Exception as e:
            print("fail", s, e); break
    time.sleep(0.4)
print("downloaded", ok, "of", len(U))
