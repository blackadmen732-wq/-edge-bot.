"""Hourly Kalshi prices for each matched game, from before the odds were collected until kickoff."""
import json, sys, time, datetime as dt
from zoneinfo import ZoneInfo
import kfetch
from kfetch import get
kfetch.MIN_GAP = float(sys.argv[2]) if len(sys.argv) > 2 else 0.12
UK = ZoneInfo("Europe/London")
games = json.load(open(sys.argv[1]))
def odds_time(ko):
    """football-data collects pre-match odds Friday afternoon (weekend games) or Tuesday afternoon (midweek)."""
    k = ko.astimezone(UK)
    for back in range(0, 8):
        d = (k - dt.timedelta(days=back)).replace(hour=16, minute=0, second=0, microsecond=0)
        if d.weekday() in (1, 4) and d <= k - dt.timedelta(hours=2):
            return d.astimezone(dt.timezone.utc)
    return None
t0, n = time.time(), 0
def _v(o, k):
    o = o or {}
    v = o.get(k)
    return v if v is not None else o.get(k + "_dollars")
def conv(cs):
    return [{"t": c["end_period_ts"], "ask_c": _v(c.get("yes_ask"), "close"), "ask_l": _v(c.get("yes_ask"), "low"), "bid_c": _v(c.get("yes_bid"), "close"),
             "px": _v(c.get("price"), "close"), "vol": c.get("volume") if c.get("volume") is not None else c.get("volume_fp")} for c in (cs or [])]
win = {}
for g in games:
    ko = dt.datetime.fromisoformat(g["kickoff"])
    ot = odds_time(ko) if g.get("odds_time") is None else dt.datetime.fromisoformat(g["odds_time"])
    g["odds_time"] = ot.isoformat() if ot else None
    win[g["event"]] = (int(((ot or ko - dt.timedelta(days=2)) - dt.timedelta(hours=3)).timestamp()), int((ko + dt.timedelta(minutes=60)).timestamp()))
# Recent (not archived) games: up to 33 games per batch request, if their windows fit within ~8 days.
live = sorted([g for g in games if all(m["src"] == "live" for m in g["markets"])], key=lambda g: win[g["event"]][0])
chunk = []
def flush(chunk):
    global n
    if not chunk: return
    s, e = min(win[g["event"]][0] for g in chunk), max(win[g["event"]][1] for g in chunk)
    d = get("/markets/candlesticks", {"market_tickers": ",".join(m["ticker"] for g in chunk for m in g["markets"]), "start_ts": s, "end_ts": e, "period_interval": 60})
    n += 1
    got = {x.get("market_ticker") or x.get("ticker"): x.get("candlesticks", []) for x in (d or {}).get("markets", [])}
    for g in chunk:
        for m in g["markets"]:
            m["candles"] = conv(got.get(m["ticker"]))
for g in live:
    nxt = chunk + [g]
    span_h = (max(win[c["event"]][1] for c in nxt) - min(win[c["event"]][0] for c in nxt)) / 3600 + 2
    if chunk and (sum(len(c["markets"]) for c in nxt) > 100 or span_h * sum(len(c["markets"]) for c in nxt) > 9000):
        flush(chunk); chunk = []
    chunk.append(g)
flush(chunk)
print(f"recent games: {len(live)} in {n} batch requests, {time.time() - t0:.0f}s, {kfetch.STATS}", flush=True)
# Archived games: one request per market.
rest = [g for g in games if not all(m["src"] == "live" for m in g["markets"])]
for i, g in enumerate(rest):
    s, e = win[g["event"]]
    for m in g["markets"]:
        series = m["ticker"].split("-")[0]
        path = f"/historical/markets/{m['ticker']}/candlesticks" if m["src"] == "historical" else f"/series/{series}/markets/{m['ticker']}/candlesticks"
        try:
            d = get(path, {"start_ts": s, "end_ts": e, "period_interval": 60})
        except RuntimeError as ex:
            print("ERR", m["ticker"], str(ex)[:160], flush=True); d = None
        n += 1
        m["candles"] = conv((d or {}).get("candlesticks"))
    if i % 100 == 0:
        print(f"archived {i}/{len(rest)} games, {n} requests, {time.time() - t0:.0f}s, {kfetch.STATS}", flush=True)
json.dump(games, open(sys.argv[1].replace(".json", "_candles.json"), "w"))
print("done", len(games), "games", n, "requests", f"{time.time() - t0:.0f}s", flush=True)
