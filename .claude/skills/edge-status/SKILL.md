---
name: edge-status
description: Daily report on every Edge Bot system in one screen (weather market maker, scoreboard, Survival Arena, liquidity rewards, stocks, jobs). Use when the owner says "status", "how's the bot", "report", "/edge-status", or "what's making money".
---

# Edge Bot status

Run the `scout` agent (cheap model) and relay its answer. For a deeper look at one part, run that part's agent instead:

| Ask | Agent |
|---|---|
| everything, one screen | `scout` |
| Survival Arena (evolving weather recipes) | `arena-keeper` |
| Kalshi liquidity rewards paper book | `lip-watch` |
| stock day-trader, live-money checklist | `stocks-watch` |
| "is there money in <idea>?" before building it | `edge-hunter` |
| "check this change" before pushing | `checker` |

Rules for the reply to the owner:
- Paper results are labelled paper. Never call an estimate income.
- Lead with the one number that changed most since yesterday, then anything broken or paused.
- Max 10 lines. No raw JSON.
