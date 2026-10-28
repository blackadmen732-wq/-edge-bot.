"""Match Kalshi NFL / college football games to free closing-line data.
NFL: minmaxxxer consensus (no-vig median of ~20 books), 2025 + 2026.  NCAAF: cfbfastR 2025 closing moneylines (ESPN Bet, Bovada, DraftKings)."""
import json, csv, gzip, re, collections, datetime as dt, unicodedata
from zoneinfo import ZoneInfo
ET = ZoneInfo("America/New_York")
MON = {m: i + 1 for i, m in enumerate("JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split())}
NFL = {"ARI": "Arizona Cardinals", "ATL": "Atlanta Falcons", "BAL": "Baltimore Ravens", "BUF": "Buffalo Bills", "CAR": "Carolina Panthers", "CHI": "Chicago Bears",
 "CIN": "Cincinnati Bengals", "CLE": "Cleveland Browns", "DAL": "Dallas Cowboys", "DEN": "Denver Broncos", "DET": "Detroit Lions", "GB": "Green Bay Packers",
 "HOU": "Houston Texans", "IND": "Indianapolis Colts", "JAC": "Jacksonville Jaguars", "KC": "Kansas City Chiefs", "LA": "Los Angeles Rams", "LAR": "Los Angeles Rams",
 "LAC": "Los Angeles Chargers", "LV": "Las Vegas Raiders", "MIA": "Miami Dolphins", "MIN": "Minnesota Vikings", "NE": "New England Patriots", "NO": "New Orleans Saints",
 "NYG": "New York Giants", "NYJ": "New York Jets", "PHI": "Philadelphia Eagles", "PIT": "Pittsburgh Steelers", "SEA": "Seattle Seahawks", "SF": "San Francisco 49ers",
 "TB": "Tampa Bay Buccaneers", "TEN": "Tennessee Titans", "WAS": "Washington Commanders"}
def tdate(et):
    mt = re.match(r"(\d\d)([A-Z]{3})(\d\d)", et.split("-")[1]); return dt.date(2000 + int(mt[1]), MON[mt[2]], int(mt[3]))
def events(series):
    ev = collections.defaultdict(list)
    for m in json.load(open(f"data/markets_{series}.json")):
        if not m.get("mve_collection_ticker"): ev[m["event_ticker"]].append(m)
    return {k: v for k, v in ev.items() if len(v) == 2}
def norm(s):
    s = unicodedata.normalize("NFD", s); s = "".join(c for c in s if unicodedata.category(c) != "Mn").lower()
    s = re.sub(r"[.'’()&]", " ", s); s = re.sub(r"\s+", " ", s).strip(); w = s.split()
    w = ["state" if (x == "st" and i > 0) else ("saint" if x == "st" else x) for i, x in enumerate(w)]
    s = " ".join(w)
    return {"miami fl": "miami", "miami florida": "miami", "ole miss": "mississippi", "uconn": "connecticut", "umass": "massachusetts", "app state": "appalachian state",
            "hawai i": "hawaii", "sam houston state": "sam houston", "southern miss": "southern mississippi", "ul monroe": "louisiana monroe", "la tech": "louisiana tech",
            "ut martin": "tennessee martin", "nc state": "north carolina state", "pitt": "pittsburgh", "texas a and m": "texas a m", "texas a&m": "texas a m",
            "fiu": "florida international", "fau": "florida atlantic", "utsa": "ut san antonio", "smu": "southern methodist", "tcu": "texas christian", "ucf": "central florida",
            "usc": "southern california", "lsu": "louisiana state", "byu": "brigham young", "unlv": "nevada las vegas", "uab": "alabama birmingham", "utep": "ut el paso"}.get(s, s)
def sim(a, b):
    a, b = norm(a), norm(b)
    if a == b: return 1.0
    ta, tb = a.split(), b.split()
    if ta == tb[:len(ta)] or tb == ta[:len(tb)]: return 0.8  # "alabama" vs "alabama crimson tide"
    return 0.0
def amer_to_dec(o):
    o = float(o); return 1 + (o / 100 if o > 0 else 100 / -o)
games, stats = [], collections.Counter()
# ---------------- NFL
nfl = []
for fn in ("cache/us/mm_nfl_2025_closing_lines_ats.csv", "cache/us/mm_nfl_2026_odds.csv"):
    nfl += list(csv.DictReader(open(fn)))
for et, mk in events("KXNFLGAME").items():
    day = tdate(et); codes = [m["ticker"].split("-")[-1] for m in mk]
    teams = [NFL.get(c) for c in codes]
    if None in teams: stats["nfl_code"] += 1; continue
    cand = [r for r in nfl if abs((dt.date.fromisoformat(r["date_et"]) - day).days) <= 1 and {r["home_team"], r["away_team"]} == set(teams)]
    if len(cand) != 1: stats["nfl_unmatched"] += 1; continue
    r = cand[0]
    if r["home_score"] == r["away_score"]: stats["nfl_tie"] += 1; continue
    home = mk[teams.index(r["home_team"])]; away = mk[teams.index(r["away_team"])]
    win = "home" if float(r["home_score"]) > float(r["away_score"]) else "away"
    yes = "home" if home["result"] == "yes" else "away" if away["result"] == "yes" else None
    if yes != win: stats["nfl_result_mismatch"] += 1; continue
    p = float(r["close_home_win_prob"]); ko = dt.datetime.fromisoformat(r["start_time_utc"].replace("Z", "+00:00"))
    games.append({"league": "KXNFLGAME", "event": et, "label": f'{r["away_team"]} at {r["home_team"]}', "kickoff": ko.isoformat(),
                  "odds_time": (ko - dt.timedelta(hours=3)).isoformat(), "result": win,
                  "markets": [{"ticker": home["ticker"], "outcome": "home", "src": home["_src"]}, {"ticker": away["ticker"], "outcome": "away", "src": away["_src"]}],
                  "odds": {"source": f'consensus of {r["bookmakers"]} books (closing)', "pre": {"home": 1 / p, "away": 1 / (1 - p)}, "close": {"home": 1 / p, "away": 1 / (1 - p)}}})
    stats["nfl_matched"] += 1
# ---------------- NCAAF 2025
sched = {r["game_id"]: r for r in csv.DictReader(open("cache/us/cfb_schedules_2025.csv"))}
lines = collections.defaultdict(lambda: collections.defaultdict(dict))
for r in csv.DictReader(gzip.open("cache/us/cfb_line_odds.csv.gz", "rt")):
    if r["season"].startswith("2025") and r["market_type"] == "money_line" and r["odds"]:
        lines[r["game_id"]][r["book"]][r["abbr"]] = r["odds"]
byday = collections.defaultdict(list)
for gid, s in sched.items():
    if gid in lines and s.get("home_points") not in ("", None) and s.get("start_date"):
        ko = dt.datetime.fromisoformat(s["start_date"].replace("Z", "+00:00")); s["_ko"] = ko
        byday[ko.astimezone(ET).date()].append(s)
for et, mk in events("KXNCAAFGAME").items():
    day = tdate(et)
    if day > dt.date(2026, 2, 1): continue  # 2026 season: no free odds file
    best = []
    for dd in (-1, 0, 1):
        for s in byday.get(day + dt.timedelta(days=dd), []):
            o1 = sim(mk[0]["yes_sub_title"], s["home_team"]) + sim(mk[1]["yes_sub_title"], s["away_team"])
            o2 = sim(mk[0]["yes_sub_title"], s["away_team"]) + sim(mk[1]["yes_sub_title"], s["home_team"])
            if max(o1, o2) >= 1.6: best.append((max(o1, o2), s, o1 > o2))
    best.sort(key=lambda x: -x[0])
    if not best or (len(best) > 1 and best[0][0] == best[1][0]): stats["cfb_unmatched"] += 1; continue
    _, s, order = best[0]
    home, away = (mk[0], mk[1]) if order else (mk[1], mk[0])
    hp, ap = float(s["home_points"]), float(s["away_points"])
    if hp == ap: stats["cfb_tie"] += 1; continue
    win = "home" if hp > ap else "away"
    yes = "home" if home["result"] == "yes" else "away" if away["result"] == "yes" else None
    if yes != win: stats["cfb_result_mismatch"] += 1; continue
    fair = []
    for book, d in lines[s["game_id"]].items():
        h, a = d.get(s["home_team"]), d.get(s["away_team"])
        if h and a:
            ih, ia = 1 / amer_to_dec(h), 1 / amer_to_dec(a)
            if 0.98 < ih + ia < 1.25: fair.append(ih / (ih + ia))
    if not fair: stats["cfb_no_odds"] += 1; continue
    p = sum(fair) / len(fair)
    if not (0.005 < p < 0.995): stats["cfb_extreme"] += 1; continue
    ko = s["_ko"]
    games.append({"league": "KXNCAAFGAME", "event": et, "label": f'{s["away_team"]} at {s["home_team"]}', "kickoff": ko.isoformat(),
                  "odds_time": (ko - dt.timedelta(hours=3)).isoformat(), "result": win,
                  "markets": [{"ticker": home["ticker"], "outcome": "home", "src": home["_src"]}, {"ticker": away["ticker"], "outcome": "away", "src": away["_src"]}],
                  "odds": {"source": f"{len(fair)} US books (closing)", "pre": {"home": 1 / p, "away": 1 / (1 - p)}, "close": {"home": 1 / p, "away": 1 / (1 - p)}}})
    stats["cfb_matched"] += 1
print(dict(stats)); json.dump(games, open("data/us_games.json", "w"))
