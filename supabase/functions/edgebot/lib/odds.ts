// The Odds API client + turning sharp-book prices into fair win chances.
// Docs: https://the-odds-api.com/liveapi/guides/v4/

import { averageFair, devigPower, maxDisagreement } from "./pricing.ts";
import { HARD, REFERENCE_BOOKS, SHARP_BOOKS } from "./rules.ts";

export interface OddsEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: {
    key: string;
    title: string;
    markets: { key: string; last_update: string; outcomes: { name: string; price: number }[] }[];
  }[];
}

export interface FetchResult {
  events: OddsEvent[];
  remaining: number | null;
  used: number | null;
  last: number | null;
}

/** One call = 1 credit (h2h market, up to 10 bookmakers). */
export async function fetchOdds(apiKey: string, sport: string, fromIso: string, toIso: string): Promise<FetchResult> {
  const url = new URL(`https://api.the-odds-api.com/v4/sports/${sport}/odds/`);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("markets", "h2h");
  url.searchParams.set("oddsFormat", "decimal");
  url.searchParams.set("bookmakers", [...SHARP_BOOKS, ...REFERENCE_BOOKS].slice(0, 10).join(","));
  url.searchParams.set("commenceTimeFrom", fromIso.replace(/\.\d{3}Z$/, "Z"));
  url.searchParams.set("commenceTimeTo", toIso.replace(/\.\d{3}Z$/, "Z"));
  const res = await fetch(url);
  const num = (h: string) => {
    const v = res.headers.get(h);
    return v === null ? null : Number(v);
  };
  if (res.status === 404) return { events: [], remaining: num("x-requests-remaining"), used: num("x-requests-used"), last: num("x-requests-last") };
  if (!res.ok) throw new Error(`Odds API ${sport} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return {
    events: await res.json(),
    remaining: num("x-requests-remaining"),
    used: num("x-requests-used"),
    last: num("x-requests-last"),
  };
}

export interface FairLine {
  source: "pinnacle" | "sharp_consensus";
  fair: Record<string, number>;
  books: Record<string, Record<string, number>>;
  note?: string;
}

/**
 * Fair win chances for one game. Pinnacle (no-vig) is the answer key; other sharp books are a
 * cross-check. Returns null (skip the game) if prices are stale, missing or disagree.
 */
export function fairLine(ev: OddsEvent, threeWay: boolean, now = Date.now()): FairLine | null {
  const books: Record<string, Record<string, number>> = {};
  const fairBySharpBook: Record<string, Record<string, number>> = {};
  for (const b of ev.bookmakers ?? []) {
    const m = (b.markets ?? []).find((x) => x.key === "h2h");
    if (!m) continue;
    const ageMin = (now - Date.parse(m.last_update)) / 60000;
    const prices: Record<string, number> = {};
    for (const o of m.outcomes ?? []) prices[o.name] = Number(o.price);
    books[b.key] = prices;
    if (!(ageMin <= HARD.MAX_ODDS_AGE_MINUTES)) continue;
    const want = threeWay ? 3 : 2;
    if (Object.keys(prices).length !== want) continue;
    if (!SHARP_BOOKS.includes(b.key)) continue;
    const f = devigPower(prices); // power method: proportional leaves long shots too high
    if (f) fairBySharpBook[b.key] = f;
  }
  const others = Object.entries(fairBySharpBook).filter(([k]) => k !== "pinnacle").map(([, f]) => f);
  const consensus = averageFair(others);
  const pin = fairBySharpBook["pinnacle"];
  if (pin) {
    if (consensus && maxDisagreement(pin, consensus) > HARD.MAX_SOURCE_DISAGREEMENT) return null;
    return { source: "pinnacle", fair: pin, books };
  }
  // No fresh Pinnacle line: need at least two other sharp books that agree with each other.
  if (others.length >= 2 && consensus) {
    for (const f of others) if (maxDisagreement(f, consensus) > HARD.MAX_SOURCE_DISAGREEMENT) return null;
    return { source: "sharp_consensus", fair: consensus, books, note: `${others.length} sharp books` };
  }
  return null;
}
