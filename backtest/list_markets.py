import json, os, sys
from kfetch import get, paged
SERIES = ["KXEPLGAME","KXEFLCHAMPIONSHIPGAME","KXBUNDESLIGAGAME","KXLALIGAGAME","KXSERIEAGAME","KXLIGUE1GAME","KXUCLGAME","KXMLSGAME","KXNFLGAME","KXNCAAFGAME"]
KEEP = ["ticker","event_ticker","yes_sub_title","no_sub_title","title","status","result","open_time","close_time","occurrence_datetime","expected_expiration_time","settlement_ts","settlement_value_dollars","volume_fp","mve_collection_ticker","custom_strike"]
os.makedirs("data", exist_ok=True)
for s in SERIES:
    hist = paged("/historical/markets", {"series_ticker": s, "limit": 1000}, "markets")
    live = paged("/markets", {"series_ticker": s, "status": "settled", "limit": 1000}, "markets")
    seen, out = set(), []
    for m in hist + live:
        if m["ticker"] in seen: continue
        seen.add(m["ticker"]); out.append({k: m.get(k) for k in KEEP} | {"_src": "historical" if m in hist else "live"})
    with open(f"data/markets_{s}.json", "w") as f: json.dump(out, f)
    closes = sorted(m["close_time"] for m in out if m.get("close_time"))
    print(s, "historical", len(hist), "live", len(live), "range", closes[0] if closes else "-", closes[-1] if closes else "-", flush=True)
