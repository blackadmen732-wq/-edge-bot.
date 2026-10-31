# Edge Bot — football price checker

## Research workspace

The companion `edge-research` service adds a durable data archive, outcome/failure analysis, versioned calibration experiments, an authenticated MCP connection for Grok Bot, bounded optional AI investigations, and a standalone research dashboard. See [the research setup and connection guide](docs/research-system.md). Research model versions do not change execution settings.

A bot that compares Kalshi's football prices with what the sharpest sportsbooks say each team's real chance is, and bets small only when Kalshi's price is wrong by more than the fees. It starts with fake money (paper trading). Real money stays locked until it has earned it.

**Plain truth:** most people who bet on sports lose. This bot is built to find out *whether* it has an edge, cheaply and honestly, not to promise one. Treat any real money you put in as money you can afford to lose.

## How it works

1. **Every 6 hours (scan):** pulls the open Kalshi game markets for your leagues, pulls Pinnacle's odds (plus other sharp books as a cross-check) from The Odds API, removes the sportsbook's cut to get each team's fair chance, and matches each Kalshi game to the sportsbook game by team names and kickoff time. If anything is unclear (names don't match, prices are stale, books disagree) it skips the game.
2. **Decides:** if Kalshi's asking price is cheap enough that the expected profit is at least 3% after Kalshi's fee, it buys. Otherwise it may post a cheaper waiting order that only fills if someone sells to it at that price. Bet size is a quarter of the "Kelly" amount, capped hard.
3. **Every 30 minutes (check-in):** fills or cancels waiting orders, records Kalshi's price right before kickoff (to measure "beat the close"), settles finished games, and pauses everything if the bankroll hits the stop level.
4. **Mondays:** emails you a weekly report (once email is set up), with an optional plain-English summary written by Claude or Grok. It also emails you each time a bankroll passes another $1,000, and keeps going.

Every market it looks at, and why it bet or passed, is saved, so you can see its reasoning.

## Replay test result (October 2026): no edge found

Before any real money, the bot's exact decision code was replayed on past games: 2,551 soccer games since May 2025, 388 NFL and 848 college football games. Details are in `backtest/README.md`.

- **Soccer:** Kalshi's price sat on average 0.74¢ from the sharp books' fair price. Only 23 bets came up, and they were worth −0.9% against the closing price.
- **College football:** the bot's 83 bets won 24% of the time, against the 31% the sportsbooks implied, and lost money. When Kalshi disagreed with the sportsbooks, Kalshi was usually right.
- **NFL:** too efficient to find bets (3 in two seasons).

**Bottom line:** don't fund this strategy with real money as it stands. Paper trading is free and can keep running. The only untested idea is reacting within minutes of sharp-book moves, which needs minute-level odds data.

## Rules it can't break

These are in the code (`supabase/functions/edgebot/lib/rules.ts`). Settings in the database can make them stricter, never looser.

| Rule | Limit |
|---|---|
| Biggest single bet | 5% of the bankroll, and never more than $300 |
| Winnings | No ceiling. It keeps going and emails you each time the bankroll passes another $1,000 |
| Money riding at once | 30% of the bankroll (hard cap 40%) |
| Bets per day | 5 (hard cap 10), one per game |
| Minimum expected profit | 3% after fees (hard floor 2%) |
| Long shots / heavy favorites | Skips anything under 15% or over 85% (hard band 8–92%) |
| Live betting | Never. Stops 1 hour before kickoff (hard floor 30 minutes) |
| Stale or disputed prices | Skips if sportsbook prices are over 60 minutes old or the sharp books disagree by more than 4 points |
| Stop level | Pauses itself at $10 (hard floor $5) and emails you |
| Real money unlock | Needs 50 finished paper bets, paper trading in profit, your Kalshi key, **and** the real-money switch. All four. |

## What's already running

- **Database:** a separate `edgebot` section inside your Supabase project `supabase-cyan-ball`. It doesn't touch your review app's tables, and it isn't reachable through the public API.
- **Engine:** the Supabase Edge Function `edgebot`.
- **Schedule:** scans at :07 past every 6th hour (UTC), check-ins at :03 and :33 every hour, weekly report Mondays 13:05 UTC (9:05 AM Eastern).
- **Dashboard:** a Claude dashboard called "Edge Bot" with live numbers from the database.
- **Leagues:** college football, NFL, and the English Championship (second-tier English soccer). Less-watched games are where prices are most often off.

## How code gets to Supabase (one way only)

GitHub `main` is the only source of truth. Every push to `main` runs all the tests, then deploys both Supabase functions (`edgebot` and `edge-research`) automatically through `.github/workflows/ci-deploy.yml`. Pull requests run the tests but never deploy.

Rules that stop the two drifting apart again:

1. Never deploy from a feature branch, a chat, or the Supabase dashboard. Merge to `main` and let the workflow deploy.
2. Database changes go in `supabase/migrations/` and are applied once by hand (SQL Editor or Claude). The workflow does not touch the database.
3. If a deploy fails, the old version keeps running. Fix forward on `main`.

**One-time setup:**

1. Create a Supabase access token at https://supabase.com/dashboard/account/tokens.
2. In GitHub: this repo → Settings → Secrets and variables → Actions → New repository secret. Name `SUPABASE_ACCESS_TOKEN`, value the token.
3. If runs show "startup failure", GitHub Actions is off or blocked for this account: check repo Settings → Actions → General ("Allow all actions"), and account Settings → Billing for a spending block on private repos.

Until the token is added, the workflow still runs the tests and skips the deploy with a warning.

## What you need to do (about 10 minutes)

The bot can't find bets until it has a sportsbook odds key. Secrets go into Supabase yourself, never into chat.

### 1. Free sportsbook odds key (required)

1. Sign up for the free plan at https://the-odds-api.com (500 credits a month, no card).
2. Copy your API key from the email or your account page.
3. Open your project's secrets page: https://supabase.com/dashboard/project/mhahkbssltukjhusjsjf/functions/secrets
4. Add a secret named `ODDS_API_KEY` with your key as the value. Save.

The next scan picks it up. Each scan uses about 1 credit per league with games coming up, so about 360 credits a month for 3 leagues. The dashboard shows what's left.

### 2. Weekly email (optional)

1. In Resend (https://resend.com/api-keys), create an API key with **Sending access**.
2. On the same Supabase secrets page add:
   - `RESEND_API_KEY` = that key
   - `REPORT_EMAIL` = the email address you want reports sent to
3. Until you verify a domain in Resend, Resend's test sender can only send to your own Resend account email, so use that address.

### 3. AI summary in the weekly email (optional, Claude or Grok)

The AI reads the bot's numbers and writes 4–6 plain sentences at the top of the weekly email. It **only explains**; it never picks bets, sizes bets or changes settings (tests of AI "pickers" show they don't beat market prices).

Pick one:

- **Claude:** sign in at https://platform.claude.com → Billing → add $5 of credit → API keys → Create key.
  Add the secret `ANTHROPIC_API_KEY` on the Supabase secrets page. The default model is `claude-haiku-5-5`.
- **Grok:** sign in at https://console.x.ai → add $5 of credit → API keys → Create key.
  Add the secret `XAI_API_KEY`. The default model is `grok-4.3`.

Optional extras:

- `AI_PROVIDER` = `anthropic` or `xai` picks one when both keys are set.
- `AI_MODEL` changes the model.

Cost is well under $1 a month (one short message a week), so $5 lasts a long time. A Claude Pro or Max chat subscription is separate from API credit. If the key is missing or the AI is down, the email still goes out without the summary.

### 4. Real money (later, only after paper trading passes)

Don't do this until the dashboard shows 50 finished paper bets **and** a paper profit.

1. Check Kalshi is allowed where you live. Sports contracts are currently blocked in some states (including Nevada, Washington and Michigan) and are being fought in court in others. You must be 18+ and verify your ID and SSN.

   **Florida (checked October 2026):** Kalshi is open to Florida residents 18+, and the state has taken no enforcement action. But the Governor has questioned it and the Attorney General has named prediction markets as a target, so this could change. Re-check before you deposit, and never use a VPN or a different address to get around a block.
2. Open and fund a Kalshi account with the amount you're prepared to lose (for example $20).
3. In Kalshi: Account → API keys → create a key. You get a **Key ID** and a **private key file** (`.key`). The file is shown once; save it.
4. On the Supabase secrets page add:
   - `KALSHI_API_KEY_ID` = the Key ID
   - `KALSHI_PRIVATE_KEY` = the full contents of the `.key` file, including the `-----BEGIN` and `-----END` lines
   - `LIVE_TRADING_ENABLED` = `true`
5. Ask Claude to "switch Edge Bot to real money". The bot checks all four conditions and refuses if any is missing. Paper trading keeps running alongside so you can compare.

To stop at any time: ask Claude to pause it, or delete `LIVE_TRADING_ENABLED` from the secrets page.

### Getting paid

Winnings land in your **Kalshi balance**. The bot can't move money out; only you can, in the Kalshi app.

- **Deposit:** Cash App works for deposits.
- **Withdraw:**
  1. Go to Kalshi → Withdraw.
  2. Pick a bank transfer (ACH, free, 1–3 days), a debit card (fast; a Cash App Card may work as one), PayPal or Venmo.
  3. To end up in Cash App, either withdraw to the Cash App Card, or withdraw to your bank and move it from there.

Withdrawing locks winnings in. Anything left on Kalshi is still at risk.

- **Taxes:** Kalshi doesn't send a 1099 for trading profits, but profits are still taxable. Keep the bot's records (the dashboard and weekly emails) and ask a tax preparer how to report them.

## Market making on weather markets (paper only)

The replay test showed that betting one side when Kalshi "looks wrong" doesn't work: Kalshi's price is usually the better guess. So the bot also tries the other approach: **being the house**. Every 30 minutes it posts a buy price and a sell price on daily high-temperature markets in six cities (New York, Chicago, Miami, Austin, Los Angeles, Denver) and earns the gap when other people trade with it. **Fake money only.** There is no real-money path for this in the code.

How it decides:

1. **Starts from Kalshi's own price** (middle of the best buy and sell). A free forecast (Open-Meteo) may nudge it by at most 3¢. Never the other way round.
2. **Inventory limits.** The more it owns in a market, the lower both its prices go, and at the limit (60 contracts) it stops adding. If money at risk nears the $500 fake bankroll, it only quotes the side that shrinks positions.
3. **Steps aside before news.** No quotes while a weather model update (GFS, ECMWF) or NWS forecast is due, and none on a market's own day after 10 AM local time, when live readings take over.
4. **Honest fake fills.** A quote only fills if a real Kalshi trade printed *through* its price after it was posted. It's assumed to be last in line.
5. **"Picked off" score.** An hour after each fill it checks where the price went. Negative on average means better-informed traders are hitting its stale prices. This is the market-making version of "beat the close".
6. **Liquidity rewards estimate.** It tracks how often both quotes sat near the best prices and whether they were big enough (100+ contracts per side) for Kalshi's Liquidity Incentive Program, which runs until January 1, 2027.
7. **Sells overpriced long shots.** When the forecast puts a bracket at 8% or less but the market charges at least 3¢ more, it posts a sell-only quote there.
8. **Alerts.** Email (and phone, see below) for big fills, inventory limits, the daily loss limit ($25) and pauses, at most once every few hours each.

Settings live in `edgebot.settings` (`mm_*` columns) and can only be made stricter than the hard caps in `lib/mm.ts`. To turn it off: `update edgebot.settings set mm_enabled = false where id = 1;`

### Switching market making on (about 5 minutes)

1. **Database:** in Supabase open **SQL Editor**, paste all of `supabase/migrations/002_market_making.sql`, and click **Run**. It adds the tables and the 30-minute schedule.
2. **Engine:** deploy the updated `edgebot` function (Edge Functions → edgebot → Code): replace `index.ts`, `lib/kalshi.ts`, `lib/rules.ts` and `lib/odds.ts`, and add the new files `lib/mm.ts` and `lib/weather.ts`. Then click **Deploy**.
3. **Phone alerts (optional):** install the free **ntfy** app, subscribe to a long random topic name only you know (for example `edgebot-` plus 20 random letters), and add it as the secret `NTFY_TOPIC` on the Supabase secrets page.

The weather series tickers are a best guess. If the run log says a series has no open markets, list the real ones with `?task=discover&category=Climate` and update `mm_series`.

**Plain truth:** published tests found free forecasts don't beat Kalshi's weather prices, and the weather book has tightened a lot in 2026. Market making could still work because it earns the gap instead of predicting, but it loses money when faster, better-informed traders pick off its prices. Judge it on the "picked off" score and profit after a few hundred fills, not a few days.

## How to read the results

- **Won–lost and profit over a few dozen bets are mostly luck.** A strategy with no edge wins 57%+ of 50 coin-flip bets about 1 time in 6.
- **"Beat the closing price"** is the early signal that matters: if the bot keeps buying below Kalshi's price at kickoff, the market is moving its way. Positive and steady over 100+ bets is a real sign; around zero means no edge.
- **Fees are big on tiny bets.** Kalshi rounds its fee up to the next cent on every order, so a $0.50 bet can pay 4%.

## Files

```
supabase/migrations/001_edgebot.sql     database tables (already applied)
supabase/migrations/002_market_making.sql  market-making tables and schedule (run once in the SQL Editor)
supabase/functions/edgebot/index.ts     the engine: scan, check-in, report, dashboard data, controls
supabase/functions/edgebot/lib/
  rules.ts      hard limits and leagues
  pricing.ts    Kalshi fees, fair odds, expected value, bet sizing
  odds.ts       The Odds API + Pinnacle answer key
  match.ts      matching Kalshi games to sportsbook games
  decide.ts     bet now / wait / skip
  kalshi.ts     Kalshi market data + signed order requests
  ai.ts         optional Claude/Grok writer for the weekly summary (explains only)
  mm.ts         market making (paper only): quotes, inventory limits, news windows, fake fills, accounting
  weather.ts    free Open-Meteo daily high forecasts
dashboard/index.html                    stand-alone dashboard you can host anywhere (reads the engine's public dashboard data)
dashboard/claude-dashboard/index.html   the page behind the Claude dashboard
tests/core.test.ts                      32 tests of the math, matching, caps, AI writer and request signing (node --test tests/core.test.ts)
tests/mm.test.ts                        15 market-making tests (node --test tests/mm.test.ts)
tests/e2e/                              15 end-to-end tests: real engine, in-memory database, fake Kalshi/odds/email/AI (tests/e2e/run.sh, needs Deno)
```

## Adding leagues

Leagues live in `LEAGUES` in `lib/rules.ts` (La Liga, Serie A, Bundesliga, Ligue 1, MLS, Champions League and the Premier League are already defined). Turn one on by asking Claude, or in SQL:

```sql
update edgebot.settings set leagues = array['ncaaf','nfl','eflchamp','mls'] where id = 1;
```

Each extra league costs about 120 odds credits a month on the free plan.

Not financial or legal advice.

