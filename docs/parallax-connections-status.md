# Parallax connection inventory — 2026-10-30

## Verified deployment

Supabase project: mhahkbssltukjhusjsjf. edge-research version 4 is active.
This change extends the deployed version 3 source, matching research PR #3's store.
The unrelated edgebot function and unmerged Parallax/Forex branches are not deployed by this change.

The first authenticated cloud collection returned HTTP 200 and archived **35 new observations** across eight added public sources. Existing Kraken and NWS collectors also received data; Frankfurter was cached under its existing collection interval.
The hourly collection job remains at minute 23. Each source has its own minimum interval, so macro and TVL sources collect less often.
Unauthenticated health requests returned HTTP 401.

## All external data and AI connections

| Service | Purpose | Current status |
| --- | --- | --- |
| Kraken | BTC/ETH reference prices | Existing feed received data |
| Frankfurter | EUR/USD and EUR/GBP daily reference rates | Existing feed; cached in verification |
| National Weather Service | Six city forecasts | Existing feed received data |
| Coinbase | BTC/USD reference price | NEW: deployed, 1 archived observation |
| CoinGecko | BTC, ETH, SOL market snapshots | NEW: deployed, 3 archived observations |
| DEX Screener | Wrapped SOL pool prices/liquidity | NEW: deployed, 15 archived observations |
| Solana public RPC | Finalized network slot/blockhash | NEW: deployed, 1 archived observation |
| DefiLlama | Ethereum, Solana, Bitcoin TVL | NEW: deployed, 3 archived observations |
| mempool.space | Bitcoin fee estimates | NEW: deployed, 1 archived observation |
| USGS | Hourly earthquake feed | NEW: deployed, 1 archived observation |
| World Bank | Latest US annual GDP history | NEW: deployed, 10 archived observations |
| [Helius](https://dashboard.helius.dev/) | Dedicated read-only Solana RPC | Adapter deployed; requires sign-in and provider key |
| [Jupiter](https://portal.jup.ag/) | SOL reference price | Adapter deployed; requires sign-in and provider key |
| [Alpha Vantage](https://www.alphavantage.co/support/api-key/) | Daily equity and WTI history | Existing adapters; no research Vault credential |
| [The Odds API](https://the-odds-api.com/) | Existing read-only sports observations | Existing adapter; no research Vault credential; no account created |
| [xAI](https://console.x.ai/) | Existing bounded research agent | Parallax team setup completed; console balance $0; backend health reports AI unconfigured |
| [Resend](https://resend.com/domains) | Research notifications | Only domain is failed; backend provider key missing; sender and recipient configuration incomplete |
| [OANDA](https://developer.oanda.com/) | Potential intraday FX history | No adapter or account connected; requires eligible account |
| [Higgsfield](https://higgsfield.ai/) | Optional generated visual assets | No application API credential/integration verified in this task |

Helius and Jupiter sign-in pages were opened and left available. Neither was registered or connected.
No paid subscription, credit purchase, trading account, wallet, trade, swap, or email send was performed.
The public feeds need no provider credentials for the tested endpoints; access and provider terms can change.

## Infrastructure inventory

| Connection | Current status |
| --- | --- |
| Supabase PostgreSQL archive | Existing; verified new observations persisted |
| Supabase Edge Functions | edge-research version 4 deployed and authenticated |
| Supabase Cron | Existing hourly collector/five-minute worker retained |
| GitHub | Code and review branch saved |
| Supabase Auth frontend | No frontend integration completed by this change |
| Supabase Storage | No bucket configuration verified or changed |
| Supabase Realtime | No frontend subscription/broadcast integration added |
| Frontend hosting | No Parallax frontend hosting configured or verified |
| Persistent compute worker | Not built; existing short research worker is separate |

## Secure credential setup

The existing owner-only credentials endpoint accepts provider IDs:
xai, alphavantage, odds, resend, helius, jupiter.

Use the existing Provider Connections page with an owner token. The page uses backend provider metadata; do not paste server secrets into ordinary chat or commit them to Git.
Keys are stored in encrypted Supabase Vault as edgebot_research_key_PROVIDER and are never returned by the status API.
Saving a key is not proof that it is valid: collect and inspect the source-specific status afterward.
Resend credential storage alone does not enable email; sender/domain/recipient setup is separate.

New keyed adapters:
- Helius: finalized getLatestBlockhash only; at most 24 adapter requests/day.
- Jupiter: price reference endpoint only; at most 24 adapter requests/day.
- Neither adapter requests wallet keys or can submit transactions.

## Implementation and verification

- New sources registered using supabase/seeds/parallax_data_sources.sql; idempotent inserts preserve existing enable/disable choices.
- Existing collection lease protects the added collector.
- New requests use fixed HTTPS hosts, reject redirects, have 9-second timeouts and 1 MB response limits.
- New outbound collection runs in batches of at most three, after the existing collectors.
- One provider's failure does not stop the other providers.
- Archive records preserve source, event time, actual ingestion availability time and attribution.
- World Bank data uses the latest available vintage; original historical release dates are unknown. These records must not be treated as information known in an earlier backtest.
- An empty USGS hour records zero events, rather than invented activity.
- Health source presence is separate from credentials and successful data receipt.
- This change adds data ingestion; it does not automatically train models or establish predictive accuracy.

Validation:
- 11 Node connector/security tests passed.
- Deno type checks passed for changed connector/store modules and the HTTP dependency graph.
- Full entrypoint type check could not resolve the unchanged npm postgres dependency because registry access was refused. Supabase deployment successfully bundled the entrypoint, and production collection returned HTTP 200.
- All eight public adapters also returned usable live data in local smoke tests.
- Production SQL verified 35 archived observations from the eight new sources.
- Unauthenticated production access returned 401.
- Security advisors were reviewed. Existing extension-in-public and Auth/password/RPC advisories were not changed by this connector work. Backend research tables retain their existing RLS/no-client-policy configuration.
  References: https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public and https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection

Reproduce connector tests with: node --test tests/connections.test.ts tests/extra-connections.test.ts

