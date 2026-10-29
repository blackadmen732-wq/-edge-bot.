# Edge Bot Forex Lab — integration and review

This is an **additive research-only module**. It does not change any Kalshi betting, market-making, scheduler, live gate, secrets, or existing database tables. It does not place orders or produce guaranteed price forecasts.

## Existing project audit, October 29 2026

The current main branch already contains:
- Supabase Edge Function with scan/tick/report/mm/control tasks and PostgreSQL storage
- Kalshi orders and sports odds integration, decision math, sizing, fee accounting and caps
- Paper prediction-market trading, a separate simulated weather market-making engine
- Backtest/replay scripts, two dashboard versions, tests and optional Claude/Grok weekly explanations
- An existing live Kalshi order pathway behind a gate; it must remain disabled in this upgrade

**Evidence:** repository backtests in backtest/README.md report no established profitable edge: 23 soccer bets estimated -0.9% versus sharp closing prices; college football bets underperformed implied win chance. Nothing in this upgrade changes that finding.

**Gaps:** no forex OHLC feed, chart-pattern engine, forex risk/P&L ledger, forex economic calendar connection, historical FX data provenance, trained forex ML models, or forex broker API integration in existing main.

## Added files

- supabase/functions/edgebot/lib/forex.ts — five transparent deterministic analysis components.
- supabase/functions/edgebot/index.ts — authenticated POST ?task=forex route.
- dashboard/forex.html — upload CSV candles, see close-price chart and agent reasoning; never stores control token.
- tests/forex.test.ts — input validation, no-lookahead, news, risk, indicator and signal regression tests.

## Five research components

1. Pattern: most recent closed candle; bullish/bearish engulfing, hammer/shooting-star shapes, inside bar, 20-candle breakout. Hammer/star **shapes are not a directional entry signal** by themselves.
2. Quant: SMA20, SMA50, RSI14, ATR14, 20-candle range in pips, 20-period return; no invented historical win rate.
3. Macro: treats event-calendar data as unknown unless a caller supplies a recent **complete, verified** calendar snapshot and events. Flags high-impact events touching either side of a pair within +/-60 minutes.
4. Risk: requires known spread, fresh candle, supplied paper equity/drawdown and a clear macro snapshot. Max 2 pip spread; paper max loss at stop 0.25% equity; max gross notional 1x equity; 5% paper drawdown blocks. Position size is a calculation, not an order.
5. Strategy: WATCH_LONG/SHORT only on aligned directional pattern + SMA trend with passing research gates. All other cases NO_TRADE. Watch is a research label **not permission to execute a trade**.

Supported pairs: EUR_USD, GBP_USD, USD_JPY. Inputs are **closed** UTC OHLC bars of 1/5/15/30/60/240 minutes, 60-5000 bars.

## Connect it to the existing Edge Function

Deploy the branch's updated Edge Function code (including lib/forex.ts) using your existing deployment process. This branch does not deploy itself and no environment changes are needed.

The new endpoint is protected with the **same** existing x-edgebot-token as control operations. Never put this token or broker keys into repo files or public web pages. Route is POST only, capped at 1MB JSON.

Example payload (pseudocode, not enough bars to run directly):

    POST /functions/v1/edgebot?task=forex
    x-edgebot-token: <existing control token>
    Content-Type: application/json

    {
      "pair": "EUR_USD",
      "intervalMinutes": 15,
      "candles": [
        {"time":"2026-10-29T15:00:00Z","open":1.1000,"high":1.1010,"low":1.0995,"close":1.1008}
      ],
      "spreadPips": 0.8,
      "equityUsd": 10000,
      "drawdownPct": 0
    }

Actual requests need **at least 60 complete candles**. If macro event information is not connected, the report still shows chart-pattern and indicator analysis, but the final decision is NO_TRADE.

To use the UI, open dashboard/forex.html in the same deployment setup as your current static dashboard, upload a CSV with time,open,high,low,close columns, and enter the control token. Never use real broker passwords.

## Testing

Use Node.js with TypeScript type stripping (Node 22+; use Node 24 to avoid older version behavior):

    node --test tests/forex.test.ts
    node --test tests/core.test.ts tests/mm.test.ts tests/forex.test.ts

Check a TypeScript typecheck with the Supabase/Deno toolchain before deployment. Running only unit tests does not prove endpoint security or integration.

## What still needs to be built before a valid forex model

- Historical bid/ask OHLC feed with clear licensing, provenance, gaps, timezone and ingestion audits
- Verified economic-calendar events with revision history and publication timestamps
- FX-specific trades, spread/slippage models, swap/financing calculations and a **paper-only** order ledger
- Walk-forward backtests; strict separation of training/validation/test dates; out-of-sample strategy evaluation
- Per-pair metrics: expectancy, profit factor, maximum drawdown, drawdown duration, volatility, trade sample sizes
- Confidence calibration based on actual labeled outcomes, not arbitrary agent scores
- Structured persisted agent decisions, versioned indicators, source timestamps and model monitoring
- Review-safe deployment, logging, rate limits and authentication hardening
- No live forex broker execution. Nothing should auto-route a WATCH label to an order.

## Security observation for existing code

The older dashboard stores the control token in localStorage and its backend allows wildcard CORS; these do not bypass the header-based authorization check, but they enlarge the impact of a browser-origin compromise. Prefer short-lived, scoped authorization before expanding access. The existing live Kalshi mode should stay disabled; paper profit over 50 bets is **not** sufficient evidence of a durable edge or a safe real-money system.

This branch is only the first integrated analysis layer, **not** a complete self-running AI trading business.
