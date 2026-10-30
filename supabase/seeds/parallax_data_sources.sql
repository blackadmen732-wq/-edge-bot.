-- Register read-only research sources. Preserve existing owner enable/disable choices.
insert into edgebot_research.sources(id,track,name,expected_seconds,enabled) values
('coinbase.spot','crypto','Coinbase BTC spot reference',3600,true),
('coingecko.markets','crypto','CoinGecko BTC ETH SOL market snapshots',3600,true),
('dexscreener.solana','crypto','DEX Screener wrapped SOL pool snapshots',3600,true),
('solana.network','crypto','Solana public RPC network status',3600,true),
('defillama.tvl','crypto','DefiLlama chain TVL snapshots',21600,true),
('mempool.fees','crypto','Mempool Bitcoin recommended fees',3600,true),
('usgs.earthquakes','geophysics','USGS hourly earthquake observations',3600,true),
('worldbank.gdp','macro','World Bank US GDP annual history',86400,true),
('helius.network','crypto','Helius Solana network observations',3600,true),
('jupiter.prices','crypto','Jupiter SOL reference price',3600,true)
on conflict(id) do nothing;

