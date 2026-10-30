# Parallax research graph and pattern measurements

This is an additive change on top of existing \`codex/research-analysis\`. It does **not** merge the separate Forex Lab PR, alter Kalshi/live trading code, initiate orders, create provider accounts or deploy production services. It is private and authenticated.

## What is now wired in code

1. \`edge-research\` serves \`GET ?task=universe\` with the same existing Bearer token authentication and origin checks as its other tools. It reads existing research *metadata*, not raw secrets.
2. The Data Universe frontend in \`dashboard/desk/parallax.mjs\` now points to that existing Supabase function instead of a hypothetical \`/v1/universe\` backend.
3. A new MCP/HTTP research tool called \`analyze_numeric_series\` measures time-ordered numerical patterns: last-value breakouts from the previous 20 observations, 20-observation level deviation (z-score), recent return volatility, and price/value change.
4. The frontend has a Pattern Research Laboratory: paste a JSON series and run the same authenticated research tool. The result remains local to the browser until you intentionally save it elsewhere.
5. The graph reads sources, datasets, jobs, models, and hypotheses already in the research service. Only documented dataset-job-model relationships become graph edges. Hypotheses appear as **unverified**, not proven patterns.

## Data and credentials

The frontend's default URL is the existing \`https://mhahkbssltukjhusjsjf.supabase.co/functions/v1/edge-research\`, not a new service. Supply the research Bearer credential in the page's masked field; **never add it to URLs, source control, or exported data**. Credentials are not saved to localStorage by the Parallax panel.

The GET endpoint is \`?task=universe\`. The analysis tool is available through \`POST ?task=tool\` with \`{"name":"analyze_numeric_series","arguments":{...}}\` and through the existing MCP \`tools/call\` protocol.

### Numeric series contract

A research series requires:
- \`name\`: human-readable series title, up to 120 characters.
- \`source\`: caller-supplied source name (not automatically verified).
- \`market\`: one of \`forex, crypto, equities, commodities, prediction, weather, other\`.
- \`asOf\`: ISO UTC research timestamp.
- \`points\`: 30–2000 **sorted** observations containing \`time\`, \`availableAt\`, and finite positive \`value\`.

\`availableAt\` must be at/after the event time, at/before \`asOf\`. Future data, unsorted observations, duplicates, nonpositive prices and unknown categories are rejected. The service does not calculate a win probability or infer profitable strategy results.

This first analyzer is not a backtest, and the use of irregular time intervals limits interpretation. Percentage change and volatility are based on observations, not necessarily equal time windows.

## Still missing

- Automatic extraction of compatible, licensed historical OHLC time series from each source. The existing daily exchange-rate feed and occasional BTC/ETH snapshots do not yet provide enough quality data for reliable intraday trading patterns.
- A persistent, versioned **pattern registry**, including dataset fingerprints, reproducible detection code, sample counts, results, out-of-sample validation, and failure analysis.
- Provenance verification and permissions for downloaded third-party datasets.
- Durable queued pattern jobs for large sources, and links from validated patterns to actual historical outcomes.
- Solana new-token discovery, venue-specific decoders, wallet evidence, quote capture, realistic simulated fills and full live connectivity.
- The Forex Lab PR integration; keep it isolated until the research branch and deployment drift have been reconciled.
- The data universe uses SVG for a bounded set of records, not a massive WebGL 3D graph. Existing ambient animations should not suggest that agents are executing while idle.

## Tests and deployment

Run on Node 24:

\`\`\`bash
node --test tests/parallax-patterns.test.ts tests/research.test.ts
\`\`\`

Then type-check using the existing Deno toolchain and test the \`edge-research\` function in a staging environment with read-only data, including 401 on missing Authorization and a frontend screenshot test. **Do not deploy** until checks pass and the difference between deployed and GitHub versions is reconciled.

The file changes are on a separate draft feature branch. This document describes the proposed code integration, not evidence of a deployed production feature or a proven profitable trading strategy.
