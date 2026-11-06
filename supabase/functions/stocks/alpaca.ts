// Minimal Alpaca REST client. Paper and live are separate keys and separate hosts; this file never guesses which.
import type { Bar } from "./orb.ts";

const HOSTS = { paper: "https://paper-api.alpaca.markets", live: "https://api.alpaca.markets" } as const;
const DATA = "https://data.alpaca.markets";

export class Alpaca {
  constructor(readonly mode: "paper" | "live", private keyId: string, private secret: string) {}

  /** Keys come from Supabase secrets only: ALPACA_PAPER_KEY_ID/SECRET or ALPACA_LIVE_KEY_ID/SECRET. */
  static fromEnv(mode: "paper" | "live", env: (k: string) => string | undefined): Alpaca | null {
    const p = mode === "live" ? "ALPACA_LIVE" : "ALPACA_PAPER";
    const id = env(`${p}_KEY_ID`), secret = env(`${p}_SECRET`);
    return id && secret ? new Alpaca(mode, id, secret) : null;
  }

  private async req(base: string, path: string, init: RequestInit = {}): Promise<any> {
    const res = await fetch(base + path, {
      ...init,
      headers: { "APCA-API-KEY-ID": this.keyId, "APCA-API-SECRET-KEY": this.secret, "content-type": "application/json", ...(init.headers ?? {}) },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Alpaca ${init.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
  private api(path: string, init?: RequestInit) { return this.req(HOSTS[this.mode], path, init); }

  clock(): Promise<{ is_open: boolean; next_open: string; next_close: string }> { return this.api("/v2/clock"); }
  account(): Promise<{ cash: string; equity: string; last_equity: string; trading_blocked: boolean; buying_power: string }> { return this.api("/v2/account"); }
  order(id: string): Promise<any> { return this.api(`/v2/orders/${id}?nested=true`); }
  positions(): Promise<any[]> { return this.api("/v2/positions"); }

  /** Close everything and cancel open orders (the 3:55 PM flatten). */
  closeAll(): Promise<any> { return this.api("/v2/positions?cancel_orders=true", { method: "DELETE" }); }

  /** One bracket: limit buy, with the stop and the target attached on Alpaca's side. Long only, whole shares, day order. */
  bracketBuy(o: { symbol: string; qty: number; limit: number; stop: number; target: number; clientId: string }): Promise<any> {
    return this.api("/v2/orders", {
      method: "POST",
      body: JSON.stringify({
        symbol: o.symbol, qty: String(o.qty), side: "buy", type: "limit", time_in_force: "day",
        limit_price: o.limit.toFixed(2), order_class: "bracket", client_order_id: o.clientId,
        take_profit: { limit_price: o.target.toFixed(2) },
        stop_loss: { stop_price: o.stop.toFixed(2) },
      }),
    });
  }

  /** Today's 5-minute bars for many symbols (free IEX feed). */
  async bars5m(symbols: string[], startIso: string): Promise<Record<string, Bar[]>> {
    const out: Record<string, Bar[]> = {};
    let token = "";
    for (let page = 0; page < 10; page++) {
      const q = new URLSearchParams({ symbols: symbols.join(","), timeframe: "5Min", start: startIso, feed: "iex", limit: "10000", adjustment: "raw" });
      if (token) q.set("page_token", token);
      const r = await this.req(DATA, `/v2/stocks/bars?${q}`);
      for (const [sym, bars] of Object.entries(r?.bars ?? {})) (out[sym] ??= []).push(...(bars as Bar[]));
      token = r?.next_page_token ?? "";
      if (!token) break;
    }
    return out;
  }
}
