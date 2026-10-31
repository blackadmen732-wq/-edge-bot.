# Private Parallax pipeline — deployed 2026-10-30

## Working behavior

The private desk now uses the existing authenticated Supabase research function for:
- GET ?task=universe: sources, legacy research metadata, and saved numeric snapshot/result relationships.
- list_archive_series: available price series, distinct usable sample counts, and readiness.
- analyze_archived_series: select server-archived observations, calculate deterministic measurements and persist the snapshot/report.
- list_numeric_results and get_numeric_result: retrieve saved calculations and their exact input evidence.

The deployed function is edge-research version 6. No paid provider, new project, public signup, customer account, customer billing or wallet is required. AI integrations remain optional and unused by this pipeline.

Supported extraction: Kraken BTC/ETH USD, Coinbase BTC USD, CoinGecko BTC/ETH/SOL USD, Jupiter SOL USD, and Frankfurter EUR/USD and EUR/GBP reference rates. At least 30 distinct usable timestamps are required. Sources with less data remain visible with a sample count and disabled calculation control.

## Persistence and automatic updates

Numeric snapshots/results are stored together as append-only application records in the existing private edgebot_research.events table with action numeric_analysis. This preserves the original observed values, availability timestamps, archive IDs, source, series selector, algorithm version and fingerprint without coercing price data into probability/outcome datasets.

Unchanged fingerprints reuse the prior saved result. Each changed snapshot gets a new record. A transaction advisory lock protects duplicate concurrent saves. The first version uses bounded event-history queries; a dedicated indexed numeric registry is appropriate if saved-result volume grows substantially.

The existing hourly collector now calculates all ready numeric series after collection. No additional scheduled job or provider request is created for numerical analysis. Source collection failures remain isolated; analysis cannot create trades or AI charges. The separate legacy five-minute worker remains for outcome jobs.

Timestamps must be known by the requested asOf time. Revisions at the same event time use the most recently available known record, and timestamps are sorted and deduplicated. Mixed assets/providers are never combined into one series. Invalid/nonpositive values are excluded. This first parser supports positive prices/rates only.

## What the reports mean

Reports calculate the previous 20-observation range, mean, level deviation, recent percentage change and observed return variability. The graph links known sources to their saved snapshots/results. These are descriptive measurements, not trained models, causal findings, forecasts or a validated trading strategy. Irregular snapshots do not become historical OHLC candles or a guaranteed execution price.

## Private desktop file

Run python3 scripts/build-private.py after installing the source assets and dashboard/research page.
It produces Parallax-Private.html beside the repository:
- Existing artwork is embedded as data URLs.
- All desk modules, including math-core and calculations, are bundled.
- The secure research workspace is embedded as iframe srcdoc.
- No access tokens or provider credentials are embedded.
- Download/open the file in a browser. Open Data & patterns, expand Backend connection, enter the existing research access token, and select Connect and load.
- Use Analyze your archived prices to calculate/save a ready series or reopen its history.
- The access token is held in memory and cleared on Disconnect. Obtain the research token from Supabase Vault; never use a service-role key.
- The file needs network access for live backend data. Existing optional externally hosted ambience video is not bundled; local math remains usable without a model API.
- No hosted public site or custom domain was published.

The backend's existing null-origin CORS allowance permits the local file to authenticate. A future hosted origin must be explicitly allowed. Existing owner-only provider credential changes remain separate from the research token.

## Verified

- 62 Node tests passed, including 5 PostgreSQL/PGlite persistence/queue/security tests and 2 numeric archive tests.
- Two DOM interaction tests passed: loading archived series, calculating/saving, readiness controls, failed credentials, and clearing on disconnect.
- Full standalone bundle startup passed in a simulated DOM with canvas/media stubs. This is not visual browser QA or a live browser-to-backend integration test.
- Deno type checks passed for the changed service and HTTP dependency graph.
- Full entrypoint typecheck remains blocked by npm registry resolution of the unchanged postgres package; Supabase successfully bundled the deployed function.
- Authenticated production universe and archive analysis calls returned HTTP 200.
- Production collector saved BTC and ETH reports from 46 observations each. A concurrent manual BTC snapshot captured the prior 45 records and is retained as a separate historical version.
- Repeating the latest BTC archive analysis returned cached=true, persisted=true, id 140.
- Unauthenticated production universe and health calls returned 401.
- Helius/Jupiter backend credentials remain encrypted in Vault and their read-only feeds remain connected.

## Remaining separate work

Private cloud paper-session synchronization, background pattern job scaling, equal-interval historical candles, out-of-sample validation and a trained model are not implemented by this change. Paper desk positions still use local browser storage. Ambient animations remain ambient; they do not claim that agents are working while idle.
Alpha Vantage credentials and email-domain repair remain optional external setup. This working numerical pipeline needs neither.

