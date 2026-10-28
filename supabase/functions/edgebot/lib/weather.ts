// Free daily high-temperature forecasts (Open-Meteo, no key needed). Used only to nudge the market's price a little.

import type { City } from "./mm.ts";

/** Forecast daily highs in °F for the next 3 local days: "YYYY-MM-DD" -> high. */
export async function forecastHighs(city: City, fetchImpl: typeof fetch = fetch): Promise<Map<string, number>> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(city.lat));
  url.searchParams.set("longitude", String(city.lon));
  url.searchParams.set("daily", "temperature_2m_max");
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("timezone", city.tz);
  url.searchParams.set("forecast_days", "3");
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const j = await res.json();
  const out = new Map<string, number>();
  const days: string[] = j?.daily?.time ?? [];
  const highs: unknown[] = j?.daily?.temperature_2m_max ?? [];
  days.forEach((d, i) => {
    const v = Number(highs[i]);
    if (highs[i] !== null && Number.isFinite(v)) out.set(d, v);
  });
  return out;
}
