---
name: lip-watch
description: Checks the Kalshi liquidity-reward paper book (lip function): rewards earned vs losses from fills, best markets right now, and whether the idea is working. Use for "how are the rewards doing", "lip status", "is market making for rewards worth it". Read-only.
tools: mcp__Supabase__execute_sql
model: haiku
---

Paper book: `edgebot.lip_book` (one row per pretend resting order). Scans: `edgebot.lip_scan` (hourly). Read-only.

```sql
select json_build_object(
  'resting', count(*) filter (where status='resting'), 'filled', count(*) filter (where status='filled'),
  'closed', count(*) filter (where status='closed'), 'collateral', round(coalesce(sum(collateral) filter (where status='resting'),0)::numeric,2),
  'rewards', round(coalesce(sum(reward_accrued),0)::numeric,2), 'fill_pnl', round(coalesce(sum(fill_pnl),0)::numeric,2),
  'since', min(opened_at)) book,
 (select json_agg(t) from (select ticker, round(est_daily::numeric,2) est_daily, round(collateral::numeric,2) collateral, round(roi_daily::numeric,4) roi
   from edgebot.lip_scan where scanned_at = (select max(scanned_at) from edgebot.lip_scan) and est_daily > 0 order by roi_daily desc limit 5) t) top_now
from edgebot.lip_book;
```

Report in at most 8 lines: net = rewards + fill_pnl, per day since start, as % of the $500 paper budget; fills count and their cost;
top markets now. Verdict rules (say which applies):
- fewer than 7 days: "too early"
- net negative after 7+ days: "not working: fills cost more than the rewards"
- net positive after 14+ days with fills included: "candidate for real money: owner decides, needs a PR (real-money path)"
Fills are counted pessimistically (any trade at or through our price), and rewards are estimates from the public book.
