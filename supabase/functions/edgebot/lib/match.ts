// Matching Kalshi games to sportsbook games by team names and kickoff time.
// Conservative on purpose: if a match is at all ambiguous, we skip the game.

const WORD_ALIASES: Record<string, string> = {
  utd: "united",
  man: "manchester",
  nottm: "nottingham",
  intl: "international",
  ft: "fort",
  mt: "mount",
  so: "southern",
  wash: "washington",
  la: "los angeles",
  ny: "new york",
};

/** Whole-name aliases (after normalizing). Left side: how Kalshi/odds may write it. Right: canonical. */
const NAME_ALIASES: Record<string, string> = {
  "miami fl": "miami hurricanes",
  "miami florida": "miami hurricanes",
  "miami oh": "miami oh redhawks",
  "miami ohio": "miami oh redhawks",
  "ul monroe": "louisiana monroe",
  "ulm": "louisiana monroe",
  "ul lafayette": "louisiana",
  "louisiana lafayette": "louisiana",
  "ole miss": "mississippi",
  "pitt": "pittsburgh",
  "uconn": "connecticut",
  "umass": "massachusetts",
  "fiu": "florida international",
  "fau": "florida atlantic",
  "utep": "texas el paso",
  "utsa": "texas san antonio",
  "uab": "alabama birmingham",
  "unlv": "nevada las vegas",
  "smu": "southern methodist",
  "tcu": "texas christian",
  "byu": "brigham young",
  "ucf": "central florida",
  "usc": "southern california",
  "lsu": "louisiana state",
  "wolves": "wolverhampton wanderers",
  "spurs": "tottenham hotspur",
  "tottenham": "tottenham hotspur",
  "brighton": "brighton and hove albion",
  "newcastle": "newcastle united",
  "west ham": "west ham united",
  "leeds": "leeds united",
  "nottingham": "nottingham forest",
  "forest": "nottingham forest",
  "sheffield utd": "sheffield united",
  "psg": "paris saint germain",
  "paris sg": "paris saint germain",
  "inter": "inter milan",
  "internazionale": "inter milan",
  "atletico": "atletico madrid",
  "atl madrid": "atletico madrid",
  "athletic club": "athletic bilbao",
  "bayern": "bayern munich",
  "leverkusen": "bayer leverkusen",
  "dortmund": "borussia dortmund",
  "gladbach": "borussia monchengladbach",
  "lafc": "los angeles fc",
  "la galaxy": "los angeles galaxy",
  "nycfc": "new york city fc",
  "ny red bulls": "new york red bulls",
};

/** Odds API names often add a mascot ("Ohio State Buckeyes"); some canonical school names differ. */
const ODDS_NAME_FIXES: Record<string, string> = {
  "ucf knights": "central florida knights",
  "lsu tigers": "louisiana state tigers",
  "usc trojans": "southern california trojans",
  "byu cougars": "brigham young cougars",
  "tcu horned frogs": "texas christian horned frogs",
  "smu mustangs": "southern methodist mustangs",
  "unlv rebels": "nevada las vegas rebels",
  "utsa roadrunners": "texas san antonio roadrunners",
  "utep miners": "texas el paso miners",
  "uab blazers": "alabama birmingham blazers",
  "fiu panthers": "florida international panthers",
  "florida atlantic owls": "florida atlantic owls",
  "ole miss rebels": "mississippi rebels",
  "pittsburgh panthers": "pittsburgh panthers",
  "uconn huskies": "connecticut huskies",
  "umass minutemen": "massachusetts minutemen",
  "ul monroe warhawks": "louisiana monroe warhawks",
  "miami hurricanes": "miami hurricanes",
};

export function normalize(name: string): string {
  let s = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[().,'’]/g, " ")
    .replace(/[-/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // "st" means "state" except as the first word ("St. Louis" -> "saint louis").
  const words = s.split(" ").map((w, i) => {
    if (w === "st") return i === 0 ? "saint" : "state";
    return WORD_ALIASES[w] ?? w;
  });
  s = words.join(" ").replace(/\s+/g, " ").trim();
  if (NAME_ALIASES[s]) s = NAME_ALIASES[s];
  if (ODDS_NAME_FIXES[s]) s = ODDS_NAME_FIXES[s];
  return s;
}

/**
 * How well a (short) Kalshi team name fits a (long) sportsbook name. 1 = certain.
 * "ohio state" vs "ohio state buckeyes" -> 1 (prefix).
 * "ohio state" vs "ohio bobcats" -> low.
 */
export function nameScore(kalshiName: string, oddsName: string): number {
  const k = normalize(kalshiName).split(" ");
  const o = normalize(oddsName).split(" ");
  if (k.length === 0 || o.length === 0) return 0;
  // Exact or prefix match on whole words.
  if (k.length <= o.length && k.every((w, i) => o[i] === w)) {
    // Penalize when the Kalshi name is a strict prefix of a *longer place name*,
    // e.g. "miami" vs "miami oh redhawks" — still decent, the opponent check settles it.
    return k.length === o.length ? 1 : 0.95;
  }
  if (o.length <= k.length && o.every((w, i) => k[i] === w)) return 0.9;
  // Last Kalshi word abbreviated: "los angeles r" vs "los angeles rams", "new york g" vs "new york giants".
  if (k.length <= o.length && k.length >= 2) {
    const last = k.length - 1;
    if (k.slice(0, last).every((w, i) => o[i] === w) && o[last].startsWith(k[last])) return 0.9;
  }
  // All Kalshi words appear somewhere in the sportsbook name.
  const oset = new Set(o);
  const hits = k.filter((w) => oset.has(w)).length;
  if (hits === k.length) return 0.85;
  // Otherwise Jaccard overlap.
  const union = new Set([...k, ...o]).size;
  return hits / union;
}

export interface OddsGame {
  id: string;
  commence: string; // ISO
  home: string;
  away: string;
}

export interface KalshiGame {
  eventTicker: string;
  /** Two team names (not including "Tie"). */
  teams: [string, string];
  /** Best guess of kickoff from Kalshi, ISO. May be null. */
  startHint: string | null;
}

export interface MatchResult {
  game: OddsGame;
  /** Kalshi team index -> odds outcome name. */
  mapping: [string, string];
  confidence: number;
}

const MIN_TEAM_SCORE = 0.8;
const MAX_HOURS_APART = 30;

/** Find the one sportsbook game that matches a Kalshi game, or null if none / ambiguous. */
export function matchGame(kg: KalshiGame, games: OddsGame[]): MatchResult | null {
  const scored: MatchResult[] = [];
  for (const g of games) {
    if (kg.startHint) {
      const hours = Math.abs(Date.parse(g.commence) - Date.parse(kg.startHint)) / 3.6e6;
      if (!Number.isFinite(hours) || hours > MAX_HOURS_APART) continue;
    }
    const a1 = nameScore(kg.teams[0], g.home), b1 = nameScore(kg.teams[1], g.away);
    const a2 = nameScore(kg.teams[0], g.away), b2 = nameScore(kg.teams[1], g.home);
    if (Math.min(a1, b1) >= MIN_TEAM_SCORE && a1 + b1 >= a2 + b2) {
      scored.push({ game: g, mapping: [g.home, g.away], confidence: (a1 + b1) / 2 });
    } else if (Math.min(a2, b2) >= MIN_TEAM_SCORE) {
      scored.push({ game: g, mapping: [g.away, g.home], confidence: (a2 + b2) / 2 });
    }
  }
  if (scored.length === 0) return null;
  scored.sort((x, y) => y.confidence - x.confidence);
  // Two equally good candidates (e.g. a rematch inside the window) -> refuse.
  if (scored.length > 1 && scored[0].confidence - scored[1].confidence < 0.1) return null;
  return scored[0];
}

/** True if a Kalshi market's team label is the draw/tie outcome. */
export function isTieLabel(label: string): boolean {
  const s = label.trim().toLowerCase();
  return s === "tie" || s === "draw" || s === "tie game";
}
