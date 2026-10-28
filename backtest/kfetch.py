"""Polite, cached Kalshi public-data fetcher (no login needed)."""
import json, os, time, random, hashlib, urllib.request, urllib.parse, urllib.error
STATS = {"ok": 0, "retry": 0}

BASE = "https://external-api.kalshi.com/trade-api/v2"
CACHE = os.path.join(os.path.dirname(__file__), "cache", "kalshi")
os.makedirs(CACHE, exist_ok=True)
_last = [0.0]
MIN_GAP = 0.22  # ~4.5 requests/second

def get(path, params=None, cache=True):
    q = urllib.parse.urlencode({k: v for k, v in (params or {}).items() if v not in (None, "")})
    url = BASE + path + ("?" + q if q else "")
    key = hashlib.sha1(url.encode()).hexdigest()
    fp = os.path.join(CACHE, key + ".json")
    if cache and os.path.exists(fp):
        with open(fp) as f:
            return json.load(f)
    for attempt in range(30):
        wait = MIN_GAP - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
        try:
            req = urllib.request.Request(url, headers={"accept": "application/json", "user-agent": "edgebot-backtest"})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.load(r)
            STATS["ok"] += 1
            if cache:
                with open(fp, "w") as f:
                    json.dump(data, f)
            return data
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code >= 500:
                STATS["retry"] += 1
                time.sleep(0.4 + random.random() * 0.6 + (0.5 * attempt if attempt > 6 else 0))
                continue
            if e.code == 404:
                return None
            raise RuntimeError(f"{e.code} {url}: {e.read()[:200]!r}")
        except (urllib.error.URLError, TimeoutError) as e:
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"gave up on {url}")

def paged(path, params, key):
    out, cursor = [], ""
    for _ in range(200):
        d = get(path, {**params, "cursor": cursor})
        if not d:
            break
        out += d.get(key, [])
        cursor = d.get("cursor") or ""
        if not cursor:
            break
    return out
