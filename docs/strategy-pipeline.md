# Strategy pipeline: how a bot idea goes from guess to real money (owner's plan, Nov 13 2026)

Every strategy walks the same road. It moves forward only by passing a gate, and any gate can send it back or kill it.
Nothing skips a stage. Research is unlimited; real money is earned.

| Stage | What happens | Limits | Gate to move on |
|---|---|---|---|
| 0. Idea | A rule written so a computer can test it (from the owner, an agent reading research, or the arena) | none | it can be replayed on past data |
| 1. Arena / replay | Tested on years of past prices against the average stock in its group, after costs (`backtest/stock_arena.py`, `insider_test.py`) | **none**: any number of rules, trades, sizes | clears the luck bar (rises with every rule tried) AND wins on the newest data it never saw |
| 2. Fresh confirm | The exact rule, fixed in advance, on stocks or dates it has never touched | none | still positive, z ≥ 2 |
| 3. Cost and capacity | Real spread per stock; max trade = 1% of the stock's daily dollar volume | none | still positive after real costs; capacity worth the work |
| 4. Paper | Runs live on the paper account, real prices, no real money | hard caps (`STOCK_HARD`) so results stay realistic | 30+ closed trades, average inside the backtest's expected range |
| 5. Live, small | **Owner flips it** (`STOCKS_LIVE_ENABLED`, live keys, `go_live`) | hard caps; starts at ~10% of capacity | 30+ live trades matching paper |
| 6. Scale | Size steps up toward capacity, one step at a time | raising `STOCK_HARD` is an owner PR | live results keep matching |
| 7. Retire | Edges fade once others find them | — | — |

## Stop switches (always on)

- **Per strategy:** auto-pause if, after 30 trades, its live average falls below the backtest's low end, or it hits its drawdown limit.
- **Daily loss limit:** stops new trades for the day (already in `stocks`).
- **Global:** `stocks?task=control` `pause` stops everything; owner only to restart live.
- **Skipped runs are warnings** in the status report, never "healthy".

## Money

The ceiling is not ambition, it is capacity: how much a rule can trade before its own orders move the price.
Ugly-stock edges are small per strategy (that's why big funds leave them). Scale comes from many unrelated small edges
running side by side (the "spider web"), each sized to its own capacity.
