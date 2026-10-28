# Edge Bot research workspace

This adds an outcome-analysis service alongside the existing engine. It archives observations, preserves unknown values, compares outcomes and quality flags, runs reproducible calibration experiments, and exposes a restricted MCP connection. It does not change execution rules or add money movement.

## Components

- `supabase/functions/edge-research`: authenticated HTTP API, stateless MCP, durable job worker, optional bounded Grok investigation.
- `supabase/migrations/20261028224408_research_analysis.sql`: private research tables, immutable evidence, source capture, separate credentials and five-minute worker dispatcher.
- `dashboard/research/index.html`: standalone dashboard. Open the file directly, or serve the repository with `python3 -m http.server 8000` and open `/dashboard/research/`.
- `tests/research.test.ts`: validation, time separation, diagnostics, HTTP/MCP authentication and model tool permissions.
- `tests/research-db.test.ts`: migration and Postgres integration tests using the existing PGlite test dependency.

## Connect

The service URL is `https://PROJECT_REF.supabase.co/functions/v1/edge-research`.
The MCP URL is `https://PROJECT_REF.supabase.co/functions/v1/edge-research/mcp`.

The migration generates two independent credentials in Supabase Vault:

- `edgebot_research_token`: MCP research tools and bounded worker requests.
- `edgebot_research_owner_token`: owner dashboard and activation of research model versions.

View the required credential in your own Supabase Vault interface and enter it in the connector's secure Authorization/Bearer field or the dashboard's masked field. Do not commit credentials, put them in URLs, or paste them into ordinary chats. The dashboard keeps the token only in memory.

In Grok Bot, add a custom MCP server using the MCP URL and the research credential. Ask it to read data health, register a hypothesis, or run an experiment. Discovery and every tool call require authentication. The connector offers no arbitrary SQL, execution-setting changes, orders, or withdrawals.

The owner dashboard can activate an eligible calibration version **for research only**. It does not apply the model to trading decisions. The agent credential cannot activate models.

## Optional AI investigation

Configure `XAI_API_KEY` through Supabase's secure secrets interface. `RESEARCH_AI_MODEL` defaults to `grok-4.3`. No key means AI jobs return a clear configuration error; diagnosis and calibration remain available.

The dashboard also provides **Provider connections → Save key securely**. This owner-only endpoint stores xAI, Alpha Vantage, The Odds API, or optional Resend credentials in encrypted Vault storage. No secret is returned to the browser or included in agent tools, URLs, or audit details. The Grok worker reads the xAI credential from Vault when no environment key is configured. Saving a key indicates presence, not successful provider validation. Resend sender/domain and recipient configuration remain separate.

### Data connections

An hourly collector uses read-only endpoints and preserves original provider attribution and availability times:

| Source | Account key | Coverage |
| --- | --- | --- |
| Kraken public market data | None | Observations of BTC/USD and ETH/USD spot prices; not order execution |
| Frankfurter | None | Daily EUR/USD and EUR/GBP reference rates; not live execution quotes |
| US National Weather Service | None | Forecast snapshots for the six existing research cities |
| Alpha Vantage | Provider-issued | Daily SPY research sample and WTI observations; source entitlements apply |
| The Odds API | Provider-issued | Read-only snapshots for the three existing sports categories |

No paid plan or provider account is created automatically. The collector caches successful polls and caps Alpha Vantage at 20 requests per UTC day and the sports feed at 12. Failed requests reserve quota conservatively. A lease prevents overlapping collection. Partial weather coverage, missing credentials, HTTP errors, and unavailable observations are recorded explicitly. Public forecasts are research context and are not represented as official market settlement observations.

The dashboard's **Collect research data** button triggers a bounded collection. Automatic collection runs hourly at minute 23. API clients use `POST ?task=collect`, and `get_connections` reports key presence and the latest collection result without exposing values.

Sources: [Kraken ticker API](https://docs.kraken.com/api-reference/market-data/get-ticker-information), [Frankfurter reference API](https://frankfurter.dev/), [NWS API](https://www.weather.gov/documentation/services-web-api), [Alpha Vantage documentation](https://www.alphavantage.co/documentation/), [The Odds API](https://the-odds-api.com/liveapi/guides/v4/).

An AI job uses at most three model requests and six permitted tool calls. The backend reserves capacity before each call, with a maximum of 20 AI requests per UTC day. Provider token usage is recorded when available. Actual dollar cost remains null until measured; it is not invented from missing billing data. Failed requests still consume reserved capacity because billing may be uncertain.

The model receives aggregated diagnostics, not raw example records. It may read health and model/hypothesis history or propose a hypothesis. It cannot activate a model or execute an external transaction. Retrieved text is evidence, not authority. An AI explanation is not a verified cause.

## Data and six research tracks

The six catalog tracks are sports, weather, equities (stocks/ETFs), crypto, currencies, and commodities. Sports/weather capture the existing engine's records when they arrive. The four additional tracks offer authenticated timestamped imports; external vendor APIs are not silently subscribed to or represented as connected.

`import_observations` accepts up to 200 records at a time:

```json
{"observations":[{"source":"equities.import","externalId":"source-record-id","eventAt":"2025-01-01T12:00:00Z","availableAt":"2025-01-01T12:00:01Z","payload":{"value":123.45,"unit":"USD","attribution":"Your permitted source"}}]}
```

Native archive records cannot be impersonated through import sources. Same-source/external-ID/payload repeats are idempotent. Corrections append a new observation. The archive survives deletion from short-lived operational tables. Captured availability time is when this archive first received the record, including backfills; it is not falsely backdated.

Only completed paper outcomes are automatically normalized into examples. Existing records lack full feature provenance and are marked accordingly. Raw archive capture is distinct from normalization. Never interpret missing observations as no activity.

## Dataset format

Import a JSON array through the dashboard, or call `create_dataset` with a name and examples. Each example includes:

```json
{"id":"example-1","predictedAt":"2025-01-01T10:00:00Z","availableAt":"2025-01-01T09:59:00Z","outcomeAt":"2025-01-02T10:00:00Z","probability":0.6,"outcome":true,"result":null,"cost":null,"group":"comparison-group","flags":["missing-secondary-source"]}
```

`outcome` must be a boolean or null. A resolved label requires `outcomeAt`. `result` is a supplied result, which may already include fees; `cost` is reported separately and is never blindly subtracted again. Nulls remain unknown. Dataset examples are canonicalized, SHA-256 fingerprinted, immutable and limited to 5,000 records. Matching content reuses the same dataset.

## Experiments and learning

- **Diagnosis:** summarizes all outcomes, gain/loss counts, Brier/log-loss, probability reliability bins, and comparison groups with and without each flag. At most 30 groups and 30 flags are returned; omitted counts are explicit. These are descriptive associations, not causal findings.
- **Calibration:** fits one probability-offset candidate on earlier resolved labels, then evaluates on a later held-out period. It requires at least 60 resolved examples and enough temporally separated training/test observations. Labels resolved after the test boundary cannot enter training. It compares the same test rows against the original predictions. Equal or worse results retain the baseline. Repeated searches reuse the holdout and are not independent confirmation.
- **AI investigation:** requests a concise interpretation and possible research questions, with recorded tool activity.

Jobs are idempotent by request ID, persist status and results, use leased claims, reject stale completion tokens, and terminate after three expired attempts. A five-minute dispatcher processes one bounded job per request. Cron's HTTP dispatch status is not the job's completion status; inspect `jobs.status` and results.

## HTTP API

All routes require `Authorization: Bearer ...`. CORS defaults allow the local standalone dashboard, localhost port 8000, and ChatGPT. Override `RESEARCH_ALLOWED_ORIGINS` with a comma-separated exact-origin list for another dashboard host. Cookie authentication is not used.

- `GET ?task=health`: source health and counts.
- `POST ?task=tool`: `{"name":"get_data_health","arguments":{}}` or any listed research tool.
- `POST ?task=worker`: process at most one queued job.
- `POST ?task=promote`: owner-only `{"id":"MODEL_UUID"}`.
- `POST /mcp`: JSON-RPC initialize, ping, tools/list and tools/call. Stateless JSON responses; no SSE stream or client session is required.

## Deployment

Apply the research migration, then deploy **only** `edge-research` with `index.ts`, `core.ts`, `store.ts`, `service.ts`, `agent.ts`, and `http.ts`. It implements its own Bearer authentication, so platform JWT verification is disabled for this function. No anonymous research endpoint is exposed.

Configure the worker URL after deploying:

```sql
insert into edgebot_research.configuration(key,value)
values('worker_url','https://PROJECT_REF.supabase.co/functions/v1/edge-research?task=worker')
on conflict(key) do update set value=excluded.value;
```

Until this URL exists the dispatcher performs no HTTP request. Check a real HTTP response and a worker result after configuration. No external data or AI key is created by deploying source code.

## Validation

```sh
npm --prefix tests/e2e/db ci
node --test tests/core.test.ts tests/mm.test.ts tests/research.test.ts tests/research-db.test.ts
npm exec --yes --package=deno -- deno check --node-modules-dir=manual supabase/functions/edge-research/index.ts
```

The Deno command needs `postgres@3.4.5` available locally when outbound npm access is blocked. Database tests mock scheduling and Vault only; the archive, permissions, immutable data, queue transactions and research records use actual PostgreSQL semantics in PGlite. They do not access production data.
