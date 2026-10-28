// Hard rules baked into the code. Database settings can make these stricter, never looser.

export const HARD = {
  /** Never stake more than this on one bet, whatever the bankroll. (There is no ceiling on winnings.) */
  MAX_STAKE_USD: 300,
  /** Email the owner each time the bankroll passes another multiple of this. The bot keeps going. */
  MILESTONE_STEP_USD: 1000,
  /** Never stake more than this share of the bankroll on one bet. */
  MAX_STAKE_PCT: 0.05,
  /** Never have more than this share of the bankroll riding at once. */
  MAX_OPEN_EXPOSURE_PCT: 0.4,
  /** Never place more than this many bets in 24 hours. */
  MAX_BETS_PER_DAY: 10,
  /** Never bet with less than this expected profit per $1 after fees. */
  MIN_EDGE_FLOOR: 0.02,
  /** Never bet on prices outside this probability band (long shots / huge favorites). */
  PROB_FLOOR: 0.08,
  PROB_CEILING: 0.92,
  /** Never bet on a game starting sooner than this (no live betting). */
  MIN_MINUTES_BEFORE_START: 30,
  /** Ignore sportsbook prices older than this. */
  MAX_ODDS_AGE_MINUTES: 60,
  /** Skip if Pinnacle and the other sharp books disagree by more than this. */
  MAX_SOURCE_DISAGREEMENT: 0.04,
  /** Real money only after this many settled paper bets... */
  LIVE_GATE_MIN_SETTLED_PAPER: 50,
  /** ...and only if paper trading is in profit. */
  LIVE_GATE_REQUIRE_PAPER_PROFIT: true,
  /** Bot pauses itself at or below this balance (settings can raise it). */
  STOP_BALANCE_FLOOR: 5,
} as const;

export interface League {
  key: string;
  name: string;
  /** Kalshi series tickers for single-game winner markets. */
  series: string[];
  /** The Odds API sport key. */
  oddsSport: string;
  /** Soccer has a draw outcome. */
  threeWay: boolean;
}

export const LEAGUES: Record<string, League> = {
  ncaaf: { key: "ncaaf", name: "College football", series: ["KXNCAAFGAME"], oddsSport: "americanfootball_ncaaf", threeWay: false },
  nfl: { key: "nfl", name: "NFL", series: ["KXNFLGAME"], oddsSport: "americanfootball_nfl", threeWay: false },
  epl: { key: "epl", name: "Premier League", series: ["KXEPLGAME"], oddsSport: "soccer_epl", threeWay: true },
  eflchamp: { key: "eflchamp", name: "EFL Championship", series: ["KXEFLCHAMPIONSHIPGAME"], oddsSport: "soccer_efl_champ", threeWay: true },
  laliga: { key: "laliga", name: "La Liga", series: ["KXLALIGAGAME"], oddsSport: "soccer_spain_la_liga", threeWay: true },
  seriea: { key: "seriea", name: "Serie A", series: ["KXSERIEAGAME"], oddsSport: "soccer_italy_serie_a", threeWay: true },
  bundesliga: { key: "bundesliga", name: "Bundesliga", series: ["KXBUNDESLIGAGAME"], oddsSport: "soccer_germany_bundesliga", threeWay: true },
  ligue1: { key: "ligue1", name: "Ligue 1", series: ["KXLIGUE1GAME"], oddsSport: "soccer_france_ligue_one", threeWay: true },
  mls: { key: "mls", name: "MLS", series: ["KXMLSGAME"], oddsSport: "soccer_usa_mls", threeWay: true },
  ucl: { key: "ucl", name: "Champions League", series: ["KXUCLGAME"], oddsSport: "soccer_uefa_champs_league", threeWay: true },
};

/** Sharp bookmakers, in order of trust. One Odds API call covers up to 10 of these for 1 credit. */
export const SHARP_BOOKS = ["pinnacle", "betfair_ex_eu", "matchbook", "smarkets", "lowvig", "betonlineag"];
/** Retail books we fetch only for reference (never used as the answer key on their own). */
export const REFERENCE_BOOKS = ["draftkings", "fanduel"];

export interface Settings {
  mode: "paper" | "live" | "paused";
  paused_reason: string | null;
  leagues: string[];
  order_style: "taker" | "smart";
  min_edge: number;
  min_prob: number;
  max_prob: number;
  kelly_fraction: number;
  max_stake_pct: number;
  max_bets_per_day: number;
  max_open_exposure_pct: number;
  stop_balance: number;
  paper_start_bankroll: number;
  min_hours_before_start: number;
  max_hours_before_start: number;
  resting_order_minutes: number;
  report_email: string | null;
}

/** Apply hard caps on top of whatever is in the database. */
export function effectiveSettings(s: Settings): Settings {
  return {
    ...s,
    min_edge: Math.max(Number(s.min_edge), HARD.MIN_EDGE_FLOOR),
    min_prob: Math.max(Number(s.min_prob), HARD.PROB_FLOOR),
    max_prob: Math.min(Number(s.max_prob), HARD.PROB_CEILING),
    kelly_fraction: Math.min(Math.max(Number(s.kelly_fraction), 0), 0.5),
    max_stake_pct: Math.min(Number(s.max_stake_pct), HARD.MAX_STAKE_PCT),
    max_bets_per_day: Math.min(Number(s.max_bets_per_day), HARD.MAX_BETS_PER_DAY),
    max_open_exposure_pct: Math.min(Number(s.max_open_exposure_pct), HARD.MAX_OPEN_EXPOSURE_PCT),
    stop_balance: Math.max(Number(s.stop_balance), HARD.STOP_BALANCE_FLOOR),
    min_hours_before_start: Math.max(Number(s.min_hours_before_start), HARD.MIN_MINUTES_BEFORE_START / 60),
    max_hours_before_start: Math.min(Number(s.max_hours_before_start), 168),
    resting_order_minutes: Math.min(Math.max(Number(s.resting_order_minutes), 15), 360),
    paper_start_bankroll: Number(s.paper_start_bankroll),
    leagues: (s.leagues ?? []).filter((k) => k in LEAGUES),
  };
}
