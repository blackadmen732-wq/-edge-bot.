"""Match Kalshi soccer games to football-data.co.uk rows (Pinnacle odds + results)."""
import json, csv, re, unicodedata, datetime as dt, collections
from zoneinfo import ZoneInfo
UK = ZoneInfo("Europe/London")
LEAGUES = {"KXEPLGAME": "E0", "KXEFLCHAMPIONSHIPGAME": "E1", "KXBUNDESLIGAGAME": "D1", "KXLALIGAGAME": "SP1", "KXSERIEAGAME": "I1", "KXLIGUE1GAME": "F1"}
MON = {m: i + 1 for i, m in enumerate("JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split())}
ALIAS = {  # canonical forms (after norm) -> shared key
 "man utd": "manchester united", "man united": "manchester united", "man city": "manchester city",
 "nottm forest": "nottingham forest", "nottingham": "nottingham forest", "wolves": "wolverhampton", "wolverhampton wanderers": "wolverhampton",
 "leeds": "leeds united", "sheffield weds": "sheffield wednesday", "sheffield utd": "sheffield united", "sheff utd": "sheffield united", "sheff wed": "sheffield wednesday",
 "west brom": "west bromwich", "west bromwich albion": "west bromwich", "qpr": "queens park rangers", "ipswich": "ipswich town", "hull": "hull city",
 "ath madrid": "atletico madrid", "atletico": "atletico madrid", "ath bilbao": "athletic bilbao", "athletic club": "athletic bilbao", "betis": "real betis",
 "sociedad": "real sociedad", "celta": "celta vigo", "vallecano": "rayo vallecano", "espanol": "espanyol", "alaves": "alaves", "la coruna": "deportivo la coruna",
 "inter": "inter milan", "internazionale": "inter milan", "milan": "ac milan", "verona": "hellas verona", "roma": "as roma",
 "paris sg": "paris saint germain", "psg": "paris saint germain", "st etienne": "saint etienne", "paris fc": "paris fc",
 "ein frankfurt": "eintracht frankfurt", "frankfurt": "eintracht frankfurt", "mgladbach": "monchengladbach", "borussia monchengladbach": "monchengladbach", "gladbach": "monchengladbach",
 "fc koln": "koln", "cologne": "koln", "leverkusen": "bayer leverkusen", "dortmund": "borussia dortmund", "bayern munich": "bayern", "bayern munchen": "bayern",
 "hamburger sv": "hamburg", "hamburg sv": "hamburg", "st pauli": "saint pauli", "union berlin": "union berlin", "mainz 05": "mainz", "werder bremen": "bremen",
 "rb leipzig": "leipzig", "heidenheim": "heidenheim", "hoffenheim": "hoffenheim",
}
def norm(s):
    s = unicodedata.normalize("NFD", s); s = "".join(c for c in s if unicodedata.category(c) != "Mn").lower()
    s = re.sub(r"[.'’´`]", "", s); s = re.sub(r"[-/&]", " ", s); s = re.sub(r"\b(fc|cf|afc|sc|ac|as|ssc|us|sv|vfb|vfl|tsg|ogc|rc|losc|1)\b", lambda m: m.group(0) if m.group(0) in ("ac", "as") else "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return ALIAS.get(s, s)
def sim(a, b):
    a, b = norm(a), norm(b)
    if a == b: return 1.0
    if a in b or b in a: return 0.9
    ta, tb = a.split(), b.split()
    hit = sum(1 for x in ta if any(y[:4] == x[:4] for y in tb))
    return hit / max(len(ta), len(tb))
def fd_rows(div):
    out = []
    for season in ("2425", "2526", "2627"):
        try:
            for r in csv.DictReader(open(f"cache/fd/{div}_{season}.csv", encoding="utf-8-sig")):
                if not r.get("Date"): continue
                d = dt.datetime.strptime(r["Date"], "%d/%m/%Y" if len(r["Date"]) == 10 else "%d/%m/%y")
                hh, mm = (r.get("Time") or "15:00").split(":")
                ko = d.replace(hour=int(hh), minute=int(mm), tzinfo=UK).astimezone(dt.timezone.utc)
                out.append({**r, "_ko": ko, "_season": season})
        except FileNotFoundError:
            pass
    return out
def f(x):
    try: return float(x)
    except (TypeError, ValueError): return None
games, report = [], {}
for series, div in LEAGUES.items():
    ms = json.load(open(f"data/markets_{series}.json"))
    ev = collections.defaultdict(list)
    for m in ms: ev[m["event_ticker"]].append(m)
    rows = fd_rows(div)
    byday = collections.defaultdict(list)
    for r in rows: byday[r["_ko"].date()].append(r)
    stats = collections.Counter()
    for et, mk in ev.items():
        seg = et.split("-")[1]; mt = re.match(r"(\d\d)([A-Z]{3})(\d\d)", seg)
        if not mt: stats["bad_ticker"] += 1; continue
        day = dt.date(2000 + int(mt[1]), MON[mt[2]], int(mt[3]))
        teams = [m for m in mk if m["yes_sub_title"] not in ("Tie", "Draw")]
        tie = [m for m in mk if m["yes_sub_title"] in ("Tie", "Draw")]
        if len(teams) != 2 or len(tie) != 1: stats["not_3way"] += 1; continue
        title = (mk[0]["title"] or "").replace(" Winner?", "")
        parts = title.split(" vs ")
        best = []
        for dd in (-1, 0, 1):
            for r in byday.get(day + dt.timedelta(days=dd), []):
                o1 = sim(teams[0]["yes_sub_title"], r["HomeTeam"]) + sim(teams[1]["yes_sub_title"], r["AwayTeam"])
                o2 = sim(teams[0]["yes_sub_title"], r["AwayTeam"]) + sim(teams[1]["yes_sub_title"], r["HomeTeam"])
                st = sim(parts[0], r["HomeTeam"]) + sim(parts[1], r["AwayTeam"]) if len(parts) == 2 else 0
                if o1 != o2:
                    order = o1 > o2
                elif len(parts) == 2:  # names alone can't tell: use the title's home team
                    order = sim(teams[0]["yes_sub_title"], parts[0]) >= sim(teams[1]["yes_sub_title"], parts[0])
                else:
                    continue
                best.append((max(o1, o2, st), r, order))
        best.sort(key=lambda x: -x[0])
        if not best or best[0][0] < 1.3 or (len(best) > 1 and best[0][0] - best[1][0] < 0.5):
            stats["unmatched"] += 1
            if stats["unmatched"] <= 6: print("  unmatched", series, et, [t["yes_sub_title"] for t in teams], [(round(b[0], 2), b[1]["HomeTeam"], b[1]["AwayTeam"]) for b in best[:2]])
            continue
        sc, r, order = best[0]
        home, away = (teams[0], teams[1]) if order else (teams[1], teams[0])
        res = r.get("FTR")
        res_k = {"H": home["ticker"], "A": away["ticker"], "D": tie[0]["ticker"]}.get(res)
        yes = [m["ticker"] for m in mk if m["result"] == "yes"]
        if res_k is None or yes != [res_k]: stats["result_mismatch"] += 1; continue
        odds = {"pre": [f(r.get("PSH")), f(r.get("PSD")), f(r.get("PSA"))], "close": [f(r.get("PSCH")), f(r.get("PSCD")), f(r.get("PSCA"))],
                "bfe_pre": [f(r.get("BFEH")), f(r.get("BFED")), f(r.get("BFEA"))], "avg_close": [f(r.get("AvgCH")), f(r.get("AvgCD")), f(r.get("AvgCA"))]}
        odds["bfe_close"] = [f(r.get("BFECH")), f(r.get("BFECD")), f(r.get("BFECA"))]
        odds["avg_pre"] = [f(r.get("AvgH")), f(r.get("AvgD")), f(r.get("AvgA"))]
        if None not in odds["pre"] and None not in odds["close"]:
            odds["source"] = "pinnacle"
        elif None not in odds["bfe_pre"] and None not in odds["bfe_close"]:
            odds["source"] = "betfair_exchange"; odds["pre"], odds["close"] = odds["bfe_pre"], odds["bfe_close"]
        else:
            stats["no_sharp_odds"] += 1; continue
        games.append({"league": series, "event": et, "label": f'{r["HomeTeam"]} vs {r["AwayTeam"]}', "kickoff": r["_ko"].isoformat(),
                      "markets": [{"ticker": home["ticker"], "outcome": "home", "src": home["_src"]}, {"ticker": tie[0]["ticker"], "outcome": "draw", "src": tie[0]["_src"]}, {"ticker": away["ticker"], "outcome": "away", "src": away["_src"]}],
                      "result": {"H": "home", "D": "draw", "A": "away"}[res], "odds": odds,
                      "close_time": max(m["close_time"] for m in mk), "score": sc})
        stats["matched"] += 1
    report[series] = dict(stats, events=len(ev)); print(series, report[series], flush=True)
json.dump(games, open("data/soccer_games_v2.json", "w"))
# sanity: Kalshi close_time - kickoff should be ~1h50m-2h10m if kickoff times are right
for series in LEAGUES:
    gaps = sorted((dt.datetime.fromisoformat(g["close_time"].replace("Z", "+00:00")) - dt.datetime.fromisoformat(g["kickoff"])).total_seconds() / 3600 for g in games if g["league"] == series)
    if gaps: print(series, "close-kickoff hours: p10 %.2f median %.2f p90 %.2f" % (gaps[len(gaps) // 10], gaps[len(gaps) // 2], gaps[9 * len(gaps) // 10]))
