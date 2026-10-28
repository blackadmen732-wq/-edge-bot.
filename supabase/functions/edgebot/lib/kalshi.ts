// Kalshi API client. Market data is public; trading requests are signed with your API key.
// Docs: https://docs.kalshi.com

export const KALSHI_BASE = "https://external-api.kalshi.com/trade-api/v2";
const SIGN_PREFIX = new URL(KALSHI_BASE).pathname; // "/trade-api/v2"

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  title?: string;
  status: string;
  result?: string;
  close_time?: string;
  occurrence_datetime?: string | null;
  expected_expiration_time?: string | null;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  last_price_dollars?: string;
  yes_ask_size_fp?: string;
  yes_bid_size_fp?: string;
  volume_fp?: string;
  open_interest_fp?: string;
  mve_collection_ticker?: string;
}

export interface KalshiEvent {
  event_ticker: string;
  series_ticker: string;
  title: string;
  sub_title: string;
  markets?: KalshiMarket[];
}

async function getJson(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<any> {
  const url = new URL(KALSHI_BASE + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`Kalshi GET ${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  }
  throw new Error(`Kalshi GET ${path} rate limited`);
}

/** Open events (with their markets) for a series. */
export async function getOpenEvents(seriesTicker: string): Promise<KalshiEvent[]> {
  const out: KalshiEvent[] = [];
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const data = await getJson("/events", { series_ticker: seriesTicker, status: "open", with_nested_markets: true, limit: 200, cursor });
    out.push(...(data.events ?? []));
    cursor = data.cursor ?? "";
    if (!cursor) break;
  }
  return out;
}

export async function getMarket(ticker: string): Promise<KalshiMarket> {
  const data = await getJson(`/markets/${encodeURIComponent(ticker)}`);
  return data.market;
}

export async function getSeries(seriesTicker: string): Promise<any> {
  const data = await getJson(`/series/${encodeURIComponent(seriesTicker)}`);
  return data.series;
}

/** List sports series (used once to discover the right series tickers). */
export async function listSportsSeries(): Promise<any[]> {
  const data = await getJson("/series", { category: "Sports" });
  return data.series ?? [];
}

// ---------------------------------------------------------------- signing

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function derLength(len: number): number[] {
  if (len < 0x80) return [len];
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function der(tag: number, content: Uint8Array): Uint8Array {
  const len = derLength(content.length);
  const out = new Uint8Array(1 + len.length + content.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.length);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Wrap a PKCS#1 RSAPrivateKey in a PKCS#8 PrivateKeyInfo so WebCrypto can import it. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const algId = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const octet = der(0x04, pkcs1);
  return der(0x30, concat(version, algId, octet));
}

/** Accepts the .key file Kalshi gives you (PKCS#1) or a PKCS#8 key. Newlines may be written as \n. */
export async function importKalshiKey(pem: string): Promise<CryptoKey> {
  const text = pem.replace(/\\n/g, "\n").trim();
  const isPkcs1 = text.includes("BEGIN RSA PRIVATE KEY");
  const body = text
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  if (!body) throw new Error("Kalshi private key is empty");
  let der = b64ToBytes(body);
  if (isPkcs1) der = pkcs1ToPkcs8(der);
  const keyData = new Uint8Array(der); // plain ArrayBuffer-backed copy for WebCrypto
  return await crypto.subtle.importKey("pkcs8", keyData, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]);
}

/** Signature over timestamp + METHOD + path (no query string), RSA-PSS SHA-256, salt = digest length. */
export async function signRequest(key: CryptoKey, timestampMs: string, method: string, fullPath: string): Promise<string> {
  const path = fullPath.split("?")[0];
  const msg = new TextEncoder().encode(timestampMs + method.toUpperCase() + path);
  const sig = await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, key, msg);
  return bytesToB64(new Uint8Array(sig));
}

export class KalshiTrader {
  private keyId: string;
  private key: CryptoKey;

  constructor(keyId: string, key: CryptoKey) {
    this.keyId = keyId;
    this.key = key;
  }

  static async fromEnv(keyId: string | undefined, pem: string | undefined): Promise<KalshiTrader | null> {
    if (!keyId || !pem) return null;
    return new KalshiTrader(keyId, await importKalshiKey(pem));
  }

  private async request(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<any> {
    const url = new URL(KALSHI_BASE + path);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const ts = String(Date.now());
    const sig = await signRequest(this.key, ts, method, SIGN_PREFIX + path);
    const res = await fetch(url, {
      method,
      headers: {
        "KALSHI-ACCESS-KEY": this.keyId,
        "KALSHI-ACCESS-TIMESTAMP": ts,
        "KALSHI-ACCESS-SIGNATURE": sig,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(`Kalshi ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
      (err as any).status = res.status;
      (err as any).body = json;
      throw err;
    }
    return json;
  }

  /** Cash balance in dollars. */
  async balance(): Promise<number> {
    const r = await this.request("GET", "/portfolio/balance");
    if (r.balance_dollars !== undefined) return parseFloat(r.balance_dollars);
    return Number(r.balance) / 100;
  }

  /**
   * Buy YES contracts with a limit price. `side: "bid"` means buy YES.
   * If the price is at or above the best ask it fills right away (taker); otherwise it waits (maker)
   * until `expirationUnix`.
   */
  async buyYes(opts: { ticker: string; contracts: number; price: number; clientOrderId: string; expirationUnix: number }): Promise<any> {
    return await this.request("POST", "/portfolio/events/orders", {
      ticker: opts.ticker,
      side: "bid",
      count: String(Math.floor(opts.contracts)),
      price: opts.price.toFixed(4),
      time_in_force: "good_till_canceled",
      expiration_time: opts.expirationUnix,
      self_trade_prevention_type: "taker_at_cross",
      client_order_id: opts.clientOrderId,
      cancel_order_on_pause: true,
    });
  }

  async getOrder(orderId: string): Promise<any> {
    const r = await this.request("GET", `/portfolio/orders/${encodeURIComponent(orderId)}`);
    return r.order;
  }

  async cancelOrder(orderId: string, ticker: string): Promise<any> {
    return await this.request("DELETE", `/portfolio/events/orders/${encodeURIComponent(orderId)}`, undefined, { market_ticker: ticker });
  }
}
