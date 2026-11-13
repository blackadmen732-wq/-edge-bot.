# Replay test

Replays past games through the bot's own decision code (`supabase/functions/edgebot/lib/decide.ts`, fees, sizing) to see whether the strategy would have made money, before any real money is risked.

## Result (October 2026)

**No edge found.**

- Kalshi's soccer prices sat on average 0.74¢ from the sharp books' fair price, across 5,958 markets from May 2025 to October 2026.
- Buying at Kalshi's asking price cleared the bot's 3% bar after fees in only 0.3% of markets.
- Under the bot's rules, 2,551 soccer games produced 23 bets. Measured against the sharp closing price, the best estimate of the true chance, those bets were worth −0.9% (95% range −4.7% to +2.9%).
- A $20 paper bankroll would have ended at $18.87.

The full numbers are in `results_soccer.json` and `results_us.json`. The tables behind the results dashboard are in `dashboard_data/`.

## How it works

1. **`list_markets.py`** lists every settled Kalshi game market (live and archived) for each league.
2. **`match_soccer.py`** matches Kalshi soccer games to football-data.co.uk files: Pinnacle odds where they exist, otherwise the Betfair exchange, plus the real results.
3. **`match_us.py`** does the same for NFL (average closing price of about 20 books) and 2025 college football (closing prices from 3 US books).
4. **`fetch_candles.py`** downloads Kalshi's hourly prices around each game. Kalshi rate-limits this, so a full run takes about an hour, and it caches everything.
5. **`replay.ts`** makes the decisions with the bot's real code:
   - Only prices from before bet time are used.
   - Waiting orders fill only if the price later trades below them.
   - Buys are capped at what was actually trading.
   - Games where two odds sources disagree by more than 4¢ are skipped, like the live bot.
   - Results are scored by real outcomes, and against the closing price.
6. **`summarize.py`** writes the dashboard tables.

## Run it

Run the data steps from an empty working folder:

```
python3 list_markets.py
python3 match_soccer.py
python3 match_us.py
python3 fetch_candles.py data/soccer_games.json 0.3
python3 fetch_candles.py data/us_games.json 0.3
```

Then run the replay from the repo root, using the files the data steps wrote:

```
node backtest/replay.ts <folder>/data/soccer_games_candles.json --out=backtest/results_soccer.json
node backtest/replay.ts <folder>/data/us_games_candles.json --us --out=backtest/results_us.json
python3 backtest/summarize.py
```

The data steps need these files in the working folder first:

- **Soccer odds:** football-data.co.uk CSVs in `cache/fd/`, named like `E0_2526.csv`.
- **US odds:**
  - the minmaxxxer NFL files from Hugging Face
  - the cfbfastR `cfb_line_odds.csv.gz` and `cfb_schedules_2025.csv` from GitHub

  Put these in `cache/us/`.

## Limits

- **Hourly prices only.** Price gaps that open and close within an hour aren't seen. If an edge exists, it's in the minutes after the sharp books move. Testing that needs minute-level sportsbook odds (The Odds API's paid historical data).
- **American football uses closing odds.** The bot bets an hour before kickoff, so those results get an hour of hindsight and flatter the bot.
- **Soccer pre-match odds are about 5 hours old at bet time.** Even so, the gap was smallest when the odds were fresh. It doesn't flatter the bot.

## Stocks: opening-range breakout replay (November 13, 2026)

**No edge found, and the loss is not noise.**

`stocks_fetch5m.py` downloads 60 days of 5-minute bars for 104 liquid US stocks and ETFs. `stocks_orb_replay.py` replays the `stocks` function's exact rule (`supabase/functions/stocks/orb.ts`) with no daily trade limit and 0.02% slippage on entries and stop exits.

| Rule (Aug 21 to Nov 13, 2026) | Trades | Wins | Avg per trade | t | 1st half | 2nd half |
|---|---|---|---|---|---|---|
| Bot as it is (15-min range, stop at middle, 1R target) | 2,408 | 47% | −0.071R | −3.7 | −0.129R | −0.023R |
| 2R target | 2,408 | 40% | −0.073R | −3.1 | −0.159R | −0.002R |
| Stop at range low | 2,436 | 47% | −0.034R | −2.2 | −0.079R | +0.003R |
| 30-min range | 1,848 | 47% | −0.047R | −2.3 | −0.144R | +0.031R |
| Only stocks that gapped up | 1,200 | 47% | −0.070R | −2.6 | −0.176R | +0.011R |

At the current settings ($1,000 max position, $25 max risk) the bot's rule loses about $0.37 per trade: −$902 over these 60 days. Raising the daily trade limit would only lose faster. The paper record can't pass the live gate while this holds.
