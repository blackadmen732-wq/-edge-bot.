"""Turn replay results into small CSV tables for the results dashboard."""
import csv, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "dashboard_data")
os.makedirs(OUT, exist_ok=True)
LEAGUE = {"KXEPLGAME": "Premier League", "KXEFLCHAMPIONSHIPGAME": "Championship", "KXBUNDESLIGAGAME": "Bundesliga", "KXLALIGAGAME": "La Liga",
          "KXSERIEAGAME": "Serie A", "KXLIGUE1GAME": "Ligue 1", "KXNFLGAME": "NFL", "KXNCAAFGAME": "College football"}
soccer = json.load(open(os.path.join(HERE, "results_soccer.json")))
us = json.load(open(os.path.join(HERE, "results_us.json"))) if os.path.exists(os.path.join(HERE, "results_us.json")) else None
NAMES = {"main: bot rules, flat $100 per bet": "Bot's rules ($100 per bet)", "main with power de-vig": "Bot's rules, fixed underdog pricing",
         "bet right when odds were collected": "Bet as soon as odds were taken", "taker only (no waiting orders)": "Buy now only, no waiting orders",
         "min edge 2%": "Lower bar: 2% minimum edge", "min edge 5%": "Higher bar: 5% minimum edge", "min edge 8%": "Higher bar: 8% minimum edge",
         "no 48h limit": "No 48-hour limit", "Pinnacle games, proportional de-vig (live bot today)": "Pinnacle odds only, old pricing",
         "Pinnacle games, power de-vig": "Pinnacle odds only, fixed pricing", "Betfair games only": "Betfair odds only",
         "without the source-disagreement check": "Without the bad-odds check", "NFL only": "NFL only", "college only": "College only"}
r4 = lambda x: None if x is None else round(x, 4)
def write(name, rows):
    with open(os.path.join(OUT, name), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    print(name, len(rows))
# 1) price gaps
gaps = []
for res, sport, allname in ((soccer, "Soccer", "All soccer"), (us, "American football", "All American football")):
    if not res: continue
    for k, v in res["gaps"].items():
        gaps.append({"group": allname if k == "ALL" else LEAGUE.get(k, k), "sport": sport, "markets": v["markets"],
                     "avg_gap_cents": r4(v["avgGapCents"]), "median_gap_cents": r4(v["medianGapCents"]), "kalshi_minus_fair_cents": r4(v["avgSignedGapCents"]),
                     "share_buy_now_profitable": r4(v["shareBuyNowProfitable"]), "share_over_3pct": r4(v["shareBuyNowOver3pct"]), "share_over_5pct": r4(v["shareBuyNowOver5pct"]),
                     "timing": "Kalshi 2h after sharp odds were taken" if sport == "Soccer" else "Kalshi 1h before kickoff vs closing odds (hindsight)"})
write("price_gaps.csv", gaps)
# 2) soccer gap by month (skip months with too few markets)
write("gap_by_month.csv", [{"month": k + "-01", "markets": v["markets"], "avg_gap_cents": r4(v["avgGapCents"]), "share_over_3pct": r4(v["shareBuyNowOver3pct"])}
                           for k, v in soccer["gapsByMonth"].items() if v["markets"] >= 50])
# 3) settings tried
var, bank = [], []
for res, sport in ((soccer, "Soccer"), (us, "American football")):
    if not res: continue
    for i, run in enumerate(res["runs"]):
        s = run["summary"]
        rid = f'{"S" if sport == "Soccer" else "U"}{i + 1:02d}'
        if run["name"].startswith("real bot"):
            bank.append({"id": rid, "sport": sport, "start": int(run["name"].split("$")[1].split(" ")[0].replace(",", "")),
                         "final": round(run["finalBankroll"], 2), "bets": s.get("bets", 0), "profit": round(run["finalBankroll"] - int(run["name"].split("$")[1].split(" ")[0].replace(",", "")), 2)})
            continue
        ci = s.get("edgeVsCloseCI95") or [None, None]
        rci = s.get("roiCI95") or [None, None]
        circular = sport != "Soccer"  # US "pre" odds are the closing odds, so edge vs close can't be measured
        var.append({"id": rid, "sport": sport, "games": run["counts"]["games"], "setting": NAMES.get(run["name"], run["name"]),
                    "bets": s.get("bets", 0), "won": s.get("won"), "win_rate": r4(s.get("winRate")), "expected_win_rate": r4(s.get("expectedWinRate")),
                    "staked": round(s["staked"], 2) if s.get("bets") else None, "profit": round(s["pnl"], 2) if s.get("bets") else None, "roi": r4(s.get("roi")),
                    "roi_ci_low": r4(rci[0]), "roi_ci_high": r4(rci[1]),
                    "promised_edge": r4(s.get("promisedEdge")), "edge_vs_close": None if circular else r4(s.get("edgeVsClose")),
                    "ci_low": None if circular else r4(ci[0]), "ci_high": None if circular else r4(ci[1]),
                    "beat_kalshi_close_cents": r4(s.get("beatKalshiCloseCents"))})
write("settings_tried.csv", var)
write("bankroll.csv", bank)
# 4) the bets the bot would have made (soccer, bot rules)
main = next(r for r in soccer["runs"] if r["name"].startswith("main:"))
write("soccer_bets.csv", [{"id": f"B{i + 1:02d}", "date": b["kickoff"][:10], "league": LEAGUE[b["league"]], "game": b["label"],
                            "pick": {"home": "Home win", "away": "Away win", "draw": "Draw"}[b["outcome"]], "order": "Bought now" if b["kind"] == "taker" else "Waiting order filled",
                            "price_cents": round(b["price"] * 100), "fair_at_bet": r4(b["fairPre"]), "fair_at_close": r4(b["fairClose"]),
                            "promised_edge": r4(b["expEdgePre"]), "edge_vs_close": r4(b["expEdgeClose"]), "result": "Won" if b["won"] else "Lost",
                            "profit": round(b["pnl"], 2), "odds_source": "Pinnacle" if b["source"] == "pinnacle" else "Betfair exchange"}
                           for i, b in enumerate(sorted(main["bets"], key=lambda b: b["kickoff"]))])
