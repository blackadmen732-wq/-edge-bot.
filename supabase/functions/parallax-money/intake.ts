// Turns stored observations (edgebot_research.observations) into one-line, human-readable "information
// entering the black hole". No imports: tested with node --test.

type P = Record<string, any>;
const c = (x: unknown) => (typeof x === "number" ? `${Math.round(x * 1000) / 10}¢` : "?");
const usd = (x: unknown) => (typeof x === "number" ? "$" + x.toLocaleString("en-US", { maximumFractionDigits: x < 10 ? 4 : 2 }) : "?");
const pct = (x: unknown) => (typeof x === "number" ? `${Math.round(x * 1000) / 10}%` : "?");

export const SOURCE_LABELS: Record<string, string> = {
  "edgebot.mm_quotes": "Kalshi weather quote", "edgebot.mm_fills": "Paper trade", "edgebot.mm_positions": "Position check",
  "edgebot.odds": "Sportsbook odds", "edgebot.signals": "Sports decision", "edgebot.bets": "Sports order",
  "nws.forecast": "Weather forecast", "dexscreener.solana": "DEX price", "kraken.spot": "Kraken price",
  "coinbase.spot": "Coinbase price", "coingecko.markets": "CoinGecko market", "frankfurter.fx": "Currency rate",
  "solana.network": "Solana network", "helius.network": "Helius network", "mempool.fees": "Bitcoin fees",
};

export function describe(source: string, p: P): string {
  try {
    switch (source) {
      case "edgebot.mm_quotes": return `${p.ticker} · ${p.side === "bid" ? "buy" : "sell"} ${c(p.price)} ×${p.size}${typeof p.fair === "number" ? ` · fair ${c(p.fair)}` : ""}`;
      case "edgebot.mm_fills": return `FILLED ${p.ticker} · ${p.side === "bid" ? "bought" : "sold"} ${p.contracts} @ ${c(p.price)}${typeof p.markout === "number" ? ` · 1h later ${p.markout >= 0 ? "+" : ""}${c(p.markout)}` : ""}`;
      case "edgebot.mm_positions": return `${p.ticker} · holding ${p.position} · price ${c(p.last_mid)}`;
      case "edgebot.odds": { const f = Object.entries(p.fair ?? {}).slice(0, 2).map(([t, v]) => `${t} ${pct(v)}`); return `${p.home_team ?? ""}${p.away_team ? " vs " + p.away_team : ""} · fair ${f.join(" / ")}`.trim(); }
      case "edgebot.signals": return `${p.label ?? p.ticker} · ${p.team ?? ""} · ${p.decision ?? ""}${p.reason ? " — " + p.reason : ""}`;
      case "edgebot.bets": return `${p.label ?? ""} · ${p.team ?? ""} · edge ${pct(p.edge)} · ${p.status ?? ""}`;
      case "nws.forecast": { const q = Array.isArray(p.periods) ? p.periods[0] : null; return `${p.city ?? "?"} · ${q?.name ?? "forecast"} ${q?.temperature ?? "?"}°${q?.temperatureUnit ?? ""} ${q?.shortForecast ?? ""}`.trim(); }
      case "dexscreener.solana": return `${p.dex ?? "DEX"} SOL ${usd(p.priceUsd)} · 24h vol ${usd(p.volume24h)}`;
      case "kraken.spot": return `${p.pair} ${usd(p.price)}`;
      case "coinbase.spot": return `${p.symbol} ${usd(p.price)}`;
      case "coingecko.markets": return `${p.asset} ${usd(p.price)} · vol ${usd(p.volume24h)}`;
      case "frankfurter.fx": return `${p.base}/${p.quote} ${p.rate}`;
      case "solana.network": case "helius.network": return `slot ${p.slot}`;
      case "mempool.fees": return `fastest ${p.fees?.fastestFee ?? "?"} sat/vB`;
    }
  } catch { /* fall through */ }
  const bits = Object.entries(p ?? {}).filter(([, v]) => typeof v !== "object").slice(0, 3).map(([k, v]) => `${k} ${String(v).slice(0, 24)}`);
  return bits.join(" · ") || "new record";
}

export function summarizeIntake(rows: { source: string; payload: P; at: string }[], perSource: { source: string; day: number; total: number }[], hours: { h: string; n: number }[], now = Date.now()) {
  const items = rows.map((r) => ({ source: r.source, kind: SOURCE_LABELS[r.source] ?? r.source, at: r.at, text: describe(r.source, r.payload).slice(0, 110) }));
  const sources = perSource.map((s) => ({ ...s, label: SOURCE_LABELS[s.source] ?? s.source })).sort((a, b) => b.day - a.day);
  const hist: number[] = Array(24).fill(0);
  for (const h of hours) { const ago = Math.floor((now - new Date(h.h).getTime()) / 3_600_000); if (ago >= 0 && ago < 24) hist[23 - ago] += h.n; }
  return { generated_at: new Date(now).toISOString(), today: sources.reduce((a, s) => a + s.day, 0), all_time: sources.reduce((a, s) => a + s.total, 0), per_hour: hist, sources, items };
}
