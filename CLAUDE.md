# Edge Bot: how to work here (cheap mode)

Paper-trading research bot on Supabase (project ref `mhahkbssltukjhusjsjf`). Five edge functions:
`edgebot` (Kalshi football scan, weather market making, forex analysis), `edge-research`
(data collectors, datasets, patterns) and `parallax-money` (read-only paper-money curve for the dashboard) and `stocks` (opening-range breakout day trades through Alpaca, paper by default) and `wx-score` (weather scoreboard: Kalshi price vs ensemble forecast vs outcome; places no orders). GitHub `main` deploys itself after tests (`.github/workflows/ci-deploy.yml`).

## The path for any change

1. **Find, don't read.** `grep -n` first. Never read `supabase/functions/edgebot/index.ts` (1,100 lines) whole.
2. **Change the least code** that does the job. No drive-by refactors.
3. **Run only the tests for what you touched:**
   - `edgebot/lib/pricing|decide|rules|match|odds|kalshi|ai.ts` → `node --test tests/core.test.ts`
   - `edgebot/lib/mm.ts|weather.ts` → `tests/mm.test.ts`
   - `edgebot/lib/forex.ts` → `tests/forex.test.ts`
   - `edge-research/*` → `tests/research.test.ts tests/connections.test.ts tests/extra-connections.test.ts tests/parallax-patterns.test.ts`
   - `dashboard/desk/*` → `tests/desk.test.mjs tests/black-hole-calculations.test.mjs`
   - `edgebot/index.ts` → core + mm + forex
   - `parallax-money/*` → `tests/parallax-money.test.ts`
   - `stocks/*` → `tests/stocks.test.ts`
   - `wx-score/*` → `tests/wx-score.test.ts`
4. **Ship.** Is it in the "needs a PR" list below?
   - **No** → one commit straight to `main`, push. CI tests it and deploys it. Done. Don't wait for CI.
   - **Yes** → one PR, say what it needs, stop. Don't watch it.
5. **Tell the owner in 1–3 lines.** Blunt and casual. No recap of steps.

**Needs a PR (everything else goes straight to main):**
- Anything touching real money: `KalshiTrader`, `liveGate`, `placeBet`'s live branch, `HARD` in `lib/rules.ts`, `MM_HARD` in `lib/mm.ts`, anything in `supabase/functions/stocks/` (`STOCK_HARD`, `Alpaca`, the live gate).
- New file in `supabase/migrations/`.
- Changes across more than ~5 files.

## Don't burn money

- No scheduled check-ins or PR watching. No re-running CI. No waiting on bots.
- Ignore ECC Tools and Qodo comments: their plans have run out and they never review anything.
- Codex review: fix a finding only if you can trace a real failure; otherwise ignore it. Never open a PR just for a bot finding.
- Batch: one commit per task, not one per fix.
- Use the `checker` agent (cheap model) for "check this / review this" instead of reviewing on the main model.

## Never

- Deploy by hand, or from a branch. Push to `main`; the workflow deploys.
- Edit a migration that has already been applied. Add a new one, and apply it once via the Supabase SQL tool.
- Loosen a hard cap, add a real-money path to market making or forex, or turn on live trading yourself.
  The owner approved one real-money path (Nov 6): `stocks`, behind `STOCK_HARD` and its live gate. Only the owner flips it live.
- Put a secret in code, a commit, a comment or chat. Keys go into Supabase secrets, typed by the owner.

## Facts worth not re-discovering

- Weather market making quotes at :18/:48 UTC, but steps aside during model-update windows (`NEWS_WINDOWS_UTC`).
- Football finds nothing until `ODDS_API_KEY` exists. The replay test found no football edge (`backtest/README.md`).
- Two DB test files need `npm ci --prefix tests/e2e/db` (PGlite). Some sandboxes block that package; CI runs them.
- GitHub billing was paid Nov 6; Actions runs start again. Code deployed before then may lag `main`.
- Weather (Nov 6): Kalshi's price beat our single-number forecast (Brier 0.166 vs 0.246 on 102 markets); long-shot selling lost $165.
  So `mm_tail_max_prob` and `mm_forecast_weight` are 0. Money follows a forecast only after `wx-score?task=board` says EARNED.
- `.claude/skills/trader-*` is the MIT day-trader-skill pack (Jake Schincariol), copied as-is for chat use. The `stocks` function is our own code, not those scripts.
- Football bets so far are all waiting orders that expired unfilled, exactly as the replay predicted.
